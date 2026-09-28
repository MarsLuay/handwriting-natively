import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCommandPaletteSwipe,
  classifySidebarSwipe,
  MobileSidebarSwipeBlocker
} from "../src/input/MobileSidebarSwipeBlocker";

function touch(identifier: number, clientX: number, clientY: number): Touch {
  return { identifier, clientX, clientY, target: document.body } as unknown as Touch;
}

function touchEvent(type: "touchstart" | "touchmove" | "touchend", touches: Touch[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: type === "touchmove" });
  Object.defineProperty(event, "touches", { configurable: true, value: touches });
  Object.defineProperty(event, "changedTouches", { configurable: true, value: touches });
  return event;
}

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType = "touch"
): Event {
  const event = new Event(type, { bubbles: true, cancelable: type === "pointermove" });
  Object.defineProperties(event, {
    clientX: { configurable: true, value: clientX },
    clientY: { configurable: true, value: clientY },
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: pointerType }
  });
  return event;
}

function penEvent(type: "pointerdown" | "pointerup", pointerId: number): Event {
  return pointerEvent(type, pointerId, 0, 0, "pen");
}

afterEach(() => {
  document.body.className = "";
});

describe("MobileSidebarSwipeBlocker", () => {
  it("classifies only strongly horizontal movement as a sidebar swipe", () => {
    expect(classifySidebarSwipe(10, 10, 30, 12)).toBe("left");
    expect(classifySidebarSwipe(100, 10, 70, 12)).toBe("right");
    expect(classifySidebarSwipe(10, 10, 20, 14)).toBeNull();
    expect(classifySidebarSwipe(10, 10, 17, 10)).toBeNull();
  });

  it("classifies only a downward top-edge gesture as a command-palette swipe", () => {
    expect(classifyCommandPaletteSwipe(100, 20, 104, 60)).toBe(true);
    expect(classifyCommandPaletteSwipe(100, 60, 104, 100)).toBe(false);
    expect(classifyCommandPaletteSwipe(100, 20, 150, 30)).toBe(false);
    expect(classifyCommandPaletteSwipe(100, 20, 104, 5)).toBe(false);
  });

  it("blocks a one-finger swipe toward a closed left sidebar", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(true);
    document.dispatchEvent(touchEvent("touchstart", [touch(1, 10, 100)]));
    const move = touchEvent("touchmove", [touch(1, 60, 108)]);
    document.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    blocker.destroy();
  });

  it("blocks the opposite direction for a closed right sidebar and allows open sidebars", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(true);

    document.dispatchEvent(touchEvent("touchstart", [touch(1, 900, 100)]));
    const rightMove = touchEvent("touchmove", [touch(1, 840, 108)]);
    document.dispatchEvent(rightMove);
    expect(rightMove.defaultPrevented).toBe(true);

    document.body.classList.add("is-right-sidebar-open");
    document.dispatchEvent(touchEvent("touchstart", [touch(2, 900, 100)]));
    const allowedMove = touchEvent("touchmove", [touch(2, 840, 108)]);
    document.dispatchEvent(allowedMove);
    expect(allowedMove.defaultPrevented).toBe(false);
    blocker.destroy();
  });

  it("blocks pointer-routed edge swipes before later same-target listeners", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(true);
    let laterListenerRan = false;
    const laterListener = (): void => {
      laterListenerRan = true;
    };
    document.addEventListener("pointermove", laterListener);

    document.dispatchEvent(pointerEvent("pointerdown", 1, 2, 100));
    const move = pointerEvent("pointermove", 1, 60, 108);
    document.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
    expect(laterListenerRan).toBe(false);
    document.removeEventListener("pointermove", laterListener);
    blocker.destroy();
  });

  it("blocks the opt-in top-edge command-palette swipe without blocking page scrolling", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(false, true);

    document.dispatchEvent(touchEvent("touchstart", [touch(1, 100, 20)]));
    const commandPaletteMove = touchEvent("touchmove", [touch(1, 104, 70)]);
    document.dispatchEvent(commandPaletteMove);
    expect(commandPaletteMove.defaultPrevented).toBe(true);

    document.dispatchEvent(touchEvent("touchstart", [touch(2, 100, 100)]));
    const pageScroll = touchEvent("touchmove", [touch(2, 104, 180)]);
    document.dispatchEvent(pageScroll);
    expect(pageScroll.defaultPrevented).toBe(false);
    blocker.destroy();
  });

  it("leaves vertical scrolling, pinch, and Pencil companion touches native", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(true);

    document.dispatchEvent(touchEvent("touchstart", [touch(1, 10, 10)]));
    const verticalMove = touchEvent("touchmove", [touch(1, 20, 80)]);
    document.dispatchEvent(verticalMove);
    expect(verticalMove.defaultPrevented).toBe(false);

    document.dispatchEvent(touchEvent("touchstart", [touch(2, 10, 10)]));
    const pinchMove = touchEvent("touchmove", [touch(2, 60, 15), touch(3, 100, 15)]);
    document.dispatchEvent(pinchMove);
    expect(pinchMove.defaultPrevented).toBe(false);

    document.dispatchEvent(penEvent("pointerdown", 7));
    document.dispatchEvent(touchEvent("touchstart", [touch(4, 10, 10)]));
    const pencilMove = touchEvent("touchmove", [touch(4, 70, 12)]);
    document.dispatchEvent(pencilMove);
    expect(pencilMove.defaultPrevented).toBe(false);
    document.dispatchEvent(penEvent("pointerup", 7));
    blocker.destroy();
  });

  it("takes effect immediately and does not duplicate listeners when toggled", () => {
    const blocker = new MobileSidebarSwipeBlocker(document);
    blocker.setEnabled(true);
    blocker.setEnabled(true);
    document.dispatchEvent(touchEvent("touchstart", [touch(1, 10, 10)]));
    const first = touchEvent("touchmove", [touch(1, 70, 12)]);
    document.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);

    blocker.setEnabled(false);
    document.dispatchEvent(touchEvent("touchstart", [touch(2, 10, 10)]));
    const disabled = touchEvent("touchmove", [touch(2, 70, 12)]);
    document.dispatchEvent(disabled);
    expect(disabled.defaultPrevented).toBe(false);
    blocker.destroy();
  });
});
