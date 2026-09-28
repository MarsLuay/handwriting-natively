import { describe, expect, it } from "vitest";
import { ZoomNativeHandoffTrace } from "../src/runtime/ZoomNativeHandoffTrace";

describe("ZoomNativeHandoffTrace", () => {
  it("correlates delayed replacement, PDF.js render, observer work, and stable rAF", () => {
    const trace = new ZoomNativeHandoffTrace({ clock: { now: () => 0 } });
    trace.begin("zoom-340", 0);
    trace.noteSignal({
      name: "canvasReplacement",
      signalAt: 10,
      callbackAt: 40,
      pageNumbers: [2],
      viewerGeneration: 3,
      mountGenerations: { "2": 7 },
      replacementRecordCount: 4,
      phase: "active-pinch"
    });
    trace.noteSignal({
      name: "mutationObserver",
      signalAt: 12,
      callbackAt: 40,
      callbackWorkMs: 6,
      pageNumbers: [2],
      viewerGeneration: 3,
      phase: "handoff"
    });
    trace.noteSignal({
      name: "pagerendered",
      signalAt: 50,
      callbackAt: 55,
      callbackWorkMs: 2,
      pageNumbers: [2, 3],
      viewerGeneration: 3,
      mountGenerations: { "2": 8, "3": 2 },
      phase: "handoff"
    });
    trace.noteStableRaf({ at: 80, compositorHeld: true, phase: "handoff" });
    trace.noteStableRaf({ at: 100, compositorHeld: false, phase: "settled" });

    expect(trace.finish()).toMatchObject({
      event: "zoom-native-handoff",
      zoomBurstId: "zoom-340",
      firstNativeSignal: "canvasReplacement",
      lastNativeSignal: "pagerendered",
      firstNativeSignalAt: 10,
      lastNativeSignalAt: 50,
      nativeWaitMs: 30,
      callbackToStableRafMs: 25,
      canvasReplacementCount: 1,
      pagerenderedCount: 1,
      observerCallbackCount: 1,
      replacementRecordCount: 4,
      pagesTouched: [2, 3],
      viewerGenerations: [3],
      stableRafCount: 2,
      stableRafHeldCount: 1,
      stableRafReleasedCount: 1,
      compositorHeldAtLastStableRaf: false,
      signals: {
        mutationObserver: { callbackWorkMs: 6, pagesTouched: [2] },
        pagerendered: { firstAt: 50, mountGenerations: { "2": 8, "3": 2 } }
      }
    });
  });

  it("bounds repeated native evidence and keeps the summary copy-safe", () => {
    const trace = new ZoomNativeHandoffTrace({ clock: { now: () => 0 } });
    trace.begin("zoom-bounded", 0);
    for (let index = 0; index < 1100; index += 1) {
      trace.noteSignal({
        name: "canvasReplacement",
        signalAt: index,
        pageNumbers: [index + 1],
        viewerGeneration: index + 1,
        replacementRecordCount: 2,
        phase: "handoff"
      });
    }

    const summary = trace.finish();
    expect(summary?.canvasReplacementCount).toBe(999);
    expect(summary?.replacementRecordCount).toBe(999);
    expect(summary?.pagesTouched).toHaveLength(64);
    expect(summary?.viewerGenerations).toHaveLength(8);
    expect(Object.keys(summary?.signals ?? {})).toHaveLength(1);
    expect(summary?.signals.canvasReplacement.pagesTouched).toHaveLength(64);
  });
});
