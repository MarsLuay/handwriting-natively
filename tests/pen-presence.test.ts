import { describe, expect, it } from "vitest";
import { PalmRejectionPolicy } from "../src/input/PalmRejectionPolicy";
import {
  effectiveInkPointerType,
  isTipContact,
  remapMouseTipSample
} from "../src/input/PenPresence";
import type { PointerSample } from "../src/input/PointerCapabilities";
import { PressureConditioner } from "../src/input/PressureProfile";

function sample(partial: Partial<PointerSample>): PointerSample {
  return {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 0,
    clientY: 0,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    width: 1,
    height: 1,
    buttons: 1,
    timeStamp: 0,
    ...partial
  };
}

describe("PenPresence / MockTab mouse tip", () => {
  it("remaps mouse tip to pen after pen was seen", () => {
    expect(effectiveInkPointerType("mouse", true, true)).toBe("pen");
    expect(effectiveInkPointerType("mouse", false, true)).toBe("mouse");
    expect(effectiveInkPointerType("mouse", true, false)).toBe("mouse");
    const remapped = remapMouseTipSample(sample({ pressure: 0.8 }), true, true);
    expect(remapped.pointerType).toBe("pen");
    expect(remapped.pressure).toBe(0.8);
  });

  it("tracks mouse tip in palm policy after pen hover", () => {
    const palm = new PalmRejectionPolicy({ penInactivityMs: 10_000 });
    const hover = {
      pointerType: "pen",
      pointerId: 1,
      buttons: 0,
      pressure: 0,
      type: "pointermove",
      button: -1
    } as PointerEvent;
    palm.notePenPresence(hover);
    expect(palm.hasPenSeen()).toBe(true);

    const tipDown = {
      pointerType: "mouse",
      pointerId: 2,
      buttons: 1,
      pressure: 0.4,
      type: "pointerdown",
      button: 0
    } as PointerEvent;
    expect(palm.shouldTreatMouseTipAsPen(tipDown)).toBe(true);
    palm.pointerDown(tipDown);
    expect(palm.hasActivePen()).toBe(true);
    expect(palm.activePenIds()).toEqual([2]);

    const plainMouse = {
      pointerType: "mouse",
      pointerId: 3,
      buttons: 1,
      pressure: 0.5,
      type: "pointerdown",
      button: 0
    } as PointerEvent;
    expect(palm.shouldTreatMouseTipAsPen(plainMouse)).toBe(false);
  });

  it("conditions real pressure for remapped mouse tip", () => {
    const conditioner = new PressureConditioner("auto", { initialFloor: 0 });
    const light = conditioner.condition({ pointerType: "pen", pressure: 0.2, distance: 0 });
    const heavy = conditioner.condition({ pointerType: "pen", pressure: 0.9, distance: 4 });
    expect(heavy).toBeGreaterThan(light);
    // Plain mouse still freezes at mousePressure.
    const mouseOnly = new PressureConditioner("auto");
    expect(mouseOnly.condition({ pointerType: "mouse", pressure: 0.9, distance: 0 })).toBe(0.5);
  });

  it("detects tip contact", () => {
    expect(isTipContact({ type: "pointerdown", buttons: 1, pressure: 0, button: 0, pointerType: "mouse" })).toBe(true);
    expect(isTipContact({ type: "pointermove", buttons: 0, pressure: 0, button: -1, pointerType: "pen" })).toBe(false);
    expect(isTipContact({ type: "pointermove", buttons: 0, pressure: 0.4, button: -1, pointerType: "pen" })).toBe(true);
    expect(isTipContact({ type: "pointermove", buttons: 32, pressure: 0, button: -1, pointerType: "mouse" })).toBe(true);
  });
});
