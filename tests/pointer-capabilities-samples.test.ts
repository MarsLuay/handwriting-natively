import { describe, expect, it } from "vitest";
import { PointerCapabilities } from "../src/input/PointerCapabilities";

function pointer(type: string, x: number, y: number, extras: Record<string, unknown> = {}): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: 3 },
    pressure: { value: 0.2 },
    width: { value: 0.5 },
    height: { value: 0.5 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    buttons: { value: 1 },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: extras.timeStamp ?? 1 },
    getCoalescedEvents: { value: extras.getCoalescedEvents ?? (() => []) }
  });
  return event;
}

describe("pen stroke samples", () => {
  it("keeps the coalesced Pencil curve inside one pointermove", () => {
    const samples = [pointer("pointermove", 10, 10, { timeStamp: 1 }), pointer("pointermove", 40, 80, { timeStamp: 2 }), pointer("pointermove", 70, 20, { timeStamp: 3 })];
    const event = pointer("pointermove", 70, 20, { timeStamp: 3, getCoalescedEvents: () => samples });
    const points = PointerCapabilities.samples(event);
    expect(points.map((point) => [point.clientX, point.clientY])).toEqual([[10, 10], [40, 80], [70, 20]]);
  });

  it("drops a lostpointercapture point at the origin so the stroke is not pulled into a line", () => {
    const event = pointer("lostpointercapture", 0, 0, { timeStamp: 9, getCoalescedEvents: () => [] });
    expect(PointerCapabilities.samples(event)).toEqual([]);
  });
});
