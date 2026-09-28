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

  it("keeps independent slow spans distinct by correlation", () => {
    const trace = new SlowSpanTrace();
    expect(trace.record({
      kind: "async",
      category: "ink",
      stage: "input-to-render",
      durationMs: 30,
      correlationId: "physical-contact-1"
    })).not.toBeNull();
    expect(trace.record({
      kind: "async",
      category: "ink",
      stage: "input-to-render",
      durationMs: 31,
      correlationId: "physical-contact-2"
    })).not.toBeNull();
    expect(trace.record({
      kind: "async",
      category: "ink",
      stage: "input-to-render",
      durationMs: 32,
      correlationId: "physical-contact-2"
    })).toBeNull();
    expect(trace.summary().byStage["input-to-render"]).toBe(2);
    expect(trace.summary().worstSpans.map((span) => span.correlationId)).toEqual([
      "physical-contact-2",
      "physical-contact-1"
    ]);
  });

  it("retains only thresholded slow ink stages with physical-contact correlation", () => {
    const trace = new SlowSpanTrace();
    expect(trace.recordInkStroke({
      pointerId: 7,
      physicalContactId: "physical-contact-7",
      strokeId: "stroke-7",
      page: 2,
      tool: "pencil",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 8,
      strokeStartToFirstCanvasCommitMs: 51,
      maxInputToRenderMs: 25,
      p95InputToRenderMs: 24,
      maxPluginCallbackMs: 8,
      p95FrameMs: 9,
      maxFrameMs: 12,
      pointerUpToCommitMs: 50
    })).toMatchObject({
      interaction: "ink-stroke",
      pointerId: 7,
      physicalContactId: "physical-contact-7",
      strokeId: "stroke-7",
      slowStages: expect.arrayContaining([
        expect.objectContaining({ stage: "pointer-down-to-stroke-start", thresholdMs: SLOW_SPAN_SYNC_MS }),
        expect.objectContaining({ stage: "first-canvas-commit", thresholdMs: SLOW_SPAN_INTERACTION_MS }),
        expect.objectContaining({ stage: "input-to-render", thresholdMs: SLOW_SPAN_ASYNC_MS }),
        expect.objectContaining({ stage: "plugin-callback", thresholdMs: SLOW_SPAN_SYNC_MS }),
        expect.objectContaining({ stage: "pointerup-to-commit", thresholdMs: SLOW_SPAN_INTERACTION_MS })
      ])
    });
    const summary = trace.slowInkStrokeSummary();
    expect(summary.totalSlowStrokes).toBe(1);
    expect(summary.byStage["input-to-render"]).toBe(1);
    expect(summary.worstStrokes).toHaveLength(1);
  });

  it("does not classify physical pen-down time as a slow stroke", () => {
    const trace = new SlowSpanTrace();
    expect(trace.recordInkStroke({
      pointerId: 9,
      physicalContactId: "physical-contact-9",
      strokeId: "stroke-9",
      page: 1,
      tool: "pen",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 4,
      strokeStartToFirstCanvasCommitMs: null,
      maxInputToRenderMs: 0,
      p95InputToRenderMs: 0,
      maxPluginCallbackMs: 0,
      p95FrameMs: 0,
      maxFrameMs: 0,
      pointerUpToCommitMs: 2
    })).toBeNull();
    expect(trace.slowInkStrokeSummary().totalSlowStrokes).toBe(0);
  });

  it("interpolates p95 so two samples do not report the smaller one", () => {
    const trace = new SlowSpanTrace();
    trace.record({ kind: "async", category: "zoom", stage: "zoom-settle", durationMs: 563, zoomBurstId: "zoom-1" });
    trace.record({ kind: "async", category: "zoom", stage: "zoom-settle", durationMs: 1677, zoomBurstId: "zoom-2" });
    expect(trace.summary().p95ByStage["zoom-settle"]).toBe(1621.3);
    expect(trace.summary().maxByStage["zoom-settle"]).toBe(1677);
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
