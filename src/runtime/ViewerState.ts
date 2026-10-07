/**
 * Canonical ViewerState
 *
 * Single authoritative state representation across:
 * - HandwritingViewport (viewport: { scale, x, y })
 * - PdfJsViewAdapter / BasePdfAdapter (pageNumber, rotation, scaleMode, scrollFraction)
 * - PluginPdfView persistence (this.state.viewer)
 * - ViewerCommandController (viewer interaction commands)
 */

export type ViewerScaleMode = "custom" | "fit-width" | "fit-page";

export interface ViewerViewportState {
  scale: number;
  x: number;
  y: number;
}

export interface ViewerState {
  viewport: ViewerViewportState;
  pageNumber: number;
  rotation: number;
  scaleMode: ViewerScaleMode;
  /** Normalized vertical scroll fraction (0..1) for scrollers that use fraction-based restoration. */
  scrollFraction?: number | undefined;
  /** Compatibility mirror for existing call sites reading state.scale directly. */
  scale?: number | undefined;
}

export function normalizeScaleMode(mode: unknown): ViewerScaleMode {
  if (mode === "fit-width" || mode === "page-width" || mode === "auto") return "fit-width";
  if (mode === "fit-page" || mode === "page-fit") return "fit-page";
  return "custom";
}

export function normalizeRotation(degrees: unknown): number {
  const num = typeof degrees === "number" && Number.isFinite(degrees) ? degrees : 0;
  return ((Math.round(num) % 360) + 360) % 360;
}

export function createViewerState(
  init?: Partial<Omit<ViewerState, "scaleMode">> & { scaleMode?: unknown }
): ViewerState {
  const scale = init?.viewport?.scale ?? init?.scale ?? 1;
  const x = init?.viewport?.x ?? 0;
  const y = init?.viewport?.y ?? 0;
  return {
    viewport: { scale, x, y },
    pageNumber: Math.max(1, Math.round(init?.pageNumber ?? 1)),
    rotation: normalizeRotation(init?.rotation ?? 0),
    scaleMode: normalizeScaleMode(init?.scaleMode),
    ...(init?.scrollFraction !== undefined ? { scrollFraction: init.scrollFraction } : {}),
    scale
  };
}

export function cloneViewerState(state: ViewerState): ViewerState {
  return {
    viewport: { ...state.viewport },
    pageNumber: state.pageNumber,
    rotation: state.rotation,
    scaleMode: state.scaleMode,
    ...(state.scrollFraction !== undefined ? { scrollFraction: state.scrollFraction } : {}),
    scale: state.viewport.scale
  };
}

export function ensureViewerState(
  state: ViewerState | {
    scale?: number;
    pageNumber?: number;
    rotation?: number;
    scrollFraction?: number;
    scaleMode?: unknown;
    viewport?: ViewerViewportState;
  }
): ViewerState {
  const scale = state.viewport?.scale ?? state.scale ?? 1;
  const x = state.viewport?.x ?? 0;
  const y = state.viewport?.y ?? 0;
  return {
    viewport: { scale, x, y },
    pageNumber: Math.max(1, Math.round(state.pageNumber ?? 1)),
    rotation: normalizeRotation(state.rotation ?? 0),
    scaleMode: normalizeScaleMode(state.scaleMode),
    ...(state.scrollFraction !== undefined ? { scrollFraction: state.scrollFraction } : {}),
    scale
  };
}
