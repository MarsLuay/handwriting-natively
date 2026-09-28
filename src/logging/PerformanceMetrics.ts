import type { FrameTimingThresholds } from "./RuntimeFrameProfile";

export const PERFORMANCE_SAMPLE_LIMIT = 256;
/** One frame on a 120 Hz display; retained for synchronous-work compatibility. */
export const FRAME_MS_120 = 1000 / 120;

export type FrameTimingProvider = () => FrameTimingThresholds;

export interface TimingSummary {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lateFrameCount: number;
  droppedFrameEstimate: number;
  histogram: Record<string, number>;
}

/**
 * Bounded timing accumulator for copied diagnostics. It keeps exact counters,
 * totals, and maxima while retaining only a small ring of samples for
 * percentiles and histograms.
 */
export class BoundedTiming {
  private readonly samples: number[] = [];
  private countValue = 0;
  private totalValue = 0;
  private maxValue = 0;
  private lateValue = 0;
  private droppedValue = 0;
  private readonly frameTiming: FrameTimingProvider;

  constructor(
    lateThresholdOrProvider: number | FrameTimingProvider = FRAME_MS_120,
    frameBudgetMs = FRAME_MS_120
  ) {
    this.frameTiming = typeof lateThresholdOrProvider === "function"
      ? lateThresholdOrProvider
      : () => ({
        frameBudgetMs: positiveFrameBudget(frameBudgetMs),
        lateFrameThresholdMs: nonNegativeThreshold(lateThresholdOrProvider),
        missedFrameThresholdMs: positiveFrameBudget(frameBudgetMs) * 2,
        substantialStallThresholdMs: positiveFrameBudget(frameBudgetMs) * 3
      });
  }

  add(value: number): void {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    const thresholds = this.frameTiming();
    const frameBudgetMs = positiveFrameBudget(thresholds.frameBudgetMs);
    const lateThresholdMs = nonNegativeThreshold(thresholds.lateFrameThresholdMs);
    this.countValue += 1;
    this.totalValue += safe;
    this.maxValue = Math.max(this.maxValue, safe);
    if (safe > lateThresholdMs) this.lateValue += 1;
    this.droppedValue += Math.max(0, Math.round(safe / frameBudgetMs) - 1);
    if (this.samples.length < PERFORMANCE_SAMPLE_LIMIT) {
      this.samples.push(safe);
    } else {
      this.samples[this.countValue % PERFORMANCE_SAMPLE_LIMIT] = safe;
    }
  }

  get count(): number { return this.countValue; }
  get totalMs(): number { return this.totalValue; }
  get maxMs(): number { return this.maxValue; }
  sampleValues(): readonly number[] { return this.samples.slice(); }

  summary(): TimingSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentileAt = (fraction: number): number => percentile(sorted, fraction);
    const frameBudgetMs = positiveFrameBudget(this.frameTiming().frameBudgetMs);
    return {
      count: this.countValue,
      averageMs: this.countValue ? this.totalValue / this.countValue : 0,
      p50Ms: percentileAt(0.5),
      p95Ms: percentileAt(0.95),
      maxMs: this.maxValue,
      lateFrameCount: this.lateValue,
      droppedFrameEstimate: this.droppedValue,
      histogram: buildTimingHistogram(this.samples, frameBudgetMs)
    };
  }
}

export function buildScaleDeltaHistogram(values: readonly number[]): Record<string, number> {
  const histogram = { "0-0.01": 0, "0.01-0.05": 0, "0.05+": 0 };
  for (const value of values) {
    if (value < 0.01) histogram["0-0.01"] += 1;
    else if (value < 0.05) histogram["0.01-0.05"] += 1;
    else histogram["0.05+"] += 1;
  }
  return histogram;
}

export function buildTimingHistogram(values: readonly number[], frameBudgetMs = FRAME_MS_120): Record<string, number> {
  const frame = positiveFrameBudget(frameBudgetMs);
  const first = `0-${bucketLabel(frame)}`;
  const second = `${bucketLabel(frame)}-${bucketLabel(frame * 2)}`;
  const third = `${bucketLabel(frame * 2)}-${bucketLabel(frame * 4)}`;
  const fourth = `${bucketLabel(frame * 4)}+`;
  const histogram: Record<string, number> = { [first]: 0, [second]: 0, [third]: 0, [fourth]: 0 };
  for (const value of values) {
    if (value < frame) histogram[first]! += 1;
    else if (value < frame * 2) histogram[second]! += 1;
    else if (value < frame * 4) histogram[third]! += 1;
    else histogram[fourth]! += 1;
  }
  return histogram;
}

export function percentile(sortedAscending: readonly number[], fraction: number): number {
  const count = sortedAscending.length;
  if (count === 0) return 0;
  if (count === 1) return sortedAscending[0]!;
  const position = (count - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAscending[lower]!;
  const weight = position - lower;
  return sortedAscending[lower]! * (1 - weight) + sortedAscending[upper]! * weight;
}

export function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveFrameBudget(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : FRAME_MS_120;
}

function nonNegativeThreshold(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : FRAME_MS_120;
}

function bucketLabel(value: number): string {
  return String(Math.round(value * 10) / 10);
}
