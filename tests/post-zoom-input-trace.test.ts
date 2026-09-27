import { describe, expect, it } from "vitest";
import {
  PostZoomInputTrace,
  classifyPostZoomFailure,
  pointerHandledForGeneration,
  postZoomFinalDisposition,
  stylusIdentityFromClassification,
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
  it("correlates zoom begin, scale ticks, settle, and the next three page contacts", () => {
    const trace = new PostZoomInputTrace();
    expect(trace.begin("2026-09-26T00:00:00.000Z")).toBe("zoom-1");
    trace.remember("scale", { scale: 1.2 });
    trace.remember("scale", { scale: 1.4 });
    trace.remember("pending-mobile-remount", { pendingMobileScrollRemount: true });
    expect(trace.settle(1_000, { scaleAfter: 1.4, routerGeneration: 8 })).toBe("zoom-1");

    expect(trace.notePageContact(1_100, true)).toEqual({ zoomBurstId: "zoom-1", postZoomContactIndex: 1 });
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
    trace.notePageContact(5_100, true);

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
    trace.notePageContact(5_100, true);
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
