export type DocumentDeviceClass = "desktop" | "constrained";

export interface DocumentBudgetTraceSample {
  readonly workloadId: string;
  readonly pointerToRenderMs: readonly number[];
  readonly scrollZoomMs: readonly number[];
  readonly remountMs: readonly number[];
  readonly saveMs: readonly number[];
}

export interface DocumentBudgetTrace {
  readonly capturedAt: string;
  readonly context: {
    readonly evidenceClass: "synthetic" | "browser-emulator" | "manual-device";
    readonly platform: string;
    readonly device: string;
    readonly runtime: string;
  };
  readonly workloads: readonly DocumentBudgetTraceSample[];
}

export interface MeasuredBudget {
  readonly status: "measured";
  readonly p95Ms: number;
  readonly sampleCount: number;
  readonly workloadId: string;
  readonly evidenceClass: "manual-device";
  readonly device: string;
  readonly runtime: string;
  readonly capturedAt: string;
}

export interface UnqualifiedBudget {
  readonly status: "unqualified";
  readonly reason: string;
}

export type DocumentBudget = MeasuredBudget | UnqualifiedBudget;

export interface DocumentMountPolicy {
  readonly deviceClass: DocumentDeviceClass;
  readonly mount: "visible-pages-only";
  /** Zero means do not preload. A larger radius is never chosen without a cited manual-device trace. */
  readonly preloadRadiusPages: 0;
  readonly preloadReason: string;
  readonly cancelSupersededScrollZoom: true;
  readonly pointerToRender: DocumentBudget;
  readonly scrollZoom: DocumentBudget;
  readonly remount: DocumentBudget;
  readonly save: DocumentBudget;
  readonly pluginOwnedMemory: DocumentBudget;
}

export function documentDeviceClass(platform: string): DocumentDeviceClass {
  return /ipad|ios|iphone|android|mobile/i.test(platform) ? "constrained" : "desktop";
}

function percentile95(values: readonly number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (finite.length === 0) return undefined;
  return finite[Math.min(finite.length - 1, Math.ceil(finite.length * 0.95) - 1)];
}

function measured(
  traces: readonly DocumentBudgetTrace[],
  deviceClass: DocumentDeviceClass,
  read: (sample: DocumentBudgetTraceSample) => readonly number[]
): DocumentBudget {
  const candidates = traces.filter((trace) => (
    trace.context.evidenceClass === "manual-device"
    && documentDeviceClass(trace.context.platform) === deviceClass
  ));
  for (const trace of candidates) {
    for (const sample of trace.workloads) {
      const p95Ms = percentile95(read(sample));
      if (p95Ms === undefined) continue;
      return {
        status: "measured",
        p95Ms,
        sampleCount: read(sample).length,
        workloadId: sample.workloadId,
        evidenceClass: "manual-device",
        device: trace.context.device,
        runtime: trace.context.runtime,
        capturedAt: trace.capturedAt
      };
    }
  }
  return {
    status: "unqualified",
    reason: candidates.length === 0
      ? `no manual-device ${deviceClass} trace`
      : `manual-device ${deviceClass} trace has no samples for this metric`
  };
}

export function documentMountPolicy(
  traces: readonly DocumentBudgetTrace[],
  deviceClass: DocumentDeviceClass
): DocumentMountPolicy {
  return {
    deviceClass,
    mount: "visible-pages-only",
    preloadRadiusPages: 0,
    preloadReason: "preload stays off until a manual-device trace records remount pop-in for this device class",
    cancelSupersededScrollZoom: true,
    pointerToRender: measured(traces, deviceClass, (sample) => sample.pointerToRenderMs),
    scrollZoom: measured(traces, deviceClass, (sample) => sample.scrollZoomMs),
    remount: measured(traces, deviceClass, (sample) => sample.remountMs),
    save: measured(traces, deviceClass, (sample) => sample.saveMs),
    pluginOwnedMemory: {
      status: "unqualified",
      reason: "byte caps stay unqualified until a constrained-device trace records pressure or allocation failure"
    }
  };
}

/** A newer scroll or zoom burst cancels mount work from the previous burst. */
export function mountWorkSuperseded(workBurstId: number, currentBurstId: number): boolean {
  return workBurstId !== currentBurstId;
}
