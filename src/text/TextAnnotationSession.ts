import type { TextAnnotation } from "../model";

/** In-memory index for sidecar-backed text annotations. */
export class TextAnnotationSession {
  private readonly byPage = new Map<number, TextAnnotation[]>();

  constructor(initial: readonly TextAnnotation[] = []) {
    initial.forEach((annotation) => this.add(annotation));
  }

  add(annotation: TextAnnotation): void {
    this.byPage.set(annotation.page, [...(this.byPage.get(annotation.page) ?? []), annotation]);
  }

  remove(id: string): TextAnnotation | undefined {
    for (const [page, annotations] of this.byPage) {
      const index = annotations.findIndex((annotation) => annotation.id === id);
      if (index < 0) continue;
      const [removed] = annotations.splice(index, 1);
      this.byPage.set(page, annotations);
      return removed;
    }
    return undefined;
  }

  replace(annotation: TextAnnotation): void {
    this.remove(annotation.id);
    this.add(annotation);
  }

  page(page: number): readonly TextAnnotation[] {
    return this.byPage.get(page) ?? [];
  }

  all(): TextAnnotation[] {
    return [...this.byPage.values()].flat();
  }

  clear(): void { this.byPage.clear(); }
}
