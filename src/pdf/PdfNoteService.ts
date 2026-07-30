import { PDFDocument } from "pdf-lib";

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

/** Inserts a blank page matching the preceding page (or page one at the start). */
export async function insertMatchingBlankPage(
  sourceBytes: Uint8Array,
  requestedPageNumber: number
): Promise<InsertedPdfPage> {
  const source = await PDFDocument.load(sourceBytes);
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

/** Rewrites source PDF bytes with one selected page permanently removed. */
export async function deletePdfPage(sourceBytes: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(sourceBytes);
  const count = source.getPageCount();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > count) {
    throw new Error(`PDF page ${pageNumber} does not exist.`);
  }
  if (count <= 1) throw new Error("A PDF must keep at least one page.");
  source.removePage(pageNumber - 1);
  return source.save();
}
