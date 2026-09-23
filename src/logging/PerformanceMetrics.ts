export const PERFORMANCE_SAMPLE_LIMIT = 256;

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

  constructor(private readonly lateThresholdMs = 24, private readonly frameBudgetMs = 1000 / 60) {}

  add(value: number): void {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    this.countValue += 1;
    this.totalValue += safe;
    this.maxValue = Math.max(this.maxValue, safe);
    if (safe > this.lateThresholdMs) this.lateValue += 1;
    this.droppedValue += Math.max(0, Math.round(safe / this.frameBudgetMs) - 1);
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
    const percentile = (fraction: number): number => sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!
      : 0;
    return {
      count: this.countValue,
      averageMs: this.countValue ? this.totalValue / this.countValue : 0,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: this.maxValue,
      lateFrameCount: this.lateValue,
      droppedFrameEstimate: this.droppedValue,
      histogram: buildTimingHistogram(this.samples)
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

export function buildTimingHistogram(values: readonly number[]): Record<string, number> {
  const histogram = { "0-16": 0, "16-24": 0, "24-50": 0, "50+": 0 };
  for (const value of values) {
    if (value < 16) histogram["0-16"] += 1;
    else if (value < 24) histogram["16-24"] += 1;
    else if (value < 50) histogram["24-50"] += 1;
    else histogram["50+"] += 1;
  }
  return histogram;
}

export function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}
