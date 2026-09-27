import { describe, expect, it } from "vitest";
import {
  BoundedTiming,
  buildScaleDeltaHistogram,
  buildTimingHistogram,
  FRAME_MS_120,
  percentile,
  roundMetric
} from "../src/logging/PerformanceMetrics";

describe("bounded performance metrics", () => {
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
