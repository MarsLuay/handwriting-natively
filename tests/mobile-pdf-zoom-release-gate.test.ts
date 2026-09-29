import { describe, expect, it } from "vitest";
import { scheduleAfterDisplayFrames } from "../src/integration/MobilePdfZoomReleaseGate";

describe("mobile PDF zoom release gate", () => {
  it("holds the temporary preview through two display frames", () => {
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const view = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => { callbacks.delete(id); }
    } as unknown as Window;
    let released = 0;

    const cancel = scheduleAfterDisplayFrames(view, () => { released += 1; });
    expect(callbacks).toHaveLength(1);
    const first = callbacks.keys().next().value as number;
    const firstCallback = callbacks.get(first);
    callbacks.delete(first);
    firstCallback?.(first);
    expect(released).toBe(0);
    expect(callbacks).toHaveLength(1);
    const second = callbacks.keys().next().value as number;
    const secondCallback = callbacks.get(second);
    callbacks.delete(second);
    secondCallback?.(second);
    expect(released).toBe(1);

    cancel();
    expect(callbacks).toHaveLength(0);
  });

  it("cancels a pending release without invoking it", () => {
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const view = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => { callbacks.delete(id); }
    } as unknown as Window;
    let released = false;

    const cancel = scheduleAfterDisplayFrames(view, () => { released = true; });
    cancel();
    expect(callbacks).toHaveLength(0);
    expect(released).toBe(false);
  });
});
