import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  createUnsupportedPdfPageMutationCallbacks,
  deletePdfPages,
  insertMatchingBlankPage,
  PdfPageMutationUnsupportedError
} from "../src/pdf/PdfNoteService";

async function createSourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  pdf.addPage([500, 700]);
  return pdf.save();
}

describe("PDF page actions", () => {
  it("rejects source-PDF insertion without an attempted write", async () => {
    const callbacks = createUnsupportedPdfPageMutationCallbacks();

    await expect(callbacks.onInsertPage(2)).rejects.toMatchObject({
      name: "PdfPageMutationUnsupportedError",
      code: "source-pdf-page-mutation-unsupported",
      action: "insert"
    });
    await expect(callbacks.onInsertPage(2)).rejects.toBeInstanceOf(PdfPageMutationUnsupportedError);
    await expect(callbacks.onInsertPage(2)).rejects.toThrow("original PDFs are read-only");
  });

  it("rejects single and range source-PDF deletion explicitly", async () => {
    const callbacks = createUnsupportedPdfPageMutationCallbacks();

    await expect(callbacks.onDeletePage(1)).rejects.toMatchObject({
      code: "source-pdf-page-mutation-unsupported",
      action: "delete"
    });
    await expect(callbacks.onDeletePages([2, 1])).rejects.toMatchObject({
      code: "source-pdf-page-mutation-unsupported",
      action: "delete"
    });
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
