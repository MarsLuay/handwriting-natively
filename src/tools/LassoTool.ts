import type { InkStroke, PagePoint, TextAnnotation } from "../model";
import { distanceToSegment, strokeBounds, type Bounds } from "../ink/StrokeHitTesting";

const OVERLAY_MARGIN_PX = 4;
/** Strokes whose span is at most this many stroke-widths count as tap/dot marks. */
const SHORT_STROKE_SPAN_WIDTHS = 4;

export type Point = Pick<PagePoint, "x" | "y">;
export type SelectionShape =
  | { type: "freeform"; points: Point[] }
  | { type: "rectangle"; bounds: Bounds };

const inBounds = (point: Point, bounds: Bounds) => point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!; const b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function shapeContainsPoint(shape: SelectionShape, point: Point): boolean {
  if (shape.type === "freeform") return pointInPolygon(point, shape.points);
  return inBounds(point, shape.bounds);
}

export function translateShape(shape: SelectionShape, dx: number, dy: number): SelectionShape {
  if (shape.type === "freeform") {
    return { type: "freeform", points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  }
  const bounds = shape.bounds;
  return {
    type: shape.type,
    bounds: {
      minX: bounds.minX + dx,
      minY: bounds.minY + dy,
      maxX: bounds.maxX + dx,
      maxY: bounds.maxY + dy
    }
  };
}

function contains(shape: SelectionShape, point: Point): boolean {
  return shapeContainsPoint(shape, point);
}

/** Return whether a point is covered by a highlighter's destination-out mask. */
function pointErasedByMask(point: Point, mask: NonNullable<InkStroke["eraseMasks"]>[number]): boolean {
  const radius = Math.max(0, mask.radius);
  if (mask.points.length === 1) return distanceToSegment(point, mask.points[0]!, mask.points[0]!) <= radius;
  for (let index = 1; index < mask.points.length; index += 1) {
    if (distanceToSegment(point, mask.points[index - 1]!, mask.points[index]!) <= radius) return true;
  }
  return false;
}

function pointErasedByMasks(point: Point, masks: InkStroke["eraseMasks"]): boolean {
  return masks?.some((mask) => pointErasedByMask(point, mask)) ?? false;
}

function segmentsIntersect(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): boolean {
  const cross = (a: Point, b: Point, c: Point): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (start: Point, end: Point, point: Point): boolean =>
    point.x >= Math.min(start.x, end.x) - 1e-9
    && point.x <= Math.max(start.x, end.x) + 1e-9
    && point.y >= Math.min(start.y, end.y) - 1e-9
    && point.y <= Math.max(start.y, end.y) + 1e-9;
  const firstStartSide = cross(firstStart, firstEnd, secondStart);
  const firstEndSide = cross(firstStart, firstEnd, secondEnd);
  const secondStartSide = cross(secondStart, secondEnd, firstStart);
  const secondEndSide = cross(secondStart, secondEnd, firstEnd);
  return (firstStartSide === 0 && onSegment(firstStart, firstEnd, secondStart))
    || (firstEndSide === 0 && onSegment(firstStart, firstEnd, secondEnd))
    || (secondStartSide === 0 && onSegment(secondStart, secondEnd, firstStart))
    || (secondEndSide === 0 && onSegment(secondStart, secondEnd, firstEnd))
    || ((firstStartSide < 0) !== (firstEndSide < 0)
      && (secondStartSide < 0) !== (secondEndSide < 0));
}

function segmentErasedByMask(start: Point, end: Point, mask: NonNullable<InkStroke["eraseMasks"]>[number]): boolean {
  const radius = Math.max(0, mask.radius);
  if (mask.points.length === 1) return distanceToSegment(mask.points[0]!, start, end) <= radius;
  for (let index = 1; index < mask.points.length; index += 1) {
    const maskStart = mask.points[index - 1]!;
    const maskEnd = mask.points[index]!;
    if (segmentsIntersect(start, end, maskStart, maskEnd)
      || distanceToSegment(start, maskStart, maskEnd) <= radius
      || distanceToSegment(end, maskStart, maskEnd) <= radius
      || distanceToSegment(maskStart, start, end) <= radius
      || distanceToSegment(maskEnd, start, end) <= radius) return true;
  }
  return false;
}

function segmentErasedByMasks(start: Point, end: Point, masks: InkStroke["eraseMasks"]): boolean {
  return masks?.some((mask) => segmentErasedByMask(start, end, mask)) ?? false;
}

/** Interpolate a centerline point when a mask crosses between sparse samples. */
function interpolateVisiblePoint(start: PagePoint, end: PagePoint, amount: number): PagePoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    pressure: start.pressure + (end.pressure - start.pressure) * amount,
    time: start.time + (end.time - start.time) * amount,
    ...(start.tiltX === undefined && end.tiltX === undefined
      ? {}
      : { tiltX: (start.tiltX ?? end.tiltX ?? 0) + ((end.tiltX ?? start.tiltX ?? 0) - (start.tiltX ?? end.tiltX ?? 0)) * amount }),
    ...(start.tiltY === undefined && end.tiltY === undefined
      ? {}
      : { tiltY: (start.tiltY ?? end.tiltY ?? 0) + ((end.tiltY ?? start.tiltY ?? 0) - (start.tiltY ?? end.tiltY ?? 0)) * amount })
  };
}

function sameVisiblePoint(first: Point, second: Point): boolean {
  return Math.abs(first.x - second.x) <= 1e-9 && Math.abs(first.y - second.y) <= 1e-9;
}

/** Split a selected highlighter path so its blue selection dash never crosses a hole. */
export function visibleStrokeSegments(
  points: readonly PagePoint[],
  masks: InkStroke["eraseMasks"]
): PagePoint[][] {
  if (!points.length) return [];
  if (!masks?.length) return [points.slice()];
  const segments: PagePoint[][] = [];
  let current: PagePoint[] = [];
  const flush = (): void => {
    if (current.length) segments.push(current);
    current = [];
  };
  const append = (point: PagePoint): void => {
    if (!current.length || !sameVisiblePoint(current[current.length - 1]!, point)) current.push(point);
  };
  const transition = (start: PagePoint, end: PagePoint, startVisible: boolean, endVisible: boolean): PagePoint => {
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const middle = (low + high) / 2;
      const visible = !pointErasedByMasks(interpolateVisiblePoint(start, end, middle), masks);
      if (visible === startVisible) low = middle;
      else high = middle;
    }
    return interpolateVisiblePoint(start, end, (low + high) / 2);
  };

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const startVisible = !pointErasedByMasks(start, masks);
    const endVisible = !pointErasedByMasks(end, masks);
    // Unmasked segments stay allocation-free. Masked candidates are sampled
    // only here, preserving the full visible ribbon on either side of a hole
    // even when the persisted centerline has just two far-apart points.
    const steps = segmentErasedByMasks(start, end, masks) ? 24 : 1;
    let previous = start;
    let previousVisible = startVisible;
    if (startVisible) append(start);
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      const next = step === steps ? end : interpolateVisiblePoint(start, end, amount);
      const nextVisible = !pointErasedByMasks(next, masks);
      if (previousVisible && nextVisible) {
        append(next);
      } else if (previousVisible && !nextVisible) {
        append(transition(previous, next, true, false));
        flush();
      } else if (!previousVisible && nextVisible) {
        current = [transition(previous, next, false, true)];
        append(next);
      }
      previous = next;
      previousVisible = nextVisible;
    }
    if (!endVisible) flush();
  }
  // A one-point stroke is still a valid visible dot.
  if (points.length === 1 && !pointErasedByMasks(points[0]!, masks)) segments.push([points[0]!]);
  flush();
  return segments;
}

function segmentLengthInsideShape(start: Point, end: Point, shape: SelectionShape): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length <= 1e-9) return 0;

  // Break at lasso boundaries instead of relying only on captured stroke
  // points. Sparse/highlighter paths can have a large painted interval between
  // two points, and a small lasso must still be able to hit that interval.
  const cuts = [0, 1];
  const polygon = shape.type === "freeform"
    ? shape.points
    : [
      { x: shape.bounds.minX, y: shape.bounds.minY },
      { x: shape.bounds.maxX, y: shape.bounds.minY },
      { x: shape.bounds.maxX, y: shape.bounds.maxY },
      { x: shape.bounds.minX, y: shape.bounds.maxY }
    ];
  const lineX = end.x - start.x;
  const lineY = end.y - start.y;
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!;
    const edgeEnd = polygon[(index + 1) % polygon.length]!;
    const edgeX = edgeEnd.x - edgeStart.x;
    const edgeY = edgeEnd.y - edgeStart.y;
    const denominator = lineX * edgeY - lineY * edgeX;
    if (Math.abs(denominator) <= 1e-9) continue;
    const fromStartX = edgeStart.x - start.x;
    const fromStartY = edgeStart.y - start.y;
    const alongStroke = (fromStartX * edgeY - fromStartY * edgeX) / denominator;
    const alongEdge = (fromStartX * lineY - fromStartY * lineX) / denominator;
    if (alongStroke >= -1e-9 && alongStroke <= 1 + 1e-9
      && alongEdge >= -1e-9 && alongEdge <= 1 + 1e-9) {
      cuts.push(Math.max(0, Math.min(1, alongStroke)));
    }
  }
  cuts.sort((a, b) => a - b);
  let insideLength = 0;
  for (let index = 1; index < cuts.length; index += 1) {
    const from = cuts[index - 1]!;
    const to = cuts[index]!;
    if (to - from <= 1e-9) continue;
    const midpoint = {
      x: start.x + lineX * ((from + to) / 2),
      y: start.y + lineY * ((from + to) / 2)
    };
    if (contains(shape, midpoint)) insideLength += length * (to - from);
  }
  return insideLength;
}

function strokeMatchesSelection(stroke: InkStroke, shape: SelectionShape): boolean {
  if (!stroke.points.length) return false;
  // Erased highlighters remain one model object, but their masked centerline
  // is physically disconnected. Test each visible segment independently so a
  // lasso cannot select an invisible hole or use the old bounds-center
  // fallback to select unrelated visible portions.
  const segments = stroke.eraseMasks?.length
    ? visibleStrokeSegments(stroke.points, stroke.eraseMasks)
    : [stroke.points];
  if (!segments.length) return false;

  let insideLength = 0;
  let insidePointCount = 0;
  for (const segment of segments) {
    insidePointCount += segment.filter((point) => contains(shape, point)).length;
    for (let index = 1; index < segment.length; index += 1) {
      insideLength += segmentLengthInsideShape(segment[index - 1]!, segment[index]!, shape);
    }
  }
  if (stroke.points.length === 1) return insidePointCount > 0;
  const bounds = strokeBounds(stroke);
  const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  // i/j dots and tap marks: one point inside the lasso is enough.
  if (span <= Math.max(stroke.width * SHORT_STROKE_SPAN_WIDTHS, 8)) return insidePointCount > 0;
  // Require a small painted interval, rather than merely touching a lasso
  // edge. Highlighters are wide ribbons, so a tiny centerline hit is still a
  // real paint hit and must select the whole visible highlight.
  const minimumLength = stroke.tool === "highlighter"
    ? Math.min(1, Math.max(0.1, stroke.width * 0.25))
    : Math.max(0.75, stroke.width * 0.5);
  return insideLength >= minimumLength;
}

export function selectionShapeArea(shape: SelectionShape): number {
  if (shape.type === "freeform") {
    const bounds = shapeBounds(shape);
    return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
  }
  const bounds = shape.bounds;
  return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
}

export function selectStrokes(strokes: readonly InkStroke[], shape: SelectionShape): InkStroke[] {
  return strokes.filter((stroke) => strokeMatchesSelection(stroke, shape));
}

/** Keep ink visible on the overlay. Do not gate on live pageWidth/Height — those can drift from pinned drawing metrics and hide real strokes. */
export function strokeDiscernibleInOverlay(
  stroke: InkStroke,
  _pageWidth: number,
  _pageHeight: number,
  _scale: number,
  overlayWidth: number,
  overlayHeight: number,
  toViewport: (point: Point) => Point,
  _minScreenPx?: number
): boolean {
  if (!stroke.points.length) return false;
  if (!(overlayWidth > 0) || !(overlayHeight > 0)) return false;
  for (const point of stroke.points) {
    const view = toViewport(point);
    if (view.x >= -OVERLAY_MARGIN_PX && view.x <= overlayWidth + OVERLAY_MARGIN_PX
      && view.y >= -OVERLAY_MARGIN_PX && view.y <= overlayHeight + OVERLAY_MARGIN_PX) {
      return true;
    }
  }
  return false;
}

export function filterSelectableStrokes(
  strokes: readonly InkStroke[],
  pageWidth: number,
  pageHeight: number,
  scale: number,
  overlayWidth: number,
  overlayHeight: number,
  toViewport: (point: Point) => Point
): InkStroke[] {
  return strokes.filter((stroke) => strokeDiscernibleInOverlay(
    stroke,
    pageWidth,
    pageHeight,
    scale,
    overlayWidth,
    overlayHeight,
    toViewport
  ));
}

export function shapeBounds(shape: SelectionShape): Bounds {
  if (shape.type !== "freeform") return shape.bounds;
  const fake = { width: 0, points: shape.points } as InkStroke;
  return strokeBounds(fake);
}

export function boundingShapeFromStrokes(strokes: readonly InkStroke[]): SelectionShape | null {
  if (!strokes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return { type: "rectangle", bounds: { minX, minY, maxX, maxY } };
}

/**
 * The normal selection outline must cover every selected annotation type, not
 * only ink. Text uses a top-left origin in PDF coordinates, so its vertical
 * extent runs from `y - height` through `y`.
 */
export function boundingShapeFromSelection(
  strokes: readonly InkStroke[],
  texts: readonly Pick<TextAnnotation, "x" | "y" | "width" | "height">[]
): SelectionShape | null {
  const inkShape = boundingShapeFromStrokes(strokes);
  const inkBounds = inkShape ? shapeBounds(inkShape) : undefined;
  let minX = inkBounds?.minX ?? Infinity;
  let minY = inkBounds?.minY ?? Infinity;
  let maxX = inkBounds?.maxX ?? -Infinity;
  let maxY = inkBounds?.maxY ?? -Infinity;

  for (const text of texts) {
    minX = Math.min(minX, text.x);
    minY = Math.min(minY, text.y - text.height);
    maxX = Math.max(maxX, text.x + text.width);
    maxY = Math.max(maxY, text.y);
  }

  if (!Number.isFinite(minX)) return null;
  return { type: "rectangle", bounds: { minX, minY, maxX, maxY } };
}
