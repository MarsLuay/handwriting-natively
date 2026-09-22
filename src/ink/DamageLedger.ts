import type { Bounds } from "./StrokeHitTesting";

/**
 * Small, merge-on-write damage ledger for transient ink rendering.
 *
 * The ledger is deliberately renderer-agnostic: it records the PDF/view
 * rectangles that must be repainted after a wet preview ends, while the
 * canonical InkSession remains the only source of persisted strokes.
 */
export class DamageLedger {
  private readonly rects: Bounds[] = [];

  add(bounds: Bounds): void {
    if (!isFiniteBounds(bounds)) return;
    let merged = { ...bounds };
    for (let index = this.rects.length - 1; index >= 0; index -= 1) {
      const existing = this.rects[index]!;
      if (!overlapsOrTouches(existing, merged)) continue;
      merged = union(existing, merged);
      this.rects.splice(index, 1);
    }
    this.rects.push(merged);
  }

  clear(): void {
    this.rects.length = 0;
  }

  get size(): number {
    return this.rects.length;
  }

  totalArea(): number {
    return this.rects.reduce((area, rect) => area + (rect.maxX - rect.minX) * (rect.maxY - rect.minY), 0);
  }

  drain(): Bounds[] {
    const result = this.rects.map((rect) => ({ ...rect }));
    this.clear();
    return result;
  }
}

function isFiniteBounds(bounds: Bounds): boolean {
  return Number.isFinite(bounds.minX)
    && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.maxY)
    && bounds.minX <= bounds.maxX
    && bounds.minY <= bounds.maxY;
}

function overlapsOrTouches(left: Bounds, right: Bounds): boolean {
  return left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minY <= right.maxY
    && left.maxY >= right.minY;
}

function union(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY)
  };
}
