import { describe, expect, it } from "vitest";
import {
  PhysicalContactTracker,
  type RawPointerContactSample,
  type RawTouchContactEvent
} from "../src/input/PhysicalContactTracker";
import { PostUiInputProbe } from "../src/input/PostUiInputProbe";

function pointer(
  eventType: RawPointerContactSample["eventType"],
  overrides: Partial<RawPointerContactSample> = {}
): RawPointerContactSample {
  return {
    eventType,
    timeStamp: 0,
    pointerId: 1,
    pointerType: "pen",
    isPrimary: true,
    pressure: eventType === "pointerup" || eventType === "pointercancel" ? 0 : 0.8,
    width: 2,
    height: 3,
    tiltX: 7,
    tiltY: -3,
    buttons: eventType === "pointerup" || eventType === "pointercancel" ? 0 : 1,
    button: 0,
    clientX: 40,
    clientY: 60,
    targetId: 101,
    composedPath: ["101", "viewer"],
    eventPhase: 1,
    cancelable: true,
    defaultPrevented: false,
    ...overrides
  };
}

function touchEvent(
  eventType: RawTouchContactEvent["eventType"],
  identifier = 2,
  overrides: Partial<RawTouchContactEvent["touches"][number]> = {}
): RawTouchContactEvent {
  const point = {
    identifier,
    clientX: 41,
    clientY: 61,
    screenX: 41,
    screenY: 61,
    pageX: 41,
    pageY: 61,
    radiusX: 11,
    radiusY: 12,
    force: 0.6
  };
  return {
    eventType,
    touches: [{
      eventType,
      timeStamp: 0,
      identifier,
      clientX: point.clientX,
      clientY: point.clientY,
      radiusX: point.radiusX,
      radiusY: point.radiusY,
      force: point.force,
      touchCount: eventType === "touchend" || eventType === "touchcancel" ? 0 : 1,
      changedCount: 1,
      activeTouches: eventType === "touchend" || eventType === "touchcancel" ? [] : [point],
      changedTouches: [point],
      targetId: 101,
      composedPath: ["101", "viewer"],
      ...overrides
    }]
  };
}

function terminalTouchContact(
  tracker: PhysicalContactTracker,
  pointerType: string,
  pointerId: number,
  touchId: number
) {
  tracker.pointerDown(0, pointer("pointerdown", { pointerType, pointerId }));
  tracker.touchStart(10, touchEvent("touchstart", touchId));
  tracker.pointerEnd(20, pointer("pointerup", { pointerType, pointerId }));
  return tracker.touchEnd(30, touchEvent("touchend", touchId));
}

describe("deterministic physical-contact routing fixtures", () => {
  it("covers a normal finger as a paired pointer/touch lifecycle", () => {
    const [terminal] = terminalTouchContact(new PhysicalContactTracker(), "touch", 11, 21);

    expect(terminal?.contact.representation).toBe("paired-pointer-touch");
    expect(terminal?.contact.classification).toBe("paired");
    expect(terminal?.contact.pointerEventTouchSeen).toBe(true);
    expect(terminal?.contact.touchEventSeen).toBe(true);
    expect(terminal?.contact.penContactId).toBeNull();
  });

  it("covers a normal stylus without inventing a TouchEvent representation", () => {
    const tracker = new PhysicalContactTracker();
    const [started] = tracker.pointerDown(100, pointer("pointerdown", { pointerId: 12 }));
    const [terminal] = tracker.pointerEnd(180, pointer("pointerup", { pointerId: 12 }));

    expect(started?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.representation).toBe("pointer-pen");
    expect(terminal?.contact.classification).toBe("pen-only");
    expect(terminal?.contact.penContactId).toBe("physical-contact-1");
    expect(terminal?.contact.rawTouch.first).toBeNull();
  });

  it("keeps touch-only Pencil-like evidence classified as touch-only", () => {
    const tracker = new PhysicalContactTracker();
    const [started] = tracker.touchStart(0, touchEvent("touchstart", 31, { force: 1, radiusX: 0, radiusY: 0 }));
    const [terminal] = tracker.touchEnd(5_000, touchEvent("touchcancel", 31, { force: 1, radiusX: 0, radiusY: 0 }));

    expect(started?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.classification).toBe("touch-only");
    expect(terminal?.contact.penContactId).toBeNull();
    expect(terminal?.contact.rawTouch.first?.force).toBe(1);
    expect(terminal?.contact.rawTouch.first?.radiusX).toBe(0);
  });

  it.each([
    ["pen-missed-router", (probe: PostUiInputProbe): void => undefined, "post-ui-pen-missed-page-router", "routing"],
    ["stale-listener", (probe: PostUiInputProbe): void => { probe.handoffStage(2, 4, "router-rejected", { staleRouter: true, routerListenerAborted: true }); }, "post-ui-pen-stale-router", "routing"],
    ["annotation-native-conflict", (probe: PostUiInputProbe): void => {
      probe.handoffStage(2, 4, "router-received", { page: 2, routerGeneration: 8 });
      probe.handoffStage(3, 4, "route", { route: "native", routeReason: "annotation-policy" });
    }, "post-ui-pen-routed-native", "annotation-native-conflict"]
  ] as const)("records the %s terminal outcome", (_name, setup, expectedOutcome, expectedClass) => {
    const probe = new PostUiInputProbe();
    probe.observeDocument(1, 4, "pen", {
      physicalContactId: "physical-contact-77",
      pageMountGeneration: 5,
      viewerGeneration: 9,
      routerAlive: true
    });
    setup(probe);

    const result = probe.finishHandoff(4, 4, "pointercancel");
    expect(result).toMatchObject({
      outcome: expectedOutcome,
      outcomeClass: expectedClass,
      contact: expect.objectContaining({
        physicalContactId: "physical-contact-77",
        terminal: "pointercancel"
      })
    });
  });

  it("keeps a multi-second contact in one lifecycle and emits no move records", () => {
    const tracker = new PhysicalContactTracker();
    tracker.pointerDown(0, pointer("pointerdown", { pointerId: 90 }));
    for (let index = 1; index <= 240; index += 1) {
      expect(tracker.pointerMove(index * 25, pointer("pointermove", {
        pointerId: 90,
        clientX: 40 + index,
        clientY: 60 + index
      }))).toEqual([]);
    }

    const [terminal] = tracker.pointerEnd(6_100, pointer("pointercancel", { pointerId: 90, clientX: 280, clientY: 300 }));
    const serialized = JSON.stringify(terminal?.contact);
    expect(terminal?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.durationMs).toBe(6_100);
    expect(terminal?.contact.pointerMoveCount).toBe(240);
    expect(terminal?.contact.rawPointer.first?.eventType).toBe("pointerdown");
    expect(terminal?.contact.rawPointer.last?.eventType).toBe("pointercancel");
    expect(serialized).not.toContain("annotation contents");
    expect(serialized).not.toContain("pointermove");
  });

  it("retains raw evidence separately from classification and preserves the stable id", () => {
    const tracker = new PhysicalContactTracker();
    const [started] = tracker.pointerDown(0, pointer("pointerdown", { pointerId: 100 }));
    tracker.touchStart(20, touchEvent("touchstart", 101));
    const [terminal] = tracker.touchEnd(40, touchEvent("touchend", 101));

    expect(started?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.physicalContactId).toBe("physical-contact-1");
    expect(terminal?.contact.rawPointer.first?.pointerType).toBe("pen");
    expect(terminal?.contact.rawTouch.first?.eventType).toBe("touchstart");
    expect(terminal?.contact.classification).toBe("paired");
    expect(terminal?.contact.classificationTransitions.map(({ classification }) => classification)).toEqual(["pen-only", "paired"]);
    expect(terminal?.contact.rawPointer.first).not.toHaveProperty("classification");
    expect(terminal?.contact.rawTouch.first).not.toHaveProperty("classification");
  });
});
