import { percentile } from "../logging/PerformanceMetrics";

/** Fixed synchronous plugin-work budget; frame gaps use RuntimeFrameProfile. */
export const SLOW_SPAN_SYNC_MS = 8;
/** Gated or waiting pipeline stages. */
export const SLOW_SPAN_ASYNC_MS = 25;
/** User-visible chains such as first ink after a pen down. */
export const SLOW_SPAN_INTERACTION_MS = 50;
export const SLOW_SPAN_WORST_LIMIT = 10;
const STAGE_SAMPLE_LIMIT = 32;

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
  frameBudgetMs: number | null;
  lateFrameThresholdMs: number | null;
  frameThresholdSource: string;
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
  frameBudgetMs?: number | null;
  lateFrameThresholdMs?: number | null;
  frameThresholdSource?: string;
  pointerUpToCommitMs: number | null;
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
  private readonly seen = new Set<string>();
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
    const thresholdMs = validThreshold(input.thresholdMs) ?? slowSpanThreshold(input.kind);
    if (input.durationMs < thresholdMs) return null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const correlationId = input.correlationId ?? null;
    const key = `${input.stage}|${correlationId ?? ""}|${zoomBurstId ?? ""}|${input.reason ?? ""}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
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
    const key = `settle-timer-churn|${zoomBurstId ?? ""}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
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

  recordInkStroke(input: SlowInkStrokePerformanceInput): SlowInkStrokeRecord | null {
    const correlationId = input.correlationId
      ?? input.physicalContactId
      ?? input.strokeId
      ?? (input.pointerId === null ? null : `pointer:${input.pointerId}`);
    const lateFrameThresholdMs = validThreshold(input.lateFrameThresholdMs)
      ?? (validThreshold(input.frameBudgetMs) === null ? null : input.frameBudgetMs! * 1.5);
    const candidates: Array<{ stage: string; durationMs: number | null; kind: SlowSpanKind; thresholdMs?: number }> = [
      { stage: "pointer-down-to-stroke-start", durationMs: input.pointerDownToStrokeStartMs, kind: "sync" },
      { stage: "stroke-start-to-first-canvas-commit", durationMs: input.strokeStartToFirstCanvasCommitMs, kind: "sync" },
      { stage: "input-to-render", durationMs: input.maxInputToRenderMs, kind: "async" },
      { stage: "stroke-frame-gap", durationMs: input.maxFrameMs, kind: "sync", ...(lateFrameThresholdMs === null ? {} : { thresholdMs: lateFrameThresholdMs }) },
      { stage: "plugin-callback", durationMs: input.maxPluginCallbackMs, kind: "sync" },
      { stage: "long-task", durationMs: input.longestLongTaskMs, kind: "interaction" },
      { stage: "pointerup-to-commit", durationMs: input.pointerUpToCommitMs, kind: "sync" }
    ];
    const slowStages = candidates.flatMap(({ stage, durationMs, kind, thresholdMs: candidateThresholdMs }) => {
      const thresholdMs = validThreshold(candidateThresholdMs) ?? slowSpanThreshold(kind);
      return durationMs !== null && durationMs >= thresholdMs
        ? [{ stage, durationMs: roundMs(durationMs), thresholdMs }]
        : [];
    });
    if (slowStages.length === 0) return null;
    for (const candidate of candidates) {
      const thresholdMs = validThreshold(candidate.thresholdMs) ?? slowSpanThreshold(candidate.kind);
      if (candidate.durationMs === null || candidate.durationMs < thresholdMs) continue;
      this.record({
        kind: candidate.kind,
        category: "ink-stroke",
        stage: candidate.stage,
        durationMs: candidate.durationMs,
        activeWorkMs: candidate.kind === "sync" ? candidate.durationMs : null,
        waitMs: candidate.kind === "sync" ? 0 : candidate.durationMs,
        correlationId,
        ...(candidate.thresholdMs === undefined ? {} : { thresholdMs: candidate.thresholdMs })
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
      frameBudgetMs: roundNullable(input.frameBudgetMs),
      lateFrameThresholdMs: roundNullable(lateFrameThresholdMs),
      frameThresholdSource: input.frameThresholdSource ?? "unknown",
      pointerUpToCommitMs: roundNullable(input.pointerUpToCommitMs),
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

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundNullable(value: number | null | undefined): number | null {
  return value == null ? null : roundMs(value);
}

function validThreshold(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
