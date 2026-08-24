import type { PressureCalibration, PressureProfile } from "../model";
import { clamp01 } from "../util/math";

export type { PressureProfile } from "../model";

/**
 * Pressure source selection is deliberately separate from stroke rendering.
 * The resulting normalized value is stored with the ink point, so previews,
 * persistence, and exports all agree on the input that produced a stroke.
 */
export type ResolvedPressureProfile = Exclude<PressureProfile, "auto">;

/** Minimum stored pressure while path length is within the early-stroke window (Ink). */
export const PEN_MIN_START_PRESSURE = 0.15;

/** Apply early floor until path length exceeds `strokeSize *` this factor (Ink). */
export const PEN_EARLY_STROKE_FLOOR_LENGTH_MULTIPLIER = 1;

export interface PressureSample {
  /** PointerEvent.pointerType, when the browser supplied one. */
  pointerType?: string | null;
  /** PointerEvent.pressure. Values outside the normalized range are tolerated. */
  pressure?: number | null;
  /** Distance since the preceding accepted sample in document/PDF space. */
  distance?: number | null;
  /** Optional alternative to distance for callers that have screen deltas. */
  movementX?: number | null;
  movementY?: number | null;
}

export interface PressureConditionerOptions {
  /**
   * Floor while the stroke is still within ~1× brush length (Ink PEN_MIN_START_PRESSURE).
   * Settings map this from pressureCalibration.initialFloor.
   */
  initialFloor?: number;
  /** Stroke width in the same space as sample distances (PDF / page units). */
  strokeSize?: number;
  /** Keep {@link initialFloor} until path length ≥ strokeSize × this (Ink default 1). */
  earlyFloorLengthMultiplier?: number;
  /** Multiplier applied before the response curve. */
  gain?: number;
  /** Response exponent; below one makes low real pen pressure usable. */
  curve?: number;
  /** EMA weight when samples arrive without meaningful movement. */
  stationaryEma?: number;
  /** EMA weight once the pointer travels `distanceForFullResponse`. */
  movingEma?: number;
  distanceForFullResponse?: number;
  /** Minimum per-sample pressure change, even for stationary input. */
  minimumSlew?: number;
  /** Additional permitted pressure change for each travelled unit. */
  slewPerDistance?: number;
  maximumSlew?: number;
  /** Constant normalized pressure for intentional non-pressure input. */
  mousePressure?: number;
}

const DEFAULTS: Required<PressureConditionerOptions> = {
  initialFloor: PEN_MIN_START_PRESSURE,
  strokeSize: 0,
  earlyFloorLengthMultiplier: PEN_EARLY_STROKE_FLOOR_LENGTH_MULTIPLIER,
  gain: 1.15,
  curve: 0.75,
  stationaryEma: 0.22,
  movingEma: 0.8,
  distanceForFullResponse: 8,
  minimumSlew: 0.045,
  slewPerDistance: 0.045,
  maximumSlew: 0.5,
  mousePressure: 0.5
};

/**
 * Keep a visible tip while the path is still shorter than ~1× brush size (Ink).
 * When strokeSize ≤ 0, the floor applies for the whole stroke (Ink fallback).
 */
export function applyPenEarlyStrokePressureFloor(
  scaledPressure: number,
  strokePathLength: number,
  strokeSize: number,
  floor: number = PEN_MIN_START_PRESSURE,
  lengthMultiplier: number = PEN_EARLY_STROKE_FLOOR_LENGTH_MULTIPLIER
): number {
  if (!(floor > 0)) return scaledPressure;
  if (!(strokeSize > 0) || strokePathLength < strokeSize * lengthMultiplier) {
    return Math.max(floor, scaledPressure);
  }
  return scaledPressure;
}

/** Map the three user-facing calibration controls onto safe conditioner values. */
export function pressureConditionerOptionsForCalibration(
  calibration: PressureCalibration
): PressureConditionerOptions {
  const smoothing = clamp01(finite(calibration.smoothing, 0.78));
  const responsiveness = 1 - smoothing;
  return {
    initialFloor: clamp01(finite(calibration.initialFloor, DEFAULTS.initialFloor)),
    gain: Math.max(0, finite(calibration.gain, DEFAULTS.gain)),
    // At zero, no EMA/slew smoothing remains: each sample reaches its
    // calibrated target. Higher smoothing damps stationary changes first,
    // while a moving pen stays responsive enough for handwriting.
    stationaryEma: responsiveness,
    movingEma: 1 - smoothing * 0.25,
    minimumSlew: DEFAULTS.minimumSlew + (1 - DEFAULTS.minimumSlew) * responsiveness,
    slewPerDistance: DEFAULTS.slewPerDistance + (1 - DEFAULTS.slewPerDistance) * responsiveness,
    maximumSlew: DEFAULTS.maximumSlew + (1 - DEFAULTS.maximumSlew) * responsiveness
  };
}


function finite(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Resolve Auto conservatively: only a physical pen opts into pressure. */
export function resolvePressureProfile(
  profile: PressureProfile,
  pointerType: string | null | undefined
): ResolvedPressureProfile {
  if (profile !== "auto") return profile;
  return pointerType?.toLowerCase() === "pen" ? "pen" : "mouse";
}

/**
 * Converts PointerEvent pressure into stable, normalized ink pressure.
 *
 * A conditioner is scoped to one active stroke. `reset()` must be called
 * before reusing it for a later stroke so the early-stroke floor stays local.
 */
export class PressureConditioner {
  private readonly options: Required<PressureConditionerOptions>;
  private previousPenPressure: number | undefined;
  private pathLength = 0;

  constructor(private readonly profile: PressureProfile = "auto", options: PressureConditionerOptions = {}) {
    this.options = {
      initialFloor: clamp01(finite(options.initialFloor, DEFAULTS.initialFloor)),
      strokeSize: Math.max(0, finite(options.strokeSize, DEFAULTS.strokeSize)),
      earlyFloorLengthMultiplier: Math.max(0, finite(options.earlyFloorLengthMultiplier, DEFAULTS.earlyFloorLengthMultiplier)),
      gain: Math.max(0, finite(options.gain, DEFAULTS.gain)),
      curve: Math.max(0.05, finite(options.curve, DEFAULTS.curve)),
      stationaryEma: clamp01(finite(options.stationaryEma, DEFAULTS.stationaryEma)),
      movingEma: clamp01(finite(options.movingEma, DEFAULTS.movingEma)),
      distanceForFullResponse: Math.max(0.001, finite(options.distanceForFullResponse, DEFAULTS.distanceForFullResponse)),
      minimumSlew: clamp01(finite(options.minimumSlew, DEFAULTS.minimumSlew)),
      slewPerDistance: Math.max(0, finite(options.slewPerDistance, DEFAULTS.slewPerDistance)),
      maximumSlew: clamp01(finite(options.maximumSlew, DEFAULTS.maximumSlew)),
      mousePressure: clamp01(finite(options.mousePressure, DEFAULTS.mousePressure))
    };
  }

  reset(): void {
    this.previousPenPressure = undefined;
    this.pathLength = 0;
  }

  condition(sample: PressureSample): number {
    if (resolvePressureProfile(this.profile, sample.pointerType) === "mouse") {
      this.reset();
      return this.options.mousePressure;
    }

    const distance = this.sampleDistance(sample);
    if (this.previousPenPressure !== undefined) this.pathLength += distance;

    const target = this.penTarget(sample.pressure);
    let next: number;
    if (this.previousPenPressure === undefined) {
      next = target;
    } else {
      const previous = this.previousPenPressure;
      const distanceWeight = clamp01(distance / this.options.distanceForFullResponse);
      const ema = this.options.stationaryEma
        + (this.options.movingEma - this.options.stationaryEma) * distanceWeight;
      const smoothed = previous + (target - previous) * ema;
      const maximumChange = Math.min(
        this.options.maximumSlew,
        this.options.minimumSlew + distance * this.options.slewPerDistance
      );
      next = clamp01(previous + Math.max(-maximumChange, Math.min(maximumChange, smoothed - previous)));
    }

    next = applyPenEarlyStrokePressureFloor(
      next,
      this.pathLength,
      this.options.strokeSize,
      this.options.initialFloor,
      this.options.earlyFloorLengthMultiplier
    );
    this.previousPenPressure = next;
    return next;
  }

  private penTarget(rawPressure: number | null | undefined): number {
    const raw = clamp01(finite(rawPressure, 0));
    return clamp01(Math.pow(clamp01(raw * this.options.gain), this.options.curve));
  }

  private sampleDistance(sample: PressureSample): number {
    const distance = finite(sample.distance, Number.NaN);
    if (Number.isFinite(distance)) return Math.max(0, distance);
    return Math.hypot(finite(sample.movementX, 0), finite(sample.movementY, 0));
  }
}

export function createPressureConditioner(
  profile: PressureProfile = "auto",
  options: PressureConditionerOptions = {}
): PressureConditioner {
  return new PressureConditioner(profile, options);
}
