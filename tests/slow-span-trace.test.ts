import { describe, expect, it } from "vitest";
import {
  SLOW_SPAN_ASYNC_MS,
  SLOW_SPAN_INTERACTION_MS,
  SLOW_SPAN_SYNC_MS,
  SLOW_SPAN_WORST_LIMIT,
  SlowSpanTrace
} from "../src/runtime/SlowSpanTrace";

describe("SlowSpanTrace", () => {
  it("emits synchronous work only at 8 ms and keeps the worst spans bounded", () => {
    const trace = new SlowSpanTrace();
    expect(trace.record({ kind: "sync", category: "zoom", stage: "zoom-settle", durationMs: SLOW_SPAN_SYNC_MS - 0.1 })).toBeNull();
    expect(trace.record({ kind: "sync", category: "zoom", stage: "zoom-settle", durationMs: SLOW_SPAN_SYNC_MS, activeWorkMs: 8, waitMs: 0 })?.stage).toBe("zoom-settle");
    expect(trace.record({ kind: "sync", category: "zoom", stage: "zoom-settle", durationMs: 40 })).toBeNull();
    for (let index = 0; index < 12; index += 1) {
      trace.record({ kind: "async", category: "zoom", stage: `wait-${index}`, durationMs: 30 + index, zoomBurstId: `zoom-${index}` });
    }
    const summary = trace.summary();
    expect(summary.worstSpans.length).toBeLessThanOrEqual(SLOW_SPAN_WORST_LIMIT);
    expect(summary.byStage["zoom-settle"]).toBe(1);
    expect(summary.maxByStage["zoom-settle"]).toBe(SLOW_SPAN_SYNC_MS);
  });

  it("aggregates settle churn once and separates wait from active work", () => {
    const trace = new SlowSpanTrace();
    expect(trace.recordSettleChurn({
      settleDelayMs: SLOW_SPAN_ASYNC_MS - 1,
      settleTimerResetCount: 2,
      resetReasons: {},
      lastDeferralReason: "pinch-cleanup"
    })).toBeNull();
    const churn = trace.recordSettleChurn({
      settleDelayMs: 1260,
      settleTimerResetCount: 46,
      resetReasons: { "pages-page-render": 40, "pinch-cleanup": 6 },
      lastDeferralReason: "pinch-cleanup",
      zoomBurstId: "zoom-7"
    });
    expect(churn).toMatchObject({
      stage: "settle-timer-churn",
      waitMs: 1260,
      activeWorkMs: null,
      settleTimerResetCount: 46
    });
    expect(trace.recordSettleChurn({
      settleDelayMs: 2000,
      settleTimerResetCount: 50,
      resetReasons: {},
      lastDeferralReason: null,
      zoomBurstId: "zoom-7"
    })).toBeNull();
    const wait = trace.record({
      kind: "async",
      category: "zoom",
      stage: "gesture-cleanup-wait",
      durationMs: 1260,
      activeWorkMs: 0,
      waitMs: 1260,
      reason: "pinch-cleanup"
    });
    expect(wait?.thresholdMs).toBe(SLOW_SPAN_ASYNC_MS);
  });

  it("decomposes the first post-zoom pen without calling the think time plugin work", () => {
    const trace = new SlowSpanTrace();
    trace.beginPostZoom("zoom-7", 1_000);
    trace.notePenDown(1_616);
    trace.noteStrokeStart(1_620);
    const fast = trace.finishFirstPen(1_622);
    expect(fast).toBeNull();

    const slow = new SlowSpanTrace();
    slow.beginPostZoom("zoom-7", 1_000);
    slow.notePenDown(1_616);
    slow.noteStrokeStart(1_640);
    const interaction = slow.finishFirstPen(1_700);
    expect(interaction?.zoomSettleToPointerDownMs).toBe(616);
    expect(interaction?.slowStages.map((stage) => stage.stage)).toEqual([
      "pointerDownToStrokeStartMs",
      "strokeStartToFirstInkMs"
    ]);
    expect(interaction?.slowStages.some((stage) => stage.stage.includes("zoomSettle"))).toBe(false);
    expect(interaction?.totalPointerDownToFirstInkMs).toBeGreaterThanOrEqual(SLOW_SPAN_INTERACTION_MS);
  });
});
