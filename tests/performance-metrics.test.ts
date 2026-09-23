import { describe, expect, it } from "vitest";
import { BoundedTiming, buildScaleDeltaHistogram, buildTimingHistogram, roundMetric } from "../src/logging/PerformanceMetrics";

describe("bounded performance metrics", () => {
  it("distinguishes a smooth 60Hz trace from a stalled trace", () => {
    const smooth = new BoundedTiming(24);
    const stalled = new BoundedTiming(24);
    for (let index = 0; index < 12; index += 1) smooth.add(16.7);
    for (const value of [16.7, 16.8, 52, 17, 41]) stalled.add(value);

    expect(smooth.summary()).toMatchObject({
      count: 12,
      lateFrameCount: 0,
      droppedFrameEstimate: 0,
      p95Ms: 16.7
    });
    expect(stalled.summary()).toMatchObject({
      count: 5,
      lateFrameCount: 2,
      droppedFrameEstimate: 3,
      maxMs: 52
    });
  });

  it("keeps samples bounded while preserving aggregate counts", () => {
    const timing = new BoundedTiming(24);
    for (let index = 0; index < 400; index += 1) timing.add(index % 60);

    const summary = timing.summary();
    expect(summary.count).toBe(400);
    expect(summary.histogram).toEqual(expect.objectContaining({ "0-16": expect.any(Number), "16-24": expect.any(Number), "24-50": expect.any(Number), "50+": expect.any(Number) }));
    expect(Object.values(summary.histogram).reduce((total, value) => total + value, 0)).toBe(256);
  });

  it("uses scale-delta buckets rather than time buckets for zoom cadence", () => {
    expect(buildScaleDeltaHistogram([0, 0.01, 0.02, 0.05, 0.08])).toEqual({
      "0-0.01": 1,
      "0.01-0.05": 2,
      "0.05+": 2
    });
  });

  it("rounds diagnostic values without producing noisy precision", () => {
    expect(roundMetric(12.345)).toBe(12.35);
    expect(buildTimingHistogram([1, 16, 23.9, 24, 49.9, 50])).toEqual({
      "0-16": 1,
      "16-24": 2,
      "24-50": 2,
      "50+": 1
    });
  });
});
