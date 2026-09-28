import { afterEach, describe, expect, it } from "vitest";
import { IpadPointerTouchTrace } from "../src/input/IpadPointerTouchTrace";

function pointerEvent(type: string, pointerId = 7): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: "touch" },
    isPrimary: { configurable: true, value: true },
    button: { configurable: true, value: type === "pointerdown" ? 0 : -1 },
    buttons: { configurable: true, value: type === "pointerup" ? 0 : 1 },
    pressure: { configurable: true, value: 0 }
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
    target.dispatchEvent(pointerEvent("pointerdown"));
    for (let index = 0; index < 20; index += 1) {
      target.dispatchEvent(pointerEvent("pointermove"));
    }
    target.dispatchEvent(pointerEvent("pointerup"));
    target.dispatchEvent(pointerEvent("pointerleave"));

    const snapshot = trace.snapshot();
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.summary.eventTypes.pointerover).toBe(1);
    expect(snapshot.summary.eventTypes.pointermove).toBe(20);
    expect(snapshot.events.some((event) => event.type === "pointerover")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "pointermove")).toBe(true);
    expect(snapshot.summary.touchActionStyleReads).toBe(2);
    trace.release();
  });
});
