import type { InkStroke, TextAnnotation } from "../model";

export class StrokeClipboard {
  private static data: { strokes: InkStroke[]; texts: TextAnnotation[]; sourcePage: number } | null = null;

  static store(strokes: readonly InkStroke[], sourcePage: number, texts: readonly TextAnnotation[] = []): void {
    this.data = {
      strokes: strokes.map((stroke) => structuredClone(stroke)),
      texts: texts.map((text) => structuredClone(text)),
      sourcePage
    };
  }

  static peek(): { strokes: InkStroke[]; texts: TextAnnotation[]; sourcePage: number } | null {
    return this.data;
  }

  static clear(): void {
    this.data = null;
  }
}
