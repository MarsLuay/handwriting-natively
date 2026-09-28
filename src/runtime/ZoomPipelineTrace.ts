/** Bounded, local-only stage evidence for the complete native pinch pipeline. */

const MAX_RETAINED_FRAMES = 32;
const MAX_REPRESENTATIVE_FRAMES = 6;
const MAX_WORST_FRAMES = 8;
const MAX_STAGE_KEYS = 24;
const MAX_WORK_KEYS = 32;

export const ZOOM_PIPELINE_STAGES = [
  "scalechanging",
  "view-state",
  "overlay-layout",
  "text-layout",
  "ink-capture",
  "ink-blit",
  "canvas-resize",
  "router-maintenance",
  "page-maintenance",
  "dom-read",
  "dom-write",
  "pdfjs-callback",
  "resize-observer",
  "mutation-observer",
  "toolbar-refresh",
  "cursor-refresh",
  "canonical-paint"
] as const;

export type ZoomPipelineStage = typeof ZOOM_PIPELINE_STAGES[number];

export interface ZoomPipelineStageTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface ZoomPipelineFrame {
  frameIndex: number;
  timestampMs: number;
  deltaMs: number;
  runtimeBudgetMs: number;
  scale: number | null;
  scrollLeft: number | null;
  scrollTop: number | null;
  eventCount: number;
  coalescedEventCount: number;
  pendingRaf: boolean;
  pendingSettle: boolean;
  nativeMutationCount: number;
  visiblePages: number;
  overlaysTouched: number;
  totalPluginWorkMs: number;
  stages: Record<string, ZoomPipelineStageTiming>;
  duplicateWork: Record<string, number>;
}

export interface ZoomPipelineSummary {
  event: "zoom-frame-pipeline";
  zoomBurstId: string | null;
  framesObserved: number;
  slowFrameCount: number;
  stageTotals: Record<string, ZoomPipelineStageTiming>;
  duplicateWork: Record<string, number>;
  representativeFrames: ZoomPipelineFrame[];
  worstFrames: ZoomPipelineFrame[];
}

interface Clock {
  now(): number;
}

interface PendingStage extends ZoomPipelineStageTiming {
  workKeys: Map<string, number>;
}

interface FrameInput {
  timestampMs?: number;
  runtimeBudgetMs: number;
  scale?: number | null;
  scrollLeft?: number | null;
  scrollTop?: number | null;
  pendingRaf: boolean;
  pendingSettle: boolean;
  nativeMutationCount: number;
  visiblePages: number;
  overlaysTouched: number;
  totalPluginWorkMs: number;
}

const defaultClock: Clock = {
  now: () => (typeof performance === "undefined" ? Date.now() : performance.now())
};

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function safeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cloneTiming(timing: ZoomPipelineStageTiming): ZoomPipelineStageTiming {
  return { count: timing.count, totalMs: timing.totalMs, maxMs: timing.maxMs };
}

function cloneFrame(frame: ZoomPipelineFrame): ZoomPipelineFrame {
  return {
    ...frame,
    stages: Object.fromEntries(Object.entries(frame.stages).map(([name, timing]) => [name, cloneTiming(timing)])),
    duplicateWork: { ...frame.duplicateWork }
  };
}

function emptyTiming(): PendingStage {
  return { count: 0, totalMs: 0, maxMs: 0, workKeys: new Map() };
}

function addTiming(target: Map<string, ZoomPipelineStageTiming>, name: string, value: ZoomPipelineStageTiming): void {
  const current = target.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += value.count;
  current.totalMs = roundMs(current.totalMs + value.totalMs);
  current.maxMs = roundMs(Math.max(current.maxMs, value.maxMs));
  target.set(name, current);
}

/**
 * Collects zoom work between presentation callbacks. It intentionally emits
 * nothing by itself; callers expose one summary through Copy Logs.
 */
export class ZoomPipelineTrace {
  private readonly clock: Clock;
  private readonly enabled: () => boolean;
  private active = false;
  private burstId: string | null = null;
  private frameIndex = 0;
  private lastFrameAt: number | null = null;
  private eventCount = 0;
  private readonly pendingEvents = new Map<string, number>();
  private readonly pendingStages = new Map<string, PendingStage>();
  private readonly frames: ZoomPipelineFrame[] = [];
  private readonly representativeFrames: ZoomPipelineFrame[] = [];
  private readonly worstFrames: ZoomPipelineFrame[] = [];
  private readonly stageTotals = new Map<string, ZoomPipelineStageTiming>();
  private readonly duplicateWork = new Map<string, number>();
  private lastSummary: ZoomPipelineSummary | null = null;

  constructor(options: { enabled?: () => boolean; clock?: Clock } = {}) {
    this.clock = options.clock ?? defaultClock;
    this.enabled = options.enabled ?? (() => true);
  }

  isActive(): boolean {
    return this.active;
  }

  begin(zoomBurstId: string | null, at = this.clock.now()): void {
    if (!this.enabled()) return;
    this.active = true;
    this.burstId = zoomBurstId;
    this.frameIndex = 0;
    this.lastFrameAt = at;
    this.eventCount = 0;
    this.pendingEvents.clear();
    this.pendingStages.clear();
    this.frames.length = 0;
    this.representativeFrames.length = 0;
    this.worstFrames.length = 0;
    this.stageTotals.clear();
    this.duplicateWork.clear();
  }

  noteEvent(name: string, count = 1): void {
    if (!this.active || !Number.isFinite(count) || count <= 0) return;
    const bounded = Math.min(999, Math.max(1, Math.floor(count)));
    this.eventCount += bounded;
    this.pendingEvents.set(name, Math.min(999, (this.pendingEvents.get(name) ?? 0) + bounded));
  }

  noteStage(stage: ZoomPipelineStage, durationMs = 0, count = 1, workKey = stage): void {
    if (!this.active || !Number.isFinite(count) || count <= 0) return;
    const boundedCount = Math.min(999, Math.max(1, Math.floor(count)));
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    if (!this.pendingStages.has(stage) && this.pendingStages.size >= MAX_STAGE_KEYS) return;
    const current = this.pendingStages.get(stage) ?? emptyTiming();
    current.count += boundedCount;
    current.totalMs = roundMs(current.totalMs + duration);
    current.maxMs = roundMs(Math.max(current.maxMs, duration));
    if (current.workKeys.size < MAX_WORK_KEYS || current.workKeys.has(workKey)) {
      current.workKeys.set(workKey, Math.min(999, (current.workKeys.get(workKey) ?? 0) + boundedCount));
    }
    this.pendingStages.set(stage, current);
  }

  recordFrame(input: FrameInput): ZoomPipelineFrame | null {
    if (!this.active) return null;
    const timestampMs = safeNumber(input.timestampMs) ?? this.clock.now();
    const deltaMs = this.lastFrameAt === null ? 0 : Math.max(0, timestampMs - this.lastFrameAt);
    this.lastFrameAt = timestampMs;
    this.frameIndex += 1;

    const stages: Record<string, ZoomPipelineStageTiming> = {};
    const duplicateWork: Record<string, number> = {};
    for (const [stage, pending] of this.pendingStages) {
      const timing = cloneTiming(pending);
      timing.totalMs = roundMs(timing.totalMs);
      timing.maxMs = roundMs(timing.maxMs);
      stages[stage] = timing;
      addTiming(this.stageTotals, stage, timing);
      for (const [key, count] of pending.workKeys) {
        const duplicateCount = Math.max(0, count - 1);
        if (duplicateCount === 0) continue;
        duplicateWork[key] = (duplicateWork[key] ?? 0) + duplicateCount;
        this.duplicateWork.set(key, (this.duplicateWork.get(key) ?? 0) + duplicateCount);
      }
    }
    this.pendingStages.clear();

    const eventCount = this.eventCount;
    const frame: ZoomPipelineFrame = {
      frameIndex: this.frameIndex,
      timestampMs: roundMs(timestampMs),
      deltaMs: roundMs(deltaMs),
      runtimeBudgetMs: roundMs(Math.max(0, input.runtimeBudgetMs)),
      scale: safeNumber(input.scale),
      scrollLeft: safeNumber(input.scrollLeft),
      scrollTop: safeNumber(input.scrollTop),
      eventCount,
      coalescedEventCount: Math.max(0, eventCount - 1),
      pendingRaf: input.pendingRaf,
      pendingSettle: input.pendingSettle,
      nativeMutationCount: Math.max(0, Math.floor(input.nativeMutationCount)),
      visiblePages: Math.max(0, Math.floor(input.visiblePages)),
      overlaysTouched: Math.max(0, Math.floor(input.overlaysTouched)),
      totalPluginWorkMs: roundMs(input.totalPluginWorkMs),
      stages,
      duplicateWork
    };
    this.eventCount = 0;
    this.pendingEvents.clear();
    this.frames.push(frame);
    if (this.frames.length > MAX_RETAINED_FRAMES) this.frames.shift();
    if (this.representativeFrames.length < MAX_REPRESENTATIVE_FRAMES) {
      this.representativeFrames.push(cloneFrame(frame));
    }
    this.worstFrames.push(cloneFrame(frame));
    this.worstFrames.sort((left, right) => this.frameScore(right) - this.frameScore(left));
    if (this.worstFrames.length > MAX_WORST_FRAMES) this.worstFrames.length = MAX_WORST_FRAMES;
    return frame;
  }

  flushFrame(input: FrameInput): ZoomPipelineFrame | null {
    if (!this.active || (this.eventCount === 0 && this.pendingStages.size === 0)) return null;
    return this.recordFrame(input);
  }

  finish(at = this.clock.now()): ZoomPipelineSummary | null {
    if (!this.active) return this.latestSummary();
    this.active = false;
    const summary = this.buildSummary();
    this.lastSummary = summary;
    return summary;
  }

  summary(): ZoomPipelineSummary | null {
    return this.active ? this.buildSummary() : this.latestSummary();
  }

  latestSummary(): ZoomPipelineSummary | null {
    return this.lastSummary ? cloneSummary(this.lastSummary) : null;
  }

  private buildSummary(): ZoomPipelineSummary {
    return {
      event: "zoom-frame-pipeline",
      zoomBurstId: this.burstId,
      framesObserved: this.frameIndex,
      slowFrameCount: this.frames.filter((frame) => frame.deltaMs >= frame.runtimeBudgetMs * 1.5 || frame.totalPluginWorkMs >= frame.runtimeBudgetMs).length,
      stageTotals: Object.fromEntries([...this.stageTotals.entries()].map(([name, timing]) => [name, cloneTiming(timing)])),
      duplicateWork: Object.fromEntries(this.duplicateWork),
      representativeFrames: this.representativeFrames.map(cloneFrame),
      worstFrames: this.worstFrames.map(cloneFrame)
    };
  }

  private frameScore(frame: ZoomPipelineFrame): number {
    return Math.max(frame.deltaMs, frame.totalPluginWorkMs);
  }
}

function cloneSummary(summary: ZoomPipelineSummary): ZoomPipelineSummary {
  return {
    ...summary,
    stageTotals: Object.fromEntries(Object.entries(summary.stageTotals).map(([name, timing]) => [name, cloneTiming(timing)])),
    duplicateWork: { ...summary.duplicateWork },
    representativeFrames: summary.representativeFrames.map(cloneFrame),
    worstFrames: summary.worstFrames.map(cloneFrame)
  };
}
