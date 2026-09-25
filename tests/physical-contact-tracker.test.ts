import { describe, expect, it } from "vitest";
import {
  PhysicalContactTracker,
  type RawPointerContactSample,
  type RawTouchContactEvent
} from "../src/input/PhysicalContactTracker";

function pointer(eventType: RawPointerContactSample["eventType"], overrides: Partial<RawPointerContactSample> = {}): RawPointerContactSample {
  return {
    eventType,
    timeStamp: 0,
    pointerId: 7,
    pointerType: "pen",
    isPrimary: true,
    pressure: 0.7,
    width: 2,
    height: 3,
    tiltX: 12,
    tiltY: -4,
    buttons: eventType === "pointerup" ? 0 : 1,
    button: eventType === "pointerup" ? 0 : 0,
    clientX: 100,
    clientY: 200,
    targetId: "page-1",
    composedPath: ["page-1", "viewer"],
    eventPhase: 1,
    cancelable: true,
    defaultPrevented: false,
    ...overrides
  };
}

function touch(
  eventType: RawTouchContactEvent["eventType"],
  identifier = 3,
  overrides: Partial<RawTouchContactEvent["touches"][number]> = {}
): RawTouchContactEvent {
  const point = {
    identifier,
    clientX: 101,
    clientY: 201,
    screenX: 101,
    screenY: 201,
    pageX: 101,
    pageY: 201,
    radiusX: 8,
    radiusY: 9,
    force: 0.4
  };
  return {
    eventType,
    touches: [{
      eventType,
      timeStamp: 0,
      identifier,
      clientX: 101,
      clientY: 201,
      radiusX: 8,
      radiusY: 9,
      force: 0.4,
      touchCount: 1,
      changedCount: 1,
      activeTouches: [point],
      changedTouches: [point],
      targetId: "page-1",
      composedPath: ["page-1", "viewer"],
      ...overrides
    }]
  };
}

describe("PhysicalContactTracker", () => {
  it("keeps one id while pairing pen PointerEvent and TouchEvent lifecycles", () => {
    const tracker = new PhysicalContactTracker();
    const started = tracker.pointerDown(100, pointer("pointerdown"));
    expect(started).toHaveLength(1);
    expect(started[0]?.contact.physicalContactId).toBe("physical-contact-1");

    expect(tracker.pointerMove(120, pointer("pointermove", { clientX: 110, clientY: 210 }))).toEqual([]);
    expect(tracker.touchStart(130, touch("touchstart"))).toEqual([]);
    expect(tracker.touchMove(140, touch("touchmove", 3, { clientX: 120, clientY: 220 }))).toEqual([]);
    expect(tracker.pointerEnd(150, pointer("pointerup", { clientX: 125, clientY: 225 }))).toEqual([]);

    const terminal = tracker.touchEnd(160, touch("touchend", 3, { clientX: 125, clientY: 225 }));
    expect(terminal).toHaveLength(1);
    const snapshot = terminal[0]!.contact;
    expect(snapshot.physicalContactId).toBe("physical-contact-1");
    expect(snapshot.penContactId).toBe("physical-contact-1");
    expect(snapshot.representation).toBe("paired-pen-touch");
    expect(snapshot.classification).toBe("paired");
    expect(snapshot.classificationTransitions.map((transition) => transition.classification)).toEqual(["pen-only", "paired"]);
    expect(snapshot.pairedStreams).toBe(true);
    expect(snapshot.pointerEventPenSeen).toBe(true);
    expect(snapshot.touchEventSeen).toBe(true);
    expect(snapshot.pointerMoveCount).toBe(1);
    expect(snapshot.touchMoveCount).toBe(1);
    expect(snapshot.pointerTerminal).toBe("pointerup");
    expect(snapshot.touchTerminal).toBe("touchend");
    expect(snapshot.durationMs).toBe(60);
    expect(snapshot.rawPointer.first?.eventType).toBe("pointerdown");
    expect(snapshot.rawPointer.last?.eventType).toBe("pointerup");
    expect(snapshot.rawTouch.first?.eventType).toBe("touchstart");
    expect(snapshot.rawTouch.last?.eventType).toBe("touchend");
    expect(snapshot.maxDisplacementPx).toBeCloseTo(Math.hypot(25, 25));
  });

  it("keeps touch-only input separate and supports cancel", () => {
    const tracker = new PhysicalContactTracker();
    const started = tracker.touchStart(1, touch("touchstart", 11, { clientX: 5, clientY: 6 }));
    expect(started[0]?.contact.representation).toBe("touch-only");
    expect(tracker.touchMove(5, touch("touchmove", 11, { clientX: 8, clientY: 10 }))).toEqual([]);

    const terminal = tracker.touchEnd(8, touch("touchcancel", 11, { clientX: 8, clientY: 10 }));
    expect(terminal[0]?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal[0]?.contact.touchTerminal).toBe("touchcancel");
    expect(terminal[0]?.contact.pointerEventPenSeen).toBe(false);
    expect(terminal[0]?.contact.penContactId).toBeNull();
    expect(terminal[0]?.contact.classification).toBe("touch-only");
    expect(terminal[0]?.contact.rawPointer.first).toBeNull();
  });

  it("retains one lifecycle for a long contact and records pointer cancel", () => {
    const tracker = new PhysicalContactTracker();
    tracker.pointerDown(0, pointer("pointerdown"));
    expect(tracker.pointerMove(5_000, pointer("pointermove", { clientX: 140, clientY: 240 }))).toEqual([]);

    const terminal = tracker.pointerEnd(5_001, pointer("pointercancel", { clientX: 140, clientY: 240 }));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal[0]?.contact.durationMs).toBe(5_001);
    expect(terminal[0]?.contact.pointerTerminal).toBe("pointercancel");
    expect(terminal[0]?.contact.terminal).toBe("pointercancel");
  });

  it("does not emit records for ordinary moves and expires an abandoned contact", () => {
    const tracker = new PhysicalContactTracker();
    tracker.pointerDown(0, pointer("pointerdown"));
    expect(tracker.pointerMove(5, pointer("pointermove"))).toEqual([]);
    expect(tracker.pointerMove(6, pointer("pointermove"))).toEqual([]);
    expect(tracker.expire(PhysicalContactTracker.CONTACT_TIMEOUT_MS - 1)).toEqual([]);

    const expired = tracker.expire(PhysicalContactTracker.CONTACT_TIMEOUT_MS + 6);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.phase).toBe("terminal");
    expect(expired[0]?.contact.terminal).toBe("timeout");
  });
});
