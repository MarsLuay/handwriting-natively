import { describe, expect, it } from "vitest";
import { MobilePdfZoomDiagnosticsTrace } from "../src/runtime/MobilePdfZoomDiagnostics";
import { ZoomPipelineTrace } from "../src/runtime/ZoomPipelineTrace";
import { ZoomNativeHandoffTrace } from "../src/runtime/ZoomNativeHandoffTrace";
import { ZoomFrameDiagnostics } from "../src/runtime/ZoomFrameDiagnostics";
import { PostZoomInputTrace } from "../src/runtime/PostZoomInputTrace";
import { PostZoomDurabilityTrace } from "../src/runtime/PostZoomDurabilityTrace";

const midpoint = { x: 120, y: 240 };

describe("mobile PDF zoom diagnostics", () => {
  it("reduces custom gesture, transform, handoff, and anchor evidence to a bounded summary", () => {
    const trace = new MobilePdfZoomDiagnosticsTrace();
    expect(trace.begin({ mode: "custom-mobile", at: 10, pageCount: 3, initialScale: 1, midpoint })).toBe(true);
    trace.notePromote();
    trace.noteSample({ x: 121, y: 241 }, 1.5);
    trace.noteTransformFrame(2.34);
    trace.noteNativeCommit(20);
    trace.noteNativeSignal(37, true);
    trace.release({ at: 45, focalAnchorErrorPx: 3.141, canonicalRenderWork: true });

    expect(trace.summary()).toMatchObject({
      event: "mobile-pdf-zoom-diagnostics",
      mode: "custom-mobile",
      phase: "settled",
      gesture: { beginCount: 1, promoteCount: 1, commitCount: 1, cancelCount: 0 },
      samples: {
        count: 2,
        firstMidpoint: midpoint,
        lastMidpoint: { x: 121, y: 241 },
        minScale: 1,
        maxScale: 1.5
      },
      transform: { frameCount: 1, totalMs: 2.3, maxMs: 2.3 },
      nativeCommitWaitMs: 17,
      focalAnchorErrorPx: 3.1,
      pageCount: 3,
      pdfJsCanonicalRenderWork: true
    });
  });

  it("records cancellation without retaining samples beyond its summary", () => {
    const trace = new MobilePdfZoomDiagnosticsTrace();
    trace.begin({ mode: "custom-mobile", at: 1, pageCount: 1, initialScale: 1, midpoint });
    trace.noteSample({ x: 1, y: 2 }, 2);
    trace.cancel("page-replaced", "page-identity-unsafe");
    const summary = trace.summary();
    expect(summary.phase).toBe("cancelled");
    expect(summary.releaseReason).toBe("page-replaced");
    expect(summary.fallbackReason).toBe("page-identity-unsafe");
    expect(summary.samples.count).toBe(2);
  });

  it("attributes existing pipeline and native handoff summaries by mode", () => {
    const pipeline = new ZoomPipelineTrace({ clock: { now: () => 0 } });
    pipeline.begin("custom-burst", 0, "custom-mobile");
    pipeline.noteEvent("scalechanging");
    pipeline.recordFrame({
      timestampMs: 16,
      runtimeBudgetMs: 16,
      pendingRaf: false,
      pendingSettle: false,
      nativeMutationCount: 0,
      visiblePages: 1,
      overlaysTouched: 1,
      totalPluginWorkMs: 1
    });
    expect(pipeline.finish()?.mode).toBe("custom-mobile");

    const handoff = new ZoomNativeHandoffTrace({ clock: { now: () => 0 } });
    handoff.begin("custom-burst", 0, "custom-mobile");
    handoff.noteSignal({ name: "pagerendered", signalAt: 4, callbackAt: 5, phase: "handoff" });
    expect(handoff.finish()?.mode).toBe("custom-mobile");

    const frames = new ZoomFrameDiagnostics();
    frames.setMode("custom-mobile");
    frames.begin("custom-burst", 0);
    expect(frames.finish().mode).toBe("custom-mobile");

    const input = new PostZoomInputTrace();
    input.setMode("custom-mobile");
    input.begin("2026-01-01T00:00:00.000Z");
    input.settle(10);
    expect(input.diagnosis().mode).toBe("custom-mobile");

    const durability = new PostZoomDurabilityTrace();
    durability.setMode("custom-mobile");
    durability.onZoomBegin("custom-burst");
    expect(durability.snapshot(0).mode).toBe("custom-mobile");
  });
});
