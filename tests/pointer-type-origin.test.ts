import { describe, expect, it } from "vitest";
import { POINTER_TYPE_ORIGIN_LIMIT, PointerTypeOriginLog, pointerTypeOrigin } from "../src/input/PointerTypeOrigin";

function pointer(type: string, pointerId = 4): PointerEvent {
  const event = new Event("pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: type },
    pointerId: { value: pointerId }
  });
  const page = document.createElement("div");
  page.className = "page";
  document.body.append(page);
  page.dispatchEvent(event);
  return event;
}

describe("pointer type origin", () => {
  it("records a pen from PointerEvent.pointerType and the listener that saw it", () => {
    const event = pointer("pen", 9);
    const origin = pointerTypeOrigin(event, "page-pointer-router", "capture");
    expect(origin).toMatchObject({
      event: "pointer-type-origin",
      inputKind: "pen",
      rawPointerType: "pen",
      typeSource: "PointerEvent.pointerType",
      eventInterface: "PointerEvent",
      eventType: "pointerdown",
      listener: "page-pointer-router",
      listenerPhase: "capture",
      pointerId: 9
    });
    expect(origin.touchIdentifiers).toEqual([]);
  });

  it("keeps a generic touch PointerEvent as touch and does not call it a pen", () => {
    const origin = pointerTypeOrigin(pointer("touch", 3), "document-physical-contact-collector", "capture");
    expect(origin.inputKind).toBe("touch");
    expect(origin.rawPointerType).toBe("touch");
    expect(origin.typeSource).toBe("PointerEvent.pointerType");
    expect(origin.listener).toBe("document-physical-contact-collector");
  });

  it("labels a TouchEvent separately from a pointerType touch", () => {
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: [] },
      changedTouches: { value: [{ identifier: 15 }] },
      targetTouches: { value: [] }
    });
    Object.setPrototypeOf(event, TouchEvent.prototype);
    const origin = pointerTypeOrigin(event, "page-touch-router", "capture");
    expect(origin).toMatchObject({
      inputKind: "touch",
      rawPointerType: null,
      typeSource: "TouchEvent",
      eventInterface: "TouchEvent",
      listener: "page-touch-router",
      pointerId: null,
      touchIdentifiers: [15]
    });
  });

  it("labels wheel and unknown pointer types as other", () => {
    const wheel = new WheelEvent("wheel", { deltaY: 4 });
    expect(pointerTypeOrigin(wheel, "document-wheel", "capture")).toMatchObject({
      inputKind: "other",
      rawPointerType: null,
      typeSource: "WheelEvent",
      eventInterface: "WheelEvent",
      eventType: "wheel",
      listener: "document-wheel"
    });
    const unknown = pointerTypeOrigin(pointer("xr"), "document-pointer-probe", "capture");
    expect(unknown.inputKind).toBe("other");
    expect(unknown.rawPointerType).toBe("xr");
    const gesture = new Event("gesturestart");
    expect(pointerTypeOrigin(gesture, "document-gesture", "capture")).toMatchObject({
      inputKind: "other",
      typeSource: "GestureEvent",
      eventInterface: "other",
      listener: "document-gesture"
    });
  });

  it("keeps the latest origins for Copy Logs and can match a contact", () => {
    const log = new PointerTypeOriginLog();
    log.note(pointerTypeOrigin(pointer("pen", 1), "document-pointer-probe", "capture"));
    log.note(pointerTypeOrigin(pointer("pen", 1), "page-pointer-router", "capture"));
    log.note(pointerTypeOrigin(pointer("touch", 2), "document-physical-contact-collector", "capture"));
    for (let index = 0; index < POINTER_TYPE_ORIGIN_LIMIT; index += 1) {
      log.note(pointerTypeOrigin(pointer("mouse", 100 + index), "document-pointer-fallback", "bubble"));
    }
    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(POINTER_TYPE_ORIGIN_LIMIT);
    expect(snapshot[0]?.pointerId).not.toBe(1);
    expect(log.forContact([1], []).map((entry) => entry.listener)).toEqual([
      "document-pointer-probe",
      "page-pointer-router"
    ]);
    expect(log.forContact([2], []).map((entry) => entry.inputKind)).toEqual(["touch"]);
  });
});
