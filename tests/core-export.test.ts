import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../src/model";
import {
  annotatedFilename,
  editableAnnotatedFilename,
  mapInkPointToPdfPage,
  mapInkWidthToPdfPage,
  PdfExportService
} from "../src/pdf/PdfExportService";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#ff0000", width: 3, opacity: 0.8, inputType: "pen", points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }, { x: 50, y: 50, pressure: 1, time: 1 }], createdAt: "now", updatedAt: "now" };

async function sourcePdf(width = 100, height = 100): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, height]);
  return pdf.save();
}

describe("PDF export", () => {
  it("generates _export filenames beside the source name", () => {
    expect(annotatedFilename("paper.pdf")).toBe("paper_export.pdf");
    expect(annotatedFilename("PAPER.PDF")).toBe("PAPER_export.pdf");
    expect(editableAnnotatedFilename("paper.pdf")).toBe("paper_editable.pdf");
  });

  it("scales ink page-space into PDF MediaBox points (CSS 96dpi vs PDF 72dpi)", () => {
    const ink = { width: 816, height: 1056 };
    const pdf = { width: 612, height: 792 };
    expect(mapInkPointToPdfPage({ x: 816, y: 1056 }, ink, pdf)).toEqual({ x: 612, y: 792 });
    expect(mapInkPointToPdfPage({ x: 408, y: 528 }, ink, pdf)).toEqual({ x: 306, y: 396 });
    expect(mapInkWidthToPdfPage(3, ink, pdf)).toBeCloseTo(2.25, 5);
  });

  it("uses latest in-memory strokes after flush and leaves source bytes unchanged", async () => {
    const source = await sourcePdf(); const original = source.slice(); let latest: InkStroke[] = [];
    const flush = vi.fn(async () => { latest = [stroke]; });
    const output = await new PdfExportService().export({ sourceBytes: source, getStrokes: () => latest, flush });
    expect(flush).toHaveBeenCalledOnce();
    expect(source).toEqual(original); expect(output).not.toEqual(source);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
  });

  it("exports when sidecar metrics differ from MediaBox without throwing", async () => {
    const source = await sourcePdf(612, 792);
    const letterStroke: InkStroke = {
      ...stroke,
      points: [
        { x: 87.3, y: 715.9, pressure: 0.5, time: 0 },
        { x: 161.6, y: 717.4, pressure: 0.5, time: 1 }
      ]
    };
    const output = await new PdfExportService().export({
      sourceBytes: source,
      strokes: [letterStroke],
      pageMetrics: [{ page: 1, width: 816, height: 1055.3 }]
    });
    expect((await PDFDocument.load(output)).getPages()[0]!.getSize()).toEqual({ width: 612, height: 792 });
  });

  it("re-exports from the same source without stacking prior export ink", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const source = await pdf.save();
    const exporter = new PdfExportService();
    const first = await exporter.export({ sourceBytes: source, strokes: [stroke] });
    const second = await exporter.export({ sourceBytes: source, strokes: [stroke] });
    expect(first.byteLength).toBe(second.byteLength);
  });

  it("exports editable Ink and FreeText annotations with self-rendering appearances", async () => {
    const source = await sourcePdf(); const original = source.slice();
    const output = await new PdfExportService().export({
      sourceBytes: source,
      strokes: [stroke],
      texts: [{
        id: "text", page: 1, text: "Editable note", x: 10, y: 90, width: 70, height: 16,
        color: "#111827", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
        runs: [{ text: "Editable note", color: "#111827", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
        sourceRuns: [{ text: "Editable note", color: "#111827", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
        createdAt: "now", updatedAt: "now"
      }],
      mode: "editable"
    });
    const page = (await PDFDocument.load(output)).getPages()[0]!;
    const annotations = page.node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annotations.size()).toBe(2);
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookup(index, PDFDict);
      expect(annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))).toBeDefined();
    }
    expect(annotations.lookup(1, PDFDict).lookup(PDFName.of("RC"), PDFHexString).decodeText()).toContain("Editable note");
    expect(source).toEqual(original);
  });

  it("preserves rich run styling and renders Unicode text in flattened and editable exports", async () => {
    const canvasContext = {
      font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
      measureText: vi.fn((text: string) => ({ width: text.length * 12 })),
      fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1rQAAAABJRU5ErkJggg=="
    );
    const text = {
      id: "unicode", page: 1, text: "Bold 한글", x: 10, y: 90, width: 90, height: 24,
      color: "#111827", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [
        { text: "Bold ", color: "#dc2626", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true },
        { text: "한글", color: "#111827", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }
      ],
      sourceRuns: [], createdAt: "now", updatedAt: "now"
    };
    const exporter = new PdfExportService();
    const flattened = await exporter.export({ sourceBytes: await sourcePdf(), texts: [text] });
    const editable = await exporter.export({ sourceBytes: await sourcePdf(), texts: [text], mode: "editable" });

    expect(await PDFDocument.load(flattened)).toBeDefined();
    const annotation = (await PDFDocument.load(editable)).getPages()[0]!
      .node.lookup(PDFName.of("Annots"), PDFArray).lookup(0, PDFDict);
    expect((annotation.lookup(PDFName.of("Contents")) as PDFHexString).decodeText()).toBe("Bold 한글");
    expect(annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))).toBeDefined();
    expect(canvasContext.fillText).toHaveBeenCalled();
  });
});
