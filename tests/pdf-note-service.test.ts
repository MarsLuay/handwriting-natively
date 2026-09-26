import { PDFDocument, PDFHexString, PDFName, degrees, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  appendMatchingBlankPage,
  createGoodNotesNotebook,
  createPdfFromTemplate,
  deletePdfPage,
  deletePdfPages,
  getPdfPageCount,
  GOODNOTES_STANDARD_PAGE_SIZE,
  importPdfPages,
  insertMatchingBlankPage,
  insertScannedPages,
  scanPageSize,
  ENCRYPTED_PDF_MUTATION_ERROR,
  SIGNED_PDF_MUTATION_ERROR,
  US_LETTER_PAGE_SIZE
} from "../src/pdf/PdfNoteService";

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));

async function createPdf(pageSizes: readonly (readonly [number, number])[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const pageSize of pageSizes) pdf.addPage([...pageSize]);
  return pdf.save();
}

async function sizes(bytes: Uint8Array): Promise<{ width: number; height: number }[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => page.getSize());
}

describe("PDF note service", () => {
  it("rewrites all source pages plus a blank page matching the previous page", async () => {
    const source = await createPdf([[400, 600], [500, 700]]);

    const result = await appendMatchingBlankPage(source);

    expect(await sizes(result)).toEqual([
      { width: 400, height: 600 },
      { width: 500, height: 700 },
      { width: 500, height: 700 }
    ]);
    expect(await sizes(source)).toEqual([
      { width: 400, height: 600 },
      { width: 500, height: 700 }
    ]);
  });

  it("uses blank Letter paper when creating a new PDF", async () => {
    const created = await createPdfFromTemplate();

    expect(await sizes(created)).toEqual([{ width: US_LETTER_PAGE_SIZE[0], height: US_LETTER_PAGE_SIZE[1] }]);
  });

  it("creates a blank GoodNotes Standard notebook page", async () => {
    const created = await createGoodNotesNotebook();

    expect(await sizes(created)).toEqual([
      { width: GOODNOTES_STANDARD_PAGE_SIZE[0], height: GOODNOTES_STANDARD_PAGE_SIZE[1] }
    ]);
  });

  it("carries the previous page rotation onto the added page", async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 600]);
    const previous = source.addPage([500, 700]);
    previous.setRotation(degrees(90));

    const result = await PDFDocument.load(await appendMatchingBlankPage(await source.save()));
    const added = result.getPages().at(-1)!;

    expect(added.getSize()).toEqual({ width: 500, height: 700 });
    expect(added.getRotation().angle).toBe(90);
  });

  it("inserts between pages using the preceding page size", async () => {
    const source = await createPdf([[400, 600], [500, 700], [600, 800]]);

    const result = await insertMatchingBlankPage(source, 3);

    expect(result.pageNumber).toBe(3);
    expect(await sizes(result.bytes)).toEqual([
      { width: 400, height: 600 },
      { width: 500, height: 700 },
      { width: 500, height: 700 },
      { width: 600, height: 800 }
    ]);
  });

  it("appends for a non-finite requested insertion position", async () => {
    const source = await createPdf([[400, 600]]);
    const result = await insertMatchingBlankPage(source, Number.POSITIVE_INFINITY);

    expect(result.pageNumber).toBe(2);
    expect(await sizes(result.bytes)).toHaveLength(2);
  });

  it("deletes exactly one non-final PDF page", async () => {
    const source = await createPdf([[400, 600], [500, 700], [600, 800]]);

    const result = await deletePdfPage(source, 2);

    expect(await sizes(result)).toEqual([{ width: 400, height: 600 }, { width: 600, height: 800 }]);
    expect(await sizes(source)).toHaveLength(3);
    await expect(deletePdfPage(source, 4)).rejects.toThrow("does not exist");
    await expect(deletePdfPage(await createPdf([[400, 600]]), 1)).rejects.toThrow("at least one page");
  });

  it("deletes a unique set of original pages together and keeps one page", async () => {
    const source = await createPdf([[100, 200], [200, 300], [300, 400], [400, 500], [500, 600]]);

    const result = await deletePdfPages(source, [4, 2, 4]);

    expect(result.pageNumbers).toEqual([4, 2]);
    expect(result.pageCountBefore).toBe(5);
    expect(result.pageCountAfter).toBe(3);
    expect(await sizes(result.bytes)).toEqual([
      { width: 100, height: 200 },
      { width: 300, height: 400 },
      { width: 500, height: 600 }
    ]);
    await expect(deletePdfPages(source, [])).rejects.toThrow("Select at least one");
    await expect(deletePdfPages(source, [1, 2, 3, 4, 5])).rejects.toThrow("at least one page");
    expect(await sizes(source)).toHaveLength(5);
  });

  it("imports selected native pages in sorted deterministic order after the current page", async () => {
    const destination = await createPdf([[400, 600], [800, 900]]);
    const sourceDocument = await PDFDocument.create();
    const first = sourceDocument.addPage([300, 500]);
    first.setRotation(degrees(90));
    first.drawRectangle({ x: 20, y: 30, width: 80, height: 60, color: rgb(1, 0, 0) });
    const second = sourceDocument.addPage([700, 200]);
    second.setRotation(degrees(270));
    second.drawRectangle({ x: 10, y: 20, width: 40, height: 30, color: rgb(0, 0, 1) });
    const source = await sourceDocument.save();

    const result = await importPdfPages(destination, source, 1, [2, 1, 2]);
    expect(result.pageNumber).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.pageNumbers).toEqual([1, 2]);
    const imported = await PDFDocument.load(result.bytes);
    expect(imported.getPageCount()).toBe(4);
    expect(imported.getPages().map((page) => page.getSize())).toEqual([
      { width: 400, height: 600 },
      { width: 300, height: 500 },
      { width: 700, height: 200 },
      { width: 800, height: 900 }
    ]);
    expect(imported.getPage(1).getRotation().angle).toBe(90);
    expect(imported.getPage(2).getRotation().angle).toBe(270);
    expect(imported.getPage(1).node.Contents()).toBeDefined();
    expect(await getPdfPageCount(source)).toBe(2);
    expect(await getPdfPageCount(destination)).toBe(2);
  });

  it("imports all source pages and rejects invalid or encrypted sources before mutation", async () => {
    const destination = await createPdf([[400, 600]]);
    const source = await createPdf([[500, 700], [600, 800], [700, 900]]);
    const result = await importPdfPages(destination, source, 1, [1, 2, 3]);
    expect(result.pageNumbers).toEqual([1, 2, 3]);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(4);
    await expect(importPdfPages(destination, new Uint8Array([1, 2, 3]), 1, [1])).rejects.toThrow();

    const encryptedMarker = new TextDecoder().decode(source).replace(
      "/Root",
      "/Encrypt 1 0 R\n/Root"
    );
    await expect(importPdfPages(destination, new TextEncoder().encode(encryptedMarker), 1, [1]))
      .rejects.toThrow(ENCRYPTED_PDF_MUTATION_ERROR);
    expect(await getPdfPageCount(destination)).toBe(1);
  });

  it("self-imports from identical bytes without corrupting destination page order", async () => {
    const destination = await createPdf([[400, 600], [500, 700], [600, 800]]);
    const result = await importPdfPages(destination, destination, 2, [1, 3]);
    expect(result.pageNumber).toBe(3);
    expect(result.pageCount).toBe(2);
    const imported = await PDFDocument.load(result.bytes);
    expect(imported.getPageCount()).toBe(5);
    expect(imported.getPages().map((page) => page.getSize())).toEqual([
      { width: 400, height: 600 },
      { width: 500, height: 700 },
      { width: 400, height: 600 },
      { width: 600, height: 800 },
      { width: 600, height: 800 }
    ]);
    expect(await getPdfPageCount(destination)).toBe(3);
  });

  it("inserts corrected scan images in capture order with aspect-ratio page sizes", async () => {
    const source = await createPdf([[400, 600], [500, 700]]);
    const result = await insertScannedPages(source, 2, [
      { bytes: ONE_PIXEL_PNG, mimeType: "image/png", width: 100, height: 200 },
      { bytes: ONE_PIXEL_PNG, mimeType: "image/png", width: 300, height: 100 }
    ]);

    expect(result.pageNumber).toBe(2);
    expect(result.count).toBe(2);
    expect(await sizes(result.bytes)).toEqual([
      { width: 400, height: 600 },
      { width: 396, height: 792 },
      { width: 792, height: 264 },
      { width: 500, height: 700 }
    ]);
    expect(await sizes(source)).toHaveLength(2);
    expect(scanPageSize(100, 200)).toEqual([396, 792]);
    expect(scanPageSize(300, 100)).toEqual([792, 264]);
  });

  it("rejects an empty scan batch", async () => {
    await expect(insertScannedPages(await createPdf([[400, 600]]), 2, [])).rejects.toThrow("at least one");
  });

  it("keeps an inserted blank page from stealing the previous page's annotations", async () => {
    const source = await PDFDocument.create();
    source.setTitle("Keep me");
    const page = source.addPage([400, 600]);
    page.setRotation(degrees(90));
    const link = source.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 10, 10],
      A: { S: "URI", URI: "https://example.test/kept" }
    });
    page.node.set(PDFName.of("Annots"), source.context.obj([link]));
    const outline = source.context.obj({
      Type: "Outlines",
      Count: 1,
      First: source.context.obj({ Title: "Chapter", Dest: [page.ref, "Fit"] })
    });
    source.catalog.set(PDFName.of("Outlines"), outline);

    const inserted = await insertMatchingBlankPage(await source.save(), 1);
    const reloaded = await PDFDocument.load(inserted.bytes);
    const moved = reloaded.getPage(1);
    const outlines = reloaded.catalog.lookup(PDFName.of("Outlines")) as {
      lookup(name: ReturnType<typeof PDFName.of>): {
        lookup(name: ReturnType<typeof PDFName.of>): { get(index: number): { toString(): string } };
      };
    } | undefined;
    const dest = outlines?.lookup(PDFName.of("First")).lookup(PDFName.of("Dest"));

    expect(inserted.pageNumber).toBe(1);
    expect(reloaded.getTitle()).toBe("Keep me");
    expect(reloaded.getPage(0).node.Annots()).toBeUndefined();
    expect(moved.getRotation().angle).toBe(90);
    expect(moved.node.Annots()?.get(0)).toBeDefined();
    expect(dest?.get(0).toString()).toBe(moved.ref.toString());
  });

  it("copies imported page geometry and annotations without document outlines", async () => {
    const destination = await createPdf([[200, 300]]);
    const source = await PDFDocument.create();
    source.setTitle("Source title");
    const page = source.addPage([400, 600]);
    page.setRotation(degrees(90));
    const link = source.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 10, 10],
      A: { S: "URI", URI: "https://example.test/kept" }
    });
    page.node.set(PDFName.of("Annots"), source.context.obj([link]));
    source.catalog.set(PDFName.of("Outlines"), source.context.obj({ Type: "Outlines", Count: 0 }));

    const imported = await importPdfPages(destination, await source.save(), 1, [1]);
    const reloaded = await PDFDocument.load(imported.bytes);
    const copied = reloaded.getPage(1);

    expect(copied.getSize()).toEqual({ width: 400, height: 600 });
    expect(copied.getRotation().angle).toBe(90);
    expect(copied.node.Annots()?.get(0)).toBeDefined();
    expect(reloaded.getTitle()).toBeUndefined();
    expect(reloaded.catalog.get(PDFName.of("Outlines"))).toBeUndefined();
  });

  it("refuses to rewrite a signed PDF and still copies pages from a signed source", async () => {
    const signed = await PDFDocument.create();
    signed.addPage([400, 600]);
    const signature = signed.context.register(signed.context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 10, 20, 30],
      Contents: PDFHexString.of("00")
    }));
    signed.catalog.set(PDFName.of("Perms"), signed.context.obj({ DocMDP: signature }));
    const signedBytes = await signed.save();
    const plain = await createPdf([[200, 300]]);

    await expect(insertMatchingBlankPage(signedBytes, 2)).rejects.toThrow(SIGNED_PDF_MUTATION_ERROR);
    await expect(deletePdfPage(signedBytes, 1)).rejects.toThrow(SIGNED_PDF_MUTATION_ERROR);
    await expect(insertScannedPages(signedBytes, 2, [{
      bytes: ONE_PIXEL_PNG,
      mimeType: "image/png",
      width: 100,
      height: 100
    }])).rejects.toThrow(SIGNED_PDF_MUTATION_ERROR);
    await expect(importPdfPages(signedBytes, plain, 1, [1])).rejects.toThrow(SIGNED_PDF_MUTATION_ERROR);
    expect(await getPdfPageCount(signedBytes)).toBe(1);

    const copied = await importPdfPages(plain, signedBytes, 1, [1]);
    expect((await PDFDocument.load(copied.bytes)).getPageCount()).toBe(2);
    expect(await getPdfPageCount(signedBytes)).toBe(1);
  });
});
