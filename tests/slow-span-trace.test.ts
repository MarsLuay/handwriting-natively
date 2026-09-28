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
      zoomBurstId: "zoom-7",
      phaseDurations: {
        "settle-timer-wait": 1260,
        "gesture-cleanup": 800,
        "unattributed-post-gesture": 1260
      }
    });
    expect(churn).toMatchObject({
      stage: "settle-timer-churn",
      waitMs: 1260,
      activeWorkMs: null,
      settleTimerResetCount: 46,
      phaseDurations: {
        "settle-timer-wait": 1260,
        "gesture-cleanup": 800,
        "unattributed-post-gesture": 1260
      },
      slowPhases: expect.arrayContaining([
        expect.objectContaining({ phase: "gesture-cleanup", durationMs: 800, thresholdMs: SLOW_SPAN_ASYNC_MS })
      ])
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
      "strokeStartToFirstCanvasCommitMs"
    ]);
    expect(interaction?.slowStages.some((stage) => stage.stage.includes("zoomSettle"))).toBe(false);
    expect(interaction?.totalPointerDownToFirstCanvasCommitMs).toBeGreaterThanOrEqual(SLOW_SPAN_INTERACTION_MS);
  });

  it("deduplicates spans by contact correlation instead of collapsing independent strokes", () => {
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
      durationMs: 40,
      correlationId: "physical-contact-2"
    })).not.toBeNull();
    expect(trace.record({
      kind: "async",
      category: "ink",
      stage: "input-to-render",
      durationMs: 50,
      correlationId: "physical-contact-1"
    })).toBeNull();
    expect(trace.summary().byStage["input-to-render"]).toBe(2);
  });

  it("retains all abnormal stroke stages without using total pen-down duration", () => {
    const trace = new SlowSpanTrace();
    const record = trace.recordInkStroke({
      pointerId: 7,
      physicalContactId: "contact-7",
      strokeId: "stroke-7",
      correlationId: "contact-7",
      page: 2,
      tool: "pencil",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 8,
      strokeStartToFirstCanvasCommitMs: 9,
      totalPointerDownToFirstCanvasCommitMs: 17,
      maxInputToRenderMs: 25,
      p95InputToRenderMs: 25,
      maxPluginCallbackMs: 10,
      longestLongTaskMs: 50,
      p95FrameMs: 9,
      maxFrameMs: 10,
      pointerUpToCommitMs: 8
    });
    expect(record?.slowStages.map((stage) => stage.stage)).toEqual([
      "pointer-down-to-stroke-start",
      "stroke-start-to-first-canvas-commit",
      "input-to-render",
      "stroke-frame-gap",
      "plugin-callback",
      "long-task",
      "pointerup-to-commit"
    ]);
    expect(trace.recordInkStroke({
      pointerId: 8,
      physicalContactId: "contact-8",
      strokeId: "stroke-8",
      correlationId: "contact-8",
      page: 2,
      tool: "pencil",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 1,
      strokeStartToFirstCanvasCommitMs: 1,
      totalPointerDownToFirstCanvasCommitMs: 2,
      maxInputToRenderMs: 1,
      p95InputToRenderMs: 1,
      maxPluginCallbackMs: 1,
      longestLongTaskMs: 1,
      p95FrameMs: 1,
      maxFrameMs: 1,
      pointerUpToCommitMs: 1
    })).toBeNull();
    expect(trace.slowInkStrokeSummary().totalSlowStrokes).toBe(1);
  });

  it("uses the runtime frame budget for stroke-frame gaps but keeps plugin work strict", () => {
    const trace = new SlowSpanTrace();
    const fastAt60Hz = trace.recordInkStroke({
      pointerId: 9,
      physicalContactId: "contact-frame",
      strokeId: "stroke-frame",
      correlationId: "contact-frame",
      page: 1,
      tool: "pen",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 1,
      strokeStartToFirstCanvasCommitMs: 1,
      totalPointerDownToFirstCanvasCommitMs: 2,
      maxInputToRenderMs: 1,
      p95InputToRenderMs: 1,
      maxPluginCallbackMs: 1,
      longestLongTaskMs: 1,
      p95FrameMs: 16.7,
      maxFrameMs: 16.7,
      frameGapThresholdMs: 25,
      pointerUpToCommitMs: 1
    });
    expect(fastAt60Hz).toBeNull();

    const missedAt60Hz = trace.recordInkStroke({
      pointerId: 10,
      physicalContactId: "contact-frame-missed",
      strokeId: "stroke-frame-missed",
      correlationId: "contact-frame-missed",
      page: 1,
      tool: "pen",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 1,
      strokeStartToFirstCanvasCommitMs: 1,
      totalPointerDownToFirstCanvasCommitMs: 2,
      maxInputToRenderMs: 1,
      p95InputToRenderMs: 1,
      maxPluginCallbackMs: 1,
      longestLongTaskMs: 1,
      p95FrameMs: 26,
      maxFrameMs: 26,
      frameGapThresholdMs: 25,
      pointerUpToCommitMs: 1
    });
    expect(missedAt60Hz?.slowStages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "stroke-frame-gap", thresholdMs: 25 })
    ]));
  });

  it("breaks a slow ink span into thresholded pipeline legs", () => {
    const trace = new SlowSpanTrace();
    const record = trace.recordInkStroke({
      pointerId: 11,
      physicalContactId: "contact-latency",
      strokeId: "stroke-latency",
      correlationId: "contact-latency",
      page: 3,
      tool: "pen",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 2,
      strokeStartToFirstCanvasCommitMs: 2,
      totalPointerDownToFirstCanvasCommitMs: 2,
      maxInputToRenderMs: 132,
      p95InputToRenderMs: 132,
      maxPluginCallbackMs: 2,
      longestLongTaskMs: 2,
      p95FrameMs: 148,
      maxFrameMs: 148,
      pointerUpToCommitMs: 2,
      latency: {
        inputMs: 132,
        routingMs: 9,
        geometryMs: 7,
        modelMs: 8,
        schedulingMs: 148,
        canvasCommitMs: 9,
        paintAcknowledgementMs: 26
      }
    });
    expect(record?.latency).toEqual({
      inputMs: 132,
      routingMs: 9,
      geometryMs: 7,
      modelMs: 8,
      schedulingMs: 148,
      canvasCommitMs: 9,
      paintAcknowledgementMs: 26
    });
    expect(record?.slowStages.map((stage) => stage.stage)).toEqual(expect.arrayContaining([
      "input",
      "routing",
      "model",
      "scheduling",
      "canvas-commit",
      "paint-acknowledgement"
    ]));
    expect(record?.slowStages.map((stage) => stage.stage)).not.toContain("geometry");
    expect(trace.slowInkStrokeSummary().byStage).toMatchObject({
      input: 1,
      routing: 1,
      model: 1,
      scheduling: 1,
      "canvas-commit": 1,
      "paint-acknowledgement": 1
    });
  });

  it("retains only thresholded slow strokes and keeps independent worst records bounded", () => {
    const trace = new SlowSpanTrace();
    const fast = {
      pointerId: 1,
      physicalContactId: "fast-contact",
      strokeId: "fast-stroke",
      correlationId: "fast-contact",
      page: 1,
      tool: "pen",
      outcome: "pointerup",
      pointerDownToStrokeStartMs: 1,
      strokeStartToFirstCanvasCommitMs: 2,
      totalPointerDownToFirstCanvasCommitMs: 3,
      maxInputToRenderMs: 24,
      p95InputToRenderMs: 12,
      maxPluginCallbackMs: 7,
      longestLongTaskMs: 49,
      p95FrameMs: 7,
      maxFrameMs: 7,
      pointerUpToCommitMs: 7
    } as const;
    expect(trace.recordInkStroke(fast)).toBeNull();
    expect(trace.slowInkStrokeSummary().totalSlowStrokes).toBe(0);

    for (let index = 0; index < SLOW_SPAN_WORST_LIMIT + 2; index += 1) {
      const slow = trace.recordInkStroke({
        ...fast,
        pointerId: index + 2,
        physicalContactId: `contact-${index}`,
        strokeId: `stroke-${index}`,
        correlationId: `contact-${index}`,
        maxInputToRenderMs: 25 + index
      });
      expect(slow?.physicalContactId).toBe(`contact-${index}`);
    }
    expect(trace.recordInkStroke(fast)).toBeNull();
    const summary = trace.slowInkStrokeSummary();
    expect(summary.totalSlowStrokes).toBe(SLOW_SPAN_WORST_LIMIT + 2);
    expect(summary.byStage["input-to-render"]).toBe(SLOW_SPAN_WORST_LIMIT + 2);
    expect(summary.worstStrokes).toHaveLength(SLOW_SPAN_WORST_LIMIT);
    expect(summary.worstStrokes[0]?.maxInputToRenderMs).toBe(SLOW_SPAN_WORST_LIMIT + 2 + 24);
    expect(summary.worstStrokes.every((stroke) => stroke.correlationId?.startsWith("contact-") === true)).toBe(true);
  });
});
