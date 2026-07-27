import type { PressureCalibration, PressureProfile } from "../model";

export type { PressureProfile } from "../model";

/**
 * Pressure source selection is deliberately separate from stroke rendering.
 * The resulting normalized value is stored with the ink point, so previews,
 * persistence, and exports all agree on the input that produced a stroke.
 */
export type ResolvedPressureProfile = Exclude<PressureProfile, "auto">;

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
  /** Initial pressure used only when a pen stroke starts nearly weightless. */
  initialFloor?: number;
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
  initialFloor: 0.08,
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

/** Map the three user-facing calibration controls onto safe conditioner values. */
export function pressureConditionerOptionsForCalibration(
  calibration: PressureCalibration
): PressureConditionerOptions {
  const smoothing = clampUnit(finite(calibration.smoothing, 0.78));
  const responsiveness = 1 - smoothing;
  return {
    initialFloor: clampUnit(finite(calibration.initialFloor, DEFAULTS.initialFloor)),
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

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
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
 * before reusing it for a later stroke so the first-sample floor stays local.
 */
export class PressureConditioner {
  private readonly options: Required<PressureConditionerOptions>;
  private previousPenPressure: number | undefined;

  constructor(private readonly profile: PressureProfile = "auto", options: PressureConditionerOptions = {}) {
    this.options = {
      initialFloor: clampUnit(finite(options.initialFloor, DEFAULTS.initialFloor)),
      gain: Math.max(0, finite(options.gain, DEFAULTS.gain)),
      curve: Math.max(0.05, finite(options.curve, DEFAULTS.curve)),
      stationaryEma: clampUnit(finite(options.stationaryEma, DEFAULTS.stationaryEma)),
      movingEma: clampUnit(finite(options.movingEma, DEFAULTS.movingEma)),
      distanceForFullResponse: Math.max(0.001, finite(options.distanceForFullResponse, DEFAULTS.distanceForFullResponse)),
      minimumSlew: clampUnit(finite(options.minimumSlew, DEFAULTS.minimumSlew)),
      slewPerDistance: Math.max(0, finite(options.slewPerDistance, DEFAULTS.slewPerDistance)),
      maximumSlew: clampUnit(finite(options.maximumSlew, DEFAULTS.maximumSlew)),
      mousePressure: clampUnit(finite(options.mousePressure, DEFAULTS.mousePressure))
    };
  }

  reset(): void {
    this.previousPenPressure = undefined;
  }

  condition(sample: PressureSample): number {
    if (resolvePressureProfile(this.profile, sample.pointerType) === "mouse") {
      this.reset();
      return this.options.mousePressure;
    }

    const target = this.penTarget(sample.pressure);
    if (this.previousPenPressure === undefined) {
      const initial = Math.max(this.options.initialFloor, target);
      this.previousPenPressure = initial;
      return initial;
    }

    const previous = this.previousPenPressure;
    const distance = this.sampleDistance(sample);
    const distanceWeight = clampUnit(distance / this.options.distanceForFullResponse);
    const ema = this.options.stationaryEma
      + (this.options.movingEma - this.options.stationaryEma) * distanceWeight;
    const smoothed = previous + (target - previous) * ema;
    const maximumChange = Math.min(
      this.options.maximumSlew,
      this.options.minimumSlew + distance * this.options.slewPerDistance
    );
    const next = clampUnit(previous + Math.max(-maximumChange, Math.min(maximumChange, smoothed - previous)));
    this.previousPenPressure = next;
    return next;
  }

  private penTarget(rawPressure: number | null | undefined): number {
    const raw = clampUnit(finite(rawPressure, 0));
    return clampUnit(Math.pow(clampUnit(raw * this.options.gain), this.options.curve));
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
