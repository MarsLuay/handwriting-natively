import { normalizedCoordinateScale } from "../util/math";

export interface BrushPoint {
  x: number;
  y: number;
  pressure: number;
  time?: number;
}

export interface BrushStrokeOptions {
  color: string;
  /** Base stroke width in the same space as `points`. */
  width: number;
  opacity: number;
  pressureSensitivity: boolean;
  thinning: number;
  /** Viewport coordinates per PDF-space unit for zoom-stable geometry floors. */
  coordinateScale?: number;
}

const PRESSURE_ALPHA = 0.4;
const VELOCITY_ALPHA = 0.3;
const VELOCITY_THINNING = 0.18;
const MIN_VELOCITY_FACTOR = 0.65;
const TAPER_WIDTHS = 2.4;
const TAPER_MAX_SHARE = 0.18;
const TIP_FLOOR = 0.12;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}

function pressureWidth(options: BrushStrokeOptions, pressure: number, coordinateScale: number): number {
  const normalizedPressure = options.pressureSensitivity ? clamp01(pressure) : 0.5;
  const width = options.width * (
    1 - options.thinning + options.thinning * normalizedPressure * 2
  );
  return Math.max(0.35 * coordinateScale, width);
}

function taperEase(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const smooth = clamped * clamped * (3 - 2 * clamped);
  return TIP_FLOOR + (1 - TIP_FLOOR) * smooth;
}

/**
 * Widths for the brush pen's filled ribbon.
 *
 * settled with a one-pole filter and speed starves the nib, while a short
 * endpoint taper keeps lifted strokes from ending in blunt round caps. The
 * recorded centerline remains untouched; these are render-time widths only.
 */
export function brushSampleWidths(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): number[] {
  if (points.length === 0) return [];
  const coordinateScale = normalizedCoordinateScale(options.coordinateScale);
  const widths: number[] = [];
  const arc: number[] = [0];
  let pressure = clamp01(points[0]!.pressure);
  let velocity = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (index > 0) {
      const previous = points[index - 1]!;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y) / coordinateScale;
      const previousTime = Number.isFinite(previous.time) ? previous.time! : index - 1;
      const currentTime = Number.isFinite(point.time) ? point.time! : index;
      const elapsed = Math.max(1, currentTime - previousTime);
      velocity += VELOCITY_ALPHA * (distance / elapsed - velocity);
      pressure += PRESSURE_ALPHA * (
        (options.pressureSensitivity ? clamp01(point.pressure) : 0.5) - pressure
      );
      arc.push(arc[index - 1]! + distance);
    }
    const velocityFactor = Math.max(
      MIN_VELOCITY_FACTOR,
      1 / (1 + VELOCITY_THINNING * velocity)
    );
    widths.push(Math.max(
      0.35 * coordinateScale,
      pressureWidth(options, pressure, coordinateScale) * velocityFactor
    ));
  }

  if (points.length < 2) return widths;
  const total = arc.at(-1)!;
  if (total < options.width / coordinateScale) return widths;
  const taperLength = Math.min(
    TAPER_WIDTHS * Math.max(options.width / coordinateScale, 0.01),
    total * TAPER_MAX_SHARE
  );
  if (taperLength <= 0) return widths;
  return widths.map((width, index) => width * taperEase(arc[index]! / taperLength) * taperEase((total - arc[index]!) / taperLength));
}

/**
 * Draw a brush as one filled collection of variable-width segment quads.
 * Keeping all quads and round joins in one fill avoids dark seams where the
 * pressure/speed-shaped ribbon overlaps itself.
 */
export function drawBrushStroke(
  context: CanvasRenderingContext2D,
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): void {
  if (!points.length) return;
  const coordinateScale = normalizedCoordinateScale(options.coordinateScale);
  const widths = brushSampleWidths(points, options);
  context.save();
  context.globalAlpha = options.opacity;
  context.fillStyle = options.color;

  if (points.length === 1) {
    const point = points[0]!;
    context.beginPath();
    context.arc(point.x, point.y, widths[0]! / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    dx /= length;
    dy /= length;
    const nx = -dy;
    const ny = dx;
    const startRadius = widths[index - 1]! / 2;
    const endRadius = widths[index]! / 2;
    context.moveTo(start.x + nx * startRadius, start.y + ny * startRadius);
    context.lineTo(end.x + nx * endRadius, end.y + ny * endRadius);
    context.lineTo(end.x - nx * endRadius, end.y - ny * endRadius);
    context.lineTo(start.x - nx * startRadius, start.y - ny * startRadius);
  }

  // Round caps and joins are subpaths in the same fill. A zero-length sample
  // still receives a dab, which keeps stationary stylus samples visible.
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const radius = Math.max(0.2 * coordinateScale, widths[index]! / 2);
    context.moveTo(point.x + radius, point.y);
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
  context.fill();
  context.restore();
}

/** Segment widths used by flattened PDF export. */
export function brushSegmentWidths(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): Array<{ start: BrushPoint; end: BrushPoint; thickness: number }> {
  const widths = brushSampleWidths(points, options);
  const segments: Array<{ start: BrushPoint; end: BrushPoint; thickness: number }> = [];
  for (let index = 1; index < points.length; index += 1) {
    segments.push({
      start: points[index - 1]!,
      end: points[index]!,
      thickness: (widths[index - 1]! + widths[index]!) / 2
    });
  }
  return segments;
}
