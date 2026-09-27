import { describe, expect, it } from "vitest";
import {
  physicalContactHotPathStats,
  rawPointerContactSample,
  rawTouchContactEvent,
  resetPhysicalContactHotPathStats
} from "../src/input/PhysicalContactCollector";
import { PhysicalContactTracker, rawSampleCloneCount, resetRawSampleCloneCount } from "../src/input/PhysicalContactTracker";

function pointerEvent(type: string): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  const page = document.createElement("div");
  page.className = "page";
  document.body.append(page);
  let pathCalls = 0;
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: 4 },
    isPrimary: { value: true },
    pressure: { value: 0.2 },
    width: { value: 0.5 },
    height: { value: 0.5 },
    tiltX: { value: 1 },
    tiltY: { value: 2 },
    buttons: { value: 1 },
    button: { value: 0 },
    clientX: { value: 10 },
    clientY: { value: 20 },
    composedPath: {
      value: () => {
        pathCalls += 1;
        return [page];
      }
    }
  });
  return Object.assign(event, { pathCalls: () => pathCalls });
}

describe("physical contact hot path", () => {
  it("does not describe the composed path on pointermove or touchmove", () => {
    resetPhysicalContactHotPathStats();
    const move = pointerEvent("pointermove");
    const sample = rawPointerContactSample(move, "pointermove");
    expect((move as PointerEvent & { pathCalls(): number }).pathCalls()).toBe(0);
    expect(sample.composedPath).toEqual([]);
    expect(sample.composedPathLabels).toEqual([]);
    expect(sample.pressure).toBe(0.2);

    const down = pointerEvent("pointerdown");
    const started = rawPointerContactSample(down, "pointerdown");
    expect((down as PointerEvent & { pathCalls(): number }).pathCalls()).toBe(1);
    expect(started.composedPathLabels?.[0]).toBe("div.page");

    const touch = new Event("touchmove", { bubbles: true }) as TouchEvent;
    let touchPaths = 0;
    Object.defineProperties(touch, {
      touches: { value: [{ identifier: 1, clientX: 1, clientY: 2, screenX: 1, screenY: 2, pageX: 1, pageY: 2, radiusX: 0, radiusY: 0, force: 0.1 }] },
      changedTouches: { value: [{ identifier: 1, clientX: 3, clientY: 4, screenX: 3, screenY: 4, pageX: 3, pageY: 4, radiusX: 0, radiusY: 0, force: 0.2 }] },
      composedPath: { value: () => { touchPaths += 1; return []; } }
    });
    const touchSample = rawTouchContactEvent(touch, "touchmove");
    expect(touchPaths).toBe(0);
    expect(touchSample.touches[0]?.composedPathLabels).toEqual([]);
    expect(physicalContactHotPathStats().pathLabelBuildOnMoveCount).toBe(0);
    expect(physicalContactHotPathStats().pathLabelBuildCount).toBe(1);
  });

  it("keeps down labels and displacement across many moves without cloning each path", () => {
    resetPhysicalContactHotPathStats();
    resetRawSampleCloneCount();
    const tracker = new PhysicalContactTracker("stroke");
    const down = rawPointerContactSample(pointerEvent("pointerdown"), "pointerdown");
    tracker.pointerDown(1_000, { ...down, clientX: 10, clientY: 20 });
    const clonesAfterDown = rawSampleCloneCount();
    for (let index = 0; index < 500; index += 1) {
      const move = rawPointerContactSample(pointerEvent("pointermove"), "pointermove");
      tracker.pointerMove(1_000 + index, { ...move, clientX: 10 + index, clientY: 20, pressure: 0.4 });
    }
    const ended = tracker.pointerEnd(2_000, {
      ...rawPointerContactSample(pointerEvent("pointerup"), "pointerup"),
      clientX: 510,
      clientY: 20,
      buttons: 0
    });
    expect(rawSampleCloneCount() - clonesAfterDown).toBeLessThan(5);
    expect(ended[0]?.contact.pointerMoveCount).toBe(500);
    expect(ended[0]?.contact.maxDisplacementPx).toBeGreaterThan(400);
    expect(ended[0]?.contact.rawPointer.first?.composedPathLabels).toEqual(["div.page"]);
    expect(physicalContactHotPathStats().pathLabelBuildOnMoveCount).toBe(0);
  });
});
