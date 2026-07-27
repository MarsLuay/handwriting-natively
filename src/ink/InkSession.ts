import type { InkStroke } from "../model";
import type { Bounds } from "./StrokeHitTesting";
import { StrokeSpatialIndex } from "./StrokeSpatialIndex";

export class InkSession {
  private readonly byPage = new Map<number, InkStroke[]>();
  private readonly indexByPage = new Map<number, StrokeSpatialIndex>();
  constructor(initial: readonly InkStroke[] = []) { initial.forEach((stroke) => this.add(stroke)); }

  add(stroke: InkStroke): void {
    this.byPage.set(stroke.page, [...(this.byPage.get(stroke.page) ?? []), stroke]);
    this.index(stroke.page).add(stroke);
  }
  remove(id: string): InkStroke | undefined {
    for (const [page, strokes] of this.byPage) {
      const index = strokes.findIndex((stroke) => stroke.id === id);
      if (index >= 0) {
        const [removed] = strokes.splice(index, 1);
        this.byPage.set(page, strokes);
        this.index(page).remove(id);
        return removed;
      }
    }
    return undefined;
  }
  replace(stroke: InkStroke): void { this.remove(stroke.id); this.add(stroke); }
  replacePage(page: number, strokes: readonly InkStroke[]): void {
    this.byPage.set(page, [...strokes]);
    const index = this.index(page);
    index.clear();
    for (const stroke of strokes) index.add(stroke);
  }
  page(page: number): readonly InkStroke[] { return this.byPage.get(page) ?? []; }
  /** Paint/hit-test candidates in a page-local PDF-space rectangle. */
  pageIntersecting(page: number, bounds: Bounds): readonly InkStroke[] {
    return this.indexByPage.get(page)?.query(bounds) ?? [];
  }
  all(): InkStroke[] { return [...this.byPage.values()].flat(); }
  clear(): void { this.byPage.clear(); this.indexByPage.clear(); }

  private index(page: number): StrokeSpatialIndex {
    let index = this.indexByPage.get(page);
    if (!index) {
      index = new StrokeSpatialIndex();
      this.indexByPage.set(page, index);
    }
    return index;
  }
}
