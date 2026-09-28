import { describe, expect, it } from "vitest";
import { ZoomPipelineTrace } from "../src/runtime/ZoomPipelineTrace";

describe("ZoomPipelineTrace", () => {
  it("keeps stage totals and same-frame duplicate work countable", () => {
    const trace = new ZoomPipelineTrace({ enabled: () => true, clock: { now: () => 16 } });
    trace.begin("zoom-1", 0);
    trace.noteEvent("scalechanging", 3);
    trace.noteStage("overlay-layout", 5, 2, "overlay-layout");
    trace.noteStage("dom-read", 2, 1, "layout-read");

    const frame = trace.recordFrame({
      timestampMs: 16,
      runtimeBudgetMs: 8.33,
      scale: 1.25,
      scrollLeft: 4,
      scrollTop: 8,
      pendingRaf: true,
      pendingSettle: true,
      nativeMutationCount: 2,
      inputPending: true,
      activeAnnotationGesture: true,
      activePinchPointers: 1,
      activePinchTouches: 1,
      activeTouchPointerCount: 1,
      visiblePages: 3,
      overlaysTouched: 3,
      totalPluginWorkMs: 7
    });

    expect(frame).toMatchObject({
      frameIndex: 1,
      eventCount: 3,
      coalescedEventCount: 2,
      scale: 1.25,
      pendingRaf: true,
      pendingSettle: true,
      stages: {
        "overlay-layout": { count: 2, totalMs: 5, maxMs: 5 },
        "dom-read": { count: 1, totalMs: 2, maxMs: 2 }
      },
      inputPending: true,
      activeAnnotationGesture: true,
      activePinchPointers: 1,
      activePinchTouches: 1,
      activeTouchPointerCount: 1,
      duplicateWork: { "overlay-layout": 1 }
    });
    expect(trace.finish()).toMatchObject({
      framesObserved: 1,
      stageTotals: {
        "overlay-layout": { count: 2, totalMs: 5, maxMs: 5 }
      },
      duplicateWork: { "overlay-layout": 1 }
    });
  });

  it("bounds representative and worst-frame evidence while retaining aggregate totals", () => {
    const trace = new ZoomPipelineTrace({ enabled: () => true, clock: { now: () => 0 } });
    trace.begin("zoom-bounded", 0);
    for (let index = 0; index < 48; index += 1) {
      trace.noteStage("view-state", index, 1, "view-state");
      trace.recordFrame({
        timestampMs: index * 10,
        runtimeBudgetMs: 8.33,
        pendingRaf: false,
        pendingSettle: index < 47,
        nativeMutationCount: index,
        visiblePages: 2,
        overlaysTouched: 2,
        totalPluginWorkMs: index
      });
    }

    const summary = trace.finish();
    expect(summary?.framesObserved).toBe(48);
    expect(summary?.representativeFrames).toHaveLength(6);
    expect(summary?.worstFrames).toHaveLength(8);
    expect(summary?.stageTotals["view-state"]).toMatchObject({ count: 48 });
  });

  it("flushes pending terminal work with the last frame context", () => {
    const trace = new ZoomPipelineTrace({ enabled: () => true, clock: { now: () => 42 } });
    trace.begin("zoom-terminal", 0);
    trace.noteEvent("mutation-observer");
    trace.noteStage("canonical-paint", 12, 1, "canonical-paint");
    expect(trace.flushFrame({
      timestampMs: 42,
      runtimeBudgetMs: 16.67,
      scale: 2,
      scrollLeft: 10,
      scrollTop: 20,
      pendingRaf: false,
      pendingSettle: false,
      nativeMutationCount: 4,
      visiblePages: 1,
      overlaysTouched: 1,
      totalPluginWorkMs: 12
    })).toMatchObject({
      frameIndex: 1,
      eventCount: 1,
      stages: { "canonical-paint": { totalMs: 12 } }
    });
  });
});
