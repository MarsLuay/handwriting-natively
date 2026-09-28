export const PERFORMANCE_SAMPLE_LIMIT = 256;
/** One frame on a 120 Hz display. Keep this for synchronous plugin-work budgets. */
export const FRAME_MS_120 = 1000 / 120;
export const DEFAULT_FRAME_FALLBACK_HZ = 60;
export const FRAME_PROFILE_SAMPLE_LIMIT = 48;
export const FRAME_PROFILE_MIN_SAMPLES = 12;
export const FRAME_PROFILE_STABLE_SAMPLES = 24;
const MIN_CLEAN_FRAME_INTERVAL_MS = 4;
/** Includes real 30 Hz low-power rAF while excluding obvious 10 Hz jank. */
const MAX_CLEAN_FRAME_INTERVAL_MS = 34;
const HARMONIC_MIN_RATIO = 1.75;
const HARMONIC_MAX_RATIO = 2.25;

export type FrameCadenceConfidence = "insufficient" | "low" | "stable";
export type FrameThresholdSource = "measured-raf" | "platform-fallback";
export type FrameCadenceSampleKind = "active" | "idle";
export type FrameCadenceInterpretation = "insufficient" | "measured-raf" | "harmonic-missed-frame";

export interface RuntimeFrameProfile {
  /** The observed cadence candidate, even when the conservative fallback wins. */
  measuredRefreshHz: number | null;
  measuredFrameBudgetMs: number | null;
  fallbackRefreshHz: number;
  fallbackFrameBudgetMs: number;
  frameBudgetMs: number;
  lateFrameThresholdMs: number;
  missedFrameThresholdMs: number;
  substantialStallThresholdMs: number;
  sampleCount: number;
  activeSampleCount: number;
  idleSampleCount: number;
  cadenceSampleSource: FrameCadenceSampleKind;
  cadenceInterpretation: FrameCadenceInterpretation;
  confidence: FrameCadenceConfidence;
  thresholdSource: FrameThresholdSource;
  platform: string;
  runtime: string;
}

export interface EffectiveFrameBudgetOptions {
  fallbackRefreshHz?: number;
  platform?: string;
  runtime?: string;
}

/**
 * Shared bounded rAF cadence estimator. It accepts only distinct, visible
 * timestamps and ignores outliers, so an active jank episode cannot teach the
 * telemetry that the display is suddenly running at 10 Hz.
 *
 * Active callbacks can be delayed by the work being measured. A stable active
 * 33 ms cadence is therefore ambiguous on a 60 Hz runtime: it may be genuine
 * 30 Hz or every-other-frame delivery. Idle samples from the lightweight
 * sampler resolve that ambiguity; until then the 60 Hz fallback remains in
 * force so missed frames cannot silently become the new baseline.
 */
export class EffectiveFrameBudget {
  private readonly samplesByKind: Record<FrameCadenceSampleKind, number[]> = { active: [], idle: [] };
  private readonly acceptedSampleCountByKind: Record<FrameCadenceSampleKind, number> = { active: 0, idle: 0 };
  private readonly lastRafAtByKind: Record<FrameCadenceSampleKind, number | null> = { active: null, idle: null };
  private measuredFrameBudgetMs: number | null = null;
  private measuredSampleSource: FrameCadenceSampleKind = "active";
  private measurementDirty = true;

  constructor(private readonly options: EffectiveFrameBudgetOptions = {}) {}

  observeRaf(
    timestampMs: number,
    documentHidden = false,
    sampleKind: FrameCadenceSampleKind = "active"
  ): void {
    if (!Number.isFinite(timestampMs)) return;
    if (documentHidden) {
      this.lastRafAtByKind[sampleKind] = null;
      return;
    }
    const previous = this.lastRafAtByKind[sampleKind];
    this.lastRafAtByKind[sampleKind] = timestampMs;
    if (previous === null) return;
    const intervalMs = timestampMs - previous;
    // Multiple callbacks from the same animation frame share a timestamp.
    if (intervalMs <= 0 || intervalMs < MIN_CLEAN_FRAME_INTERVAL_MS || intervalMs > MAX_CLEAN_FRAME_INTERVAL_MS) return;
    const samples = this.samplesByKind[sampleKind];
    if (samples.length < FRAME_PROFILE_SAMPLE_LIMIT) samples.push(intervalMs);
    else samples.shift(), samples.push(intervalMs);
    this.acceptedSampleCountByKind[sampleKind] += 1;
    const selectedSource = this.selectedSampleSource();
    if (selectedSource !== this.measuredSampleSource
      || this.acceptedSampleCountByKind[selectedSource] === FRAME_PROFILE_MIN_SAMPLES
      || this.acceptedSampleCountByKind[selectedSource] % 8 === 0) {
      this.measurementDirty = true;
    }
  }

  snapshot(): RuntimeFrameProfile {
    const fallbackRefreshHz = Math.max(1, this.options.fallbackRefreshHz ?? DEFAULT_FRAME_FALLBACK_HZ);
    const fallbackFrameBudgetMs = 1000 / fallbackRefreshHz;
    const selectedSource = this.selectedSampleSource();
    const samples = this.samplesByKind[selectedSource];
    this.refreshEstimate(selectedSource, samples);
    const sampleCount = samples.length;
    const confidence: FrameCadenceConfidence = sampleCount < FRAME_PROFILE_MIN_SAMPLES
      ? "insufficient"
      : sampleCount < FRAME_PROFILE_STABLE_SAMPLES
        ? "low"
        : "stable";
    const harmonicMissedFrame = confidence === "stable"
      && this.measuredFrameBudgetMs !== null
      && selectedSource === "active"
      && this.measuredFrameBudgetMs / fallbackFrameBudgetMs >= HARMONIC_MIN_RATIO
      && this.measuredFrameBudgetMs / fallbackFrameBudgetMs <= HARMONIC_MAX_RATIO;
    const thresholdSource: FrameThresholdSource = confidence === "stable"
      && this.measuredFrameBudgetMs !== null
      && !harmonicMissedFrame
      ? "measured-raf"
      : "platform-fallback";
    const frameBudgetMs = thresholdSource === "measured-raf"
      ? this.measuredFrameBudgetMs!
      : fallbackFrameBudgetMs;
    return {
      measuredRefreshHz: this.measuredFrameBudgetMs === null ? null : Math.round((1000 / this.measuredFrameBudgetMs) * 10) / 10,
      measuredFrameBudgetMs: this.measuredFrameBudgetMs,
      fallbackRefreshHz,
      fallbackFrameBudgetMs: roundMetric(fallbackFrameBudgetMs),
      frameBudgetMs: roundMetric(frameBudgetMs),
      lateFrameThresholdMs: roundMetric(frameBudgetMs * 1.5),
      missedFrameThresholdMs: roundMetric(frameBudgetMs * 2),
      substantialStallThresholdMs: roundMetric(frameBudgetMs * 3),
      sampleCount,
      activeSampleCount: this.samplesByKind.active.length,
      idleSampleCount: this.samplesByKind.idle.length,
      cadenceSampleSource: selectedSource,
      cadenceInterpretation: this.measuredFrameBudgetMs === null || confidence === "insufficient"
        ? "insufficient"
        : harmonicMissedFrame
          ? "harmonic-missed-frame"
          : "measured-raf",
      confidence,
      thresholdSource,
      platform: this.options.platform ?? "unknown",
      runtime: this.options.runtime ?? "unknown"
    };
  }

  private selectedSampleSource(): FrameCadenceSampleKind {
    return this.samplesByKind.idle.length >= FRAME_PROFILE_MIN_SAMPLES ? "idle" : "active";
  }

  private refreshEstimate(source: FrameCadenceSampleKind, samples: readonly number[]): void {
    if (!this.measurementDirty || samples.length < FRAME_PROFILE_MIN_SAMPLES) return;
    this.measuredFrameBudgetMs = roundMetric(percentile([...samples].sort((a, b) => a - b), 0.5));
    this.measuredSampleSource = source;
    this.measurementDirty = false;
  }
}

export interface FrameTimingThresholds {
  frameBudgetMs: number;
  lateFrameThresholdMs: number;
}

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

  constructor(
    private readonly lateThresholdMs = FRAME_MS_120,
    private readonly frameBudgetMs = FRAME_MS_120,
    private readonly frameTiming?: () => FrameTimingThresholds
  ) {}

  add(value: number): void {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    const frameTiming = this.currentFrameTiming();
    this.countValue += 1;
    this.totalValue += safe;
    this.maxValue = Math.max(this.maxValue, safe);
    if (safe > frameTiming.lateFrameThresholdMs) this.lateValue += 1;
    this.droppedValue += Math.max(0, Math.round(safe / frameTiming.frameBudgetMs) - 1);
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
    const frameTiming = this.currentFrameTiming();
    return {
      count: this.countValue,
      averageMs: this.countValue ? this.totalValue / this.countValue : 0,
      p50Ms: percentileAt(0.5),
      p95Ms: percentileAt(0.95),
      maxMs: this.maxValue,
      lateFrameCount: this.lateValue,
      droppedFrameEstimate: this.droppedValue,
      histogram: buildTimingHistogram(this.samples, frameTiming.frameBudgetMs)
    };
  }

  private currentFrameTiming(): FrameTimingThresholds {
    return this.frameTiming?.() ?? {
      lateFrameThresholdMs: this.lateThresholdMs,
      frameBudgetMs: this.frameBudgetMs
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

export function buildTimingHistogram(
  values: readonly number[],
  frameBudgetMs = FRAME_MS_120
): Record<string, number> {
  const frame = Math.max(0.1, frameBudgetMs);
  const labels = [
    `0-${frameLabel(frame)}`,
    `${frameLabel(frame)}-${frameLabel(frame * 2)}`,
    `${frameLabel(frame * 2)}-${frameLabel(frame * 4)}`,
    `${frameLabel(frame * 4)}+`
  ] as const;
  const [withinFrame, oneToTwoFrames, twoToFourFrames, overFourFrames] = labels;
  const histogram: Record<string, number> = Object.fromEntries(labels.map((label) => [label, 0]));
  const increment = (label: string): void => { histogram[label] = (histogram[label] ?? 0) + 1; };
  for (const value of values) {
    if (value < frame) increment(withinFrame);
    else if (value < frame * 2) increment(oneToTwoFrames);
    else if (value < frame * 4) increment(twoToFourFrames);
    else increment(overFourFrames);
  }
  return histogram;
}

function frameLabel(value: number): string {
  return String(Math.round(value * 10) / 10);
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
