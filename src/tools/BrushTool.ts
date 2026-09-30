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

/**
 * Brush geometry adapted from the owned MIT inspiration's pen pipeline:
 * midpoint-quadratic centerline, filtered pressure/velocity widths, endpoint
 * taper, and one filled ribbon. The canonical centerline remains untouched;
 * these are render-time points only.
 *
 * Source concepts: inspirations/handwriting-inspiration-folder/src/ink/
 * {InkShape,Smoothing,Ribbon,RibbonRenderer}.ts. Unlike that project's
 * world-space renderer, this adapter keeps native-pdf-handwriting's existing
 * pressure/thinning settings and viewport-point API.
 */
const PRESSURE_ALPHA = 0.4;
const VELOCITY_ALPHA = 0.3;
const VELOCITY_THINNING = 0.18;
const MIN_VELOCITY_FACTOR = 0.65;
const TAPER_WIDTHS = 2.4;
const TAPER_MAX_SHARE = 0.18;
const TIP_FLOOR = 0.12;
const FLATTEN_TOLERANCE_PX = 0.25;
const MAX_SUBDIVISIONS = 24;

interface Point2 {
  x: number;
  y: number;
}

interface SmoothSegment {
  from: Point2;
  ctrl: Point2;
  to: Point2;
}

interface RibbonPoint {
  x: number;
  y: number;
  halfWidth: number;
}

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

function shapedSampleWidths(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): { widths: number[]; arc: number[] } {
  const coordinateScale = normalizedCoordinateScale(options.coordinateScale);
  const widths: number[] = [];
  const arc: number[] = [0];
  let pressure = options.pressureSensitivity ? clamp01(points[0]?.pressure ?? 0.5) : 0.5;
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
      const targetPressure = options.pressureSensitivity ? clamp01(point.pressure) : 0.5;
      pressure += PRESSURE_ALPHA * (targetPressure - pressure);
      arc.push(arc[index - 1]! + distance * coordinateScale);
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
  return { widths, arc };
}

function taperWidths(
  widths: readonly number[],
  arc: readonly number[],
  baseWidth: number
): number[] {
  if (widths.length < 2) return [...widths];
  const total = arc.at(-1)!;
  if (total < baseWidth) return [...widths];
  const taperLength = Math.min(TAPER_WIDTHS * Math.max(baseWidth, 0.01), total * TAPER_MAX_SHARE);
  if (taperLength <= 0) return [...widths];
  return widths.map((width, index) => width
    * taperEase(arc[index]! / taperLength)
    * taperEase((total - arc[index]!) / taperLength));
}

/** Widths for the brush pen's shaped samples, including endpoint taper. */
export function brushSampleWidths(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): number[] {
  if (points.length === 0) return [];
  const shaped = shapedSampleWidths(points, options);
  return taperWidths(shaped.widths, shaped.arc, options.width);
}

function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function smoothSegments(points: readonly BrushPoint[]): SmoothSegment[] {
  const out: SmoothSegment[] = [];
  if (points.length < 2) return out;
  let previous = points[0]!;
  let lastMidpoint: Point2 | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]!;
    const middle = midpoint(previous, current);
    out.push({
      from: lastMidpoint ?? { x: previous.x, y: previous.y },
      ctrl: { x: previous.x, y: previous.y },
      to: middle
    });
    lastMidpoint = middle;
    previous = current;
  }
  out.push({
    from: lastMidpoint!,
    ctrl: { x: previous.x, y: previous.y },
    to: { x: previous.x, y: previous.y }
  });
  return out;
}

function quadraticAt(segment: SmoothSegment, t: number): Point2 {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * segment.from.x
      + 2 * inverse * t * segment.ctrl.x
      + t * t * segment.to.x,
    y: inverse * inverse * segment.from.y
      + 2 * inverse * t * segment.ctrl.y
      + t * t * segment.to.y
  };
}

function subdivisionsFor(segment: SmoothSegment): number {
  const ax = segment.to.x - segment.from.x;
  const ay = segment.to.y - segment.from.y;
  const cx = segment.ctrl.x - segment.from.x;
  const cy = segment.ctrl.y - segment.from.y;
  const chord = Math.hypot(ax, ay);
  const distance = chord < 1e-9
    ? Math.hypot(cx, cy)
    : Math.abs(cx * ay - cy * ax) / chord;
  const deviation = distance / 2;
  if (!Number.isFinite(deviation) || deviation <= FLATTEN_TOLERANCE_PX) return 1;
  return Math.max(1, Math.min(MAX_SUBDIVISIONS, Math.ceil(Math.sqrt(deviation / FLATTEN_TOLERANCE_PX))));
}

function flattenSegment(
  segment: SmoothSegment,
  halfWidthFrom: number,
  halfWidthTo: number
): RibbonPoint[] {
  const subdivisions = subdivisionsFor(segment);
  const out: RibbonPoint[] = [];
  for (let index = 1; index <= subdivisions; index += 1) {
    const t = index / subdivisions;
    const point = quadraticAt(segment, t);
    out.push({
      x: point.x,
      y: point.y,
      halfWidth: halfWidthFrom + (halfWidthTo - halfWidthFrom) * t
    });
  }
  return out;
}

function applyRibbonTaper(ribbon: RibbonPoint[], baseWidth: number): void {
  if (ribbon.length < 2) return;
  let total = 0;
  const arc: number[] = [0];
  for (let index = 1; index < ribbon.length; index += 1) {
    total += Math.hypot(ribbon[index]!.x - ribbon[index - 1]!.x, ribbon[index]!.y - ribbon[index - 1]!.y);
    arc.push(total);
  }
  if (total < baseWidth) return;
  const taperLength = Math.min(TAPER_WIDTHS * Math.max(baseWidth, 0.01), total * TAPER_MAX_SHARE);
  if (taperLength <= 0) return;
  for (let index = 0; index < ribbon.length; index += 1) {
    ribbon[index]!.halfWidth *= taperEase(arc[index]! / taperLength)
      * taperEase((total - arc[index]!) / taperLength);
  }
}

function ribbonFor(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): RibbonPoint[] {
  if (points.length === 0) return [];
  const shaped = shapedSampleWidths(points, options);
  if (points.length === 1) return [{
    x: points[0]!.x,
    y: points[0]!.y,
    halfWidth: shaped.widths[0]! / 2
  }];

  const halfWidths = shaped.widths.map((width) => width / 2);
  const segments = smoothSegments(points);
  const ribbon: RibbonPoint[] = [{
    x: segments[0]!.from.x,
    y: segments[0]!.from.y,
    halfWidth: halfWidths[0]!
  }];
  const last = points.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    const from = index === 0
      ? halfWidths[0]!
      : (halfWidths[index - 1]! + halfWidths[Math.min(index, last)]!) / 2;
    const to = index >= last
      ? halfWidths[last]!
      : (halfWidths[index]! + halfWidths[index + 1]!) / 2;
    ribbon.push(...flattenSegment(segments[index]!, from, to));
  }
  applyRibbonTaper(ribbon, options.width);
  return ribbon;
}

function ribbonSides(ribbon: readonly RibbonPoint[]): { left: Point2[]; right: Point2[] } {
  const left: Point2[] = [];
  const right: Point2[] = [];
  for (let index = 0; index < ribbon.length; index += 1) {
    const previous = ribbon[Math.max(0, index - 1)]!;
    const next = ribbon[Math.min(ribbon.length - 1, index + 1)]!;
    const current = ribbon[index]!;
    let tx = next.x - previous.x;
    let ty = next.y - previous.y;
    const length = Math.hypot(tx, ty);
    if (length < 1e-9) {
      tx = 1;
      ty = 0;
    } else {
      tx /= length;
      ty /= length;
    }
    const nx = -ty;
    const ny = tx;
    left.push({ x: current.x + nx * current.halfWidth, y: current.y + ny * current.halfWidth });
    right.push({ x: current.x - nx * current.halfWidth, y: current.y - ny * current.halfWidth });
  }
  return { left, right };
}

function jointIndices(ribbon: readonly RibbonPoint[]): number[] {
  const joints: number[] = [];
  for (let index = 1; index < ribbon.length - 1; index += 1) {
    const previous = ribbon[index - 1]!;
    const current = ribbon[index]!;
    const next = ribbon[index + 1]!;
    const ux = current.x - previous.x;
    const uy = current.y - previous.y;
    const vx = next.x - current.x;
    const vy = next.y - current.y;
    const firstLength = Math.hypot(ux, uy);
    const secondLength = Math.hypot(vx, vy);
    if (firstLength < 1e-9 || secondLength < 1e-9) continue;
    const cosine = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (firstLength * secondLength)));
    if (Math.acos(cosine) * 180 / Math.PI >= 12) joints.push(index);
  }
  return joints;
}

function addDisc(
  context: CanvasRenderingContext2D,
  point: RibbonPoint,
  coordinateScale: number
): void {
  const radius = Math.max(0.2 * coordinateScale, point.halfWidth);
  context.moveTo(point.x + radius, point.y);
  context.arc(point.x, point.y, radius, 0, Math.PI * 2, true);
}

/**
 * Draw a brush as one filled, smoothed ribbon. All quads and cap/join discs
 * share one fill so overlapping samples do not darken or bead the edge.
 */
export function drawBrushStroke(
  context: CanvasRenderingContext2D,
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): void {
  if (!points.length) return;
  const coordinateScale = normalizedCoordinateScale(options.coordinateScale);
  const ribbon = ribbonFor(points, options);
  context.save();
  context.globalAlpha = options.opacity;
  context.fillStyle = options.color;

  if (ribbon.length === 1) {
    context.beginPath();
    addDisc(context, ribbon[0]!, coordinateScale);
    context.fill();
    context.restore();
    return;
  }

  const sides = ribbonSides(ribbon);
  context.beginPath();
  for (let index = 0; index < ribbon.length - 1; index += 1) {
    const leftStart = sides.left[index]!;
    const leftEnd = sides.left[index + 1]!;
    const rightEnd = sides.right[index + 1]!;
    const rightStart = sides.right[index]!;
    context.moveTo(leftStart.x, leftStart.y);
    context.lineTo(leftEnd.x, leftEnd.y);
    context.lineTo(rightEnd.x, rightEnd.y);
    context.lineTo(rightStart.x, rightStart.y);
  }
  addDisc(context, ribbon[0]!, coordinateScale);
  for (const index of jointIndices(ribbon)) addDisc(context, ribbon[index]!, coordinateScale);
  addDisc(context, ribbon[ribbon.length - 1]!, coordinateScale);
  context.fill();
  context.restore();
}

export interface BrushRibbonSample {
  x: number;
  y: number;
  radius: number;
}

/** The same flattened ribbon samples used by the canvas renderer. */
export function brushRibbonSamples(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): BrushRibbonSample[] {
  return ribbonFor(points, options).map((point) => ({
    x: point.x,
    y: point.y,
    radius: Math.max(0.125, point.halfWidth)
  }));
}

/** Segment widths used by flattened PDF export. */
export function brushSegmentWidths(
  points: readonly BrushPoint[],
  options: BrushStrokeOptions
): Array<{ start: BrushPoint; end: BrushPoint; thickness: number }> {
  const ribbon = ribbonFor(points, options);
  const toPoint = (point: RibbonPoint): BrushPoint => ({
    x: point.x,
    y: point.y,
    pressure: 0.5
  });
  const segments: Array<{ start: BrushPoint; end: BrushPoint; thickness: number }> = [];
  for (let index = 1; index < ribbon.length; index += 1) {
    segments.push({
      start: toPoint(ribbon[index - 1]!),
      end: toPoint(ribbon[index]!),
      thickness: ribbon[index - 1]!.halfWidth + ribbon[index]!.halfWidth
    });
  }
  return segments;
}
