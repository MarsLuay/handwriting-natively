import type { PointerSample } from "./PointerCapabilities";
import { PEN_HOVER_PRESSURE_EPSILON } from "./PointerCapabilities";

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
