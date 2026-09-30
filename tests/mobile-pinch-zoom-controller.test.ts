import { describe, expect, it } from "vitest";
import {
  MobilePinchZoomController,
  type MobilePinchZoomFrame,
  type MobilePinchZoomFocalPoint
} from "../src/input/MobilePinchZoomController";

function frame(distance: number, x = 100, y = 120): MobilePinchZoomFrame {
  return {
    generation: 1,
    points: [
      { pointerId: 1, clientX: x - distance / 2, clientY: y },
      { pointerId: 2, clientX: x + distance / 2, clientY: y }
    ]
  };
}

function harness(initialScale = 1) {
  let scale = initialScale;
  let now = 0;
  let nextFrame = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const timers = new Map<number, () => void>();
  const previews: Array<{ scale: number; focalPoint: MobilePinchZoomFocalPoint }> = [];
  const ends: Array<{ scale: number; reason: string }> = [];
  const cancels: string[] = [];
  let nextTimer = 1;
  const controller = new MobilePinchZoomController({
    minScale: 0.5,
    maxScale: 4,
    getScale: () => scale,
    now: () => now,
    requestFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onStart: () => ({ accepted: true, scale }),
    onPreview: (nextScale, focalPoint) => {
      scale = nextScale;
      previews.push({ scale: nextScale, focalPoint });
    },
    onEnd: (nextScale, reason) => {
      scale = nextScale;
      ends.push({ scale: nextScale, reason });
    },
    onCancel: (reason) => cancels.push(reason)
  });
  return {
    controller,
    previews,
    ends,
    cancels,
    flushFrame(timestamp = now) {
      const pending = [...frames.entries()][0];
      if (!pending) return;
      frames.delete(pending[0]);
      pending[1](timestamp);
    },
    fireTimer() {
      const pending = [...timers.entries()][0];
      if (!pending) return;
      timers.delete(pending[0]);
      pending[1]();
    },
    setNow(value: number) { now = value; },
    getScale() { return scale; }
  };
}

describe("MobilePinchZoomController", () => {
  it("anchors a pinch at the midpoint and coalesces preview frames", () => {
    const h = harness();

    expect(h.controller.start(frame(100, 240, 300))).toBe(true);
    h.controller.frame(frame(150, 280, 320));
    expect(h.previews).toHaveLength(0);
    h.flushFrame();

    expect(h.previews).toEqual([{ scale: 1.5, focalPoint: { x: 280, y: 320 } }]);
    h.controller.end("pointercancel");
    expect(h.cancels).toEqual(["pointercancel"]);
    expect(h.ends).toHaveLength(0);
  });

  it("commits the exact pinch scale immediately without release snapping or animation", () => {
    const h = harness();

    h.controller.start(frame(100));
    h.controller.frame(frame(103));
    h.flushFrame();
    h.controller.end("pointerup");

    expect(h.ends).toEqual([{ scale: 1.03, reason: "pointerup" }]);
    expect(h.getScale()).toBeCloseTo(1.03);
    expect(h.cancels).toEqual([]);
    h.setNow(180);
    h.flushFrame(180);
    expect(h.ends).toHaveLength(1);
  });

  it("keeps ctrl-wheel events in one anchored session and settles after the gap", () => {
    const h = harness();

    expect(h.controller.handleWheel({
      ctrlKey: true,
      metaKey: false,
      deltaY: -100,
      clientX: 90,
      clientY: 110,
      target: null
    })).toBe(true);
    h.flushFrame();
    expect(h.previews.at(-1)).toEqual({ scale: Math.E, focalPoint: { x: 90, y: 110 } });
    h.fireTimer();
    expect(h.ends).toHaveLength(1);
  });

  it("does not intercept ineligible wheel targets", () => {
    const h = harness();
    const controller = new MobilePinchZoomController({
      minScale: 0.5,
      maxScale: 4,
      getScale: () => h.getScale(),
      onStart: () => ({ accepted: true }),
      onPreview: () => undefined,
      onEnd: () => undefined,
      onCancel: () => undefined,
      onEligibility: () => false
    });

    expect(controller.handleWheel({
      ctrlKey: true,
      metaKey: false,
      deltaY: -1,
      clientX: 0,
      clientY: 0,
      target: null
    })).toBe(false);
  });
});
