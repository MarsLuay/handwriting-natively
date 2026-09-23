import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  deletePdfPages,
  insertMatchingBlankPage
} from "../src/pdf/PdfNoteService";

async function createSourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  pdf.addPage([500, 700]);
  return pdf.save();
}

describe("PDF page actions", () => {
  it("inserts a matching page at the requested thumbnail position", async () => {
    const source = await createSourcePdf();
    const inserted = await insertMatchingBlankPage(source, 2);
    const result = await PDFDocument.load(inserted.bytes);

    expect(inserted.pageNumber).toBe(2);
    expect(result.getPageCount()).toBe(3);
    expect(result.getPage(1).getWidth()).toBe(400);
    expect(result.getPage(1).getHeight()).toBe(600);
  });

  it("deletes a single page and preserves the remaining page order", async () => {
    const source = await createSourcePdf();
    const deleted = await deletePdfPages(source, [1]);
    const result = await PDFDocument.load(deleted.bytes);

    expect(deleted.pageNumbers).toEqual([1]);
    expect(deleted.pageCountBefore).toBe(2);
    expect(deleted.pageCountAfter).toBe(1);
    expect(result.getPageCount()).toBe(1);
    expect(result.getPage(0).getWidth()).toBe(500);
  });

  it("keeps pure derived page transforms separate from the source bytes", async () => {
    const source = await createSourcePdf();
    const original = source.slice();

    await insertMatchingBlankPage(source, 2);
    await deletePdfPages(source, [2]);

    expect(source).toEqual(original);
    expect((await PDFDocument.load(source)).getPageCount()).toBe(2);
  });
});
