import type { InkStroke, PdfPoint } from "../model";

export interface SvgInkExportPageMetrics {
  page: number;
  width: number;
  height: number;
}

export interface SvgInkExportOptions {
  /**
   * Page dimensions in the same coordinate space as the ink.  Supplying them
   * preserves the original page bounds; otherwise each exported page is tight
   * to its selected ink.
   */
  pageMetrics?: readonly SvgInkExportPageMetrics[];
  /** Whitespace around the composed page stack, in ink-space units. */
  padding?: number;
  /** Vertical whitespace between selected pages, in ink-space units. */
  pageGap?: number;
  /**
   * Convert the recorded normalized pressure into a variable-width filled
   * ribbon.  This does not alter sidecar data; it only controls this export.
   */
  pressureAware?: boolean;
}

export interface SvgInkExportBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface SvgInkExportPage {
  page: number;
  /** Translation from source page coordinates into the composed SVG. */
  translateX: number;
  translateY: number;
  width: number;
  height: number;
}

export interface SvgInkExportResult {
  svg: string;
  /** Bounds of the composed SVG coordinate space. */
  bounds: SvgInkExportBounds;
  pages: readonly SvgInkExportPage[];
  strokeCount: number;
}

interface ValidStroke {
  stroke: InkStroke;
  page: number;
  points: PdfPoint[];
  radii: number[];
  bounds: SvgInkExportBounds;
}

interface SourcePage {
  page: number;
  strokes: ValidStroke[];
  bounds: SvgInkExportBounds;
}

const EMPTY_BOUNDS: SvgInkExportBounds = {
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
  width: 0,
  height: 0
};

/**
 * Produce a self-contained SVG for selected strokes without changing the PDF
 * or the canonical sidecar JSON.  Multiple pages are composed vertically so
 * their independent page coordinate systems cannot overlap.
 */
export function exportInkStrokesToSvg(
  strokes: readonly InkStroke[],
  options: SvgInkExportOptions = {}
): SvgInkExportResult {
  const padding = nonNegativeFinite(options.padding, 16);
  const pageGap = nonNegativeFinite(options.pageGap, 24);
  const pressureAware = options.pressureAware ?? true;
  const validStrokes = strokes
    .map((stroke) => validStroke(stroke, pressureAware))
    .filter((stroke): stroke is ValidStroke => stroke !== null)
    .sort(compareStrokes);

  if (!validStrokes.length) return emptyResult();

  const metrics = new Map<number, SvgInkExportPageMetrics>();
  for (const metric of options.pageMetrics ?? []) {
    if (!Number.isFinite(metric.page) || !positiveFinite(metric.width) || !positiveFinite(metric.height)) continue;
    metrics.set(normalizePage(metric.page), metric);
  }

  const sourcePages = groupPages(validStrokes, metrics);
  const layout = layoutPages(sourcePages, padding, pageGap);
  const paths = sourcePages.flatMap((page) => {
    const placement = layout.pages.find((item) => item.page === page.page)!;
    const content = page.strokes.map((stroke, index) => strokeElement(stroke, index, pressureAware)).join("\n");
    return [`  <g id="ink-page-${formatNumber(page.page)}" data-page="${formatNumber(page.page)}" transform="translate(${formatNumber(placement.translateX)} ${formatNumber(placement.translateY)})">`, content, "  </g>"];
  });
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(layout.bounds.width)}" height="${formatNumber(layout.bounds.height)}" viewBox="0 0 ${formatNumber(layout.bounds.width)} ${formatNumber(layout.bounds.height)}" role="img" aria-label="Selected PDF ink">`,
    ...paths,
    "</svg>",
    ""
  ].join("\n");
  return { svg, bounds: layout.bounds, pages: layout.pages, strokeCount: validStrokes.length };
}

function emptyResult(): SvgInkExportResult {
  return {
    svg: [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\" viewBox=\"0 0 1 1\" role=\"img\" aria-label=\"Selected PDF ink\" data-empty=\"true\">",
      "</svg>",
      ""
    ].join("\n"),
    bounds: { ...EMPTY_BOUNDS },
    pages: [],
    strokeCount: 0
  };
}

function groupPages(strokes: readonly ValidStroke[], metrics: ReadonlyMap<number, SvgInkExportPageMetrics>): SourcePage[] {
  const byPage = new Map<number, ValidStroke[]>();
  for (const stroke of strokes) {
    const page = byPage.get(stroke.page);
    if (page) page.push(stroke);
    else byPage.set(stroke.page, [stroke]);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, pageStrokes]) => {
      const metric = metrics.get(page);
      const bounds = metric
        ? boundsFromExtent(0, 0, metric.width, metric.height)
        : combineBounds(pageStrokes.map((stroke) => stroke.bounds));
      return { page, strokes: pageStrokes, bounds };
    });
}

function layoutPages(pages: readonly SourcePage[], padding: number, pageGap: number): {
  bounds: SvgInkExportBounds;
  pages: SvgInkExportPage[];
} {
  let cursorY = padding;
  let widest = 0;
  const result: SvgInkExportPage[] = [];
  for (const page of pages) {
    const width = Math.max(0, page.bounds.width);
    const height = Math.max(0, page.bounds.height);
    result.push({
      page: page.page,
      translateX: padding - page.bounds.minX,
      translateY: cursorY - page.bounds.minY,
      width,
      height
    });
    widest = Math.max(widest, width);
    cursorY += height + pageGap;
  }
  const totalHeight = Math.max(1, cursorY - pageGap + padding);
  const totalWidth = Math.max(1, widest + padding * 2);
  return { bounds: boundsFromExtent(0, 0, totalWidth, totalHeight), pages: result };
}

function validStroke(stroke: InkStroke, pressureAware: boolean): ValidStroke | null {
  const points = stroke.points.filter(isFinitePoint);
  if (!points.length) return null;
  const width = positiveFinite(stroke.width) ? stroke.width : 1;
  const radii = points.map((point) => strokeRadius(stroke, point, width, pressureAware));
  const minX = Math.min(...points.map((point, index) => point.x - radii[index]!));
  const minY = Math.min(...points.map((point, index) => point.y - radii[index]!));
  const maxX = Math.max(...points.map((point, index) => point.x + radii[index]!));
  const maxY = Math.max(...points.map((point, index) => point.y + radii[index]!));
  return {
    stroke,
    page: normalizePage(stroke.page),
    points,
    radii,
    bounds: boundsFromExtent(minX, minY, maxX, maxY)
  };
}

function strokeRadius(stroke: InkStroke, point: PdfPoint, width: number, pressureAware: boolean): number {
  if (!pressureAware || stroke.tool === "highlighter") return Math.max(0.125, width / 2);
  const pressure = clamp01(Number.isFinite(point.pressure) ? point.pressure : 0.5);
  const floor = stroke.tool === "pencil" ? 0.35 : 0.15;
  return Math.max(0.125, width * (floor + (1 - floor) * pressure) / 2);
}

function strokeElement(stroke: ValidStroke, index: number, pressureAware: boolean): string {
  const id = `ink-stroke-page-${formatNumber(stroke.page)}-${index + 1}`;
  const common = `id="${id}" data-stroke-id="${escapeXml(stroke.stroke.id)}" data-page="${formatNumber(stroke.page)}" data-tool="${escapeXml(stroke.stroke.tool)}" data-base-width="${formatNumber(normalizedWidth(stroke.stroke.width))}"`;
  const color = escapeXml(stroke.stroke.color || "#000000");
  const opacity = formatNumber(clamp01(stroke.stroke.opacity));
  if (!pressureAware) {
    return `    <path ${common} d="${centerlinePath(stroke.points)}" fill="none" stroke="${color}" stroke-width="${formatNumber(normalizedWidth(stroke.stroke.width))}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
  }
  return `    <path ${common} d="${ribbonPath(stroke.points, stroke.radii)}" fill="${color}" fill-rule="nonzero" opacity="${opacity}"/>`;
}

function centerlinePath(points: readonly PdfPoint[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ");
}

/** A single filled union avoids alpha-darkened overlaps between pressure samples. */
function ribbonPath(points: readonly PdfPoint[], radii: readonly number[]): string {
  if (points.length === 1) return circlePath(points[0]!.x, points[0]!.y, radii[0]!);
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const tangent = tangentAt(points, index);
    const radius = radii[index]!;
    const normalX = -tangent.y;
    const normalY = tangent.x;
    left.push({ x: points[index]!.x + normalX * radius, y: points[index]!.y + normalY * radius });
    right.push({ x: points[index]!.x - normalX * radius, y: points[index]!.y - normalY * radius });
  }
  const outline = [
    `M${pointPair(left[0]!)}`,
    ...left.slice(1).map((point) => `L${pointPair(point)}`),
    ...right.slice().reverse().map((point) => `L${pointPair(point)}`),
    "Z"
  ].join(" ");
  return `${outline} ${points.map((point, index) => circlePath(point.x, point.y, radii[index]!)).join(" ")}`;
}

function tangentAt(points: readonly PdfPoint[], index: number): { x: number; y: number } {
  const point = points[index]!;
  const previous = points[index - 1] ?? point;
  const next = points[index + 1] ?? point;
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
}

function circlePath(x: number, y: number, radius: number): string {
  const left = formatNumber(x - radius);
  const right = formatNumber(x + radius);
  const cy = formatNumber(y);
  const r = formatNumber(radius);
  return `M${left} ${cy} A${r} ${r} 0 1 0 ${right} ${cy} A${r} ${r} 0 1 0 ${left} ${cy} Z`;
}

function pointPair(point: { x: number; y: number }): string {
  return `${formatNumber(point.x)} ${formatNumber(point.y)}`;
}

function compareStrokes(a: ValidStroke, b: ValidStroke): number {
  if (a.page !== b.page) return a.page - b.page;
  const created = a.stroke.createdAt.localeCompare(b.stroke.createdAt);
  return created || a.stroke.id.localeCompare(b.stroke.id);
}

function combineBounds(bounds: readonly SvgInkExportBounds[]): SvgInkExportBounds {
  return boundsFromExtent(
    Math.min(...bounds.map((bound) => bound.minX)),
    Math.min(...bounds.map((bound) => bound.minY)),
    Math.max(...bounds.map((bound) => bound.maxX)),
    Math.max(...bounds.map((bound) => bound.maxY))
  );
}

function boundsFromExtent(minX: number, minY: number, maxX: number, maxY: number): SvgInkExportBounds {
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function isFinitePoint(point: PdfPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function normalizePage(page: number): number {
  return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
}

function normalizedWidth(width: number): number {
  return positiveFinite(width) ? width : 1;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

function formatNumber(value: number): string {
  const normalized = Math.abs(value) < 0.0000005 ? 0 : Math.round(value * 1_000_000) / 1_000_000;
  return normalized.toFixed(6).replace(/(?:\.0+|(?<fraction>\.\d*?)0+)$/, "$1");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;"
  })[character]!);
}
