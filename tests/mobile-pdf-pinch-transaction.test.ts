import { describe, expect, it, vi } from "vitest";
import {
  MobilePdfPinchTransaction,
  type MobilePdfPinchTransactionCompletion
} from "../src/integration/MobilePdfPinchTransaction";
import type { MobilePdfCompositor } from "../src/integration/MobilePdfCompositor";
import type {
  MobilePdfZoomHandoff,
  MobilePdfZoomHandoffPhase,
  MobilePdfZoomHandoffSignal
} from "../src/integration/MobilePdfZoomHandoff";

function transactionHarness() {
  const calls: string[] = [];
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let nativePhase: MobilePdfZoomHandoffPhase = "preview";
  const view = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frameCallbacks.delete(id),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn()
  } as unknown as Window;
  const compositor = {
    submit: vi.fn(() => true),
    flush: vi.fn(() => calls.push("flush")),
    cancel: vi.fn(() => calls.push("cancel"))
  } as unknown as MobilePdfCompositor;
  const handoff = {
    updateFocalPoint: vi.fn(() => true),
    currentCancelReason: vi.fn(() => undefined),
    commit: vi.fn((scale: number) => {
      calls.push(`commit:${scale}`);
      nativePhase = "committing";
      return { phase: nativePhase, accepted: true };
    }),
    observe: vi.fn((_signal: MobilePdfZoomHandoffSignal) => nativePhase),
    currentPhase: vi.fn(() => nativePhase),
    release: vi.fn(() => {
      calls.push("release");
      nativePhase = "settled";
      return { phase: nativePhase, released: true, scrollDelta: { left: 0, top: 0 } };
    }),
    cancel: vi.fn()
  } as unknown as MobilePdfZoomHandoff;
  const runFrame = (): void => {
    const [id, callback] = frameCallbacks.entries().next().value ?? [];
    if (typeof id !== "number" || typeof callback !== "function") return;
    frameCallbacks.delete(id);
    callback(0);
  };
  return { calls, compositor, handoff, view, runFrame };
}

describe("mobile PDF pinch transaction", () => {
  it("flushes before the one native commit and releases after two display frames", () => {
    const harness = transactionHarness();
    const completion: MobilePdfPinchTransactionCompletion[] = [];
    const transaction = new MobilePdfPinchTransaction({
      compositor: harness.compositor,
      handoff: harness.handoff,
      initialScale: 1,
      view: harness.view,
      onComplete: (result) => completion.push(result)
    });

    expect(transaction.preview(1.25, { x: 300, y: 300 })).toBe(true);
    expect(transaction.commit()).toBe(true);
    expect(harness.calls).toEqual(["flush", "commit:1.25"]);
    expect(transaction.currentPhase()).toBe("committing");

    transaction.observe("render");
    harness.runFrame();
    expect(harness.calls).toEqual(["flush", "commit:1.25"]);
    harness.runFrame();

    expect(harness.calls).toEqual(["flush", "commit:1.25", "release", "cancel"]);
    expect(transaction.currentPhase()).toBe("settled");
    expect(completion).toEqual([{
      phase: "settled",
      result: {
        phase: "settled",
        released: true,
        scrollDelta: { left: 0, top: 0 }
      }
    }]);
  });
});
