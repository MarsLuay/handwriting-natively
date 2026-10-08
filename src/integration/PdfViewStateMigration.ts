import type { ViewerState } from "../runtime/AnnotationSurface";

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function scaleFromLegacyZoom(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const percent = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) return Number(percent[1]) / 100;
  return finiteNumber(value);
}

/** Translate Obsidian PDFView's `{page,left,top,zoom}` state into plugin state. */
export function nativePdfViewStateFromLegacyState(state: Record<string, unknown>): ViewerState | undefined {
  const pageNumber = finiteNumber(state.pageNumber) ?? finiteNumber(state.page);
  const left = finiteNumber(state.left) ?? 0;
  const top = finiteNumber(state.top) ?? 0;
  const zoom = scaleFromLegacyZoom(state.zoom);
  const zoomValue = typeof state.zoom === "string" ? state.zoom.trim().toLowerCase() : undefined;
  const scaleMode = zoomValue === "page-width" || zoomValue === "auto"
    ? "fit-width"
    : zoomValue === "page-height"
      ? "fit-height"
    : zoomValue === "page-fit"
      ? "fit-page"
      : "custom";
  const scale = zoom && zoom > 0 ? zoom : 1;
  const rotation = finiteNumber(state.rotation) ?? 0;

  if (pageNumber === undefined && left === 0 && top === 0 && zoom === undefined && !zoomValue && rotation === 0) return undefined;
  return {
    pageNumber: Math.max(1, Math.round(pageNumber ?? 1)),
    viewport: { scale, x: Math.max(0, left), y: Math.max(0, top) },
    scale,
    scaleMode,
    rotation,
    scrollFraction: 0
  };
}
