import { describe, expect, it } from "vitest";
import {
  PinchGestureCleanup,
  decideZoomBurstWatchdog,
  PostZoomInputTrace,
  classifyPostZoomFailure,
  pointerHandledForGeneration,
  postZoomFinalDisposition,
  stylusIdentityFromClassification,
  stylusIdentityRegression,
  validPhysicalDisplacementPx
} from "../src/runtime/PostZoomInputTrace";

const pageContact = {
  overAnnotatablePage: true,
  strokeStarted: false,
  routerReceived: false,
  routerRejected: false,
  stalePageBinding: false,
  inputOwnerMismatch: false,
  fallbackRejected: false,
  nativePanWon: false,
  pointerCaptureStale: false
} as const;

describe("PostZoomInputTrace", () => {
  it("admits only the first three contacts inside eight seconds and keeps the diagnosis", () => {
    const trace = new PostZoomInputTrace();
    trace.begin();
    trace.settle(1_000, { scaleAfter: 1.4 });
    expect(trace.notePageContact(1_000 + 7_999, true, "in-window")?.postZoomContactIndex).toBe(1);
    expect(trace.notePageContact(1_000 + 8_001, true, "late")).toBeNull();

    const bounded = new PostZoomInputTrace();
    bounded.begin();
    bounded.settle(1_000, { scaleAfter: 1.4 });
    for (const id of ["a", "b", "c"]) bounded.notePageContact(1_100, true, id);
    expect(bounded.notePageContact(1_200, true, "fourth")).toBeNull();
    const admitted = bounded.anomaly({
      ...pageContact,
      physicalContactId: "c",
      stylusIdentity: "established"
    });
    const late = bounded.anomaly({
      ...pageContact,
      physicalContactId: "fourth",
      stylusIdentity: "established"
    });
    expect(admitted?.postZoomContactIndex).toBe(3);
    expect(late).toBeNull();
    bounded.completeAdmittedContact("a", 1_100);
    bounded.completeAdmittedContact("b", 1_100);
    expect(bounded.diagnosis().lastPostZoomAnomaly?.physicalContactId).toBe("c");
    expect(bounded.diagnosis().zoomBurstId).toBe("zoom-1");
    expect(bounded.currentBurstId()).toBeNull();
  });

  it("correlates zoom begin, scale ticks, settle, and the next three page contacts", () => {
    const trace = new PostZoomInputTrace();
    expect(trace.begin("2026-09-26T00:00:00.000Z")).toBe("zoom-1");
    trace.remember("scale", { scale: 1.2 });
    trace.remember("scale", { scale: 1.4 });
    trace.remember("pending-mobile-remount", { pendingMobileScrollRemount: true });
    expect(trace.settle(1_000, { scaleAfter: 1.4, routerGeneration: 8 })).toBe("zoom-1");

    expect(trace.notePageContact(1_100, true)).toMatchObject({ zoomBurstId: "zoom-1", postZoomContactIndex: 1 });
    expect(trace.notePageContact(1_200, true)?.postZoomContactIndex).toBe(2);
    expect(trace.notePageContact(1_300, true)?.postZoomContactIndex).toBe(3);
    expect(trace.notePageContact(1_400, true)).toBeNull();
    expect(trace.notePageContact(1_100, false)).toBeNull();
  });

  it("emits one self-contained anomaly when an established Pencil contact misses the router", () => {
    const trace = new PostZoomInputTrace();
    trace.begin();
    trace.remember("stroke-end", { page: 1, routerGeneration: 4 });
    trace.remember("router-destroy", { listenerGeneration: 7 });
    trace.settle(5_000, { routerGeneration: 8 });
    trace.notePageContact(5_100, true, "physical-contact-32");

    const first = trace.anomaly({
      ...pageContact,
      physicalContactId: "physical-contact-32",
      stylusIdentity: "established"
    });
    const second = trace.anomaly({
      ...pageContact,
      physicalContactId: "physical-contact-32",
      stylusIdentity: "established"
    });

    expect(first?.event).toBe("post-zoom-input-anomaly");
    expect(first?.reason).toBe("post-zoom-contact-not-routed");
    expect(first?.classification).toBe("post-zoom-router-not-received");
    expect(first?.zoomBurstId).toBe("zoom-1");
    expect(first?.lifecycle.map((entry) => entry.event)).toEqual([
      "zoom-begin",
      "stroke-end",
      "router-destroy",
      "zoom-settle"
    ]);
    expect(second).toBeNull();
  });

  it("does not treat a genuine finger as a failed Pencil stroke", () => {
    expect(classifyPostZoomFailure({
      ...pageContact,
      physicalContactId: "finger",
      stylusIdentity: "absent",
      nativePanWon: true
    })).toBeNull();
    expect(stylusIdentityFromClassification({
      pointerEventPenSeen: false,
      classification: "touch-only"
    })).toBe("absent");
    expect(stylusIdentityFromClassification({
      pointerEventPenSeen: true,
      classification: "paired"
    })).toBe("established");
  });

  it("keeps a stale zoom pointer from blocking the next router generation", () => {
    const handled = new Map<number, number>([[7, 4]]);
    expect(pointerHandledForGeneration(handled, 7, 4)).toBe(true);
    expect(pointerHandledForGeneration(handled, 7, 8)).toBe(false);
    expect(pointerHandledForGeneration(handled, 9, 8)).toBe(false);
  });

  it("keeps the last zoom diagnosis after the log ring scrolls away", () => {
    const trace = new PostZoomInputTrace();
    trace.begin("2026-09-26T00:00:00.000Z");
    trace.remember("pending-mobile-remount", { pendingMobileScrollRemount: true });
    trace.settle(5_000, { scaleBefore: 1, scaleAfter: 1.4, routerGeneration: 8 });
    trace.notePageContact(5_100, true, "physical-contact-62");
    trace.remember("post-zoom-contact", { physicalContactId: "physical-contact-62", postZoomContactIndex: 1 });
    const anomaly = trace.anomaly({
      ...pageContact,
      physicalContactId: "physical-contact-62",
      stylusIdentity: "established",
      routerReceived: true,
      pointerCaptureStale: true,
      nativePanWon: true
    });
    for (let index = 0; index < 40; index += 1) trace.remember("settings-ui", { index });

    const diagnosis = trace.diagnosis();
    expect(anomaly?.classification).toBe("post-zoom-pointer-capture-stale");
    expect(diagnosis.zoomBurstId).toBe("zoom-1");
    expect(diagnosis.beganAt).toBe("2026-09-26T00:00:00.000Z");
    expect(diagnosis.scaleAfter).toBe(1.4);
    expect(diagnosis.pendingMobileScrollRemount).toBe(true);
    expect(diagnosis.firstPostZoomContacts).toEqual([
      expect.objectContaining({ physicalContactId: "physical-contact-62" })
    ]);
    expect(diagnosis.lastPostZoomAnomaly?.classification).toBe("post-zoom-pointer-capture-stale");
    expect(diagnosis.anomalyLifecycle.map((entry) => entry.event)).toContain("zoom-settle");
  });

  it("replaces the start-phase classification when the same contact ends", () => {
    const trace = new PostZoomInputTrace();
    trace.begin();
    trace.settle(1_000, { scaleBefore: 1.2, scaleAfter: 2.96 });
    trace.notePageContact(1_100, true);
    trace.remember("post-zoom-contact", {
      physicalContactId: "physical-contact-18",
      postZoomContactIndex: 1,
      classification: "unknown",
      startClassification: "unknown",
      pointerEventPenSeen: false,
      finalClassification: null
    });
    trace.remember("post-zoom-contact", {
      physicalContactId: "physical-contact-18",
      classification: "paired",
      finalClassification: "paired",
      pointerEventPenSeen: false,
      representation: "paired-pointer-touch",
      stylusIdentity: "absent",
      strokeStarted: false,
      ...postZoomFinalDisposition({
        penToolActive: true,
        stylusIdentity: "absent",
        strokeStarted: false,
        anomalyClassification: null
      })
    });

    const contacts = trace.diagnosis().firstPostZoomContacts;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      startClassification: "unknown",
      classification: "paired",
      finalClassification: "paired",
      finalDisposition: "post-zoom-contact-no-stylus-identity",
      possibleFinger: true,
      stylusIdentity: "absent"
    });
    expect(trace.diagnosis().scaleBefore).toBe(1.2);
    expect(trace.diagnosis().lastPostZoomAnomaly).toBeNull();
  });

  it("keeps zoom unsettled until both pinch touches end, then records one frame", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(7, "pointerdown", "pen");
    pinch.observePointer(4, "pointerdown", "touch");
    pinch.observePointer(5, "pointerdown", "touch");
    pinch.observeTouch(4, "touchstart");
    pinch.observeTouch(5, "touchstart");
    pinch.beginBurst();

    const waiting = pinch.evaluate(1_000);
    expect(waiting.quiescent).toBe(false);
    expect(waiting.pinchPointerIds).toEqual([4, 5]);
    expect(waiting.activePinchTouchesAtSettle).toEqual([4, 5]);
    expect(waiting.settleDeferredForGestureCleanup).toBe(true);

    pinch.observePointer(4, "pointerup", "touch");
    pinch.observePointer(5, "pointercancel", "touch");
    pinch.observePointer(4, "lostpointercapture", "touch");
    pinch.observeTouch(4, "touchend");
    pinch.observeTouch(5, "touchcancel");
    const finished = pinch.evaluate(1_040);
    expect(finished.quiescent).toBe(true);
    expect(finished.terminalPointerIds).toEqual([4, 5]);
    expect(finished.terminalTouchIdentifiers).toEqual([4, 5]);
    expect(finished.lostCapturePointerIds).toEqual([4]);
    expect(finished.gestureCleanupWaitMs).toBe(40);
    expect(pinch.needsAnimationFrame()).toBe(true);
    pinch.noteAnimationFrame();
    expect(pinch.evaluate(1_050).postCleanupAnimationFrames).toBe(1);
  });

  it("recovers a quiet burst only after its settle continuation is gone", () => {
    const quiet = {
      now: 5_000,
      lastZoomSignalAt: 1_000,
      zoomSettleTimerArmed: false,
      zoomSettleTimerDueAt: 0,
      pinchCleanupFrameArmed: false,
      activePinchPointers: 0,
      activePinchTouches: 0,
      liveInk: false
    };
    expect(decideZoomBurstWatchdog(quiet)).toEqual({ action: "recover", reason: "no-continuation" });
    expect(decideZoomBurstWatchdog({ ...quiet, now: 2_000 })).toEqual({ action: "wait", reason: "recent-zoom-signal" });
    expect(decideZoomBurstWatchdog({ ...quiet, zoomSettleTimerArmed: true, zoomSettleTimerDueAt: 5_500 })).toEqual({
      action: "wait",
      reason: "settle-timer-pending"
    });
    expect(decideZoomBurstWatchdog({ ...quiet, zoomSettleTimerArmed: true, zoomSettleTimerDueAt: 4_000 })).toEqual({
      action: "recover",
      reason: "settle-timer-lost"
    });
    expect(decideZoomBurstWatchdog({ ...quiet, pinchCleanupFrameArmed: true })).toEqual({
      action: "wait",
      reason: "pinch-cleanup-frame"
    });
    expect(decideZoomBurstWatchdog({ ...quiet, activePinchTouches: 2 })).toEqual({ action: "wait", reason: "active-pinch" });
    expect(decideZoomBurstWatchdog({ ...quiet, liveInk: true })).toEqual({ action: "wait", reason: "live-ink" });
    expect(decideZoomBurstWatchdog({
      ...quiet,
      activePinchPointers: 1,
      activePinchTouches: 1,
      gestureCleanupTimedOut: true
    })).toEqual({ action: "recover", reason: "no-continuation" });
    expect(decideZoomBurstWatchdog({
      ...quiet,
      now: 1_500,
      activePinchPointers: 1,
      gestureCleanupTimedOut: false
    })).toEqual({ action: "wait", reason: "active-pinch" });
  });

  it("keeps a finger pinch and excludes only a touch paired to a pen", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observeTouch(11, "touchstart");
    pinch.beginBurst();
    expect(pinch.associationState().pinchEligibleTouchIdentifiers).toEqual([11]);
    expect(pinch.activePinchCount().touches).toBe(1);
    pinch.observeTouch(771228036, "touchstart");
    expect(pinch.excludeStylusTouch(771228036)).toBe(true);
    expect(pinch.activePinchCount().touches).toBe(1);
    expect(pinch.watchState(Date.now() + 5_000).staleTouchIds).not.toContain(771228036);
    expect(pinch.associationState().excludedStylusTouchIdentifiers).toEqual([771228036]);
    expect(pinch.associationState().pinchEligibleTouchIdentifiers).toEqual([11]);
    pinch.releaseStylusTouch(771228036);
    pinch.observeTouch(42, "touchstart");
    expect(pinch.beginBurst().seededPinchTouchIdentifiers.sort((a, b) => a - b)).toEqual([11, 42]);
  });

  it("does not seed an orphan touch that the browser has already cleared", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observeTouch(-2034777937, "touchstart");
    pinch.observeTouch(-2034777926, "touchstart");
    const cleared = pinch.reconcileTouches("touchend", [-2034777926], []);
    expect(cleared.map((entry) => entry.id)).toContain(-2034777937);
    expect(cleared.every((entry) => entry.reason === "touch-list-all-clear")).toBe(true);
    const seed = pinch.beginBurst();
    expect(seed.seededPinchTouchIdentifiers).toEqual([]);
    expect(pinch.evaluate(0).quiescent).toBe(true);
    expect(pinch.needsAnimationFrame()).toBe(false);
  });

  it("drops a touch that disappeared from the active browser list", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observeTouch(1, "touchstart");
    pinch.observeTouch(2, "touchstart");
    const pruned = pinch.reconcileTouches("touchmove", [], [2]);
    expect(pruned).toEqual([
      expect.objectContaining({ id: 1, stream: "touch", reason: "not-in-current-active-set", event: "stale-pinch-contact-pruned" })
    ]);
    expect(pinch.beginBurst().seededPinchTouchIdentifiers).toEqual([2]);
  });

  it("runs one post-timeout frame when a pinch id never ends", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(4, "pointerdown", "touch");
    pinch.observeTouch(4, "touchstart");
    pinch.beginBurst();
    let settled = false;
    let calls = 0;
    const step = (now: number): void => {
      calls += 1;
      const report = pinch.evaluate(now);
      if (!report.quiescent) return;
      if (pinch.needsAnimationFrame()) {
        pinch.noteAnimationFrame();
        return;
      }
      settled = true;
    };
    step(0);
    expect(settled).toBe(false);
    step(800);
    expect(pinch.needsAnimationFrame()).toBe(false);
    step(801);
    expect(settled).toBe(true);
    const callsAtSettle = calls;
    for (let index = 0; index < 100; index += 1) {
      if (settled) break;
      step(900 + index);
    }
    expect(callsAtSettle).toBeLessThan(50);
    expect(pinch.diagnostics().evaluateCount).toBeLessThan(50);
    expect(pinch.watchState().timedOut).toBe(true);
    expect(pinch.watchState().stalePointerIds).toEqual([4]);
  });

  it("settles immediately when the zoom never saw a pinch contact", () => {
    const pinch = new PinchGestureCleanup();
    pinch.beginBurst();
    pinch.observePointer(11, "pointerdown", "pen");
    pinch.observePointer(11, "pointerup", "pen");
    expect(pinch.evaluate(1_000).quiescent).toBe(true);
    expect(pinch.needsAnimationFrame()).toBe(false);
  });

  it("settles a stuck pinch after the cleanup timeout without treating it as a pen", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(9, "pointerdown", "touch");
    pinch.observeTouch(9, "touchstart");
    pinch.beginBurst();
    expect(pinch.evaluate(0, 800).quiescent).toBe(false);
    const timedOut = pinch.evaluate(800, 800);
    expect(timedOut.quiescent).toBe(true);
    expect(timedOut.gestureCleanupTimedOut).toBe(true);
    expect(timedOut.activePinchPointersAtSettle).toEqual([9]);
  });

  it("retires a pinch pointer when its paired touch ends and the pointer event never does", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(-719735785, "pointerdown", "touch", 1_000);
    pinch.observePointer(-719735784, "pointerdown", "touch", 1_000);
    pinch.observeTouch(-719735785, "touchstart", 1_000);
    pinch.observeTouch(-719735784, "touchstart", 1_000);
    pinch.beginBurst(1_000);
    pinch.observePointer(-719735784, "pointerup", "touch", 1_100);
    pinch.observeTouch(-719735784, "touchend", 1_100);
    pinch.reconcileTouches("touchend", [-719735785], [], 1_200);
    const reconciled = pinch.consumePointerReconciliations();
    expect(reconciled).toEqual([expect.objectContaining({
      event: "stale-pinch-pointer-reconciled",
      pointerId: -719735785,
      pairedTouchIdentifier: -719735785,
      nativePointerTerminalSeen: false,
      pairedTouchTerminal: "touchend",
      remainingActiveTouches: [],
      reason: "paired-touch-ended"
    })]);
    const report = pinch.evaluate(1_200);
    expect(report.quiescent).toBe(true);
    expect(report.gestureCleanupTimedOut).toBe(false);
    expect(report.gestureCleanupWaitMs).toBe(0);
    expect(report.activePinchPointersAtSettle).toEqual([]);
    expect(report.orphanedPinchPointerIds).toEqual([-719735785]);
    expect(report.pointerRetireReason["-719735785"]).toBe("paired-touch-ended");
    expect(pinch.activePinchCount()).toEqual({ pointers: 0, touches: 0 });
    expect(decideZoomBurstWatchdog({
      now: 5_000,
      lastZoomSignalAt: 0,
      zoomSettleTimerArmed: false,
      zoomSettleTimerDueAt: 0,
      pinchCleanupFrameArmed: false,
      activePinchPointers: 0,
      activePinchTouches: 0,
      liveInk: false
    }).reason).not.toBe("active-pinch");
  });

  it("retires a pointer when touchcancel is the only terminal event", () => {
    const pinch = new PinchGestureCleanup();
    pinch.associate(8, 18);
    pinch.observePointer(8, "pointerdown", "touch", 1_000);
    pinch.observeTouch(18, "touchstart", 1_000);
    pinch.beginBurst(1_000);
    pinch.reconcileTouches("touchcancel", [18], [], 1_100);
    expect(pinch.consumePointerReconciliations()[0]).toMatchObject({
      pointerId: 8,
      pairedTouchIdentifier: 18,
      pairedTouchTerminal: "touchcancel",
      nativePointerTerminalSeen: false,
      reason: "paired-touch-ended"
    });
    expect(pinch.evaluate(1_100).activePinchPointersAtSettle).toEqual([]);
    expect(pinch.evaluate(1_100).gestureCleanupTimedOut).toBe(false);
  });

  it("retires a paired touch when the pointer ends and the touch event is missing", () => {
    const pinch = new PinchGestureCleanup();
    pinch.associate(7, 70);
    pinch.observePointer(7, "pointerdown", "touch");
    pinch.observeTouch(70, "touchstart");
    pinch.beginBurst();
    pinch.observePointer(7, "pointerup", "touch");
    expect(pinch.activePinchCount()).toEqual({ pointers: 0, touches: 0 });
    expect(pinch.evaluate(50).quiescent).toBe(true);
    expect(pinch.evaluate(50).gestureCleanupWaitMs).toBe(0);
    expect(pinch.consumePointerReconciliations()).toEqual([]);
  });

  it("keeps a pointer that has no paired touch, and does not retire an unrelated pointer", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(9, "pointerdown", "touch");
    pinch.observePointer(1, "pointerdown", "touch");
    pinch.observeTouch(2, "touchstart");
    pinch.beginBurst();
    pinch.reconcileTouches("touchend", [2], []);
    expect(pinch.consumePointerReconciliations()).toEqual([]);
    expect(pinch.activePinchCount().pointers).toBe(2);
    expect(pinch.evaluate(0).quiescent).toBe(false);
    expect(pinch.evaluate(800).activePinchPointersAtSettle.sort((a, b) => a - b)).toEqual([1, 9]);
    expect(pinch.evaluate(800).gestureCleanupTimedOut).toBe(true);
  });

  it("does not retire a pointer that is still a live pen", () => {
    const pinch = new PinchGestureCleanup();
    pinch.noteLivePens([-719735785]);
    pinch.associate(-719735785, -719735785);
    pinch.observePointer(-719735785, "pointerdown", "touch");
    pinch.observeTouch(-719735785, "touchstart");
    pinch.beginBurst();
    pinch.reconcileTouches("touchend", [-719735785], []);
    expect(pinch.consumePointerReconciliations()).toEqual([]);
    expect(pinch.activePinchCount().pointers).toBe(1);
  });

  it("settles a normal two-finger pinch without the cleanup timeout", () => {
    const pinch = new PinchGestureCleanup();
    pinch.observePointer(4, "pointerdown", "touch");
    pinch.observePointer(5, "pointerdown", "touch");
    pinch.observeTouch(4, "touchstart");
    pinch.observeTouch(5, "touchstart");
    pinch.beginBurst();
    pinch.observePointer(4, "pointerup", "touch");
    pinch.observePointer(5, "pointerup", "touch");
    pinch.observeTouch(4, "touchend");
    pinch.observeTouch(5, "touchend");
    const report = pinch.evaluate(40);
    expect(report.quiescent).toBe(true);
    expect(report.gestureCleanupTimedOut).toBe(false);
    expect(report.gestureCleanupWaitMs).toBe(0);
    expect(report.activePinchPointersAtSettle).toEqual([]);
    expect(report.activePinchTouchesAtSettle).toEqual([]);
    expect(pinch.consumePointerReconciliations()).toEqual([]);
  });

  it("emits one browser identity regression after a pen stroke without calling touch a Pencil", () => {
    const trace = new PostZoomInputTrace();
    trace.begin();
    trace.noteCaptureRecovery("release-annotation-pointer-captures", 0);
    trace.settle(1_000, { scaleBefore: 4.68, scaleAfter: 2.96, pageMountGeneration: 1, routerGeneration: 1 });
    const regression = stylusIdentityRegression({
      zoomBurstId: trace.currentBurstId(),
      preZoomPointerType: "pen",
      preZoomPointerEventPenSeen: true,
      postZoomPointerType: "touch",
      postZoomPointerEventPenSeen: false,
      postZoomStylusIdentity: "absent",
      strokeStarted: false,
      preZoomPageMountGeneration: 1,
      postZoomPageMountGeneration: 1,
      preZoomRouterGeneration: 1,
      postZoomRouterGeneration: 1,
      recoveryExperiment: "release-annotation-pointer-captures"
    });
    expect(trace.noteStylusIdentityRegression(regression)?.event).toBe("post-zoom-stylus-identity-regression");
    expect(trace.noteStylusIdentityRegression(regression)).toBeNull();
    expect(trace.diagnosis().stylusIdentityRegression).toMatchObject({
      preZoomPointerType: "pen",
      postZoomPointerType: "touch",
      postZoomStylusIdentity: "absent",
      samePageMountGeneration: true,
      sameRouterGeneration: true,
      physicalToolClaimed: false,
      recoveryExperiment: "release-annotation-pointer-captures"
    });
    expect(stylusIdentityRegression({
      zoomBurstId: "zoom-1",
      preZoomPointerType: "pen",
      preZoomPointerEventPenSeen: true,
      postZoomPointerType: "pen",
      postZoomPointerEventPenSeen: true,
      postZoomStylusIdentity: "established",
      strokeStarted: false,
      preZoomPageMountGeneration: 1,
      postZoomPageMountGeneration: 1,
      preZoomRouterGeneration: 1,
      postZoomRouterGeneration: 1,
      recoveryExperiment: null
    })).toBeNull();
    expect(stylusIdentityRegression({
      zoomBurstId: "zoom-1",
      preZoomPointerType: "touch",
      preZoomPointerEventPenSeen: false,
      postZoomPointerType: "touch",
      postZoomPointerEventPenSeen: false,
      postZoomStylusIdentity: "absent",
      strokeStarted: false,
      preZoomPageMountGeneration: 1,
      postZoomPageMountGeneration: 1,
      preZoomRouterGeneration: 1,
      postZoomRouterGeneration: 1,
      recoveryExperiment: null
    })).toBeNull();
  });

  it("does not treat a rejected origin terminal as native page movement", () => {
    expect(validPhysicalDisplacementPx({
      maxDisplacementPx: 991.439862018872,
      firstPoint: { x: 627, y: 768 },
      lastValidPoint: { x: 627, y: 768 },
      terminalPointRejectReason: "lostpointercapture-sentinel"
    })).toBe(0);
    expect(validPhysicalDisplacementPx({
      maxDisplacementPx: 200,
      firstPoint: { x: 10, y: 10 },
      lastValidPoint: { x: 30, y: 40 },
      terminalPointRejectReason: null
    })).toBe(200);
  });

  it("classifies stale binding and unknown stylus identity before routing", () => {
    expect(classifyPostZoomFailure({
      ...pageContact,
      physicalContactId: "unknown",
      stylusIdentity: "unknown"
    })).toBe("post-zoom-stylus-identity-not-established");
    expect(classifyPostZoomFailure({
      ...pageContact,
      physicalContactId: "stale",
      stylusIdentity: "established",
      stalePageBinding: true,
      routerReceived: true
    })).toBe("post-zoom-stale-page-binding");
  });
});
