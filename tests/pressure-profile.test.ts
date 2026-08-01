import { describe, expect, it } from "vitest";
import {
  PressureConditioner,
  applyPenEarlyStrokePressureFloor,
  createPressureConditioner,
  pressureConditionerOptionsForCalibration,
  resolvePressureProfile,
  PEN_MIN_START_PRESSURE,
  type PressureProfile
} from "../src/input/PressureProfile";

describe("pressure profiles", () => {
  it("maps the compact calibration controls to a safe responsive conditioner", () => {
    const calibrated = pressureConditionerOptionsForCalibration({ initialFloor: 0.15, gain: 1.15, smoothing: 0.78 });
    expect(calibrated.initialFloor).toBeCloseTo(0.15, 8);
    expect(calibrated.gain).toBeCloseTo(1.15, 8);
    expect(calibrated.stationaryEma).toBeCloseTo(0.22, 8);
    expect(calibrated.movingEma).toBeCloseTo(0.805, 8);
    expect(calibrated.minimumSlew).toBeGreaterThan(0.045);
    const direct = new PressureConditioner("pen", pressureConditionerOptionsForCalibration({ initialFloor: 0, gain: 1, smoothing: 0 }));
    direct.condition({ pressure: 0, distance: 0 });
    expect(direct.condition({ pressure: 1, distance: 0 })).toBe(1);
  });

  it("resolves Auto to pen only for a physical pen", () => {
    expect(resolvePressureProfile("auto", "pen")).toBe("pen");
    expect(resolvePressureProfile("auto", "PEN")).toBe("pen");
    expect(resolvePressureProfile("auto", "mouse")).toBe("mouse");
    expect(resolvePressureProfile("auto", "touch")).toBe("mouse");
    expect(resolvePressureProfile("auto", undefined)).toBe("mouse");
    expect(resolvePressureProfile("pen", "mouse")).toBe("pen");
    expect(resolvePressureProfile("mouse", "pen")).toBe("mouse");
  });

  it("applies Ink early-stroke floor for ~1× brush length then allows taper", () => {
    expect(applyPenEarlyStrokePressureFloor(0.02, 0, 2)).toBe(PEN_MIN_START_PRESSURE);
    expect(applyPenEarlyStrokePressureFloor(0.02, 1.9, 2)).toBe(PEN_MIN_START_PRESSURE);
    expect(applyPenEarlyStrokePressureFloor(0.02, 2, 2)).toBe(0.02);
    expect(PEN_MIN_START_PRESSURE).toBe(0.15);

    const conditioner = new PressureConditioner("pen", { strokeSize: 2 });
    const initial = conditioner.condition({ pointerType: "pen", pressure: 0, distance: 0 });
    const stillEarly = conditioner.condition({ pointerType: "pen", pressure: 0, distance: 1 });
    const later = conditioner.condition({ pointerType: "pen", pressure: 0, distance: 2 });
    const heavier = conditioner.condition({ pointerType: "pen", pressure: 0.7, distance: 8 });

    expect(initial).toBeCloseTo(0.15, 8);
    expect(stillEarly).toBeCloseTo(0.15, 8);
    expect(later).toBeLessThan(stillEarly);
    expect(later).toBeGreaterThanOrEqual(0);
    expect(heavier).toBeGreaterThan(later);
  });

  it("uses a curved, gained pen response instead of a minimum-pressure clamp", () => {
    const conditioner = new PressureConditioner("pen", { initialFloor: 0 });
    const light = conditioner.condition({ pressure: 0.01, distance: 0 });
    conditioner.reset();
    const medium = conditioner.condition({ pressure: 0.5, distance: 0 });
    conditioner.reset();
    const heavy = conditioner.condition({ pressure: 1, distance: 0 });

    expect(light).toBeGreaterThan(0);
    expect(light).toBeLessThan(0.1);
    expect(medium).toBeGreaterThan(0.5);
    expect(heavy).toBe(1);
  });

  it("smooths pressure while allowing larger changes after greater movement", () => {
    const stationary = new PressureConditioner("pen", { initialFloor: 0 });
    stationary.condition({ pressure: 0, distance: 0 });
    const stationaryRise = stationary.condition({ pressure: 1, distance: 0 });

    const moving = new PressureConditioner("pen", { initialFloor: 0 });
    moving.condition({ pressure: 0, distance: 0 });
    const movingRise = moving.condition({ pressure: 1, distance: 8 });

    expect(stationaryRise).toBeGreaterThan(0);
    expect(stationaryRise).toBeLessThan(0.1);
    expect(movingRise).toBeGreaterThan(stationaryRise);
    expect(movingRise).toBeLessThan(1);
  });

  it("accepts movement deltas when an explicit distance is unavailable", () => {
    const conditioner = new PressureConditioner("pen", { initialFloor: 0 });
    conditioner.condition({ pressure: 0, distance: 0 });
    const fromMovement = conditioner.condition({ pressure: 1, movementX: 6, movementY: 8 });

    expect(fromMovement).toBeGreaterThan(0.4);
  });

  it("uses fixed, bounded pressure for mouse input and resets pen state when sources change", () => {
    const conditioner = createPressureConditioner("auto");
    const pen = conditioner.condition({ pointerType: "pen", pressure: 1, distance: 8 });
    const mouseLight = conditioner.condition({ pointerType: "mouse", pressure: 0, distance: 50 });
    const mouseHeavy = conditioner.condition({ pointerType: "mouse", pressure: 1, distance: 50 });
    const restartedPen = conditioner.condition({ pointerType: "pen", pressure: 0, distance: 0 });

    expect(pen).toBe(1);
    expect(mouseLight).toBe(0.5);
    expect(mouseHeavy).toBe(0.5);
    expect(restartedPen).toBeCloseTo(0.15, 8);
  });

  it("clamps malformed values and is deterministic", () => {
    const profiles: PressureProfile[] = ["auto", "pen", "mouse"];
    for (const profile of profiles) {
      const first = createPressureConditioner(profile);
      const second = createPressureConditioner(profile);
      const samples = [
        { pointerType: "pen", pressure: Number.NaN, distance: -10 },
        { pointerType: "pen", pressure: -5, movementX: Number.POSITIVE_INFINITY, movementY: 3 },
        { pointerType: "pen", pressure: 5, distance: 12 }
      ];
      const one = samples.map((sample) => first.condition(sample));
      const two = samples.map((sample) => second.condition(sample));
      expect(one).toEqual(two);
      expect(one.every((value) => value >= 0 && value <= 1)).toBe(true);
    }
  });
});
