import type { PdfPoint } from "../model";

/** Stationary hold before the active stroke snaps to a recognised shape. */
export const SHAPE_RECOGNITION_HOLD_MS = 500;

export type RecognizedShape = "line" | "arrow" | "rectangle" | "square" | "triangle" | "diamond" | "circle" | "ellipse" | "star" | "heart";

export interface ShapeRecognition {
  kind: RecognizedShape;
  points: PdfPoint[];
}

type Point = Pick<PdfPoint, "x" | "y">;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Opposite point stays fixed while a held, recognised shape is resized. */
export function shapeResizeAnchor(points: readonly PdfPoint[], handle: Point): PdfPoint {
  if (!points.length) throw new TypeError("Cannot resize an empty shape");
  return points.reduce((farthest, point) =>
    distance(point, handle) > distance(farthest, handle) ? point : farthest
  );
}

/** Closest clean shape point becomes the draggable handle after recognition. */
export function shapeResizeHandle(points: readonly PdfPoint[], pointer: Point): PdfPoint {
  if (!points.length) throw new TypeError("Cannot resize an empty shape");
  return points.reduce((nearest, point) =>
    distance(point, pointer) < distance(nearest, pointer) ? point : nearest
  );
}

/**
 * Uniformly scales and rotates recognised geometry so the held point follows
 * the pointer around the fixed anchor. Unlike per-axis scaling, this remains
 * continuous through every quadrant and keeps constrained geometry (squares,
 * circles, stars) intact.
 */
export function resizeShapePoints(
  points: readonly PdfPoint[],
  anchor: Point,
  handle: Point,
  target: Point
): PdfPoint[] {
  const startX = handle.x - anchor.x;
  const startY = handle.y - anchor.y;
  const targetX = target.x - anchor.x;
  const targetY = target.y - anchor.y;
  const startLength = Math.hypot(startX, startY);
  if (startLength < 1e-6) return points.map((point) => ({ ...point }));
  const targetLength = Math.hypot(targetX, targetY);
  // Retain a visible, non-degenerate shape when the pointer reaches the anchor.
  const scale = Math.max(0.05, targetLength / startLength);
  const denominator = startLength * Math.max(targetLength, 1e-6);
  const cosine = targetLength < 1e-6 ? 1 : (startX * targetX + startY * targetY) / denominator;
  const sine = targetLength < 1e-6 ? 0 : (startX * targetY - startY * targetX) / denominator;
  return points.map((point) => ({
    ...point,
    ...(distance(point, anchor) < 1e-6 ? { x: anchor.x, y: anchor.y }
      : distance(point, handle) < 1e-6 ? { x: target.x, y: target.y }
        : {
            x: anchor.x + ((point.x - anchor.x) * cosine - (point.y - anchor.y) * sine) * scale,
            y: anchor.y + ((point.x - anchor.x) * sine + (point.y - anchor.y) * cosine) * scale
          })
  }));
}

function lineDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return distance(point, from);
  return Math.abs(dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / length;
}

function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  let farthest = 0;
  let farthestDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidate = lineDistance(points[index]!, points[0]!, points.at(-1)!);
    if (candidate > farthestDistance) { farthestDistance = candidate; farthest = index; }
  }
  if (farthestDistance <= tolerance) return [points[0]!, points.at(-1)!];
  return [...simplify(points.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplify(points.slice(farthest), tolerance)];
}

function stamp(points: readonly Point[], template: PdfPoint): PdfPoint[] {
  return points.map((point) => ({ ...template, x: point.x, y: point.y }));
}

function bounds(points: readonly Point[]): { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function polygonArea(points: readonly Point[]): number {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function looksLikeEllipse(points: readonly Point[], box: ReturnType<typeof bounds>): boolean {
  if (box.width < 10 || box.height < 10 || points.length < 8) return false;
  const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const rx = box.width / 2; const ry = box.height / 2;
  const deviations = points.map((point) => Math.abs(Math.hypot((point.x - center.x) / rx, (point.y - center.y) / ry) - 1));
  return deviations.reduce((sum, value) => sum + value, 0) / deviations.length < 0.26;
}

function regularEllipse(box: ReturnType<typeof bounds>, template: PdfPoint): PdfPoint[] {
  const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  return stamp(Array.from({ length: 33 }, (_, index) => {
    const theta = (Math.PI * 2 * index) / 32;
    return { x: center.x + box.width * Math.cos(theta) / 2, y: center.y + box.height * Math.sin(theta) / 2 };
  }), template);
}

function regularCircle(box: ReturnType<typeof bounds>, template: PdfPoint): PdfPoint[] {
  const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const radius = (box.width + box.height) / 4;
  return stamp(Array.from({ length: 33 }, (_, index) => {
    const theta = (Math.PI * 2 * index) / 32;
    return { x: center.x + radius * Math.cos(theta), y: center.y + radius * Math.sin(theta) };
  }), template);
}

function looksLikeCircle(box: ReturnType<typeof bounds>): boolean {
  const shortest = Math.min(box.width, box.height);
  const longest = Math.max(box.width, box.height);
  // Accept a slightly uneven freehand circle, but preserve deliberately oval input.
  return shortest >= 10 && longest / shortest <= 1.18;
}

function isRightAngle(previous: Point, current: Point, next: Point): boolean {
  const ax = previous.x - current.x; const ay = previous.y - current.y;
  const bx = next.x - current.x; const by = next.y - current.y;
  const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return scale > 1 && Math.abs((ax * bx + ay * by) / scale) < 0.35;
}

function regularSquare(vertices: readonly Point[], template: PdfPoint): PdfPoint[] | null {
  if (vertices.length !== 4) return null;
  const sides = vertices.map((vertex, index) => distance(vertex, vertices[(index + 1) % vertices.length]!));
  const shortest = Math.min(...sides);
  const longest = Math.max(...sides);
  if (shortest < 8 || longest / shortest > 1.22) return null;
  const firstSide = {
    x: vertices[1]!.x - vertices[0]!.x,
    y: vertices[1]!.y - vertices[0]!.y
  };
  const sideLength = sides.reduce((sum, side) => sum + side, 0) / sides.length;
  const directionLength = Math.hypot(firstSide.x, firstSide.y);
  if (directionLength < 1e-6) return null;
  const direction = { x: firstSide.x / directionLength, y: firstSide.y / directionLength };
  const turn = firstSide.x * (vertices[2]!.y - vertices[1]!.y) - firstSide.y * (vertices[2]!.x - vertices[1]!.x);
  const perpendicular = turn >= 0
    ? { x: -direction.y, y: direction.x }
    : { x: direction.y, y: -direction.x };
  const center = midpoint(vertices[0]!, vertices[2]!);
  const half = sideLength / 2;
  const corners = [
    { x: center.x - (direction.x + perpendicular.x) * half, y: center.y - (direction.y + perpendicular.y) * half },
    { x: center.x + (direction.x - perpendicular.x) * half, y: center.y + (direction.y - perpendicular.y) * half },
    { x: center.x + (direction.x + perpendicular.x) * half, y: center.y + (direction.y + perpendicular.y) * half },
    { x: center.x - (direction.x - perpendicular.x) * half, y: center.y - (direction.y - perpendicular.y) * half }
  ];
  return stamp([...corners, corners[0]!], template);
}

function regularRectangle(vertices: readonly Point[], template: PdfPoint): PdfPoint[] {
  const sides = vertices.map((vertex, index) => distance(vertex, vertices[(index + 1) % vertices.length]!));
  const firstSide = {
    x: vertices[1]!.x - vertices[0]!.x,
    y: vertices[1]!.y - vertices[0]!.y
  };
  const directionLength = Math.hypot(firstSide.x, firstSide.y);
  const direction = { x: firstSide.x / directionLength, y: firstSide.y / directionLength };
  const turn = firstSide.x * (vertices[2]!.y - vertices[1]!.y) - firstSide.y * (vertices[2]!.x - vertices[1]!.x);
  const perpendicular = turn >= 0
    ? { x: -direction.y, y: direction.x }
    : { x: direction.y, y: -direction.x };
  const halfWidth = (sides[0]! + sides[2]!) / 4;
  const halfHeight = (sides[1]! + sides[3]!) / 4;
  const center = midpoint(vertices[0]!, vertices[2]!);
  const corners = [
    { x: center.x - direction.x * halfWidth - perpendicular.x * halfHeight, y: center.y - direction.y * halfWidth - perpendicular.y * halfHeight },
    { x: center.x + direction.x * halfWidth - perpendicular.x * halfHeight, y: center.y + direction.y * halfWidth - perpendicular.y * halfHeight },
    { x: center.x + direction.x * halfWidth + perpendicular.x * halfHeight, y: center.y + direction.y * halfWidth + perpendicular.y * halfHeight },
    { x: center.x - direction.x * halfWidth + perpendicular.x * halfHeight, y: center.y - direction.y * halfWidth + perpendicular.y * halfHeight }
  ];
  return stamp([...corners, corners[0]!], template);
}

function regularizeStar(vertices: readonly Point[], template: PdfPoint): PdfPoint[] | null {
  if (vertices.length !== 10) return null;
  const center = vertices.reduce((sum, point) => ({ x: sum.x + point.x / vertices.length, y: sum.y + point.y / vertices.length }), { x: 0, y: 0 });
  const radii = vertices.map((point) => distance(point, center));
  const maxIndex = radii.indexOf(Math.max(...radii));
  const ordered = [...vertices.slice(maxIndex), ...vertices.slice(0, maxIndex)];
  const orderedRadii = ordered.map((point) => distance(point, center));
  const outer = orderedRadii.filter((_, index) => index % 2 === 0);
  const inner = orderedRadii.filter((_, index) => index % 2 === 1);
  const outerMean = outer.reduce((sum, value) => sum + value, 0) / outer.length;
  const innerMean = inner.reduce((sum, value) => sum + value, 0) / inner.length;
  if (innerMean < outerMean * 0.28 || innerMean > outerMean * 0.72) return null;
  if (Math.max(...outer) - Math.min(...outer) > outerMean * 0.38 || Math.max(...inner) - Math.min(...inner) > innerMean * 0.48) return null;
  const snapped = ordered.map((point, index) => {
    const radius = index % 2 === 0 ? outerMean : innerMean;
    const theta = Math.atan2(point.y - center.y, point.x - center.x);
    return { x: center.x + Math.cos(theta) * radius, y: center.y + Math.sin(theta) * radius };
  });
  return stamp([...snapped, snapped[0]!], template);
}

function regularHeart(box: ReturnType<typeof bounds>, template: PdfPoint): PdfPoint[] {
  const raw = Array.from({ length: 33 }, (_, index) => {
    const theta = (Math.PI * 2 * index) / 32;
    return { x: 16 * Math.sin(theta) ** 3, y: 13 * Math.cos(theta) - 5 * Math.cos(2 * theta) - 2 * Math.cos(3 * theta) - Math.cos(4 * theta) };
  });
  const rawBounds = bounds(raw);
  return stamp(raw.map((point) => ({
    x: box.minX + ((point.x - rawBounds.minX) / rawBounds.width) * box.width,
    y: box.minY + ((point.y - rawBounds.minY) / rawBounds.height) * box.height
  })), template);
}

function looksLikeHeart(vertices: readonly Point[], box: ReturnType<typeof bounds>): boolean {
  if (vertices.length < 6 || box.width < 12 || box.height < 12) return false;
  const centerX = (box.minX + box.maxX) / 2;
  const topBand = box.maxY - box.height * 0.22;
  const lobes = vertices.filter((point) => point.y >= topBand);
  const hasLeftLobe = lobes.some((point) => point.x < centerX - box.width * 0.12);
  const hasRightLobe = lobes.some((point) => point.x > centerX + box.width * 0.12);
  const notch = vertices.some((point) => Math.abs(point.x - centerX) < box.width * 0.16 && point.y < box.maxY - box.height * 0.16 && point.y > box.minY + box.height * 0.32);
  const tip = vertices.some((point) => Math.abs(point.x - centerX) < box.width * 0.18 && point.y < box.minY + box.height * 0.18);
  return hasLeftLobe && hasRightLobe && notch && tip;
}

/**
 * Conservative stationary-hold recognition. Ambiguous input returns null so it
 * remains ordinary ink; recognising a wrong shape is worse than doing nothing.
 */
export function recognizeHeldShape(input: readonly PdfPoint[]): ShapeRecognition | null {
  if (input.length < 2) return null;
  const plain = input.map(({ x, y }) => ({ x, y }));
  const box = bounds(plain);
  const diagonal = Math.hypot(box.width, box.height);
  if (diagonal < 10) return null;
  const pathLength = plain.slice(1).reduce((sum, point, index) => sum + distance(point, plain[index]!), 0);
  const first = plain[0]!; const last = plain.at(-1)!;
  const template = { ...input.at(-1)!, pressure: 1 };
  const closed = distance(first, last) <= Math.max(10, diagonal * 0.18);

  if (!closed && distance(first, last) / Math.max(pathLength, 1) > 0.93) {
    return { kind: "line", points: stamp([first, last], template) };
  }

  const compact = simplify(plain, Math.max(4, diagonal * 0.045));
  if (!closed && compact.length >= 5) {
    for (let firstTip = 1; firstTip < compact.length - 3; firstTip += 1) {
      for (let secondTip = firstTip + 2; secondTip < compact.length - 1; secondTip += 1) {
        if (distance(compact[firstTip]!, compact[secondTip]!) > Math.max(8, diagonal * 0.12)) continue;
        const wingA = compact[firstTip + 1]!;
        const wingB = compact[secondTip + 1]!;
        const tip = compact[firstTip]!;
        const shaft = distance(compact[0]!, tip);
        if (shaft < 18 || distance(wingA, tip) > shaft * 0.55 || distance(wingB, tip) > shaft * 0.55) continue;
        return { kind: "arrow", points: stamp([compact[0]!, tip, wingA, tip, wingB], template) };
      }
    }
  }
  const vertices = closed && compact.length > 2 ? compact.slice(0, -1) : compact;
  if (!closed || vertices.length < 3 || polygonArea(vertices) < 25) return null;

  if (vertices.length === 3) {
    return { kind: "triangle", points: stamp([...vertices, vertices[0]!], template) };
  }
  const star = regularizeStar(vertices, template);
  if (star) return { kind: "star", points: star };
  if (looksLikeHeart(vertices, box)) return { kind: "heart", points: regularHeart(box, template) };
  if (vertices.length === 4 && vertices.every((vertex, index) => isRightAngle(vertices[(index + 3) % 4]!, vertex, vertices[(index + 1) % 4]!))) {
    const square = regularSquare(vertices, template);
    if (square) return { kind: "square", points: square };
    return { kind: "rectangle", points: regularRectangle(vertices, template) };
  }
  if (looksLikeEllipse(plain, box)) {
    if (looksLikeCircle(box)) return { kind: "circle", points: regularCircle(box, template) };
    return { kind: "ellipse", points: regularEllipse(box, template) };
  }
  return null;
}
