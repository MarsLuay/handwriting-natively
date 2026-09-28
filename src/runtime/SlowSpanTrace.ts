/** One frame on a 120 Hz display. Synchronous plugin work above this can consume the frame. */
export const SLOW_SPAN_SYNC_MS = 8;
/** Gated or waiting pipeline stages. */
export const SLOW_SPAN_ASYNC_MS = 25;
/** User-visible chains such as first ink after a pen down. */
export const SLOW_SPAN_INTERACTION_MS = 50;
export const SLOW_SPAN_WORST_LIMIT = 10;
import { percentile } from "../logging/PerformanceMetrics";
const STAGE_SAMPLE_LIMIT = 32;
const SEEN_KEY_LIMIT = 512;

export type SlowSpanKind = "sync" | "async" | "interaction";

/** Bounded latency legs for one pen contact. Values are maxima over the stroke. */
export interface InkLatencyBreakdown {
  inputMs: number | null;
  routingMs: number | null;
  geometryMs: number | null;
  modelMs: number | null;
  schedulingMs: number | null;
  canvasCommitMs: number | null;
  paintAcknowledgementMs: number | null;
}

export interface SlowSpanRecord {
  event: "perf-slow-span";
  category: string;
  stage: string;
  durationMs: number;
  thresholdMs: number;
  activeWorkMs: number | null;
  waitMs: number | null;
  reason: string | null;
  correlationId: string | null;
  zoomBurstId: string | null;
}

export interface SettleChurnSummary {
  event: "perf-slow-span";
  category: "zoom";
  stage: "settle-timer-churn";
  durationMs: number;
  thresholdMs: number;
  activeWorkMs: null;
  waitMs: number;
  reason: string | null;
  correlationId: string | null;
  zoomBurstId: string | null;
  /** Thresholded sub-phases that explain the aggregate settle wait. */
  phaseDurations: Record<string, number | null>;
  slowPhases: Array<{ phase: string; durationMs: number; thresholdMs: number }>;
  settleDelayMs: number;
  settleTimerResetCount: number;
  inGestureResetCount: number;
  resetReasons: Record<string, number>;
  lastDeferralReason: string | null;
  zoomGestureDurationMs: number | null;
  pinchTerminalToSettleMs: number | null;
  lastScaleChangeToSettleMs: number | null;
  liveInkWaitAfterPinchTerminalMs: number | null;
}

export interface FirstPenInteraction {
  event: "perf-slow-interaction";
  interaction: "first-post-zoom-pen";
  zoomBurstId: string | null;
  zoomSettleToPointerDownMs: number | null;
  pointerDownToStrokeStartMs: number | null;
  strokeStartToFirstCanvasCommitMs: number | null;
  totalPointerDownToFirstCanvasCommitMs: number | null;
  slowStages: Array<{ stage: string; durationMs: number }>;
}

export interface SlowSpanSummary {
  totalSlowSpans: number;
  byStage: Record<string, number>;
  maxByStage: Record<string, number>;
  p95ByStage: Record<string, number>;
  worstSpans: SlowSpanRecord[];
}

export interface SlowInkStrokeRecord {
  event: "perf-slow-interaction";
  interaction: "ink-stroke";
  correlationId: string | null;
  pointerId: number | null;
  physicalContactId: string | null;
  strokeId: string | null;
  page: number;
  tool: string;
  outcome: string;
  pointerDownToStrokeStartMs: number | null;
  strokeStartToFirstCanvasCommitMs: number | null;
  totalPointerDownToFirstCanvasCommitMs: number | null;
  maxInputToRenderMs: number;
  p95InputToRenderMs: number;
  maxPluginCallbackMs: number;
  longestLongTaskMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  pointerUpToCommitMs: number | null;
  latency: InkLatencyBreakdown;
  slowStages: Array<{ stage: string; durationMs: number; thresholdMs: number }>;
}

export interface SlowInkStrokeSummary {
  totalSlowStrokes: number;
  byStage: Record<string, number>;
  maxByStage: Record<string, number>;
  p95ByStage: Record<string, number>;
  worstStrokes: SlowInkStrokeRecord[];
}

export interface SlowInkStrokePerformanceInput {
  pointerId: number | null;
  physicalContactId: string | null;
  strokeId: string | null;
  correlationId: string | null;
  page: number;
  tool: string;
  outcome: string;
  pointerDownToStrokeStartMs: number | null;
  strokeStartToFirstCanvasCommitMs: number | null;
  totalPointerDownToFirstCanvasCommitMs: number | null;
  maxInputToRenderMs: number;
  p95InputToRenderMs: number;
  maxPluginCallbackMs: number;
  longestLongTaskMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  /** Runtime-derived presentation threshold captured with this stroke. */
  frameGapThresholdMs?: number;
  pointerUpToCommitMs: number | null;
  /** Optional so older callers can keep using the legacy stroke profile fields. */
  latency?: Partial<InkLatencyBreakdown>;
}

export function slowSpanThreshold(kind: SlowSpanKind): number {
  if (kind === "sync") return SLOW_SPAN_SYNC_MS;
  if (kind === "async") return SLOW_SPAN_ASYNC_MS;
  return SLOW_SPAN_INTERACTION_MS;
}

export class SlowSpanTrace {
  private totalSlowSpans = 0;
  private readonly counts = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();
  private readonly worst: SlowSpanRecord[] = [];
  private readonly inkStrokeCounts = new Map<string, number>();
  private readonly inkStrokeSamples = new Map<string, number[]>();
  private readonly worstInkStrokes: SlowInkStrokeRecord[] = [];
  private totalSlowInkStrokes = 0;
  /** Deduplication is diagnostic-only and must not grow with document lifetime. */
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private zoomSettledAt: number | null = null;
  private zoomBurstId: string | null = null;
  private penDownAt: number | null = null;
  private strokeStartAt: number | null = null;
  private firstPenEmitted = false;

  beginPostZoom(zoomBurstId: string | null, settledAt: number): void {
    this.zoomBurstId = zoomBurstId;
    this.zoomSettledAt = settledAt;
    this.penDownAt = null;
    this.strokeStartAt = null;
    this.firstPenEmitted = false;
  }

  notePenDown(at: number): void {
    if (this.penDownAt === null) this.penDownAt = at;
  }

  noteStrokeStart(at: number): void {
    if (this.strokeStartAt === null) this.strokeStartAt = at;
  }

  /** The caller supplies the timestamp only after the first live canvas render completes. */
  finishFirstPen(firstCanvasCommitAt: number): FirstPenInteraction | null {
    if (this.firstPenEmitted || this.penDownAt === null) return null;
    this.firstPenEmitted = true;
    const pointerDownToStrokeStartMs = this.strokeStartAt === null ? null : roundMs(this.strokeStartAt - this.penDownAt);
    const strokeStartToFirstCanvasCommitMs = this.strokeStartAt === null ? null : roundMs(firstCanvasCommitAt - this.strokeStartAt);
    const totalPointerDownToFirstCanvasCommitMs = roundMs(firstCanvasCommitAt - this.penDownAt);
    const slowStages: Array<{ stage: string; durationMs: number }> = [];
    if (pointerDownToStrokeStartMs !== null && pointerDownToStrokeStartMs >= SLOW_SPAN_SYNC_MS) {
      slowStages.push({ stage: "pointerDownToStrokeStartMs", durationMs: pointerDownToStrokeStartMs });
    }
    if (strokeStartToFirstCanvasCommitMs !== null && strokeStartToFirstCanvasCommitMs >= SLOW_SPAN_SYNC_MS) {
      slowStages.push({ stage: "strokeStartToFirstCanvasCommitMs", durationMs: strokeStartToFirstCanvasCommitMs });
    }
    if (totalPointerDownToFirstCanvasCommitMs < SLOW_SPAN_INTERACTION_MS && slowStages.length === 0) return null;
    return {
      event: "perf-slow-interaction",
      interaction: "first-post-zoom-pen",
      zoomBurstId: this.zoomBurstId,
      zoomSettleToPointerDownMs: this.zoomSettledAt === null ? null : roundMs(this.penDownAt - this.zoomSettledAt),
      pointerDownToStrokeStartMs,
      strokeStartToFirstCanvasCommitMs,
      totalPointerDownToFirstCanvasCommitMs,
      slowStages
    };
  }

  record(input: {
    kind: SlowSpanKind;
    category: string;
    stage: string;
    durationMs: number;
    activeWorkMs?: number | null;
    waitMs?: number | null;
    reason?: string | null;
    correlationId?: string | null;
    zoomBurstId?: string | null;
    thresholdMs?: number;
  }): SlowSpanRecord | null {
    const thresholdMs = input.thresholdMs ?? slowSpanThreshold(input.kind);
    if (input.durationMs < thresholdMs) return null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const correlationId = input.correlationId ?? null;
    const key = `${input.stage}|${correlationId ?? ""}|${zoomBurstId ?? ""}|${input.reason ?? ""}`;
    if (this.hasSeen(key)) return null;
    this.rememberSeen(key);
    const record: SlowSpanRecord = {
      event: "perf-slow-span",
      category: input.category,
      stage: input.stage,
      durationMs: roundMs(input.durationMs),
      thresholdMs,
      activeWorkMs: input.activeWorkMs ?? null,
      waitMs: input.waitMs ?? null,
      reason: input.reason ?? null,
      correlationId,
      zoomBurstId
    };
    this.remember(record);
    return record;
  }

  recordSettleChurn(input: {
    settleDelayMs: number;
    settleTimerResetCount: number;
    inGestureResetCount?: number;
    resetReasons: Record<string, number>;
    lastDeferralReason: string | null;
    zoomBurstId?: string | null;
    zoomGestureDurationMs?: number | null;
    pinchTerminalToSettleMs?: number | null;
    lastScaleChangeToSettleMs?: number | null;
    liveInkWaitAfterPinchTerminalMs?: number | null;
    phaseDurations?: Record<string, number | null | undefined>;
  }): SettleChurnSummary | null {
    const phaseDurations = Object.fromEntries(
      Object.entries(input.phaseDurations ?? {})
        .filter(([, durationMs]) => durationMs === null || Number.isFinite(durationMs))
        .map(([phase, durationMs]) => [phase, durationMs === null ? null : roundMs(Math.max(0, durationMs!))])
    ) as Record<string, number | null>;
    const slowPhases = Object.entries(phaseDurations)
      .flatMap(([phase, durationMs]) => durationMs !== null && durationMs >= SLOW_SPAN_ASYNC_MS
        ? [{ phase, durationMs, thresholdMs: SLOW_SPAN_ASYNC_MS }]
        : []);
    const maxPhaseMs = Math.max(0, ...slowPhases.map((phase) => phase.durationMs));
    if (input.settleDelayMs < SLOW_SPAN_ASYNC_MS && maxPhaseMs < SLOW_SPAN_ASYNC_MS) return null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const key = `settle-timer-churn|${zoomBurstId ?? ""}`;
    if (this.hasSeen(key)) return null;
    this.rememberSeen(key);
    const record: SettleChurnSummary = {
      event: "perf-slow-span",
      category: "zoom",
      stage: "settle-timer-churn",
      durationMs: roundMs(Math.max(input.settleDelayMs, maxPhaseMs)),
      thresholdMs: SLOW_SPAN_ASYNC_MS,
      activeWorkMs: null,
      waitMs: roundMs(input.settleDelayMs),
      reason: input.lastDeferralReason,
      correlationId: null,
      zoomBurstId,
      phaseDurations,
      slowPhases,
      settleDelayMs: roundMs(input.settleDelayMs),
      settleTimerResetCount: input.settleTimerResetCount,
      inGestureResetCount: input.inGestureResetCount ?? 0,
      resetReasons: { ...input.resetReasons },
      lastDeferralReason: input.lastDeferralReason,
      zoomGestureDurationMs: roundNullable(input.zoomGestureDurationMs),
      pinchTerminalToSettleMs: roundNullable(input.pinchTerminalToSettleMs),
      lastScaleChangeToSettleMs: roundNullable(input.lastScaleChangeToSettleMs),
      liveInkWaitAfterPinchTerminalMs: roundNullable(input.liveInkWaitAfterPinchTerminalMs)
    };
    this.remember(record);
    return record;
  }

  recordInkStroke(input: SlowInkStrokePerformanceInput): SlowInkStrokeRecord | null {
    const correlationId = input.correlationId
      ?? input.physicalContactId
      ?? input.strokeId
      ?? (input.pointerId === null ? null : `pointer:${input.pointerId}`);
    const latency = normalizeLatency(input.latency);
    const candidates: Array<{
      stage: string;
      durationMs: number | null;
      kind: SlowSpanKind;
      thresholdMs?: number;
      activeWorkMs?: number | null;
      waitMs?: number | null;
    }> = [
      { stage: "pointer-down-to-stroke-start", durationMs: input.pointerDownToStrokeStartMs, kind: "sync" },
      { stage: "stroke-start-to-first-canvas-commit", durationMs: input.strokeStartToFirstCanvasCommitMs, kind: "sync" },
      { stage: "input-to-render", durationMs: input.maxInputToRenderMs, kind: "async" },
      {
        stage: "stroke-frame-gap",
        durationMs: input.maxFrameMs,
        kind: "sync",
        // This is elapsed time between presentation callbacks, not a measured
        // synchronous callback. The stroke's latency fields retain separate
        // scheduling and callback evidence without double-counting this gap.
        activeWorkMs: null,
        waitMs: null,
        ...(input.frameGapThresholdMs === undefined ? {} : { thresholdMs: input.frameGapThresholdMs })
      },
      { stage: "plugin-callback", durationMs: input.maxPluginCallbackMs, kind: "sync" },
      { stage: "long-task", durationMs: input.longestLongTaskMs, kind: "interaction" },
      { stage: "pointerup-to-commit", durationMs: input.pointerUpToCommitMs, kind: "sync" },
      { stage: "input", durationMs: latency.inputMs, kind: "async" },
      { stage: "routing", durationMs: latency.routingMs, kind: "sync" },
      { stage: "geometry", durationMs: latency.geometryMs, kind: "sync" },
      { stage: "model", durationMs: latency.modelMs, kind: "sync" },
      { stage: "scheduling", durationMs: latency.schedulingMs, kind: "async" },
      { stage: "canvas-commit", durationMs: latency.canvasCommitMs, kind: "sync" },
      { stage: "paint-acknowledgement", durationMs: latency.paintAcknowledgementMs, kind: "async" }
    ];
    const slowStages = candidates.flatMap(({ stage, durationMs, kind, thresholdMs: candidateThresholdMs }) => {
      const thresholdMs = candidateThresholdMs ?? slowSpanThreshold(kind);
      return durationMs !== null && durationMs >= thresholdMs
        ? [{ stage, durationMs: roundMs(durationMs), thresholdMs }]
        : [];
    });
    if (slowStages.length === 0) return null;
    for (const candidate of candidates) {
      const thresholdMs = candidate.thresholdMs ?? slowSpanThreshold(candidate.kind);
      if (candidate.durationMs === null || candidate.durationMs < thresholdMs) continue;
      this.record({
        kind: candidate.kind,
        category: "ink-stroke",
        stage: candidate.stage,
        durationMs: candidate.durationMs,
        activeWorkMs: candidate.activeWorkMs !== undefined
          ? candidate.activeWorkMs
          : candidate.kind === "sync" ? candidate.durationMs : null,
        waitMs: candidate.waitMs !== undefined
          ? candidate.waitMs
          : candidate.kind === "sync" ? 0 : candidate.durationMs,
        correlationId,
        thresholdMs
      });
    }
    const record: SlowInkStrokeRecord = {
      event: "perf-slow-interaction",
      interaction: "ink-stroke",
      correlationId,
      pointerId: input.pointerId,
      physicalContactId: input.physicalContactId,
      strokeId: input.strokeId,
      page: input.page,
      tool: input.tool,
      outcome: input.outcome,
      pointerDownToStrokeStartMs: roundNullable(input.pointerDownToStrokeStartMs),
      strokeStartToFirstCanvasCommitMs: roundNullable(input.strokeStartToFirstCanvasCommitMs),
      totalPointerDownToFirstCanvasCommitMs: roundNullable(input.totalPointerDownToFirstCanvasCommitMs),
      maxInputToRenderMs: roundMs(input.maxInputToRenderMs),
      p95InputToRenderMs: roundMs(input.p95InputToRenderMs),
      maxPluginCallbackMs: roundMs(input.maxPluginCallbackMs),
      longestLongTaskMs: roundMs(input.longestLongTaskMs),
      p95FrameMs: roundMs(input.p95FrameMs),
      maxFrameMs: roundMs(input.maxFrameMs),
      pointerUpToCommitMs: roundNullable(input.pointerUpToCommitMs),
      latency,
      slowStages
    };
    this.rememberSlowInkStroke(record);
    return record;
  }

  slowInkStrokeSummary(): SlowInkStrokeSummary {
    const maxByStage: Record<string, number> = {};
    const p95ByStage: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    for (const [stage, count] of this.inkStrokeCounts) byStage[stage] = count;
    for (const [stage, samples] of this.inkStrokeSamples) {
      const sorted = [...samples].sort((a, b) => a - b);
      maxByStage[stage] = sorted[sorted.length - 1] ?? 0;
      p95ByStage[stage] = roundMs(percentile(sorted, 0.95));
    }
    return {
      totalSlowStrokes: this.totalSlowInkStrokes,
      byStage,
      maxByStage,
      p95ByStage,
      worstStrokes: this.worstInkStrokes.map((stroke) => ({
        ...stroke,
        slowStages: stroke.slowStages.map((stage) => ({ ...stage }))
      }))
    };
  }

  summary(): SlowSpanSummary {
    const maxByStage: Record<string, number> = {};
    const p95ByStage: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    for (const [stage, count] of this.counts) byStage[stage] = count;
    for (const [stage, samples] of this.samples) {
      const sorted = [...samples].sort((a, b) => a - b);
      maxByStage[stage] = sorted[sorted.length - 1] ?? 0;
      p95ByStage[stage] = roundMs(percentile(sorted, 0.95));
    }
    return {
      totalSlowSpans: this.totalSlowSpans,
      byStage,
      maxByStage,
      p95ByStage,
      worstSpans: this.worst.map((span) => ({ ...span }))
    };
  }

  private rememberSlowInkStroke(record: SlowInkStrokeRecord): void {
    this.totalSlowInkStrokes += 1;
    for (const stage of record.slowStages) {
      this.inkStrokeCounts.set(stage.stage, (this.inkStrokeCounts.get(stage.stage) ?? 0) + 1);
      const samples = this.inkStrokeSamples.get(stage.stage) ?? [];
      samples.push(stage.durationMs);
      if (samples.length > STAGE_SAMPLE_LIMIT) samples.shift();
      this.inkStrokeSamples.set(stage.stage, samples);
    }
    this.worstInkStrokes.push(record);
    this.worstInkStrokes.sort((a, b) => slowInkStrokeSeverity(b) - slowInkStrokeSeverity(a));
    if (this.worstInkStrokes.length > SLOW_SPAN_WORST_LIMIT) this.worstInkStrokes.length = SLOW_SPAN_WORST_LIMIT;
  }

  private hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  private rememberSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > SEEN_KEY_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private remember(record: SlowSpanRecord): void {
    this.totalSlowSpans += 1;
    this.counts.set(record.stage, (this.counts.get(record.stage) ?? 0) + 1);
    const samples = this.samples.get(record.stage) ?? [];
    samples.push(record.durationMs);
    if (samples.length > STAGE_SAMPLE_LIMIT) samples.shift();
    this.samples.set(record.stage, samples);
    this.worst.push(record);
    this.worst.sort((a, b) => b.durationMs - a.durationMs);
    if (this.worst.length > SLOW_SPAN_WORST_LIMIT) this.worst.length = SLOW_SPAN_WORST_LIMIT;
  }
}

function slowInkStrokeSeverity(record: SlowInkStrokeRecord): number {
  return record.slowStages.reduce((max, stage) => Math.max(max, stage.durationMs), 0);
}

function normalizeLatency(input: Partial<InkLatencyBreakdown> | undefined): InkLatencyBreakdown {
  return {
    inputMs: roundNullable(input?.inputMs),
    routingMs: roundNullable(input?.routingMs),
    geometryMs: roundNullable(input?.geometryMs),
    modelMs: roundNullable(input?.modelMs),
    schedulingMs: roundNullable(input?.schedulingMs),
    canvasCommitMs: roundNullable(input?.canvasCommitMs),
    paintAcknowledgementMs: roundNullable(input?.paintAcknowledgementMs)
  };
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundNullable(value: number | null | undefined): number | null {
  return value == null ? null : roundMs(value);
}
