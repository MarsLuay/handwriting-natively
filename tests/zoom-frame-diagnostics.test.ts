import { describe, expect, it, vi } from "vitest";
import { performanceObserverCapability, ZoomFrameDiagnostics } from "../src/runtime/ZoomFrameDiagnostics";

function testClock() {
  let time = 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  return {
    clock: {
      now: () => time,
      setTimeout: (callback: () => void) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        timers.delete(timer as unknown as number);
      }
    },
    setTime: (next: number) => { time = next; }
  };
}

describe("ZoomFrameDiagnostics", () => {
  it("does not observe outside a zoom window and attributes a compositor gap", () => {
    const harness = testClock();
    const diagnostics = new ZoomFrameDiagnostics(harness.clock);
    expect(diagnostics.recordFrame({ requestedAt: 0, callbackAt: 20, pluginWorkMs: 0 })).toBeNull();

    diagnostics.begin("zoom-1", 0);
    diagnostics.notePdfSignal("pagerendered");
    diagnostics.noteObserverSignal("mutationObserver");
    diagnostics.notePluginOperation("overlay-layout", 10);
    diagnostics.recordFrame({ requestedAt: 100, callbackAt: 100, pluginWorkMs: 1 });
    const emitted = diagnostics.recordFrame({
      requestedAt: 100,
      callbackAt: 116,
      pluginWorkMs: 1,
      context: { documentHidden: false, visualViewportScale: 1, devicePixelRatio: 2 }
    });

    expect(emitted).toMatchObject({
      event: "perf-unattributed-frame-gap",
      zoomBurstId: "zoom-1",
      phase: "active-pinch",
      frameDeltaMs: 16,
      rafRequestToCallbackMs: 16,
      attribution: "raf/compositor-delay",
      pdfSignals: { pagerendered: { count: 1 } },
      observerSignals: { mutationObserver: { count: 1 } },
      knownOperations: { "overlay-layout": { count: 1, totalMs: 10, maxMs: 10 } },
      documentHidden: false,
      devicePixelRatio: 2
    });
    expect(diagnostics.summary()).toMatchObject({
      slowFrameCount: 1,
      byAttribution: { "raf/compositor-delay": 1 },
      maxFrameGapMs: 16,
      knownOperations: { "overlay-layout": { count: 1, totalMs: 10, maxMs: 10 } }
    });
  });

  it("retains the worst frame from a prior burst when a later burst is tiny", () => {
    const harness = testClock();
    const diagnostics = new ZoomFrameDiagnostics(harness.clock);
    diagnostics.begin("zoom-slow", 0);
    diagnostics.recordFrame({ requestedAt: 0, callbackAt: 0, pluginWorkMs: 0 });
    diagnostics.recordFrame({ requestedAt: 500, callbackAt: 500, pluginWorkMs: 0 });
    diagnostics.finish();

    diagnostics.begin("zoom-tap", 600);
    diagnostics.recordFrame({ requestedAt: 600, callbackAt: 600, pluginWorkMs: 0 });
    diagnostics.recordFrame({ requestedAt: 601, callbackAt: 601, pluginWorkMs: 0 });
    const summary = diagnostics.finish();

    expect(summary.maxFrameGapMs).toBe(500);
    expect(summary.worstFrames[0]).toMatchObject({ zoomBurstId: "zoom-slow", frameDeltaMs: 500 });
    expect(summary.slowFrameCount).toBe(1);
  });

  it("keeps frame records, worst samples, and signal names bounded", () => {
    const harness = testClock();
    const diagnostics = new ZoomFrameDiagnostics(harness.clock);
    diagnostics.begin("zoom-bounded");
    for (let index = 0; index < 80; index += 1) {
      diagnostics.notePdfSignal(`signal-${index}`);
      diagnostics.recordFrame({
        requestedAt: index * 20,
        callbackAt: index * 20 + 20,
        pluginWorkMs: 0
      });
    }
    const summary = diagnostics.summary();
    expect(summary.slowFrameCount).toBeLessThanOrEqual(32);
    expect(summary.worstFrames).toHaveLength(10);
    expect(Math.max(...summary.worstFrames.map((frame) => Object.keys(frame.pdfSignals).length))).toBeLessThanOrEqual(16);
  });

  it("attributes measured PDF callback work separately from compositor delay", () => {
    const harness = testClock();
    const diagnostics = new ZoomFrameDiagnostics(harness.clock);
    diagnostics.begin("zoom-pdf");
    diagnostics.recordFrame({ requestedAt: 0, callbackAt: 0, pluginWorkMs: 0 });
    diagnostics.notePdfSignal("pagerendered", 12);
    const frame = diagnostics.recordFrame({ requestedAt: 20, callbackAt: 20, pluginWorkMs: 0 });
    expect(frame?.attribution).toBe("pdf-render-burst");
    expect(frame?.measuredPdfCallbackWorkMs).toBe(12);
  });

  it("reports supported observer entry types without treating missing longtask as no observer", () => {
    class FakePerformanceObserver {
      static supportedEntryTypes = ["event", "paint"];
    }
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    try {
      expect(performanceObserverCapability()).toMatchObject({
        performanceObserverSupported: true,
        supportedEntryTypes: ["event", "paint"],
        longtaskSupported: false,
        eventTimingSupported: true,
        paintTimingSupported: true
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps plugin work distinct from unexplained gaps and reports unsupported longtask state", () => {
    const harness = testClock();
    const diagnostics = new ZoomFrameDiagnostics(harness.clock);
    diagnostics.begin("zoom-plugin");
    diagnostics.setLongTaskObserverState(false, "unsupported");
    diagnostics.recordFrame({ requestedAt: 0, callbackAt: 0, pluginWorkMs: 0 });
    expect(diagnostics.recordFrame({ requestedAt: 0, callbackAt: 20, pluginWorkMs: 12 })).toBeNull();
    expect(diagnostics.summary()).toMatchObject({
      byAttribution: { "plugin-work": 1 },
      capabilities: {
        longTaskObserverInstalled: false,
        longTaskObserverError: "unsupported"
      }
    });
  });
});
