import { afterEach, describe, expect, it } from "vitest";
import { IpadPointerTouchTrace } from "../src/input/IpadPointerTouchTrace";

function pointerEvent(type: string, pointerId = 7, pointerType = "touch", buttons = type === "pointerup" ? 0 : 1, pressure = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: pointerType },
    isPrimary: { configurable: true, value: true },
    button: { configurable: true, value: type === "pointerdown" ? 0 : -1 },
    buttons: { configurable: true, value: buttons },
    pressure: { configurable: true, value: pressure }
  });
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("IpadPointerTouchTrace", () => {
  it("keeps hover events lightweight and caches hot-path style reads", () => {
    const target = document.createElement("div");
    target.className = "setting-item-name";
    document.body.append(target);
    const trace = IpadPointerTouchTrace.acquire(document);
    trace.start(true);

    target.dispatchEvent(pointerEvent("pointerover"));
    for (let index = 0; index < 3; index += 1) {
      target.dispatchEvent(new Event("gesturechange", { bubbles: true, cancelable: true }));
    }
    for (let index = 0; index < 5; index += 1) {
      target.dispatchEvent(pointerEvent("pointermove", 8, "pen", 0, 0));
    }
    target.dispatchEvent(pointerEvent("pointerdown"));
    for (let index = 0; index < 20; index += 1) {
      target.dispatchEvent(pointerEvent("pointermove"));
    }
    target.dispatchEvent(pointerEvent("pointerup"));
    target.dispatchEvent(pointerEvent("pointerleave"));

    const snapshot = trace.snapshot();
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.summary.eventTypes.pointerover).toBe(1);
    expect(snapshot.summary.eventTypes.gesturechange).toBe(3);
    expect(snapshot.summary.gestureChangeEvents).toBe(3);
    expect(snapshot.summary.eventTypes.pointermove).toBe(25);
    expect(snapshot.summary.passivePenHoverMoves).toBe(5);
    expect(snapshot.events.some((event) => event.type === "pointerover")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "gesturechange")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "pointermove")).toBe(true);
    expect(snapshot.events.some((event) => event.pointerType === "pen")).toBe(false);
    expect(snapshot.summary.touchActionStyleReads).toBe(2);
    trace.release();
  });
});
