import type { InkStroke, PagePoint } from "../model";
import { clamp01 } from "../util/math";

type Point = Pick<PagePoint, "x" | "y">;
type Interval = readonly [start: number, end: number];
interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

export interface SegmentEraserOptions {
  /** Viewport pixels per PDF unit when `size` is expressed in viewport pixels. */
  scale?: number;
  now?: () => string;
  createFragmentId?: (stroke: InkStroke, fragmentIndex: number) => string;
  /** Spatial-index candidates. Non-candidates are kept without geometric work. */
  candidateIds?: ReadonlySet<string>;
}

export interface SegmentEraseResult {
  /** Complete post-erase stroke set, including untouched strokes and fragments. */
  kept: InkStroke[];
  /** Original strokes changed or fully removed by the erase operation. */
  erased: InkStroke[];
  /** Replacement fragments produced from changed strokes. */
  fragments: InkStroke[];
}

const EPSILON = 1e-9;

function intersect(a: Interval | null, b: Interval | null): Interval | null {
  if (!a || !b) return null;
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return end + EPSILON >= start ? [clamp01(start), clamp01(end)] : null;
}

/** Values of t in [0,1] for which min <= origin + delta*t <= max. */
function linearInterval(origin: number, delta: number, min: number, max: number): Interval | null {
  if (Math.abs(delta) <= EPSILON) return origin >= min - EPSILON && origin <= max + EPSILON ? [0, 1] : null;
  const first = (min - origin) / delta;
  const second = (max - origin) / delta;
  return intersect([Math.min(first, second), Math.max(first, second)], [0, 1]);
}

function circleInterval(start: Point, end: Point, center: Point, radius: number): Interval | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fx = start.x - center.x;
  const fy = start.y - center.y;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - radius * radius;
  if (a <= EPSILON) return c <= EPSILON ? [0, 1] : null;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  return intersect([(-b - root) / (2 * a), (-b + root) / (2 * a)], [0, 1]);
}

/** Exact intersection interval between a line segment and a swept circular eraser capsule. */
function capsuleIntervals(strokeStart: Point, strokeEnd: Point, eraserStart: Point, eraserEnd: Point, radius: number): Interval[] {
  const ex = eraserEnd.x - eraserStart.x;
  const ey = eraserEnd.y - eraserStart.y;
  const lengthSquared = ex * ex + ey * ey;
  if (lengthSquared <= EPSILON) {
    const interval = circleInterval(strokeStart, strokeEnd, eraserStart, radius);
    return interval ? [interval] : [];
  }

  const sx = strokeEnd.x - strokeStart.x;
  const sy = strokeEnd.y - strokeStart.y;
  const fromEraserX = strokeStart.x - eraserStart.x;
  const fromEraserY = strokeStart.y - eraserStart.y;
  const projectionStart = (fromEraserX * ex + fromEraserY * ey) / lengthSquared;
  const projectionDelta = (sx * ex + sy * ey) / lengthSquared;
  const projected = linearInterval(projectionStart, projectionDelta, 0, 1);
  const crossStart = fromEraserX * ey - fromEraserY * ex;
  const crossDelta = sx * ey - sy * ex;
  const strip = linearInterval(crossStart, crossDelta, -radius * Math.sqrt(lengthSquared), radius * Math.sqrt(lengthSquared));
  const body = intersect(projected, strip);
  return [circleInterval(strokeStart, strokeEnd, eraserStart, radius), body,
    circleInterval(strokeStart, strokeEnd, eraserEnd, radius)].filter((interval): interval is Interval => interval !== null);
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.map(([start, end]) => [clamp01(start), clamp01(end)] as Interval)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1] + EPSILON) merged.push([interval[0], interval[1]]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function complement(intervals: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const [start, end] of mergeIntervals(intervals)) {
    if (start > cursor + EPSILON) result.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1 - EPSILON) result.push([cursor, 1]);
  return result;
}

function interpolate(start: PagePoint, end: PagePoint, t: number): PagePoint {
  const optional = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? b ?? 0) + ((b ?? a ?? 0) - (a ?? b ?? 0)) * t;
  const tiltX = optional(start.tiltX, end.tiltX);
  const tiltY = optional(start.tiltY, end.tiltY);
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    pressure: start.pressure + (end.pressure - start.pressure) * t,
    time: start.time + (end.time - start.time) * t,
    ...(tiltX === undefined ? {} : { tiltX }),
    ...(tiltY === undefined ? {} : { tiltY })
  };
}

function samePoint(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON; }

/** One gesture-wide broad phase. It can only admit extra work, never reject contact. */
function boundsOfPath(path: readonly Point[]): Bounds {
  const first = path[0]!;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (let index = 1; index < path.length; index += 1) {
    const point = path[index]!;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

interface EraserSegment {
  start: Point;
  end: Point;
  bounds: Bounds;
}

interface EraserPathIndex {
  segments: EraserSegment[];
  cellSize: number;
  cells: Map<string, number[]>;
}

function createEraserPathIndex(path: readonly Point[], radius: number): EraserPathIndex {
  const segments: EraserSegment[] = [];
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]!;
    const end = path[index]!;
    segments.push({
      start,
      end,
      bounds: {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y)
      }
    });
  }
  if (!segments.length) return { segments, cellSize: 1, cells: new Map() };
  const pathBounds = boundsOfPath(path);
  const span = Math.max(pathBounds.maxX - pathBounds.minX, pathBounds.maxY - pathBounds.minY, 1);
  const cellSize = Math.max(16, radius * 4, span / Math.sqrt(segments.length));
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number): string => `${x}:${y}`;
  for (let index = 0; index < segments.length; index += 1) {
    const bounds = segments[index]!.bounds;
    const minX = Math.floor(bounds.minX / cellSize);
    const maxX = Math.floor(bounds.maxX / cellSize);
    const minY = Math.floor(bounds.minY / cellSize);
    const maxY = Math.floor(bounds.maxY / cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const cell = key(x, y);
        const members = cells.get(cell);
        if (members) members.push(index);
        else cells.set(cell, [index]);
      }
    }
  }
  return { segments, cellSize, cells };
}

/** A segment outside an envelope expanded by its collision radius cannot touch any capsule. */
function segmentMayTouchPath(start: Point, end: Point, pathBounds: Bounds, radius: number): boolean {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  return maxX >= pathBounds.minX - radius
    && minX <= pathBounds.maxX + radius
    && maxY >= pathBounds.minY - radius
    && minY <= pathBounds.maxY + radius;
}

function collectCapsuleIntervals(
  strokeStart: Point,
  strokeEnd: Point,
  path: readonly Point[],
  pathIndex: EraserPathIndex,
  radius: number
): Interval[] {
  if (path.length === 1) return capsuleIntervals(strokeStart, strokeEnd, path[0]!, path[0]!, radius);
  const intervals: Interval[] = [];
  // Keep the exact capsule math, but reject eraser segments whose bounding
  // boxes cannot touch this stroke segment before doing the more expensive
  // capsule intersection work.
  for (const eraserSegment of pathIndex.segments) {
    if (!segmentMayTouchPath(strokeStart, strokeEnd, eraserSegment.bounds, radius)) continue;
    intervals.push(...capsuleIntervals(strokeStart, strokeEnd, eraserSegment.start, eraserSegment.end, radius));
  }
  return intervals;
}

function eraseStroke(
  stroke: InkStroke,
  path: readonly Point[],
  pathIndex: EraserPathIndex,
  radius: number,
  pathBounds: Bounds
): PagePoint[][] | null {
  if (stroke.points.length === 0 || path.length === 0) return null;
  if (stroke.points.length === 1) {
    const touched = path.length === 1
      ? Math.hypot(stroke.points[0]!.x - path[0]!.x, stroke.points[0]!.y - path[0]!.y) <= radius
      : pathIndex.segments.some((segment) => segmentMayTouchPath(
        stroke.points[0]!,
        stroke.points[0]!,
        segment.bounds,
        radius
      ) && capsuleIntervals(stroke.points[0]!, stroke.points[0]!, segment.start, segment.end, radius).length > 0);
    return touched ? [] : null;
  }

  const fragments: PagePoint[][] = [];
  let active: PagePoint[] | undefined;
  let changed = false;
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1]!;
    const end = stroke.points[index]!;
    const erased = !segmentMayTouchPath(start, end, pathBounds, radius)
      ? []
      : collectCapsuleIntervals(start, end, path, pathIndex, radius);
    const removed = erased.length
      ? mergeIntervals(erased).filter(([from, to]) => to - from > EPSILON)
      : [];
    if (removed.length === 0) {
      // Most stroke segments are outside the short eraser gesture. Avoid the
      // merge/complement allocations and interpolation work on that hot path.
      if (active && samePoint(active[active.length - 1]!, start)) active.push(end);
      else { active = [start, end]; fragments.push(active); }
      continue;
    }
    changed = true;
    const preserved = complement(removed);
    if (preserved.length === 0) { active = undefined; continue; }
    for (const [from, to] of preserved) {
      const fromPoint = interpolate(start, end, from);
      const toPoint = interpolate(start, end, to);
      if (active && from <= EPSILON && samePoint(active[active.length - 1]!, fromPoint)) active.push(toPoint);
      else { active = [fromPoint, toPoint]; fragments.push(active); }
      if (to < 1 - EPSILON) active = undefined;
    }
  }
  return changed ? fragments.map((points) => points.filter((item, index) => index === 0 || !samePoint(item, points[index - 1]!))) : null;
}

function distancePointToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp01(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function pointHitsEraserPath(
  point: Point,
  path: readonly Point[],
  radius: number,
  pathIndex?: EraserPathIndex
): boolean {
  if (path.length === 1) return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y) <= radius;
  if (pathIndex?.segments.length) {
    const key = (x: number, y: number): string => `${x}:${y}`;
    const minX = Math.floor((point.x - radius) / pathIndex.cellSize);
    const maxX = Math.floor((point.x + radius) / pathIndex.cellSize);
    const minY = Math.floor((point.y - radius) / pathIndex.cellSize);
    const maxY = Math.floor((point.y + radius) / pathIndex.cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        for (const index of pathIndex.cells.get(key(x, y)) ?? []) {
          const segment = pathIndex.segments[index]!;
          if (distancePointToSegment(point, segment.start, segment.end) <= radius) return true;
        }
      }
    }
    return false;
  }
  for (let index = 1; index < path.length; index += 1) {
    if (distancePointToSegment(point, path[index - 1]!, path[index]!) <= radius) return true;
  }
  return false;
}

function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

interface HighlighterErasePlan {
  /** null = untouched; empty = fully erased; otherwise one updated stroke (same geometry + masks). */
  fragments: InkStroke[] | null;
}

/**
 * Highlighter-only erase: append a subtractive erase mask. Stroke stays one object —
 * no centerline split into two round-cap circles. Render punches holes with destination-out.
 */
function eraseHighlighterStroke(
  stroke: InkStroke,
  path: readonly Point[],
  pathIndex: EraserPathIndex,
  eraserRadius: number,
  pathBounds: Bounds,
  options: SegmentEraserOptions
): HighlighterErasePlan {
  if (stroke.points.length === 0 || path.length === 0) return { fragments: null };
  const width = Math.max(stroke.width, EPSILON);
  const paintRadius = width / 2;
  const paintBounds = expandBounds(boundsOfPath(stroke.points), paintRadius);
  const eraserBounds = expandBounds(pathBounds, eraserRadius);
  if (!boundsOverlap(paintBounds, eraserBounds)) return { fragments: null };

  // A highlighter is rendered as a filled ribbon, so raster-sampling the whole
  // stroke on release scales with stroke length * ribbon area. The indexed
  // centerline test gives the exact touched/not-touched decision without
  // allocating a grid for every point in a dense highlight.
  if (!strokeIntersectsEraserPath(
    stroke,
    path,
    pathIndex,
    eraserRadius + paintRadius,
    pathBounds
  )) return { fragments: null };

  const existingMasks = stroke.eraseMasks ?? [];
  const nextMask = {
    points: path.map((point) => ({ x: point.x, y: point.y })),
    radius: eraserRadius
  };
  const allMasks = [...existingMasks, nextMask];
  let fullyCovered = paintRadius <= eraserRadius
    && paintBounds.minX >= eraserBounds.minX
    && paintBounds.maxX <= eraserBounds.maxX
    && paintBounds.minY >= eraserBounds.minY
    && paintBounds.maxY <= eraserBounds.maxY;
  if (fullyCovered) {
    const innerRadius = eraserRadius - paintRadius;
    for (let index = 0; index < stroke.points.length; index += 1) {
      const start = stroke.points[index]!;
      if (!pointHitsEraserPath(start, path, innerRadius, pathIndex)) {
        fullyCovered = false;
        break;
      }
      const end = stroke.points[index + 1];
      if (end && !pointHitsEraserPath({
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2
      }, path, innerRadius, pathIndex)) {
        fullyCovered = false;
        break;
      }
    }
  }
  if (fullyCovered) return { fragments: [] };

  const updatedAt = options.now?.() ?? new Date().toISOString();
  return {
    fragments: [{
      ...stroke,
      id: options.createFragmentId?.(stroke, 0) ?? stroke.id,
      eraseMasks: allMasks,
      updatedAt
    }]
  };
}

/**
 * Default eraser: remove only stroke portions touched by the swept circular path.
 * `size` is the eraser diameter; stroke thickness participates in collision.
 * Highlighter keeps one stroke and stores erase masks (hole punch, no split).
 */
export function eraseStrokeSegments(strokes: readonly InkStroke[], path: readonly Point[], size: number, options: SegmentEraserOptions = {}): SegmentEraseResult {
  const scale = options.scale ?? 1;
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Eraser size must be positive");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Coordinate scale must be positive");
  const eraserRadius = size / (2 * scale);
  const pathBounds = path.length ? boundsOfPath(path) : undefined;
  const pathIndex = createEraserPathIndex(path, eraserRadius);
  const kept: InkStroke[] = [];
  const erased: InkStroke[] = [];
  const fragments: InkStroke[] = [];
  for (const stroke of strokes) {
    if (options.candidateIds && !options.candidateIds.has(stroke.id)) {
      kept.push(stroke);
      continue;
    }
    if (!pathBounds) {
      kept.push(stroke);
      continue;
    }

    if (stroke.tool === "highlighter") {
      const plan = eraseHighlighterStroke(stroke, path, pathIndex, eraserRadius, pathBounds, options);
      if (plan.fragments === null) {
        kept.push(stroke);
        continue;
      }
      erased.push(stroke);
      plan.fragments.forEach((fragment) => {
        fragments.push(fragment);
        kept.push(fragment);
      });
      continue;
    }

    const replacementPoints = eraseStroke(stroke, path, pathIndex, eraserRadius + stroke.width / 2, pathBounds);
    if (replacementPoints === null) { kept.push(stroke); continue; }
    erased.push(stroke);
    const updatedAt = options.now?.() ?? new Date().toISOString();
    replacementPoints.forEach((points, fragmentIndex) => {
      if (points.length === 0) return;
      const fragment: InkStroke = {
        ...stroke,
        id: options.createFragmentId?.(stroke, fragmentIndex) ?? (fragmentIndex === 0 ? stroke.id : `${stroke.id}~erase-${fragmentIndex}`),
        points,
        updatedAt
      };
      fragments.push(fragment);
      kept.push(fragment);
    });
  }
  return { kept, erased, fragments };
}

/**
 * Whole-stroke erasing only needs contact, not clipped fragments. Keep this
 * separate from `eraseStroke` so the hot path can stop at the first actual
 * (non-tangent) capsule overlap.
 */
function strokeIntersectsEraserPath(
  stroke: InkStroke,
  path: readonly Point[],
  pathIndex: EraserPathIndex,
  radius: number,
  pathBounds: Bounds
): boolean {
  if (stroke.points.length === 0 || path.length === 0) return false;
  if (stroke.points.length === 1) {
    const point = stroke.points[0]!;
    if (path.length === 1) return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y) <= radius;
    return pathIndex.segments.some((segment) => segmentMayTouchPath(point, point, segment.bounds, radius)
      && capsuleIntervals(point, point, segment.start, segment.end, radius).length > 0);
  }

  for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex += 1) {
    const start = stroke.points[strokeIndex - 1]!;
    const end = stroke.points[strokeIndex]!;
    if (!segmentMayTouchPath(start, end, pathBounds, radius)) continue;
    if (path.length === 1) {
      if (mergeIntervals(capsuleIntervals(start, end, path[0]!, path[0]!, radius))
        .some(([from, to]) => to - from > EPSILON)) return true;
      continue;
    }
    for (const segment of pathIndex.segments) {
      if (!segmentMayTouchPath(start, end, segment.bounds, radius)) continue;
      if (mergeIntervals(capsuleIntervals(start, end, segment.start, segment.end, radius))
        .some(([from, to]) => to - from > EPSILON)) return true;
    }
  }
  return false;
}

/** Whole-stroke eraser: any contact removes the complete original stroke. */
export function eraseWholeStrokes(strokes: readonly InkStroke[], path: readonly Point[], size: number, options: SegmentEraserOptions = {}): SegmentEraseResult {
  const scale = options.scale ?? 1;
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Eraser size must be positive");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Coordinate scale must be positive");
  const eraserRadius = size / (2 * scale);
  const pathBounds = path.length ? boundsOfPath(path) : undefined;
  const pathIndex = createEraserPathIndex(path, eraserRadius);
  const erased = pathBounds
    ? strokes.filter((stroke) => (!options.candidateIds || options.candidateIds.has(stroke.id))
      && strokeIntersectsEraserPath(stroke, path, pathIndex, eraserRadius + stroke.width / 2, pathBounds))
    : [];
  const erasedIds = new Set(erased.map((stroke) => stroke.id));
  return {
    kept: strokes.filter((stroke) => !erasedIds.has(stroke.id)),
    erased,
    fragments: []
  };
}

/** Default eraser entry point. */
export const eraseStrokes = eraseStrokeSegments;
