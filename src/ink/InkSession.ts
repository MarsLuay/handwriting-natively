import type { InkStroke } from "../model";
import type { Bounds } from "./StrokeHitTesting";
import { StrokeSpatialIndex } from "./StrokeSpatialIndex";

export type InkLifecyclePhase = "stroke-model-insert" | "stroke-model-remove";

export interface InkLifecycleEvent {
  phase: InkLifecyclePhase;
  stroke: InkStroke;
  reason?: string;
  strokeCountBefore: number;
  strokeCountAfter: number;
  modelPresent: boolean;
}

export type InkLifecycleListener = (event: InkLifecycleEvent) => void;

export class InkSession {
  private readonly byPage = new Map<number, InkStroke[]>();
  private readonly indexByPage = new Map<number, StrokeSpatialIndex>();
  private strokeCount = 0;

  constructor(initial: readonly InkStroke[] = [], private readonly onLifecycle?: InkLifecycleListener) {
    initial.forEach((stroke) => this.add(stroke));
  }

  add(stroke: InkStroke): void {
    const strokeCountBefore = this.strokeCount;
    this.byPage.set(stroke.page, [...(this.byPage.get(stroke.page) ?? []), stroke]);
    this.index(stroke.page).add(stroke);
    this.strokeCount += 1;
    this.onLifecycle?.({
      phase: "stroke-model-insert",
      stroke,
      strokeCountBefore,
      strokeCountAfter: this.strokeCount,
      modelPresent: true
    });
  }

  remove(id: string, reason = "unspecified"): InkStroke | undefined {
    for (const [page, strokes] of this.byPage) {
      const index = strokes.findIndex((stroke) => stroke.id === id);
      if (index >= 0) {
        const [removed] = strokes.splice(index, 1);
        const strokeCountBefore = this.strokeCount;
        this.byPage.set(page, strokes);
        this.index(page).remove(id);
        this.strokeCount -= 1;
        if (removed) {
          this.onLifecycle?.({
            phase: "stroke-model-remove",
            stroke: removed,
            reason,
            strokeCountBefore,
            strokeCountAfter: this.strokeCount,
            modelPresent: false
          });
        }
        return removed;
      }
    }
    return undefined;
  }

  replace(stroke: InkStroke, reason = "replace"): void {
    this.remove(stroke.id, reason);
    this.add(stroke);
  }

  replacePage(page: number, strokes: readonly InkStroke[], reason = "replace-page"): void {
    const previous = this.byPage.get(page) ?? [];
    const previousIds = new Set(previous.map((stroke) => stroke.id));
    const next = [...strokes];
    const nextIds = new Set(next.map((stroke) => stroke.id));
    const strokeCountBefore = this.strokeCount;
    this.byPage.set(page, next);
    const index = this.index(page);
    index.clear();
    for (const stroke of next) index.add(stroke);
    this.strokeCount += next.length - previous.length;
    for (const stroke of previous) {
      if (!nextIds.has(stroke.id)) {
        this.onLifecycle?.({
          phase: "stroke-model-remove",
          stroke,
          reason,
          strokeCountBefore,
          strokeCountAfter: this.strokeCount,
          modelPresent: false
        });
      }
    }
    for (const stroke of next) {
      if (!previousIds.has(stroke.id)) {
        this.onLifecycle?.({
          phase: "stroke-model-insert",
          stroke,
          strokeCountBefore,
          strokeCountAfter: this.strokeCount,
          modelPresent: true
        });
      }
    }
  }

  page(page: number): readonly InkStroke[] { return this.byPage.get(page) ?? []; }
  /** Paint/hit-test candidates in a page-local PDF-space rectangle. */
  pageIntersecting(page: number, bounds: Bounds): readonly InkStroke[] {
    return this.indexByPage.get(page)?.query(bounds) ?? [];
  }
  all(): InkStroke[] {
    const allStrokes: InkStroke[] = [];
    for (const strokes of this.byPage.values()) {
      allStrokes.push(...strokes);
    }
    return allStrokes;
  }

  clear(reason = "clear"): void {
    const previous = this.all();
    const strokeCountBefore = this.strokeCount;
    this.byPage.clear();
    this.indexByPage.clear();
    this.strokeCount = 0;
    for (const stroke of previous) {
      this.onLifecycle?.({
        phase: "stroke-model-remove",
        stroke,
        reason,
        strokeCountBefore,
        strokeCountAfter: 0,
        modelPresent: false
      });
    }
  }

  private index(page: number): StrokeSpatialIndex {
    let index = this.indexByPage.get(page);
    if (!index) {
      index = new StrokeSpatialIndex();
      this.indexByPage.set(page, index);
    }
    return index;
  }
}
