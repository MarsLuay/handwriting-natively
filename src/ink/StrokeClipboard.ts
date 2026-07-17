import type { InkStroke, PdfTextAnnotation } from "../model";

export class StrokeClipboard {
  private static data: { strokes: InkStroke[]; texts: PdfTextAnnotation[]; sourcePage: number } | null = null;

  static store(strokes: readonly InkStroke[], sourcePage: number, texts: readonly PdfTextAnnotation[] = []): void {
    this.data = {
      strokes: strokes.map((stroke) => structuredClone(stroke)),
      texts: texts.map((text) => structuredClone(text)),
      sourcePage
    };
  }

  static peek(): { strokes: InkStroke[]; texts: PdfTextAnnotation[]; sourcePage: number } | null {
    return this.data;
  }

  static clear(): void {
    this.data = null;
  }
}
