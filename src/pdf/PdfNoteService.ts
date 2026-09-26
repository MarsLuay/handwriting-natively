import { PDFDocument, PDFName } from "pdf-lib";
import type { ScanDocumentPage } from "../scanning/ScanDocument";

export const ENCRYPTED_PDF_MUTATION_ERROR = "Encrypted PDF cannot be rewritten.";
export const SIGNED_PDF_MUTATION_ERROR = "Signed PDF cannot be rewritten. Saving it would invalidate the digital signature.";

function trailerDeclaresEncryption(bytes: Uint8Array): boolean {
  const tailLength = Math.min(bytes.length, 8192);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(bytes.length - tailLength));
  const trailerAt = tail.lastIndexOf("trailer");
  return /\/Encrypt\b/.test(trailerAt >= 0 ? tail.slice(trailerAt) : tail);
}

function hasDigitalSignature(pdf: PDFDocument): boolean {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!object || typeof object !== "object" || !("get" in object)) continue;
    const type = (object as { get(name: ReturnType<typeof PDFName.of>): { toString(): string } | undefined })
      .get(PDFName.of("Type"));
    if (type?.toString() === "/Sig") return true;
  }
  return false;
}

async function loadPdfBytes(bytes: Uint8Array): Promise<PDFDocument> {
  if (trailerDeclaresEncryption(bytes)) throw new Error(ENCRYPTED_PDF_MUTATION_ERROR);
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) throw new Error(ENCRYPTED_PDF_MUTATION_ERROR);
    throw error;
  }
}

/** Loads a PDF that this plugin is allowed to save. Signed and encrypted files stay untouched. */
async function loadRewrittenPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const pdf = await loadPdfBytes(bytes);
  if (hasDigitalSignature(pdf)) throw new Error(SIGNED_PDF_MUTATION_ERROR);
  return pdf;
}

/** PDF points for a blank US Letter page (8.5 × 11 inches). */
export const US_LETTER_PAGE_SIZE: readonly [number, number] = [612, 792];

/**
 * GoodNotes “Standard” portrait paper size in PDF points (~6.32 × 8.17 in).
 * Matches the default notebook page GoodNotes uses for on-screen notes.
 */
export const GOODNOTES_STANDARD_PAGE_SIZE: readonly [number, number] = [455.04, 588.41];

async function appendFirstTemplatePage(pdfDocument: PDFDocument, templateBytes?: Uint8Array): Promise<void> {
  if (!templateBytes) {
    pdfDocument.addPage([...US_LETTER_PAGE_SIZE]);
    return;
  }
  const template = await PDFDocument.load(templateBytes);
  if (template.getPageCount() === 0) throw new Error("The configured PDF template has no pages.");
  const [templatePage] = await pdfDocument.copyPages(template, [0]);
  pdfDocument.addPage(templatePage);
}

/** Creates a new one-page handwritten PDF from template page one, or blank Letter paper. */
export async function createPdfFromTemplate(templateBytes?: Uint8Array): Promise<Uint8Array> {
  const pdfDocument = await PDFDocument.create();
  await appendFirstTemplatePage(pdfDocument, templateBytes);
  return pdfDocument.save();
}

/** Creates a fresh one-page blank PDF at GoodNotes Standard paper size. */
export async function createGoodNotesNotebook(): Promise<Uint8Array> {
  const pdfDocument = await PDFDocument.create();
  pdfDocument.addPage([...GOODNOTES_STANDARD_PAGE_SIZE]);
  return pdfDocument.save();
}

export interface InsertedPdfPage {
  bytes: Uint8Array;
  /** One-indexed page number of the newly inserted page. */
  pageNumber: number;
}

export interface ImportedPdfPages {
  bytes: Uint8Array;
  /** One-indexed page number of the first newly inserted page. */
  pageNumber: number;
  /** Number of imported pages, in the same order as `pageNumbers`. */
  pageCount: number;
  /** One-indexed source-PDF pages copied into the destination (document order). */
  pageNumbers: number[];
}

export interface InsertedPdfPages {
  bytes: Uint8Array;
  /** One-indexed page number of the first newly inserted page. */
  pageNumber: number;
  count: number;
}

/** Returns the page count after validating that the bytes are a readable PDF. */
export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}

/**
 * Copies selected native PDF pages into the destination after `afterPage`.
 * `pdf-lib` copies page dictionaries and content streams rather than rasterizing
 * them, so page dimensions, rotation, vector content, and page annotations stay
 * on the copied page. Document title, outlines, and the catalog AcroForm are not
 * copied. A signed or encrypted destination is refused before any save.
 *
 * Destination and source bytes are loaded independently so self-import (same
 * path or identical bytes) cannot corrupt the destination snapshot.
 */
export async function importPdfPages(
  destinationBytes: Uint8Array,
  sourceBytes: Uint8Array,
  afterPage: number,
  requestedPageNumbers: readonly number[]
): Promise<ImportedPdfPages> {
  const destination = await loadRewrittenPdf(destinationBytes);
  const source = await loadPdfBytes(sourceBytes);
  const destinationCount = destination.getPageCount();
  const sourceCount = source.getPageCount();
  if (!destinationCount) throw new Error("Cannot import pages into a PDF with no pages.");
  if (!Number.isInteger(afterPage) || afterPage < 1 || afterPage > destinationCount) {
    throw new Error(`Destination PDF page ${afterPage} does not exist.`);
  }
  const pageNumbers = [...new Set(requestedPageNumbers)].sort((left, right) => left - right);
  if (!pageNumbers.length) throw new Error("Select at least one PDF page to import.");
  for (const pageNumber of pageNumbers) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > sourceCount) {
      throw new Error(`Source PDF page ${pageNumber} does not exist.`);
    }
  }
  const copiedPages = await destination.copyPages(source, pageNumbers.map((pageNumber) => pageNumber - 1));
  const insertionIndex = afterPage;
  copiedPages.forEach((page, index) => destination.insertPage(insertionIndex + index, page));
  return {
    bytes: await destination.save(),
    pageNumber: afterPage + 1,
    pageCount: copiedPages.length,
    pageNumbers
  };
}

/** Keeps a scanned page's aspect ratio while using a practical PDF point size. */
export function scanPageSize(width: number, height: number): readonly [number, number] {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Scanned page dimensions must be positive.");
  }
  const longEdge = 792;
  const aspect = width / height;
  return aspect >= 1
    ? [longEdge, longEdge / aspect]
    : [longEdge * aspect, longEdge];
}

/** Inserts corrected camera pages as real PDF pages in capture order. */
export async function insertScannedPages(
  sourceBytes: Uint8Array,
  requestedPageNumber: number,
  scannedPages: readonly ScanDocumentPage[]
): Promise<InsertedPdfPages> {
  if (!scannedPages.length) throw new Error("Capture at least one document page.");
  const source = await loadRewrittenPdf(sourceBytes);
  const pageCount = source.getPageCount();
  if (!pageCount) throw new Error("Cannot add a page to a PDF with no pages.");
  const requested = Number.isFinite(requestedPageNumber)
    ? Math.floor(requestedPageNumber)
    : pageCount + 1;
  const pageNumber = Math.max(1, Math.min(pageCount + 1, requested));

  for (const [offset, scanned] of scannedPages.entries()) {
    const image = scanned.mimeType === "image/png"
      ? await source.embedPng(scanned.bytes)
      : await source.embedJpg(scanned.bytes);
    const [width, height] = scanPageSize(scanned.width, scanned.height);
    const page = source.insertPage(pageNumber - 1 + offset, [width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }

  return {
    bytes: await source.save(),
    pageNumber,
    count: scannedPages.length
  };
}

/** Inserts a blank page matching the preceding page (or page one at the start). */
export async function insertMatchingBlankPage(
  sourceBytes: Uint8Array,
  requestedPageNumber: number
): Promise<InsertedPdfPage> {
  const source = await loadRewrittenPdf(sourceBytes);
  const pages = source.getPages();
  if (!pages.length) throw new Error("Cannot add a page to a PDF with no pages.");
  const requested = Number.isFinite(requestedPageNumber)
    ? Math.floor(requestedPageNumber)
    : pages.length + 1;
  const pageNumber = Math.max(1, Math.min(pages.length + 1, requested));
  const reference = pages[Math.max(0, pageNumber - 2)]!;
  const addedPage = source.insertPage(pageNumber - 1, [reference.getWidth(), reference.getHeight()]);
  addedPage.setRotation(reference.getRotation());
  return { bytes: await source.save(), pageNumber };
}

/** Rewrites source PDF bytes with a blank page matching its final page. */
export async function appendMatchingBlankPage(sourceBytes: Uint8Array): Promise<Uint8Array> {
  return (await insertMatchingBlankPage(sourceBytes, Number.MAX_SAFE_INTEGER)).bytes;
}

export interface DeletedPdfPages {
  bytes: Uint8Array;
  /** Canonical, descending one-indexed source page numbers. */
  pageNumbers: number[];
  pageCountBefore: number;
  pageCountAfter: number;
}

/** Rewrites source PDF bytes with multiple selected source pages removed together. */
export async function deletePdfPages(
  sourceBytes: Uint8Array,
  requestedPageNumbers: readonly number[]
): Promise<DeletedPdfPages> {
  const source = await loadRewrittenPdf(sourceBytes);
  const count = source.getPageCount();
  const pageNumbers = [...new Set(requestedPageNumbers)].sort((left, right) => right - left);
  if (!pageNumbers.length) throw new Error("Select at least one PDF page.");
  for (const pageNumber of pageNumbers) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > count) {
      throw new Error(`PDF page ${pageNumber} does not exist.`);
    }
  }
  if (pageNumbers.length >= count) throw new Error("A PDF must keep at least one page.");
  for (const pageNumber of pageNumbers) source.removePage(pageNumber - 1);
  return {
    bytes: await source.save(),
    pageNumbers,
    pageCountBefore: count,
    pageCountAfter: count - pageNumbers.length
  };
}

/** Rewrites source PDF bytes with one selected page permanently removed. */
export async function deletePdfPage(sourceBytes: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  return (await deletePdfPages(sourceBytes, [pageNumber])).bytes;
}
