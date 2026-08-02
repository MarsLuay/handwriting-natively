import type { PdfPoint } from "../model";

export type StabilizationLevel = "off" | "low" | "medium" | "high";

/** EMA blend toward the new raw sample (1 = raw / no smoothing). */
export const STABILIZATION_ALPHA: Record<StabilizationLevel, number> = {
  off: 1,
  low: 0.72,
  medium: 0.48,
  high: 0.28
};

/**
 * Batch re-stabilize from scratch. Tip is pinned to the last raw sample.
 * Prefer {@link appendStabilizedPoint} for live preview — batch recomputation
 * moves earlier points and breaks incremental draft stamps.
 */
export function stabilizePoints(points: readonly PdfPoint[], level: StabilizationLevel): PdfPoint[] {
  if (points.length < 2 || level === "off") return points.map((point) => ({ ...point }));
  const result: PdfPoint[] = [{ ...points[0]! }];
  const alpha = STABILIZATION_ALPHA[level];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const previous = result[index - 1]!;
    result.push({
      ...point,
      x: previous.x + (point.x - previous.x) * alpha,
      y: previous.y + (point.y - previous.y) * alpha,
      pressure: previous.pressure + (point.pressure - previous.pressure) * alpha
    });
  }
  result[result.length - 1] = { ...points[points.length - 1]! };
  return result;
}

/**
 * Causal EMA: append one smoothed point. Prior entries in `smoothed` never move,
 * so incremental live draft stamps stay valid with stabilization on.
 */
export function appendStabilizedPoint(
  smoothed: PdfPoint[],
  raw: PdfPoint,
  level: StabilizationLevel
): void {
  if (level === "off" || smoothed.length === 0) {
    smoothed.push({ ...raw });
    return;
  }
  const alpha = STABILIZATION_ALPHA[level];
  const previous = smoothed[smoothed.length - 1]!;
  smoothed.push({
    ...raw,
    x: previous.x + (raw.x - previous.x) * alpha,
    y: previous.y + (raw.y - previous.y) * alpha,
    pressure: previous.pressure + (raw.pressure - previous.pressure) * alpha
  });
}

function perpendicularDistance(point: PdfPoint, start: PdfPoint, end: PdfPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy);
}

export function simplifyPoints(points: readonly PdfPoint[], tolerance = 0.35): PdfPoint[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  let maxDistance = 0;
  let split = 0;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index]!, start, end);
    if (distance > maxDistance) { maxDistance = distance; split = index; }
  }
  if (maxDistance <= tolerance) return [{ ...start }, { ...end }];
  return [...simplifyPoints(points.slice(0, split + 1), tolerance).slice(0, -1),
    ...simplifyPoints(points.slice(split), tolerance)];
}
