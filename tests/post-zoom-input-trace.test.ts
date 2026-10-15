import { describe, expect, it } from "vitest";
import {
  PostZoomInputTrace,
  decideZoomBurstWatchdog,
  postZoomFinalDisposition,
  stylusIdentityRegression,
  validPhysicalDisplacementPx,
  type PostZoomContactObservation
} from "../src/runtime/PostZoomInputTrace";

function contact(physicalContactId: string, overrides: Partial<PostZoomContactObservation> = {}): PostZoomContactObservation {
  return {
    overAnnotatablePage: true,
    stylusIdentity: "established",
    physicalContactId,
    strokeStarted: false,
    routerReceived: false,
    routerRejected: false,
    stalePageBinding: false,
    inputOwnerMismatch: false,
    fallbackRejected: false,
    nativePanWon: false,
    pointerCaptureStale: false,
    ...overrides
  };
}

describe("PostZoomInputTrace", () => {
  it("admits only three page contacts during the eight-second post-settle window", () => {
    const trace = new PostZoomInputTrace();
    expect(trace.begin("2026-10-14T00:00:00.000Z")).toBe("zoom-1");
    expect(trace.settle(100, { scaleBefore: 1, scaleAfter: 1.5 })).toBe("zoom-1");

    expect(trace.notePageContact(101, true, "pen-1")).toMatchObject({
      zoomBurstId: "zoom-1",
      postZoomContactIndex: 1
    });
    expect(trace.notePageContact(102, true, "pen-2")?.postZoomContactIndex).toBe(2);
    expect(trace.notePageContact(103, true, "pen-3")?.postZoomContactIndex).toBe(3);
    expect(trace.notePageContact(104, true, "pen-4")).toBeNull();
    expect(trace.notePageContact(8_101, true, "pen-5")).toBeNull();
  });

  it("reports the first failed stylus-routing stage and ignores ordinary touch", () => {
    const trace = new PostZoomInputTrace();
    trace.begin();
    trace.settle(1_000);
    trace.notePageContact(1_010, true, "finger");
    expect(trace.anomaly(contact("finger", { stylusIdentity: "absent" }), 1_011)).toBeNull();

    trace.notePageContact(1_020, true, "pen");
    expect(trace.anomaly(contact("pen"), 1_021)).toMatchObject({
      event: "post-zoom-input-anomaly",
      classification: "post-zoom-router-not-received",
      physicalContactId: "pen",
      postZoomContactIndex: 2
    });
    expect(trace.diagnosis().lastPostZoomAnomaly?.classification).toBe("post-zoom-router-not-received");
  });

  it("waits for recent signals, an armed timer, or live ink before watchdog recovery", () => {
    const quiet = {
      now: 5_000,
      lastZoomSignalAt: 1_000,
      zoomSettleTimerArmed: false,
      zoomSettleTimerDueAt: 0,
      liveInk: false
    };

    expect(decideZoomBurstWatchdog({ ...quiet, now: 2_500 })).toMatchObject({ action: "wait", reason: "recent-zoom-signal" });
    expect(decideZoomBurstWatchdog({ ...quiet, liveInk: true })).toMatchObject({ action: "wait", reason: "live-ink" });
    expect(decideZoomBurstWatchdog({
      ...quiet,
      zoomSettleTimerArmed: true,
      zoomSettleTimerDueAt: 6_000
    })).toMatchObject({ action: "wait", reason: "settle-timer-pending" });
    expect(decideZoomBurstWatchdog(quiet)).toMatchObject({ action: "recover", reason: "no-continuation" });
  });

  it("records only confirmed browser identity regressions", () => {
    const regression = stylusIdentityRegression({
      zoomBurstId: "zoom-7",
      preZoomPointerType: "pen",
      preZoomPointerEventPenSeen: true,
      postZoomPointerType: "touch",
      postZoomPointerEventPenSeen: false,
      postZoomStylusIdentity: "absent",
      physicalToolClaimed: true,
      strokeStarted: false,
      preZoomPageMountGeneration: 2,
      postZoomPageMountGeneration: 2,
      preZoomRouterGeneration: 7,
      postZoomRouterGeneration: 7,
      recoveryExperiment: null
    });

    expect(regression).toMatchObject({
      event: "post-zoom-stylus-identity-regression",
      samePageMountGeneration: true,
      sameRouterGeneration: true
    });
    expect(stylusIdentityRegression({
      zoomBurstId: "zoom-7",
      preZoomPointerType: "pen",
      preZoomPointerEventPenSeen: true,
      postZoomPointerType: "touch",
      postZoomPointerEventPenSeen: false,
      postZoomStylusIdentity: "absent",
      physicalToolClaimed: false,
      strokeStarted: false,
      preZoomPageMountGeneration: null,
      postZoomPageMountGeneration: null,
      preZoomRouterGeneration: null,
      postZoomRouterGeneration: null,
      recoveryExperiment: null
    })).toBeNull();
  });

  it("keeps final touch classification and displacement handling neutral", () => {
    expect(postZoomFinalDisposition({
      penToolActive: true,
      stylusIdentity: "absent",
      strokeStarted: false,
      anomalyClassification: null
    })).toEqual({ finalDisposition: "post-zoom-contact-no-stylus-identity", possibleFinger: true });
    expect(validPhysicalDisplacementPx({
      maxDisplacementPx: 20,
      firstPoint: { x: 0, y: 0 },
      lastValidPoint: { x: 3, y: 4 },
      terminalPointRejectReason: "outside-page"
    })).toBe(5);
  });
});
