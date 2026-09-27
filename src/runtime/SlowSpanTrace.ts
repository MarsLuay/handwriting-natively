/** One frame on a 120 Hz display. Synchronous plugin work above this can consume the frame. */
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
  zoomBurstId: string | null;
  settleDelayMs: number;
  settleTimerResetCount: number;
  resetReasons: Record<string, number>;
  lastDeferralReason: string | null;
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
    zoomBurstId?: string | null;
  }): SlowSpanRecord | null {
    const thresholdMs = slowSpanThreshold(input.kind);
    if (input.durationMs < thresholdMs) return null;
    const zoomBurstId = input.zoomBurstId ?? this.zoomBurstId;
    const key = `${input.stage}|${zoomBurstId ?? ""}|${input.reason ?? ""}`;
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
      zoomBurstId
    };
    this.remember(record);
    return record;
  }

  recordSettleChurn(input: {
    settleDelayMs: number;
    settleTimerResetCount: number;
    resetReasons: Record<string, number>;
    lastDeferralReason: string | null;
    zoomBurstId?: string | null;
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
      zoomBurstId,
      settleDelayMs: roundMs(input.settleDelayMs),
      settleTimerResetCount: input.settleTimerResetCount,
      resetReasons: { ...input.resetReasons },
      lastDeferralReason: input.lastDeferralReason
    };
    this.remember(record);
    return record;
  }

  summary(): SlowSpanSummary {
    const maxByStage: Record<string, number> = {};
    const p95ByStage: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    for (const [stage, count] of this.counts) byStage[stage] = count;
    for (const [stage, samples] of this.samples) {
      const sorted = [...samples].sort((a, b) => a - b);
      maxByStage[stage] = sorted[sorted.length - 1] ?? 0;
      p95ByStage[stage] = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))] ?? 0;
    }
    return {
      totalSlowSpans: this.totalSlowSpans,
      byStage,
      maxByStage,
      p95ByStage,
      worstSpans: this.worst.map((span) => ({ ...span }))
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
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}
