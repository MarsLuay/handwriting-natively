import { describe, expect, it } from "vitest";
import { PalmRejectionPolicy } from "../src/input/PalmRejectionPolicy";

describe("PalmRejectionPolicy", () => {
  it("clears contact on pointerup and inactivity timeout", () => {
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const policy = new PalmRejectionPolicy({
      now: () => now,
      setTimeout: (handler) => {
        const id = nextId++;
        timers.set(id, handler);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      penInactivityMs: 250,
      stalePenTouchMs: 150
    });
    const resets: string[] = [];
    policy.setResetListener((reason) => {
      resets.push(reason);
    });

    policy.pointerDown({ pointerType: "pen", pointerId: 7 } as PointerEvent);
    expect(policy.hasActivePen()).toBe(true);
    expect(timers.size).toBe(1);

    policy.pointerUp({ pointerType: "pen", pointerId: 7 } as PointerEvent);
    expect(policy.hasActivePen()).toBe(false);
    expect(resets).toEqual(["pointerup"]);
    expect(timers.size).toBe(0);

    policy.pointerDown({ pointerType: "pen", pointerId: 8 } as PointerEvent);
    now = 300;
    for (const handler of [...timers.values()]) handler();
    expect(policy.hasActivePen()).toBe(false);
    expect(resets.at(-1)).toBe("pen-inactivity-timeout");
  });

  it("reconciles stale pen when a finger arrives after the grace window", () => {
    let now = 0;
    const policy = new PalmRejectionPolicy({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      stalePenTouchMs: 150,
      penInactivityMs: 10_000
    });
    policy.pointerDown({ pointerType: "pen", pointerId: 3 } as PointerEvent);
    now = 151;
    expect(policy.reconcileStalePenOnTouch()).toBe(true);
    expect(policy.hasActivePen()).toBe(false);
  });

  it("does not reconcile companion touch within the grace window", () => {
    let now = 0;
    const policy = new PalmRejectionPolicy({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      stalePenTouchMs: 150,
      penInactivityMs: 10_000
    });
    policy.pointerDown({ pointerType: "pen", pointerId: 3 } as PointerEvent);
    now = 4;
    expect(policy.reconcileStalePenOnTouch()).toBe(false);
    expect(policy.hasActivePen()).toBe(true);
    expect(policy.shouldIgnore({
      pointerType: "touch",
      width: 1,
      height: 1,
      pressure: 0.2
    } as PointerEvent)).toBe(true);
  });
});
