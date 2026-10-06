import { describe, expect, it } from "vitest";
import {
  inkVisibilityCause,
  inkVisibilityFlash,
  probeInkCanvas,
  replacementInkReady,
  replacementInkReadyForActivePages,
  type InkVisibilitySnapshot
} from "../src/runtime/InkVisibility";

function snapshot(overrides: Partial<InkVisibilitySnapshot> = {}): InkVisibilitySnapshot {
  return {
    pageNumber: 1,
    phase: "before-composite-release",
    modelStrokeCount: 4,
    overlayConnected: true,
    overlayDisplay: "block",
    overlayVisibility: "visible",
    overlayOpacity: "1",
    compositingClassPresent: true,
    canvasConnected: true,
    canvasWidth: 800,
    canvasHeight: 1000,
    canonicalPaintComplete: true,
    canonicalPaintDeferred: false,
    pixelProbeRan: true,
    pixelProbeHasInk: true,
    pixelProbeNonTransparentSamples: 3,
    pixelProbeSampleCount: 16,
    pixelProbeBounds: { x: 0, y: 0, width: 800, height: 1000 },
    pixelProbeFailureReason: null,
    ...overrides
  };
}

describe("ink visibility", () => {
  it("samples a grid without reading every pixel and ignores a blank page with no strokes", () => {
    const probe = probeInkCanvas({
      width: 100,
      height: 80,
      readAlpha: (x, y) => (x === 0 && y === 0 ? 255 : 0)
    });
    expect(probe.pixelProbeRan).toBe(true);
    expect(probe.pixelProbeHasInk).toBe(true);
    expect(probe.pixelProbeSampleCount).toBeLessThanOrEqual(64);
    expect(inkVisibilityCause(snapshot({ modelStrokeCount: 0, pixelProbeHasInk: false }))).toBeNull();
    expect(inkVisibilityFlash({
      previousHasInk: true,
      current: snapshot({ modelStrokeCount: 0, pixelProbeHasInk: false })
    })).toBeNull();
  });

  it("names a one-frame blank and refuses to release until replacement ink is ready", () => {
    expect(inkVisibilityCause(snapshot({ pixelProbeHasInk: false, pixelProbeNonTransparentSamples: 0 }))).toBe("canvas-cleared");
    expect(inkVisibilityCause(snapshot({ canvasWidth: 0, canvasHeight: 0, pixelProbeRan: false }))).toBe("canvas-zero-size");
    expect(inkVisibilityCause(snapshot({ overlayConnected: false }))).toBe("overlay-detached");
    expect(inkVisibilityCause(snapshot({
      phase: "after-final-canonical",
      canonicalPaintComplete: false,
      pixelProbeRan: false
    }))).toBe("canonical-rebase-blank");
    const flash = inkVisibilityFlash({
      previousHasInk: true,
      current: snapshot({
        phase: "post-composite-release-frame-1",
        pixelProbeHasInk: false,
        pixelProbeNonTransparentSamples: 0
      }),
      nextHasInk: true
    });
    expect(flash).toMatchObject({
      event: "ink-visibility-flash",
      phase: "post-composite-release-frame-1",
      cause: "canvas-cleared",
      previousPhasePixelProbeHasInk: true,
      nextPhasePixelProbeHasInk: true
    });
    // A coarse-grid miss is not proof that sparse ink is absent when the
    // canonical layer (or an explicitly retained zoom raster) is ready.
    expect(replacementInkReady(snapshot({ pixelProbeHasInk: false, pixelProbeNonTransparentSamples: 0 }))).toBe(true);
    expect(replacementInkReady(snapshot({
      canonicalPaintComplete: false,
      canonicalPaintDeferred: true,
      pixelProbeHasInk: false,
      pixelProbeNonTransparentSamples: 0
    }))).toBe(true);
    expect(replacementInkReady(snapshot({
      canonicalPaintComplete: false,
      canonicalPaintDeferred: false,
      pixelProbeHasInk: false,
      pixelProbeNonTransparentSamples: 0
    }))).toBe(false);
    expect(replacementInkReady(snapshot())).toBe(true);
    expect(replacementInkReady(snapshot({ pixelProbeRan: false, canonicalPaintComplete: true }))).toBe(true);
  });

  it("does not let an unrendered offscreen page hold the active page release", () => {
    const active = snapshot({ pageNumber: 1 });
    const offscreen = snapshot({
      pageNumber: 2,
      overlayConnected: false,
      canvasConnected: false,
      canvasWidth: 0,
      canvasHeight: 0,
      pixelProbeRan: false
    });

    expect(replacementInkReadyForActivePages([active, offscreen], 1)).toBe(true);
    expect(replacementInkReadyForActivePages([active, offscreen], 2)).toBe(false);
  });
});
