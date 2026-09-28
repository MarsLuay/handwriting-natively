/** One frame on a 120 Hz display. Synchronous plugin work above this can consume the frame. */
export const SLOW_SPAN_SYNC_MS = 8;
/** Gated or waiting pipeline stages. */
export const SLOW_SPAN_ASYNC_MS = 25;
/** User-visible chains such as first ink after a pen down. */
export const SLOW_SPAN_INTERACTION_MS = 50;
export const SLOW_SPAN_WORST_LIMIT = 10;
export const STAGE_SAMPLE_LIMIT = 32;
import { percentile } from "../logging/PerformanceMetrics";

export type SlowSpanKind = "sync" | "async" | "interaction";

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
  zoomBurstId: string | null;
  durationMs: number;
  pointerDownToStrokeStartMs: number | null;
  strokeStartToFirstCanvasCommitMs: number | null;
  maxInputToRenderMs: number;
  p95InputToRenderMs: number;
  maxPluginCallbackMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  pointerUpToCommitMs: number | null;
  slowStages: Array<{ stage: string; durationMs: number; thresholdMs: number }>;
}

export interface SlowInkStrokeSummary {
  totalSlowStrokes: number;
  byStage: Record<string, number>;
  maxByStage: Record<string, number>;
  p95ByStage: Record<string, number>;
  worstStrokes: SlowInkStrokeRecord[];
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
  correlationId: null;
  zoomBurstId: string | null;
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
  strokeStartToFirstInkMs: number | null;
  totalPointerDownToFirstInkMs: number | null;
  totalDurationMs: number | null;
  slowStages: Array<{ stage: string; durationMs: number }>;
}

export interface SlowSpanSummary {
  totalSlowSpans: number;
  byStage: Record<string, number>;
  maxByStage: Record<string, number>;
  p95ByStage: Record<string, number>;
  worstSpans: SlowSpanRecord[];
  slowInkStrokeSummary: SlowInkStrokeSummary;
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
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private slowInkStrokeCount = 0;
  private readonly slowInkStrokeCounts = new Map<string, number>();
  private readonly slowInkStrokeSamples = new Map<string, number[]>();
  private readonly worstInkStrokes: SlowInkStrokeRecord[] = [];
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

  finishFirstPen(firstInkAt: number): FirstPenInteraction | null {
    if (this.firstPenEmitted || this.penDownAt === null) return null;
    this.firstPenEmitted = true;
    const pointerDownToStrokeStartMs = this.strokeStartAt === null ? null : roundMs(this.strokeStartAt - this.penDownAt);
    const strokeStartToFirstInkMs = this.strokeStartAt === null ? null : roundMs(firstInkAt - this.strokeStartAt);
    const totalPointerDownToFirstInkMs = roundMs(firstInkAt - this.penDownAt);
    const slowStages: Array<{ stage: string; durationMs: number }> = [];
    if (pointerDownToStrokeStartMs !== null && pointerDownToStrokeStartMs >= SLOW_SPAN_SYNC_MS) {
      slowStages.push({ stage: "pointerDownToStrokeStartMs", durationMs: pointerDownToStrokeStartMs });
    }
    if (strokeStartToFirstInkMs !== null && strokeStartToFirstInkMs >= SLOW_SPAN_SYNC_MS) {
      slowStages.push({ stage: "strokeStartToFirstInkMs", durationMs: strokeStartToFirstInkMs });
    }
    if (totalPointerDownToFirstInkMs < SLOW_SPAN_INTERACTION_MS && slowStages.length === 0) return null;
    return {
      event: "perf-slow-interaction",
      interaction: "first-post-zoom-pen",
      zoomBurstId: this.zoomBurstId,
      zoomSettleToPointerDownMs: this.zoomSettledAt === null ? null : roundMs(this.penDownAt - this.zoomSettledAt),
      pointerDownToStrokeStartMs,
      strokeStartToFirstInkMs,
      totalPointerDownToFirstInkMs,
      totalDurationMs: totalPointerDownToFirstInkMs,
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
  }): SlowSpanRecord | null {
    const thresholdMs = slowSpanThreshold(input.kind);
    if (input.durationMs < thresholdMs) return null;
    const correlationId = input.correlationId ?? null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const key = `${input.stage}|${correlationId ?? ""}|${zoomBurstId ?? ""}|${input.reason ?? ""}`;
    if (this.seen.has(key)) return null;
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
  }): SettleChurnSummary | null {
    if (input.settleDelayMs < SLOW_SPAN_ASYNC_MS) return null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const key = `settle-timer-churn||${zoomBurstId ?? ""}|`;
    if (this.seen.has(key)) return null;
    this.rememberSeen(key);
    const record: SettleChurnSummary = {
      event: "perf-slow-span",
      category: "zoom",
      stage: "settle-timer-churn",
      durationMs: roundMs(input.settleDelayMs),
      thresholdMs: SLOW_SPAN_ASYNC_MS,
      activeWorkMs: null,
      waitMs: roundMs(input.settleDelayMs),
      reason: input.lastDeferralReason,
      correlationId: null,
      zoomBurstId,
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

  /** Retain only abnormal completed ink strokes; physical down time is not a stage. */
  recordInkStroke(input: {
    pointerId?: number | null;
    physicalContactId?: string | null;
    strokeId?: string | null;
    page: number;
    tool: string;
    outcome: string;
    pointerDownToStrokeStartMs?: number | null;
    strokeStartToFirstCanvasCommitMs?: number | null;
    maxInputToRenderMs?: number;
    p95InputToRenderMs?: number;
    maxPluginCallbackMs?: number;
    p95FrameMs?: number;
    maxFrameMs?: number;
    pointerUpToCommitMs?: number | null;
    zoomBurstId?: string | null;
  }): SlowInkStrokeRecord | null {
    const pointerId = input.pointerId ?? null;
    const physicalContactId = input.physicalContactId ?? null;
    const strokeId = input.strokeId ?? null;
    const correlationId = physicalContactId ?? strokeId ?? (pointerId === null ? null : `pointer-${pointerId}`);
    const pointerDownToStrokeStartMs = roundNullable(input.pointerDownToStrokeStartMs);
    const strokeStartToFirstCanvasCommitMs = roundNullable(input.strokeStartToFirstCanvasCommitMs);
    const maxInputToRenderMs = roundMs(input.maxInputToRenderMs ?? 0);
    const p95InputToRenderMs = roundMs(input.p95InputToRenderMs ?? 0);
    const maxPluginCallbackMs = roundMs(input.maxPluginCallbackMs ?? 0);
    const p95FrameMs = roundMs(input.p95FrameMs ?? 0);
    const maxFrameMs = roundMs(input.maxFrameMs ?? 0);
    const pointerUpToCommitMs = roundNullable(input.pointerUpToCommitMs);
    const candidates: Array<{ stage: string; durationMs: number | null; thresholdMs: number; kind: SlowSpanKind }> = [
      { stage: "pointer-down-to-stroke-start", durationMs: pointerDownToStrokeStartMs, thresholdMs: SLOW_SPAN_SYNC_MS, kind: "sync" },
      { stage: "first-canvas-commit", durationMs: strokeStartToFirstCanvasCommitMs, thresholdMs: SLOW_SPAN_INTERACTION_MS, kind: "interaction" },
      { stage: "input-to-render", durationMs: maxInputToRenderMs, thresholdMs: SLOW_SPAN_ASYNC_MS, kind: "async" },
      { stage: "stroke-frame-gap", durationMs: maxFrameMs, thresholdMs: SLOW_SPAN_SYNC_MS, kind: "sync" },
      { stage: "plugin-callback", durationMs: maxPluginCallbackMs, thresholdMs: SLOW_SPAN_SYNC_MS, kind: "sync" },
      { stage: "pointerup-to-commit", durationMs: pointerUpToCommitMs, thresholdMs: SLOW_SPAN_INTERACTION_MS, kind: "interaction" }
    ];
    const slowStages = candidates
      .filter((candidate): candidate is typeof candidate & { durationMs: number } => candidate.durationMs !== null && candidate.durationMs >= candidate.thresholdMs)
      .map(({ stage, durationMs, thresholdMs, kind }) => {
        this.record({
          kind,
          category: "ink",
          stage,
          durationMs,
          correlationId,
          reason: "ink-stroke",
          zoomBurstId: input.zoomBurstId ?? null
        });
        return { stage, durationMs: roundMs(durationMs), thresholdMs };
      });
    if (slowStages.length === 0) return null;
    const record: SlowInkStrokeRecord = {
      event: "perf-slow-interaction",
      interaction: "ink-stroke",
      correlationId,
      pointerId,
      physicalContactId,
      strokeId,
      page: input.page,
      tool: input.tool,
      outcome: input.outcome,
      zoomBurstId: input.zoomBurstId ?? this.zoomBurstId,
      durationMs: Math.max(...slowStages.map((stage) => stage.durationMs)),
      pointerDownToStrokeStartMs,
      strokeStartToFirstCanvasCommitMs,
      maxInputToRenderMs,
      p95InputToRenderMs,
      maxPluginCallbackMs,
      p95FrameMs,
      maxFrameMs,
      pointerUpToCommitMs,
      slowStages
    };
    this.rememberInkStroke(record);
    return record;
  }

  slowInkStrokeSummary(): SlowInkStrokeSummary {
    const byStage: Record<string, number> = {};
    const maxByStage: Record<string, number> = {};
    const p95ByStage: Record<string, number> = {};
    for (const [stage, count] of this.slowInkStrokeCounts) byStage[stage] = count;
    for (const [stage, samples] of this.slowInkStrokeSamples) {
      const sorted = [...samples].sort((a, b) => a - b);
      maxByStage[stage] = sorted[sorted.length - 1] ?? 0;
      p95ByStage[stage] = roundMs(percentile(sorted, 0.95));
    }
    return {
      totalSlowStrokes: this.slowInkStrokeCount,
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
      worstSpans: this.worst.map((span) => ({ ...span })),
      slowInkStrokeSummary: this.slowInkStrokeSummary()
    };
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

  private rememberInkStroke(record: SlowInkStrokeRecord): void {
    this.slowInkStrokeCount += 1;
    for (const stage of record.slowStages) {
      this.slowInkStrokeCounts.set(stage.stage, (this.slowInkStrokeCounts.get(stage.stage) ?? 0) + 1);
      const samples = this.slowInkStrokeSamples.get(stage.stage) ?? [];
      samples.push(stage.durationMs);
      if (samples.length > STAGE_SAMPLE_LIMIT) samples.shift();
      this.slowInkStrokeSamples.set(stage.stage, samples);
    }
    this.worstInkStrokes.push(record);
    this.worstInkStrokes.sort((a, b) => b.durationMs - a.durationMs);
    if (this.worstInkStrokes.length > SLOW_SPAN_WORST_LIMIT) this.worstInkStrokes.length = SLOW_SPAN_WORST_LIMIT;
  }

  private rememberSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > SLOW_SPAN_WORST_LIMIT * STAGE_SAMPLE_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundNullable(value: number | null | undefined): number | null {
  return value == null ? null : roundMs(value);
}
