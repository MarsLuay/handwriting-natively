import type { InkStroke } from "../model";
import type { Bounds } from "./StrokeHitTesting";

interface IndexedStroke {
  stroke: InkStroke;
  bounds: Bounds;
  cells: string[];
  order: number;
}

/**
 * Small uniform-grid index for one PDF page's strokes. The sidecar remains
 * canonical; this is rebuilt in memory as strokes are added/replaced.
 */
export class StrokeSpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, IndexedStroke>();
  private nextOrder = 0;

  constructor(private readonly cellSize = 128) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("Spatial-index cell size must be positive");
  }

  add(stroke: InkStroke): void {
    this.remove(stroke.id);
    const bounds = boundsForStroke(stroke);
    if (!bounds) return;
    const cells = this.cellsFor(bounds);
    this.entries.set(stroke.id, { stroke, bounds, cells, order: this.nextOrder++ });
    for (const cell of cells) {
      const ids = this.cells.get(cell) ?? new Set<string>();
      ids.add(stroke.id);
      this.cells.set(cell, ids);
    }
  }

  remove(id: string): InkStroke | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    for (const cell of entry.cells) {
      const ids = this.cells.get(cell);
      if (!ids) continue;
      ids.delete(id);
      if (ids.size === 0) this.cells.delete(cell);
    }
    return entry.stroke;
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.nextOrder = 0;
  }

  /** Returns only strokes whose paint bounds intersect `bounds`, in draw order. */
  query(bounds: Bounds): InkStroke[] {
    if (!isFiniteBounds(bounds)) return [];
    const ids = new Set<string>();
    for (const cell of this.cellsFor(bounds)) {
      const cellIds = this.cells.get(cell);
      if (cellIds) {
        for (const id of cellIds) ids.add(id);
      }
    }
    const result: IndexedStroke[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry && intersects(entry.bounds, bounds)) {
        result.push(entry);
      }
    }
    result.sort((left, right) => left.order - right.order);
    const mappedResult = new Array(result.length);
    for (let i = 0, len = result.length; i < len; i++) {
        mappedResult[i] = result[i].stroke;
    }
    return mappedResult;
  }

  private cellsFor(bounds: Bounds): string[] {
    const minX = Math.floor(bounds.minX / this.cellSize);
    const maxX = Math.floor(bounds.maxX / this.cellSize);
    const minY = Math.floor(bounds.minY / this.cellSize);
    const maxY = Math.floor(bounds.maxY / this.cellSize);
    const cells: string[] = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) cells.push(`${x}:${y}`);
    }
    return cells;
  }
}

function boundsForStroke(stroke: InkStroke): Bounds | null {
  if (!stroke.points.length) return null;
  const half = Number.isFinite(stroke.width) && stroke.width > 0 ? stroke.width / 2 : 0.5;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x - half);
    minY = Math.min(minY, point.y - half);
    maxX = Math.max(maxX, point.x + half);
    maxY = Math.max(maxY, point.y + half);
  }
  return Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
    ? { minX, minY, maxX, maxY }
    : null;
}

function isFiniteBounds(bounds: Bounds): boolean {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    && bounds.minX <= bounds.maxX
    && bounds.minY <= bounds.maxY;
}

function intersects(left: Bounds, right: Bounds): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX
    && left.minY <= right.maxY && left.maxY >= right.minY;
}
