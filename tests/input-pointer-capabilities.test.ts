import { describe, expect, it } from "vitest";
import {
  PEN_HOVER_PRESSURE_EPSILON,
  PointerCapabilities,
  USE_COALESCED_POINTER_SAMPLES
} from "../src/input/PointerCapabilities";

function penEvent(pressure: number, extra: Record<string, unknown> = {}): PointerEvent {
  const event = new Event((extra.eventType as string) || "pointermove", {
    bubbles: true,
    cancelable: true
  }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: extra.pointerId ?? 1 },
    pressure: { value: pressure },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    width: { value: 1 },
    height: { value: 1 },
    buttons: { value: extra.buttons ?? 1 },
    clientX: { value: extra.clientX ?? 0 },
    clientY: { value: extra.clientY ?? 0 },
    timeStamp: { value: extra.timeStamp ?? 1 },
    getCoalescedEvents: { value: extra.getCoalescedEvents ?? (() => []) }
  });
  return event;
}

describe("PointerCapabilities pen hover filter", () => {
  it("flags near-zero Pencil pressure as hover", () => {
    expect(PointerCapabilities.isPenHoverSample({ pointerType: "pen", pressure: 0 })).toBe(true);
    expect(PointerCapabilities.isPenHoverSample({
      pointerType: "pen",
      pressure: PEN_HOVER_PRESSURE_EPSILON
    })).toBe(true);
    expect(PointerCapabilities.isPenHoverSample({
      pointerType: "pen",
      pressure: PEN_HOVER_PRESSURE_EPSILON + 0.001
    })).toBe(false);
    expect(PointerCapabilities.isPenHoverSample({ pointerType: "mouse", pressure: 0 })).toBe(false);
  });

  it("drops hover samples only when skipPenHover is set", () => {
    const hover = penEvent(0.005, { clientX: 1 });
    expect(PointerCapabilities.isPenHoverSample(PointerCapabilities.sample(hover))).toBe(true);
    expect(PointerCapabilities.samples(hover, { skipPenHover: true })).toEqual([]);
    expect(PointerCapabilities.samples(penEvent(0.4), { skipPenHover: true }).map((s) => s.pressure)).toEqual([0.4]);
  });

  it("ignores coalesced intermediates by default", () => {
    expect(USE_COALESCED_POINTER_SAMPLES).toBe(false);
    const a = penEvent(0.2, { clientX: 1, timeStamp: 1 });
    const b = penEvent(0.9, { clientX: 2, timeStamp: 2 });
    const move = penEvent(0.9, { clientX: 3, getCoalescedEvents: () => [a, b] });
    expect(PointerCapabilities.samples(move).map((s) => s.clientX)).toEqual([3]);
    expect(PointerCapabilities.samples(move, { useCoalesced: true }).map((s) => s.clientX)).toEqual([1, 2, 3]);
  });

  it("can drop an entire coalesced hover batch when coalesced is forced on", () => {
    const a = penEvent(0, { clientX: 1 });
    const b = penEvent(0.01, { clientX: 2 });
    const move = penEvent(0, { clientX: 2, getCoalescedEvents: () => [a, b] });
    expect(PointerCapabilities.samples(move, { skipPenHover: true, useCoalesced: true })).toEqual([]);
  });
});
