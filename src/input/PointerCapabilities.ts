export type PointerKind = "pen" | "touch" | "mouse" | "unknown";

/** Ignore pen samples at or below this pressure (hover / lift jitter). Ink PEN_HOVER_PRESSURE_EPSILON. */
export const PEN_HOVER_PRESSURE_EPSILON = 0.01;

/**
 * Mouse stays on the dispatched event. Pen defaults to coalesced samples: iPad packs a
 * Pencil curve into one pointermove, and keeping only that event draws a straight line.
 */
export const USE_COALESCED_POINTER_SAMPLES = false;

/** iOS pointercancel / lostpointercapture often report (0, 0) instead of the pen. */
export function isSyntheticPointerOrigin(sample: { clientX: number; clientY: number }): boolean {
  return Math.max(Math.abs(sample.clientX), Math.abs(sample.clientY)) <= 1;
}

export interface PointerSample {
  pointerId: number;
  pointerType: PointerKind;
  clientX: number;
  clientY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  width: number;
  height: number;
  buttons: number;
  timeStamp: number;
}

export interface PointerSampleOptions {
  /**
   * Drop Pencil hover / near-zero pressure samples (Ink draw-tool skip).
   * Keep false for pointerdown/up so early-stroke floor and lift tip still land.
   */
  skipPenHover?: boolean;
  /** Override {@link USE_COALESCED_POINTER_SAMPLES} (tests). */
  useCoalesced?: boolean;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class PointerCapabilities {
  static kind(event: Pick<PointerEvent, "pointerType">): PointerKind {
    return event.pointerType === "pen" || event.pointerType === "touch" || event.pointerType === "mouse"
      ? event.pointerType
      : "unknown";
  }

  static isPenHoverSample(sample: Pick<PointerSample, "pointerType" | "pressure">): boolean {
    return sample.pointerType === "pen" && sample.pressure <= PEN_HOVER_PRESSURE_EPSILON;
  }

  static sample(event: PointerEvent): PointerSample {
    const source = event as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    const sample: PointerSample = {
      pointerId: event.pointerId,
      pointerType: this.kind(event),
      clientX: event.clientX,
      clientY: event.clientY,
      pressure: finite(event.pressure, 0),
      tiltX: finite(event.tiltX, 0),
      tiltY: finite(event.tiltY, 0),
      width: finite(event.width, 1),
      height: finite(event.height, 1),
      buttons: finite(event.buttons, 0),
      timeStamp: finite(event.timeStamp, performance.now())
    };
    if (typeof source.altitudeAngle === "number") sample.altitudeAngle = source.altitudeAngle;
    if (typeof source.azimuthAngle === "number") sample.azimuthAngle = source.azimuthAngle;
    return sample;
  }

  static samples(event: PointerEvent, options: PointerSampleOptions = {}): PointerSample[] {
    const useCoalesced = options.useCoalesced ?? (event.pointerType === "pen" || USE_COALESCED_POINTER_SAMPLES);
    let rawEvents: PointerEvent[] = [event];
    if (useCoalesced && typeof event.getCoalescedEvents === "function") {
      const coalesced = event.getCoalescedEvents();
      if (coalesced.length > 0) {
        rawEvents = coalesced.length > 1
          ? [...coalesced].sort((a, b) => a.timeStamp - b.timeStamp)
          : [...coalesced];
        const tail = rawEvents[rawEvents.length - 1]!;
        const dx = event.clientX - tail.clientX;
        const dy = event.clientY - tail.clientY;
        if (dx * dx + dy * dy > 0.01) rawEvents = [...rawEvents, event];
      }
    }
    const raw = rawEvents.map((sample) => this.sample(sample));
    const kept = event.type === "lostpointercapture" || event.type === "pointercancel"
      ? raw.filter((sample) => !isSyntheticPointerOrigin(sample))
      : raw;
    if (!options.skipPenHover) return kept;
    return kept.filter((sample) => !this.isPenHoverSample(sample));
  }

  static hasTilt(event: PointerEvent): boolean {
    return event.tiltX !== 0 || event.tiltY !== 0 || "altitudeAngle" in event;
  }
}
