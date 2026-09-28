import { describe, expect, it } from "vitest";
import { BoundedTiming } from "../src/logging/PerformanceMetrics";
import { RuntimeFrameProfile } from "../src/logging/RuntimeFrameProfile";
import { SlowSpanTrace } from "../src/runtime/SlowSpanTrace";
import { ZoomFrameDiagnostics } from "../src/runtime/ZoomFrameDiagnostics";

function feed(profile: RuntimeFrameProfile, intervalMs: number, count: number, startAt = 0): void {
  for (let index = 0; index <= count; index += 1) profile.observeRaf(startAt + index * intervalMs);
}

function slowStroke(maxFrameMs: number) {
  return {
    pointerId: 1,
    physicalContactId: "contact-1",
    strokeId: "stroke-1",
    correlationId: "contact-1",
    page: 1,
    tool: "pencil",
    outcome: "pointerup",
    pointerDownToStrokeStartMs: 1,
    strokeStartToFirstCanvasCommitMs: 1,
    totalPointerDownToFirstCanvasCommitMs: 2,
    maxInputToRenderMs: 1,
    p95InputToRenderMs: 1,
    maxPluginCallbackMs: 1,
    longestLongTaskMs: 1,
    p95FrameMs: maxFrameMs,
    maxFrameMs,
    frameBudgetMs: 1000 / 60,
    lateFrameThresholdMs: 25,
    frameThresholdSource: "measured-raf",
    pointerUpToCommitMs: 1
  } as const;
}

describe("RuntimeFrameProfile", () => {
  it("measures a stable 60Hz cadence and derives presentation thresholds", () => {
    const profile = new RuntimeFrameProfile({ platform: "ios", runtime: "capacitor-wkwebview" });
    feed(profile, 1000 / 60, 40);

    expect(profile.snapshot()).toMatchObject({
      measuredRefreshHz: 60,
      measuredFrameBudgetMs: 16.67,
      refreshHz: 60,
      frameBudgetMs: 16.67,
      lateFrameThresholdMs: 25,
      missedFrameThresholdMs: 33.33,
      substantialStallThresholdMs: 50,
      sampleCount: 40,
      confidence: "stable",
      thresholdSource: "measured-raf",
      platform: "ios",
      runtime: "capacitor-wkwebview"
    });
  });

  it("uses the fallback until enough clean samples arrive", () => {
    const profile = new RuntimeFrameProfile({ platform: "ios", runtime: "capacitor-wkwebview" });
    feed(profile, 16.67, 2);

    expect(profile.snapshot()).toMatchObject({
      measuredRefreshHz: null,
      measuredFrameBudgetMs: null,
      refreshHz: 60,
      frameBudgetMs: 16.67,
      confidence: "insufficient",
      thresholdSource: "platform-fallback"
    });
  });

  it("keeps stalled callbacks out of the refresh baseline", () => {
    const profile = new RuntimeFrameProfile({ fallbackRefreshHz: 60 });
    let timestamp = 0;
    profile.observeRaf(timestamp);
    for (let index = 0; index < 36; index += 1) {
      timestamp += index === 18 ? 500 : 1000 / 60;
      profile.observeRaf(timestamp);
    }

    expect(profile.snapshot()).toMatchObject({
      measuredRefreshHz: 60,
      measuredFrameBudgetMs: 16.67,
      confidence: "stable",
      thresholdSource: "measured-raf"
    });
  });

  it("lets bounded timing and zoom diagnostics consume the shared measured budget", () => {
    const profile = new RuntimeFrameProfile({ fallbackRefreshHz: 60 });
    feed(profile, 1000 / 60, 40);
    const timing = new BoundedTiming(() => profile.thresholds());
    timing.add(16);
    timing.add(25.1);
    expect(timing.summary()).toMatchObject({ lateFrameCount: 1, droppedFrameEstimate: 1 });
    expect(timing.summary().histogram).toEqual(expect.objectContaining({
      "0-16.7": 1,
      "16.7-33.3": 1
    }));

    const clock = {
      now: () => 0,
      setTimeout: (callback: () => void) => setTimeout(callback, 0),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
    };
    const diagnostics = new ZoomFrameDiagnostics(clock, profile);
    diagnostics.begin("zoom-60");
    diagnostics.recordFrame({ requestedAt: 0, callbackAt: 0, pluginWorkMs: 0 });
    expect(diagnostics.recordFrame({ requestedAt: 16.7, callbackAt: 16.7, pluginWorkMs: 0 })).toBeNull();
    expect(diagnostics.recordFrame({ requestedAt: 42, callbackAt: 42, pluginWorkMs: 0 })?.lateFrameThresholdMs).toBe(25);
  });

  it("uses the measured late-frame threshold for slow Pencil retention", () => {
    const trace = new SlowSpanTrace();
    expect(trace.recordInkStroke(slowStroke(20))).toBeNull();
    expect(trace.recordInkStroke({ ...slowStroke(26), strokeId: "stroke-2", correlationId: "contact-2", physicalContactId: "contact-2" })).toMatchObject({
      frameBudgetMs: 16.7,
      lateFrameThresholdMs: 25,
      frameThresholdSource: "measured-raf",
      slowStages: [expect.objectContaining({ stage: "stroke-frame-gap", thresholdMs: 25 })]
    });
  });
});
