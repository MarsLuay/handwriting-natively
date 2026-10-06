/** Diagnostic-only ink canvas checks around zoom handoff. Not a full-canvas scan. */

export const INK_VISIBILITY_SAMPLE_CAP = 64;

export type InkVisibilityPhase =
  | "before-final-canonical"
  | "after-final-canonical"
  | "before-composite-release"
  | "post-composite-release-frame-1"
  | "post-composite-release-frame-2";

export type InkVisibilityCause =
  | "overlay-detached"
  | "overlay-hidden"
  | "canvas-zero-size"
  | "canvas-cleared"
  | "compositor-released-early"
  | "canonical-rebase-blank";

export interface InkPixelProbe {
  pixelProbeRan: boolean;
  pixelProbeHasInk: boolean;
  pixelProbeNonTransparentSamples: number;
  pixelProbeSampleCount: number;
  pixelProbeBounds: { x: number; y: number; width: number; height: number } | null;
  pixelProbeFailureReason: string | null;
  overlayRect?: { x: number; y: number; width: number; height: number };
}

export interface InkVisibilitySnapshot extends InkPixelProbe {
  pageNumber: number;
  phase: InkVisibilityPhase;
  modelStrokeCount: number;
  overlayConnected: boolean;
  overlayDisplay: string;
  overlayVisibility: string;
  overlayOpacity: string;
  compositingClassPresent: boolean;
  canvasConnected: boolean;
  canvasWidth: number;
  canvasHeight: number;
  canonicalPaintComplete: boolean;
  /** True when visible raster ink is safe for release while vector HQ paint is deferred. */
  canonicalPaintDeferred: boolean;
}

/** Sample a coarse grid. `readAlpha` returns null when the canvas cannot be read. */
export function probeInkCanvas(input: {
  width: number;
  height: number;
  readAlpha: (x: number, y: number) => number | null;
  maxSamples?: number;
}): InkPixelProbe {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  if (width < 1 || height < 1) {
    return {
      pixelProbeRan: false,
      pixelProbeHasInk: false,
      pixelProbeNonTransparentSamples: 0,
      pixelProbeSampleCount: 0,
      pixelProbeBounds: null,
      pixelProbeFailureReason: "canvas-zero-size"
    };
  }
  const columns = 8;
  const rows = 8;
  const cap = Math.min(input.maxSamples ?? INK_VISIBILITY_SAMPLE_CAP, columns * rows);
  let nonTransparent = 0;
  let sampleCount = 0;
  let failure: string | null = null;
  const stepX = Math.max(1, Math.floor(width / columns));
  const stepY = Math.max(1, Math.floor(height / rows));
  for (let row = 0; row < rows && sampleCount < cap; row += 1) {
    for (let column = 0; column < columns && sampleCount < cap; column += 1) {
      const x = Math.min(width - 1, column * stepX);
      const y = Math.min(height - 1, row * stepY);
      const alpha = input.readAlpha(x, y);
      if (alpha == null) {
        failure = "pixel-read-failed";
        break;
      }
      sampleCount += 1;
      if (alpha > 0) nonTransparent += 1;
    }
    if (failure) break;
  }
  return {
    pixelProbeRan: failure == null && sampleCount > 0,
    pixelProbeHasInk: nonTransparent > 0,
    pixelProbeNonTransparentSamples: nonTransparent,
    pixelProbeSampleCount: sampleCount,
    pixelProbeBounds: { x: 0, y: 0, width, height },
    pixelProbeFailureReason: failure
  };
}

/** Why a page that still has strokes does not look painted. Zero strokes are not a flash. */
export function inkVisibilityCause(snapshot: InkVisibilitySnapshot): InkVisibilityCause | null {
  if (snapshot.modelStrokeCount <= 0) return null;
  if (!snapshot.overlayConnected) return "overlay-detached";
  if (hidden(snapshot.overlayDisplay, snapshot.overlayVisibility, snapshot.overlayOpacity)) return "overlay-hidden";
  if (!snapshot.canvasConnected || snapshot.canvasWidth <= 0 || snapshot.canvasHeight <= 0) return "canvas-zero-size";
  if (snapshot.phase === "after-final-canonical" && !snapshot.canonicalPaintComplete && !snapshot.canonicalPaintDeferred) {
    return "canonical-rebase-blank";
  }
  if (
    snapshot.phase === "before-composite-release"
    && !snapshot.compositingClassPresent
    && !snapshot.canonicalPaintComplete
    && !snapshot.canonicalPaintDeferred
  ) return "compositor-released-early";
  if (snapshot.pixelProbeRan && !snapshot.pixelProbeHasInk) return "canvas-cleared";
  return null;
}

/**
 * Connected, non-zero canvas with canonical or retained-raster paint state.
 *
 * The coarse 8×8 probe is diagnostic evidence, not a completeness proof: it
 * routinely misses sparse handwriting on a very large zoomed canvas. A miss
 * may still report a possible flash, but it must not hold the compositor when
 * the canonical layer or an explicitly retained raster is ready.
 */
export function replacementInkReady(snapshot: InkVisibilitySnapshot): boolean {
  if (snapshot.modelStrokeCount <= 0) return snapshot.overlayConnected && snapshot.canvasWidth > 0 && snapshot.canvasHeight > 0;
  if (inkVisibilityCause(snapshot) === "overlay-detached") return false;
  if (inkVisibilityCause(snapshot) === "overlay-hidden") return false;
  if (inkVisibilityCause(snapshot) === "canvas-zero-size") return false;
  if (snapshot.pixelProbeHasInk) return true;
  return snapshot.canonicalPaintComplete || snapshot.canonicalPaintDeferred;
}

/**
 * Offscreen PDF pages may not have a connected/non-zero canvas while PDF.js is
 * virtualizing them. They must not hold the visible page's zoom handoff, but
 * the active page still fails closed until its replacement is paintable.
 */
export function replacementInkReadyForActivePages(
  snapshots: readonly InkVisibilitySnapshot[],
  activePageNumber: number
): boolean {
  return snapshots.every((snapshot) => {
    const geometryUnavailable = !snapshot.overlayConnected
      || !snapshot.canvasConnected
      || snapshot.canvasWidth <= 0
      || snapshot.canvasHeight <= 0;
    if (geometryUnavailable && snapshot.pageNumber !== activePageNumber) return true;
    return replacementInkReady(snapshot);
  });
}

export function inkVisibilityFlash(input: {
  previousHasInk: boolean | null;
  current: InkVisibilitySnapshot;
  nextHasInk?: boolean | null;
}): Record<string, unknown> | null {
  const cause = inkVisibilityCause(input.current);
  if (!cause) return null;
  if (cause === "canvas-cleared" && input.previousHasInk !== true) return null;
  return {
    event: "ink-visibility-flash",
    pageNumber: input.current.pageNumber,
    phase: input.current.phase,
    cause,
    modelStrokeCount: input.current.modelStrokeCount,
    overlayConnected: input.current.overlayConnected,
    overlayDisplay: input.current.overlayDisplay,
    overlayVisibility: input.current.overlayVisibility,
    overlayOpacity: input.current.overlayOpacity,
    compositingClassPresent: input.current.compositingClassPresent,
    canonicalPaintComplete: input.current.canonicalPaintComplete,
    canonicalPaintDeferred: input.current.canonicalPaintDeferred,
    canvasConnected: input.current.canvasConnected,
    canvasWidth: input.current.canvasWidth,
    canvasHeight: input.current.canvasHeight,
    pixelProbeRan: input.current.pixelProbeRan,
    pixelProbeHasInk: input.current.pixelProbeHasInk,
    pixelProbeNonTransparentSamples: input.current.pixelProbeNonTransparentSamples,
    pixelProbeSampleCount: input.current.pixelProbeSampleCount,
    pixelProbeFailureReason: input.current.pixelProbeFailureReason,
    previousPhasePixelProbeHasInk: input.previousHasInk,
    nextPhasePixelProbeHasInk: input.nextHasInk ?? null
  };
}

function hidden(display: string, visibility: string, opacity: string): boolean {
  if (display === "none" || visibility === "hidden") return true;
  const value = Number(opacity);
  return Number.isFinite(value) && value <= 0;
}
