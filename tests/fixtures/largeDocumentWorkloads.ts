export const LARGE_DOCUMENT_BENCHMARK_VERSION = 1 as const;

export type LargeDocumentEvidenceClass = "synthetic" | "browser-emulator" | "manual-device";

export interface LargeDocumentWorkload {
  readonly id: string;
  readonly pageCount: 10 | 100 | 500 | 1000;
  readonly strokesPerPage: number;
  readonly textDensity: "none" | "mixed" | "dense";
  readonly shapeDensity: "none" | "mixed";
  readonly actions: readonly ("scroll" | "zoom" | "mutate" | "reopen")[];
  readonly requiresHardware: boolean;
}

export interface LargeDocumentWorkloadPlan extends LargeDocumentWorkload {
  readonly seed: number;
  readonly totalStrokes: number;
  readonly estimatedTextObjects: number;
  readonly estimatedShapeObjects: number;
}

export interface LargeDocumentRuntimeContext {
  readonly evidenceClass: LargeDocumentEvidenceClass;
  readonly platform: string;
  readonly device: string;
  readonly runtime: string;
  readonly dpr: number | null;
  readonly refreshRateHz: number | null;
  readonly pluginVersion: string;
  readonly hostVersion: string;
}

export interface LargeDocumentTraceSample {
  readonly workloadId: string;
  readonly pointerToRenderMs: readonly number[];
  readonly scrollZoomMs: readonly number[];
  readonly remountMs: readonly number[];
  readonly saveMs: readonly number[];
  readonly cacheBytes: number | null;
  readonly pluginOwnedMemoryBytes: number | null;
  readonly mountedPages: number;
  readonly evictions: number;
  readonly unsafeGates: number;
}

export interface LargeDocumentTrace {
  readonly schemaVersion: typeof LARGE_DOCUMENT_BENCHMARK_VERSION;
  readonly capturedAt: string;
  readonly context: LargeDocumentRuntimeContext;
  readonly workloads: readonly LargeDocumentTraceSample[];
}

export const LARGE_DOCUMENT_WORKLOADS: readonly LargeDocumentWorkload[] = [
  { id: "10-sparse", pageCount: 10, strokesPerPage: 8, textDensity: "mixed", shapeDensity: "none", actions: ["scroll", "zoom", "reopen"], requiresHardware: false },
  { id: "100-sparse", pageCount: 100, strokesPerPage: 8, textDensity: "mixed", shapeDensity: "none", actions: ["scroll", "zoom", "reopen"], requiresHardware: false },
  { id: "500-dense", pageCount: 500, strokesPerPage: 80, textDensity: "dense", shapeDensity: "mixed", actions: ["scroll", "zoom", "reopen"], requiresHardware: false },
  { id: "1000-dense", pageCount: 1000, strokesPerPage: 80, textDensity: "dense", shapeDensity: "mixed", actions: ["scroll", "zoom", "reopen"], requiresHardware: false },
  { id: "mixed-editing", pageCount: 100, strokesPerPage: 32, textDensity: "mixed", shapeDensity: "mixed", actions: ["scroll", "zoom", "mutate", "reopen"], requiresHardware: false },
  { id: "rapid-scroll-zoom", pageCount: 500, strokesPerPage: 16, textDensity: "mixed", shapeDensity: "none", actions: ["scroll", "zoom"], requiresHardware: true },
  { id: "mobile-reopen", pageCount: 1000, strokesPerPage: 24, textDensity: "dense", shapeDensity: "mixed", actions: ["scroll", "zoom", "mutate", "reopen"], requiresHardware: true }
] as const;

function hashWorkloadId(id: string): number {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildLargeDocumentWorkloadPlan(workload: LargeDocumentWorkload): LargeDocumentWorkloadPlan {
  const seed = hashWorkloadId(workload.id);
  return {
    ...workload,
    seed,
    totalStrokes: workload.pageCount * workload.strokesPerPage,
    estimatedTextObjects: workload.pageCount * (workload.textDensity === "dense" ? 40 : workload.textDensity === "mixed" ? 12 : 0),
    estimatedShapeObjects: workload.pageCount * (workload.shapeDensity === "mixed" ? 6 : 0)
  };
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number.isFinite(value) ? Math.max(0, value) : 0;
}

function boundedSamples(values: readonly number[] | undefined): readonly number[] {
  return (values || []).slice(0, 256).map((value) => finiteNonNegative(value) ?? 0);
}

/**
 * Remove unbounded/raw content before a trace is copied into a release record.
 * This is intentionally a serializer, not a source of performance claims.
 */
export function sanitizeLargeDocumentTrace(trace: LargeDocumentTrace): LargeDocumentTrace {
  return {
    schemaVersion: LARGE_DOCUMENT_BENCHMARK_VERSION,
    capturedAt: String(trace.capturedAt).slice(0, 40),
    context: {
      evidenceClass: trace.context.evidenceClass,
      platform: String(trace.context.platform).slice(0, 80),
      device: String(trace.context.device).slice(0, 80),
      runtime: String(trace.context.runtime).slice(0, 80),
      dpr: finiteNonNegative(trace.context.dpr),
      refreshRateHz: finiteNonNegative(trace.context.refreshRateHz),
      pluginVersion: String(trace.context.pluginVersion).slice(0, 40),
      hostVersion: String(trace.context.hostVersion).slice(0, 80)
    },
    workloads: trace.workloads.slice(0, LARGE_DOCUMENT_WORKLOADS.length).map((sample) => ({
      workloadId: String(sample.workloadId).slice(0, 40),
      pointerToRenderMs: boundedSamples(sample.pointerToRenderMs),
      scrollZoomMs: boundedSamples(sample.scrollZoomMs),
      remountMs: boundedSamples(sample.remountMs),
      saveMs: boundedSamples(sample.saveMs),
      cacheBytes: finiteNonNegative(sample.cacheBytes),
      pluginOwnedMemoryBytes: finiteNonNegative(sample.pluginOwnedMemoryBytes),
      mountedPages: Math.max(0, Math.floor(sample.mountedPages || 0)),
      evictions: Math.max(0, Math.floor(sample.evictions || 0)),
      unsafeGates: Math.max(0, Math.floor(sample.unsafeGates || 0))
    }))
  };
}
