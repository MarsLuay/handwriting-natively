import { describe, expect, it } from "vitest";
import {
  BoundedTiming,
  EffectiveFrameBudget,
  buildScaleDeltaHistogram,
  buildTimingHistogram,
  FRAME_MS_120,
  percentile,
  roundMetric
} from "../src/logging/PerformanceMetrics";

describe("bounded performance metrics", () => {
  it("measures clean rAF cadence without learning a jank episode", () => {
    const budget = new EffectiveFrameBudget({ platform: "ipad", runtime: "wkwebview" });
    let timestamp = 0;
    budget.observeRaf(timestamp);
    for (let index = 0; index < 24; index += 1) {
      timestamp += 16.67;
      budget.observeRaf(timestamp);
    }
    const stable = budget.snapshot();
    expect(stable).toMatchObject({
      measuredRefreshHz: 60,
      measuredFrameBudgetMs: 16.67,
      sampleCount: 24,
      confidence: "stable",
      thresholdSource: "measured-raf",
      lateFrameThresholdMs: 25.01,
      platform: "ipad",
      runtime: "wkwebview"
    });

    for (let index = 0; index < 4; index += 1) {
      timestamp += 447;
      budget.observeRaf(timestamp);
    }
    expect(budget.snapshot()).toMatchObject({
      measuredRefreshHz: 60,
      sampleCount: 24,
      thresholdSource: "measured-raf"
    });
  });

  it("does not promote active every-other-frame delivery to a 30Hz baseline", () => {
    const budget = new EffectiveFrameBudget({ fallbackRefreshHz: 60, platform: "ipad", runtime: "wkwebview" });
    budget.observeRaf(0, false, "active");
    for (let index = 1; index <= 24; index += 1) budget.observeRaf(index * 33.33, false, "active");

    expect(budget.snapshot()).toMatchObject({
      measuredRefreshHz: 30,
      measuredFrameBudgetMs: 33.33,
      frameBudgetMs: 16.67,
      thresholdSource: "platform-fallback",
      cadenceInterpretation: "harmonic-missed-frame",
      cadenceSampleSource: "active",
      activeSampleCount: 24,
      idleSampleCount: 0
    });
  });

  it("accepts a stable 30Hz cadence from the idle sampling window", () => {
    const budget = new EffectiveFrameBudget({ fallbackRefreshHz: 60, platform: "low-refresh", runtime: "webview" });
    budget.observeRaf(0, false, "idle");
    for (let index = 1; index <= 24; index += 1) budget.observeRaf(index * 33.33, false, "idle");

    expect(budget.snapshot()).toMatchObject({
      measuredRefreshHz: 30,
      measuredFrameBudgetMs: 33.33,
      frameBudgetMs: 33.33,
      thresholdSource: "measured-raf",
      cadenceInterpretation: "measured-raf",
      cadenceSampleSource: "idle",
      activeSampleCount: 0,
      idleSampleCount: 24
    });
  });

  it("lets idle evidence recover the 60Hz baseline after active frame misses", () => {
    const budget = new EffectiveFrameBudget({ fallbackRefreshHz: 60 });
    budget.observeRaf(0, false, "active");
    for (let index = 1; index <= 24; index += 1) budget.observeRaf(index * 33.33, false, "active");
    budget.observeRaf(0, false, "idle");
    for (let index = 1; index <= 24; index += 1) budget.observeRaf(index * 16.67, false, "idle");

    expect(budget.snapshot()).toMatchObject({
      measuredRefreshHz: 60,
      measuredFrameBudgetMs: 16.67,
      frameBudgetMs: 16.67,
      thresholdSource: "measured-raf",
      cadenceSampleSource: "idle"
    });
  });

  it("uses the fallback until enough clean rAF samples establish cadence", () => {
    const budget = new EffectiveFrameBudget({ fallbackRefreshHz: 60, platform: "desktop", runtime: "electron" });
    budget.observeRaf(0);
    for (let index = 1; index <= 12; index += 1) budget.observeRaf(index * 8.33);
    expect(budget.snapshot()).toMatchObject({
      measuredRefreshHz: 120,
      confidence: "low",
      thresholdSource: "platform-fallback",
      frameBudgetMs: 16.67
    });
    for (let index = 13; index <= 24; index += 1) budget.observeRaf(index * 8.33);
    expect(budget.snapshot()).toMatchObject({
      confidence: "stable",
      thresholdSource: "measured-raf",
      frameBudgetMs: 8.33
    });
  });

  it("distinguishes a smooth 120Hz trace from a stalled trace", () => {
    const smooth = new BoundedTiming();
    const stalled = new BoundedTiming();
    for (let index = 0; index < 12; index += 1) smooth.add(8);
    for (const value of [16.7, 16.8, 52, 17, 41]) stalled.add(value);

    expect(smooth.summary()).toMatchObject({
      count: 12,
      lateFrameCount: 0,
      droppedFrameEstimate: 0,
      p95Ms: 8
    });
    expect(stalled.summary()).toMatchObject({
      count: 5,
      lateFrameCount: 5,
      droppedFrameEstimate: 12,
      maxMs: 52
    });
  });

  it("keeps samples bounded while preserving aggregate counts", () => {
    const timing = new BoundedTiming();
    for (let index = 0; index < 400; index += 1) timing.add(index % 60);

    const summary = timing.summary();
    expect(summary.count).toBe(400);
    expect(summary.histogram).toEqual(expect.objectContaining({ "0-8.3": expect.any(Number), "8.3-16.7": expect.any(Number), "16.7-33.3": expect.any(Number), "33.3+": expect.any(Number) }));
    expect(Object.values(summary.histogram).reduce((total, value) => total + value, 0)).toBe(256);
  });

  it("uses scale-delta buckets rather than time buckets for zoom cadence", () => {
    expect(buildScaleDeltaHistogram([0, 0.01, 0.02, 0.05, 0.08])).toEqual({
      "0-0.01": 1,
      "0.01-0.05": 2,
      "0.05+": 2
    });
  });

  it("interpolates p95 instead of picking the lower rank for a tiny sample", () => {
    expect(percentile([563, 1677], 0.95)).toBeCloseTo(1621.3, 5);
    expect(percentile([FRAME_MS_120], 0.95)).toBe(FRAME_MS_120);
  });

  it("rounds diagnostic values without producing noisy precision", () => {
    expect(roundMetric(12.345)).toBe(12.35);
    expect(buildTimingHistogram([1, 9, 16, 20, 40])).toEqual({
      "0-8.3": 1,
      "8.3-16.7": 2,
      "16.7-33.3": 1,
      "33.3+": 1
    });
  });
});
