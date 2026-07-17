import type { PdfTextAnnotation } from "../model";

/** In-memory index for sidecar-backed text annotations. */
export class TextAnnotationSession {
  private readonly byPage = new Map<number, PdfTextAnnotation[]>();

  constructor(initial: readonly PdfTextAnnotation[] = []) {
    initial.forEach((annotation) => this.add(annotation));
  }

  add(annotation: PdfTextAnnotation): void {
    this.byPage.set(annotation.page, [...(this.byPage.get(annotation.page) ?? []), annotation]);
  }

  remove(id: string): PdfTextAnnotation | undefined {
    for (const [page, annotations] of this.byPage) {
      const index = annotations.findIndex((annotation) => annotation.id === id);
      if (index < 0) continue;
      const [removed] = annotations.splice(index, 1);
      this.byPage.set(page, annotations);
      return removed;
    }
    return undefined;
  }

  replace(annotation: PdfTextAnnotation): void {
    this.remove(annotation.id);
    this.add(annotation);
  }

  page(page: number): readonly PdfTextAnnotation[] {
    return this.byPage.get(page) ?? [];
  }

  all(): PdfTextAnnotation[] {
    return [...this.byPage.values()].flat();
  }
}
