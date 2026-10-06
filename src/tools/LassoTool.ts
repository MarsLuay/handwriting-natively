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

function strokeBoundsCenter(stroke: InkStroke): Point {
  const bounds = strokeBounds(stroke);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
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
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (pointErasedByMasks(point, masks)) {
      flush();
      continue;
    }
    const previous = points[index - 1];
    if (previous && !pointErasedByMasks(previous, masks) && segmentErasedByMasks(previous, point, masks)) {
      flush();
    }
    current.push(point);
  }
  flush();
  return segments;
}

function strokeMatchesSelection(stroke: InkStroke, shape: SelectionShape): boolean {
  if (!stroke.points.length) return false;
  // Highlighter erasing keeps the original centerline and records holes as
  // masks. Do not let points (or the bounds-center fallback) inside one of
  // those holes make the whole highlighter selectable again.
  const visiblePoints = stroke.eraseMasks?.length
    ? stroke.points.filter((point) => !pointErasedByMasks(point, stroke.eraseMasks))
    : stroke.points;
  if (!visiblePoints.length) return false;
  const center = strokeBoundsCenter(stroke);
  if (contains(shape, center) && !pointErasedByMasks(center, stroke.eraseMasks)) return true;
  const insideCount = visiblePoints.filter((point) => contains(shape, point)).length;
  if (insideCount === 0) return false;
  if (stroke.points.length === 1) return true;
  const bounds = strokeBounds(stroke);
  const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  // i/j dots and tap marks: one point inside the lasso is enough
  if (span <= Math.max(stroke.width * SHORT_STROKE_SPAN_WIDTHS, 8)) return true;
  return insideCount >= 2;
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
