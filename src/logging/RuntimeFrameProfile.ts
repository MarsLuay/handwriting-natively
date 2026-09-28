export type RuntimeFrameConfidence = "insufficient" | "low" | "stable";
export type RuntimeFrameThresholdSource = "measured-raf" | "platform-fallback";

export interface FrameTimingThresholds {
  frameBudgetMs: number;
  lateFrameThresholdMs: number;
  missedFrameThresholdMs: number;
  substantialStallThresholdMs: number;
}

export interface RuntimeFrameProfileSnapshot extends FrameTimingThresholds {
  measuredRefreshHz: number | null;
  measuredFrameBudgetMs: number | null;
  refreshHz: number;
  sampleCount: number;
  confidence: RuntimeFrameConfidence;
  thresholdSource: RuntimeFrameThresholdSource;
  platform: string;
  runtime: string;
}

export interface RuntimeFrameProfileOptions {
  platform?: string;
  runtime?: string;
  fallbackRefreshHz?: number;
  minMeasuredSamples?: number;
  stableMeasuredSamples?: number;
}

export interface RuntimeFrameObservationOptions {
  documentHidden?: boolean;
}

const MAX_RETAINED_SAMPLES = 120;
const MIN_CLEAN_INTERVAL_MS = 4;
const MAX_CLEAN_INTERVAL_MS = 40;
const DEFAULT_FALLBACK_REFRESH_HZ = 60;
const DEFAULT_MIN_MEASURED_SAMPLES = 6;
const DEFAULT_STABLE_MEASURED_SAMPLES = 24;
const LATE_FRAME_MULTIPLIER = 1.5;
const MISSED_FRAME_MULTIPLIER = 2;
const SUBSTANTIAL_STALL_MULTIPLIER = 3;

/**
 * Bounded, local-only rAF cadence evidence. The estimator keeps only clean
 * intervals and calculates a robust lower-cluster median when a profile is
 * requested; stalled callbacks never become the display baseline.
 */
export class RuntimeFrameProfile {
  private readonly platform: string;
  private readonly runtime: string;
  private readonly fallbackRefreshHz: number;
  private readonly minMeasuredSamples: number;
  private readonly stableMeasuredSamples: number;
  private readonly cleanIntervals: number[] = [];
  private lastRafTimestamp: number | null = null;
  private cleanSampleCount = 0;
  private cachedEstimate: { frameBudgetMs: number; confidence: RuntimeFrameConfidence } | null = null;
  private estimateDirty = true;

  constructor(options: RuntimeFrameProfileOptions = {}) {
    this.platform = String(options.platform || "unknown");
    this.runtime = String(options.runtime || "unknown");
    const fallbackRefreshHz = options.fallbackRefreshHz;
    this.fallbackRefreshHz = positiveFinite(fallbackRefreshHz)
      ? fallbackRefreshHz
      : DEFAULT_FALLBACK_REFRESH_HZ;
    this.minMeasuredSamples = Math.max(2, Math.floor(options.minMeasuredSamples ?? DEFAULT_MIN_MEASURED_SAMPLES));
    this.stableMeasuredSamples = Math.max(
      this.minMeasuredSamples,
      Math.floor(options.stableMeasuredSamples ?? DEFAULT_STABLE_MEASURED_SAMPLES)
    );
  }

  /** Feed a real requestAnimationFrame timestamp; no logging or allocation is done per frame. */
  observeRaf(timestamp: number, options: RuntimeFrameObservationOptions = {}): void {
    if (!Number.isFinite(timestamp)) return;
    if (options.documentHidden) {
      this.lastRafTimestamp = null;
      return;
    }
    const previous = this.lastRafTimestamp;
    this.lastRafTimestamp = timestamp;
    if (previous === null) return;
    const interval = timestamp - previous;
    if (interval < MIN_CLEAN_INTERVAL_MS || interval > MAX_CLEAN_INTERVAL_MS) return;
    this.cleanSampleCount += 1;
    this.cleanIntervals.push(interval);
    if (this.cleanIntervals.length > MAX_RETAINED_SAMPLES) this.cleanIntervals.shift();
    this.estimateDirty = true;
  }

  /** Forget only the pending rAF pair, retaining bounded cadence evidence. */
  resetRafSequence(): void {
    this.lastRafTimestamp = null;
  }

  sampleCount(): number {
    return this.cleanSampleCount;
  }

  thresholds(): FrameTimingThresholds {
    const profile = this.snapshot();
    return {
      frameBudgetMs: profile.frameBudgetMs,
      lateFrameThresholdMs: profile.lateFrameThresholdMs,
      missedFrameThresholdMs: profile.missedFrameThresholdMs,
      substantialStallThresholdMs: profile.substantialStallThresholdMs
    };
  }

  snapshot(): RuntimeFrameProfileSnapshot {
    const estimate = this.estimate();
    const measured = estimate.confidence === "insufficient" ? null : estimate.frameBudgetMs;
    const frameBudgetMs = measured ?? 1000 / this.fallbackRefreshHz;
    const thresholdSource: RuntimeFrameThresholdSource = measured === null ? "platform-fallback" : "measured-raf";
    return {
      measuredRefreshHz: measured === null ? null : round(1000 / measured),
      measuredFrameBudgetMs: measured === null ? null : round(measured),
      refreshHz: round(1000 / frameBudgetMs),
      frameBudgetMs: round(frameBudgetMs),
      lateFrameThresholdMs: round(frameBudgetMs * LATE_FRAME_MULTIPLIER),
      missedFrameThresholdMs: round(frameBudgetMs * MISSED_FRAME_MULTIPLIER),
      substantialStallThresholdMs: round(frameBudgetMs * SUBSTANTIAL_STALL_MULTIPLIER),
      sampleCount: this.cleanSampleCount,
      confidence: estimate.confidence,
      thresholdSource,
      platform: this.platform,
      runtime: this.runtime
    };
  }

  private estimate(): { frameBudgetMs: number; confidence: RuntimeFrameConfidence } {
    if (!this.estimateDirty && this.cachedEstimate) return this.cachedEstimate;
    this.estimateDirty = false;
    if (this.cleanIntervals.length < this.minMeasuredSamples) {
      this.cachedEstimate = { frameBudgetMs: 1000 / this.fallbackRefreshHz, confidence: "insufficient" };
      return this.cachedEstimate;
    }

    const sorted = [...this.cleanIntervals].sort((left, right) => left - right);
    const initialMedian = median(sorted);
    // Keep the lower stable cluster. A 2x/3x delayed callback must not turn
    // a healthy display into a false 20 Hz baseline.
    const upperCleanBound = Math.min(
      MAX_CLEAN_INTERVAL_MS,
      Math.max(initialMedian + 2, initialMedian * 1.75)
    );
    const lowerCluster = sorted.filter((value) => value <= upperCleanBound);
    const frameBudgetMs = median(lowerCluster.length >= this.minMeasuredSamples ? lowerCluster : sorted);
    const deviations = lowerCluster.map((value) => Math.abs(value - frameBudgetMs));
    const mad = deviations.length ? median([...deviations].sort((left, right) => left - right)) : frameBudgetMs;
    const confidence = this.cleanSampleCount >= this.stableMeasuredSamples && mad <= frameBudgetMs * 0.15
      ? "stable"
      : "low";
    this.cachedEstimate = { frameBudgetMs, confidence };
    return this.cachedEstimate;
  }
}

function positiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(sortedAscending: readonly number[]): number {
  if (!sortedAscending.length) return 0;
  const middle = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 === 0
    ? (sortedAscending[middle - 1]! + sortedAscending[middle]!) / 2
    : sortedAscending[middle]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
