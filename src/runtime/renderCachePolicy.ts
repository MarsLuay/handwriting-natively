export interface RenderCacheKey {
  readonly documentId: string;
  readonly pageNumber: number;
  readonly scale: number;
  readonly rotation: number;
  readonly contentRevision: number;
  readonly rendererGeneration: number;
}

export interface DirtyRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type RepaintPlan =
  | { readonly mode: "dirty-region"; readonly rects: readonly DirtyRect[] }
  | { readonly mode: "full-page"; readonly reason: "no-dirty-region" };

export type RenderStage = "wet" | "finalized" | "hq";
export type RenderDisposition = "run" | "cancel";

export interface RasterCacheEntry {
  readonly id: string;
  readonly pageNumber: number;
  readonly kind: "raster" | "vector" | "model";
  readonly lastUsed: number;
  readonly visible: boolean;
}

export interface RenderCacheBudget {
  readonly byteCap: { readonly status: "unqualified"; readonly reason: string };
  readonly eviction: "offscreen-raster-lru-first";
  readonly keep: readonly ["visible-page", "model"];
}

/** Normalizes a cache key. Non-finite geometry cannot match a stored entry. */
export function renderCacheKey(input: RenderCacheKey): RenderCacheKey | null {
  if (!input.documentId) return null;
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) return null;
  if (![input.scale, input.rotation, input.contentRevision, input.rendererGeneration].every(Number.isFinite)) return null;
  return { ...input };
}

export function renderCacheStale(cached: RenderCacheKey, current: RenderCacheKey): boolean {
  return cached.documentId !== current.documentId
    || cached.pageNumber !== current.pageNumber
    || cached.scale !== current.scale
    || cached.rotation !== current.rotation
    || cached.contentRevision !== current.contentRevision
    || cached.rendererGeneration !== current.rendererGeneration;
}

/** Dirty rectangles repaint locally. No finite damage means a full-page fallback. */
export function repaintPlan(rects: readonly DirtyRect[]): RepaintPlan {
  const finite = rects.filter((rect) => (
    [rect.minX, rect.minY, rect.maxX, rect.maxY].every(Number.isFinite)
    && rect.minX <= rect.maxX
    && rect.minY <= rect.maxY
  ));
  if (finite.length === 0) return { mode: "full-page", reason: "no-dirty-region" };
  return { mode: "dirty-region", rects: finite };
}

/**
 * Wet samples always run. Finalized paint runs so a commit is not dropped.
 * Deferred HQ cancels when the ink-layer epoch moved.
 */
export function deferredRenderDisposition(
  stage: RenderStage,
  workEpoch: number,
  currentEpoch: number
): RenderDisposition {
  if (stage === "hq" && workEpoch !== currentEpoch) return "cancel";
  return "run";
}

export function renderCacheBudget(): RenderCacheBudget {
  return {
    byteCap: {
      status: "unqualified",
      reason: "byte caps stay unqualified until a constrained-device trace records pressure or allocation failure"
    },
    eviction: "offscreen-raster-lru-first",
    keep: ["visible-page", "model"]
  };
}

/** Drops offscreen raster by least-recent use. Visible pages and the model stay. */
export function retainAfterMemoryPressure(entries: readonly RasterCacheEntry[]): {
  kept: RasterCacheEntry[];
  evicted: RasterCacheEntry[];
} {
  const evictIds = new Set(
    entries
      .filter((entry) => entry.kind === "raster" && !entry.visible)
      .sort((left, right) => left.lastUsed - right.lastUsed)
      .map((entry) => entry.id)
  );
  const kept: RasterCacheEntry[] = [];
  const evicted: RasterCacheEntry[] = [];
  for (const entry of entries) {
    if (evictIds.has(entry.id)) evicted.push(entry);
    else kept.push(entry);
  }
  return { kept, evicted };
}
