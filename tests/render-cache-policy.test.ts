import { describe, expect, it } from "vitest";
import {
  DENSE_ZOOM_RASTER_FALLBACK_STROKES,
  deferredRenderDisposition,
  renderCacheBudget,
  renderCacheKey,
  renderCacheStale,
  repaintPlan,
  shouldUseDenseZoomRasterFallback,
  retainAfterMemoryPressure
} from "../src/runtime/renderCachePolicy";

const key = {
  documentId: "pdf-1",
  pageNumber: 2,
  scale: 1,
  rotation: 0,
  contentRevision: 4,
  rendererGeneration: 1
};

describe("render cache policy", () => {
  it("invalidates a cache key when page identity, geometry, content, or generation changes", () => {
    const current = renderCacheKey(key);
    expect(current).toEqual(key);
    expect(renderCacheKey({ ...key, documentId: "" })).toBeNull();
    expect(renderCacheKey({ ...key, scale: Number.NaN })).toBeNull();
    expect(renderCacheStale(key, key)).toBe(false);
    expect(renderCacheStale(key, { ...key, pageNumber: 3 })).toBe(true);
    expect(renderCacheStale(key, { ...key, scale: 2 })).toBe(true);
    expect(renderCacheStale(key, { ...key, rotation: 90 })).toBe(true);
    expect(renderCacheStale(key, { ...key, contentRevision: 5 })).toBe(true);
    expect(renderCacheStale(key, { ...key, rendererGeneration: 2 })).toBe(true);
    expect(renderCacheStale(key, { ...key, documentId: "pdf-2" })).toBe(true);
  });

  it("uses dirty rectangles and falls back to a full page when none are finite", () => {
    expect(repaintPlan([])).toEqual({ mode: "full-page", reason: "no-dirty-region" });
    expect(repaintPlan([{ minX: 1, minY: 2, maxX: Number.NaN, maxY: 4 }])).toEqual({
      mode: "full-page",
      reason: "no-dirty-region"
    });
    expect(repaintPlan([{ minX: 1, minY: 2, maxX: 8, maxY: 9 }])).toEqual({
      mode: "dirty-region",
      rects: [{ minX: 1, minY: 2, maxX: 8, maxY: 9 }]
    });
  });

  it("keeps a dense captured raster for same-size zoom release frames", () => {
    const input = {
      canonicalZoomSettle: true,
      strokeCount: DENSE_ZOOM_RASTER_FALLBACK_STROKES,
      needsResize: false,
      canBlit: true,
      layerValid: true,
      layerMatchesBacking: true,
      erasingLive: false,
      movingSelection: false,
      livePreview: false
    };
    expect(shouldUseDenseZoomRasterFallback(input)).toBe(true);
    expect(shouldUseDenseZoomRasterFallback({ ...input, strokeCount: input.strokeCount - 1 })).toBe(false);
    expect(shouldUseDenseZoomRasterFallback({ ...input, needsResize: true })).toBe(false);
    expect(shouldUseDenseZoomRasterFallback({ ...input, livePreview: true })).toBe(false);
  });

  it("cancels deferred HQ when the ink-layer epoch moves and still runs wet input", () => {
    expect(deferredRenderDisposition("hq", 1, 2)).toBe("cancel");
    expect(deferredRenderDisposition("hq", 2, 2)).toBe("run");
    expect(deferredRenderDisposition("wet", 1, 2)).toBe("run");
    expect(deferredRenderDisposition("finalized", 1, 2)).toBe("run");
  });

  it("drops offscreen raster under pressure without a byte cap or system memory query", () => {
    const budget = renderCacheBudget();
    expect(budget.byteCap.status).toBe("unqualified");
    expect(JSON.stringify(budget)).not.toMatch(/"bytes":/);
    const result = retainAfterMemoryPressure([
      { id: "visible", pageNumber: 1, kind: "raster", lastUsed: 1, visible: true },
      { id: "old", pageNumber: 2, kind: "raster", lastUsed: 1, visible: false },
      { id: "new", pageNumber: 3, kind: "raster", lastUsed: 5, visible: false },
      { id: "model", pageNumber: 2, kind: "model", lastUsed: 0, visible: false }
    ]);
    expect(result.evicted.map((entry) => entry.id)).toEqual(["old", "new"]);
    expect(result.kept.map((entry) => entry.id)).toEqual(["visible", "model"]);
  });
});
