/**
 * Bounded, local-only evidence for the opt-in mobile PDF pinch path.
 *
 * This is a summary, not an event log: midpoint/scale samples are reduced to
 * endpoints and ranges, and transform work is reduced to aggregate timings.
 */

export type MobilePdfZoomTraceMode = "native" | "custom-mobile" | "native-fallback";
export type MobilePdfZoomTracePhase = "idle" | "gesture" | "preview" | "committing" | "settled" | "cancelled";

export type MobilePdfZoomTraceCancelReason =
  | "pointer-cancel"
  | "touch-cancel"
  | "lost-pointer-capture"
  | "visibility-hidden"
  | "page-replaced"
  | "capability-lost"
  | "native-scroll-observed"
  | "handoff-failed"
  | "native-scale-commit-unavailable"
  | "stable-geometry-unavailable"
  | "viewer-replaced"
  | "page-identity-changed"
  | "page-geometry-unsafe";

export interface MobilePdfZoomTraceSummary {
  event: "mobile-pdf-zoom-diagnostics";
  mode: MobilePdfZoomTraceMode;
  phase: MobilePdfZoomTracePhase;
  startedAt: number | null;
  settledAt: number | null;
  gesture: {
    beginCount: number;
    promoteCount: number;
    cancelCount: number;
    commitCount: number;
  };
  samples: {
    count: number;
    firstMidpoint: { x: number; y: number } | null;
    lastMidpoint: { x: number; y: number } | null;
    minScale: number | null;
    maxScale: number | null;
  };
  transform: {
    frameCount: number;
    totalMs: number;
    maxMs: number;
  };
  nativeCommitWaitMs: number | null;
  releaseReason: string | null;
  fallbackReason: string | null;
  focalAnchorErrorPx: number | null;
  pageCount: number;
  pdfJsCanonicalRenderWork: boolean;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function point(value: { x: number; y: number } | null): { x: number; y: number } | null {
  if (!value || !finite(value.x) || !finite(value.y)) return null;
  return { x: round(value.x), y: round(value.y) };
}

function clone(summary: MobilePdfZoomTraceSummary): MobilePdfZoomTraceSummary {
  return {
    ...summary,
    gesture: { ...summary.gesture },
    samples: {
      ...summary.samples,
      firstMidpoint: summary.samples.firstMidpoint ? { ...summary.samples.firstMidpoint } : null,
      lastMidpoint: summary.samples.lastMidpoint ? { ...summary.samples.lastMidpoint } : null
    },
    transform: { ...summary.transform }
  };
}

function emptySummary(mode: MobilePdfZoomTraceMode): MobilePdfZoomTraceSummary {
  return {
    event: "mobile-pdf-zoom-diagnostics",
    mode,
    phase: "idle",
    startedAt: null,
    settledAt: null,
    gesture: { beginCount: 0, promoteCount: 0, cancelCount: 0, commitCount: 0 },
    samples: { count: 0, firstMidpoint: null, lastMidpoint: null, minScale: null, maxScale: null },
    transform: { frameCount: 0, totalMs: 0, maxMs: 0 },
    nativeCommitWaitMs: null,
    releaseReason: null,
    fallbackReason: null,
    focalAnchorErrorPx: null,
    pageCount: 0,
    pdfJsCanonicalRenderWork: false
  };
}

export class MobilePdfZoomDiagnosticsTrace {
  private summaryState: MobilePdfZoomTraceSummary = emptySummary("native-fallback");
  private lastSummary: MobilePdfZoomTraceSummary | null = null;
  private nativeCommitAt: number | null = null;
  private nativeSignalAt: number | null = null;

  setMode(mode: MobilePdfZoomTraceMode): void {
    if (this.summaryState.phase === "idle") this.summaryState.mode = mode;
  }

  begin(input: {
    mode: MobilePdfZoomTraceMode;
    at: number;
    pageCount: number;
    initialScale: number;
    midpoint: { x: number; y: number };
  }): boolean {
    if (!finite(input.at) || !finite(input.initialScale) || input.initialScale <= 0 || !point(input.midpoint)) return false;
    this.summaryState = emptySummary(input.mode);
    this.summaryState.phase = "preview";
    this.summaryState.startedAt = round(input.at);
    this.summaryState.pageCount = Math.max(0, Math.min(64, Math.floor(input.pageCount)));
    this.summaryState.gesture.beginCount = 1;
    this.noteSample(input.midpoint, input.initialScale);
    this.nativeCommitAt = null;
    this.nativeSignalAt = null;
    this.lastSummary = null;
    return true;
  }

  notePromote(): void {
    if (this.summaryState.phase === "idle") return;
    this.summaryState.gesture.promoteCount = Math.min(999, this.summaryState.gesture.promoteCount + 1);
  }

  noteSample(midpoint: { x: number; y: number }, scale: number): void {
    if (this.summaryState.phase === "idle" || !point(midpoint) || !finite(scale) || scale <= 0) return;
    const samples = this.summaryState.samples;
    samples.count = Math.min(999, samples.count + 1);
    samples.firstMidpoint ??= point(midpoint);
    samples.lastMidpoint = point(midpoint);
    samples.minScale = samples.minScale === null ? round(scale) : Math.min(samples.minScale, round(scale));
    samples.maxScale = samples.maxScale === null ? round(scale) : Math.max(samples.maxScale, round(scale));
  }

  noteTransformFrame(durationMs: number): void {
    if (this.summaryState.phase === "idle" || !finite(durationMs)) return;
    const duration = round(durationMs);
    const transform = this.summaryState.transform;
    transform.frameCount = Math.min(999, transform.frameCount + 1);
    transform.totalMs = round(transform.totalMs + duration);
    transform.maxMs = Math.max(transform.maxMs, duration);
  }

  noteNativeCommit(at: number): void {
    if (this.summaryState.phase === "idle" || !finite(at)) return;
    this.summaryState.phase = "committing";
    this.summaryState.gesture.commitCount = Math.min(999, this.summaryState.gesture.commitCount + 1);
    this.nativeCommitAt = at;
  }

  noteNativeSignal(at: number, canonicalRenderWork = false): void {
    if (this.summaryState.phase === "idle" || !finite(at)) return;
    this.nativeSignalAt ??= at;
    this.summaryState.pdfJsCanonicalRenderWork ||= canonicalRenderWork;
    if (this.nativeCommitAt !== null) {
      this.summaryState.nativeCommitWaitMs = round(Math.max(0, (this.nativeSignalAt - this.nativeCommitAt)));
    }
  }

  release(input: {
    at: number;
    reason?: string;
    focalAnchorErrorPx?: number | null;
    canonicalRenderWork?: boolean;
  }): void {
    if (this.summaryState.phase === "idle" || !finite(input.at)) return;
    this.summaryState.phase = "settled";
    this.summaryState.settledAt = round(input.at);
    this.summaryState.releaseReason = input.reason ?? "stable";
    this.summaryState.focalAnchorErrorPx = input.focalAnchorErrorPx !== undefined
      && input.focalAnchorErrorPx !== null
      && finite(input.focalAnchorErrorPx)
      ? round(input.focalAnchorErrorPx)
      : null;
    this.summaryState.pdfJsCanonicalRenderWork ||= input.canonicalRenderWork === true;
    this.lastSummary = clone(this.summaryState);
  }

  cancel(reason: MobilePdfZoomTraceCancelReason | string, fallbackReason?: string): void {
    if (this.summaryState.phase === "idle") return;
    this.summaryState.phase = "cancelled";
    this.summaryState.gesture.cancelCount = Math.min(999, this.summaryState.gesture.cancelCount + 1);
    this.summaryState.releaseReason = reason;
    this.summaryState.fallbackReason = fallbackReason ?? null;
    this.lastSummary = clone(this.summaryState);
  }

  setFallbackReason(reason: string): void {
    if (this.summaryState.mode === "native-fallback" && this.summaryState.phase === "idle") {
      this.summaryState.fallbackReason = reason;
    }
  }

  finishNativeFallback(reason: string): void {
    this.summaryState = emptySummary("native-fallback");
    this.summaryState.phase = "settled";
    this.summaryState.fallbackReason = reason;
    this.lastSummary = clone(this.summaryState);
  }

  summary(): MobilePdfZoomTraceSummary {
    return clone(this.summaryState.phase === "idle" && this.lastSummary ? this.lastSummary : this.summaryState);
  }
}
