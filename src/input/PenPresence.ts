import type { PointerSample } from "./PointerCapabilities";
import { PEN_HOVER_PRESSURE_EPSILON } from "./PointerCapabilities";

export interface PointerIdentityResolution {
  pointerType: "pen" | "mouse" | "touch";
  effectivePointerType: "pen" | "mouse" | "touch";
  stylusRemapped: boolean;
  reason: "native-pen" | "mocktab-stylus-tip" | "native-mouse" | "native-touch";
}

/**
 * MockTab / some stacks: hover arrives as `pen`, tip contact as `mouse`.
 * After any pen sample in the session, treat mouse tip contact as pen for
 * pressure, palm lock, and ink typing (mirrors input-capability-probe).
 */

export function isTipContact(
  event: Pick<PointerEvent, "type" | "buttons" | "pressure" | "button" | "pointerType">
): boolean {
  if (event.type === "pointerup" || event.type === "pointercancel") return false;
  if (isEraserTip(event)) return true;
  if ((event.buttons & 1) !== 0) return true;
  if (event.pointerType === "pen" && event.pressure > PEN_HOVER_PRESSURE_EPSILON) return true;
  if (event.type === "pointerdown" && event.button === 0) return true;
  return false;
}

/** W3C Pointer Events reserves button 5 / bit 32 for a physical eraser tip. */
export function isEraserTip(event: Pick<PointerEvent, "button" | "buttons">): boolean {
  return event.button === 5 || (event.buttons & 32) !== 0;
}

/** Narrow MockTab compatibility: a prior pen signal plus a non-mouse tip signature. */
export function isMockTabStylusTip(
  event: Pick<PointerEvent, "pointerType" | "type" | "buttons" | "pressure" | "button">,
  penSeen: boolean
): boolean {
  if (event.pointerType !== "mouse") return false;
  if (!penSeen) return false;
  if (isEraserTip(event)) return true;
  if (!isTipContact(event)) return false;
  const pressure = event.pressure;
  return pressure > 0 && pressure < 1 && Math.abs(pressure - 0.5) > 0.02;
}

/** Resolve browser pointer identity once for routing, palm protection, and diagnostics. */
export function resolvePointerIdentity(
  event: Pick<PointerEvent, "pointerType" | "type" | "buttons" | "pressure" | "button">,
  priorPenEvidence: boolean
): PointerIdentityResolution {
  if (event.pointerType === "pen") {
    return { pointerType: "pen", effectivePointerType: "pen", stylusRemapped: false, reason: "native-pen" };
  }
  if (event.pointerType === "touch") {
    return { pointerType: "touch", effectivePointerType: "touch", stylusRemapped: false, reason: "native-touch" };
  }
  if (event.pointerType === "mouse" && isMockTabStylusTip(event, priorPenEvidence)) {
    return { pointerType: "mouse", effectivePointerType: "pen", stylusRemapped: true, reason: "mocktab-stylus-tip" };
  }
  return { pointerType: "mouse", effectivePointerType: "mouse", stylusRemapped: false, reason: "native-mouse" };
}

export function remapMouseTipSample(
  sample: PointerSample,
  penSeen: boolean,
  tipContact: boolean
): PointerSample {
  if (!penSeen || !tipContact || sample.pointerType !== "mouse") return sample;
  return { ...sample, pointerType: "pen" };
}

export function remapMouseTipSamples(
  samples: readonly PointerSample[],
  penSeen: boolean,
  tipContact: boolean
): PointerSample[] {
  if (!penSeen || !tipContact) return [...samples];
  return samples.map((sample) => remapMouseTipSample(sample, penSeen, tipContact));
}

export function effectiveInkPointerType(
  pointerType: string | null | undefined,
  penSeen: boolean,
  tipContact: boolean
): string {
  const kind = (pointerType ?? "").toLowerCase();
  if (kind === "pen") return "pen";
  if (penSeen && tipContact && kind === "mouse") return "pen";
  return kind || "mouse";
}
