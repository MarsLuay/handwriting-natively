import { afterEach, describe, expect, it } from "vitest";
import { IpadPointerTouchTrace } from "../src/input/IpadPointerTouchTrace";

function pointerEvent(
  type: string,
  pointerId = 7,
  pointerType = "touch",
  buttons = type === "pointerup" ? 0 : 1,
  pressure = 0,
  sensors: Partial<Pick<PointerEvent, "width" | "height" | "tiltX" | "tiltY" | "twist">> = {},
  eventTimeStamp?: number
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: pointerType },
    isPrimary: { configurable: true, value: true },
    button: { configurable: true, value: type === "pointerdown" ? 0 : -1 },
    buttons: { configurable: true, value: buttons },
    pressure: { configurable: true, value: pressure },
    width: { configurable: true, value: sensors.width ?? 1 },
    height: { configurable: true, value: sensors.height ?? 1 },
    tiltX: { configurable: true, value: sensors.tiltX ?? 0 },
    tiltY: { configurable: true, value: sensors.tiltY ?? 0 },
    twist: { configurable: true, value: sensors.twist ?? 0 }
  });
  if (eventTimeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { configurable: true, value: eventTimeStamp });
  }
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
    expect(snapshot.schemaVersion).toBe(5);
    expect(snapshot.summary.eventTypes.pointerover).toBe(1);
    expect(snapshot.summary.eventTypes.gesturechange).toBe(3);
    expect(snapshot.summary.gestureChangeEvents).toBe(3);
    expect(snapshot.summary.eventTypes.pointermove).toBe(25);
    expect(snapshot.summary.passivePenHoverMoves).toBe(5);
    expect(snapshot.events.some((event) => event.type === "pointerover")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "gesturechange")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "pointermove")).toBe(true);
    expect(snapshot.events.some((event) => event.pointerType === "pen")).toBe(false);
    expect(snapshot.summary.touchActionStyleReads).toBe(2);
    trace.release();
  });

  it("preserves ordered boundaries, browser timestamps, and stylus sensor evidence", () => {
    const target = document.createElement("div");
    target.className = "pdf-page";
    document.body.append(target);
    const trace = IpadPointerTouchTrace.acquire(document);
    trace.start(true);

    target.dispatchEvent(pointerEvent("pointermove", 44, "pen", 0, 0, {
      width: 1,
      height: 1,
      tiltX: 3,
      tiltY: -2,
      twist: 17
    }, 10));
    const sensorlessHover = new Event("pointermove", { bubbles: true, cancelable: true });
    Object.defineProperties(sensorlessHover, {
      pointerId: { configurable: true, value: 46 },
      pointerType: { configurable: true, value: "pen" },
      buttons: { configurable: true, value: 0 }
    });
    target.dispatchEvent(sensorlessHover);
    target.dispatchEvent(pointerEvent("pointerover", 44, "pen", 0, 0, {}, 11));
    target.dispatchEvent(pointerEvent("pointerenter", 44, "pen", 0, 0, {}, 12));
    target.dispatchEvent(pointerEvent("pointerdown", 44, "pen", 1, 0.6, {
      width: 2.5,
      height: 3.5,
      tiltX: 21,
      tiltY: -14,
      twist: 35
    }, 13));
    target.dispatchEvent(pointerEvent("pointerup", 44, "pen", 0, 0, {}, 14));
    const sensorless = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(sensorless, {
      pointerId: { configurable: true, value: 45 },
      pointerType: { configurable: true, value: "pen" }
    });
    target.dispatchEvent(sensorless);
    const sensorlessUp = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(sensorlessUp, {
      pointerId: { configurable: true, value: 45 },
      pointerType: { configurable: true, value: "pen" }
    });
    target.dispatchEvent(sensorlessUp);

    const snapshot = trace.snapshot();
    const pointerEvents = snapshot.events.filter((event) => event.source === "pointer");
    const over = pointerEvents.find((event) => event.type === "pointerover");
    const enter = pointerEvents.find((event) => event.type === "pointerenter");
    const down = pointerEvents.find((event) => event.type === "pointerdown");
    const up = pointerEvents.find((event) => event.type === "pointerup");
    const sensorlessDown = pointerEvents.find((event) => event.pointerId === 45);
    const hover = snapshot.summary.passivePenHoverSamples.first;
    const sensorlessHoverSample = snapshot.summary.passivePenHoverSamples.last;

    expect([over?.sequence, enter?.sequence, down?.sequence, up?.sequence]).toEqual([
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)
    ]);
    expect(over!.sequence).toBeLessThan(enter!.sequence);
    expect(enter!.sequence).toBeLessThan(down!.sequence);
    expect(down!.sequence).toBeLessThan(up!.sequence);
    expect(hover).toMatchObject({
      pointerId: 44,
      eventTimeStamp: 10,
      pressure: 0,
      tiltX: 3,
      tiltY: -2,
      twist: 17
    });
    expect(hover!.sequence).toBeLessThan(over!.sequence);
    expect(snapshot.summary.passivePenHoverMoves).toBe(2);
    expect(sensorlessHoverSample).toMatchObject({
      pointerId: 46,
      pressure: null,
      width: null,
      height: null,
      tiltX: null,
      tiltY: null,
      twist: null
    });
    expect(down).toMatchObject({
      eventTimeStamp: 13,
      pressure: 0.6,
      width: 2.5,
      height: 3.5,
      tiltX: 21,
      tiltY: -14,
      twist: 35,
      targetClass: { tag: "div", classes: ["pdf-page"] }
    });
    expect(sensorlessDown).toMatchObject({
      pressure: null,
      width: null,
      height: null,
      tiltX: null,
      tiltY: null,
      twist: null
    });
    expect(snapshot.summary.pointerIds).toContain(45);
    expect(snapshot.events.at(-1)?.activePointerIds).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("clientX");
    trace.release();
  });
});
