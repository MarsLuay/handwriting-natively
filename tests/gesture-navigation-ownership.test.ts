import { describe, expect, it, vi } from "vitest";
import { GestureNavigationController } from "../src/input/GestureNavigationController";

function pointer(type: string, pointerId: number, clientX: number, clientY: number, button = 0): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "pen" },
    isPrimary: { value: true },
    button: { value: button },
    clientX: { value: clientX },
    clientY: { value: clientY }
  });
  return event;
}

function touchPointer(pointerId: number, clientX: number, clientY: number): PointerEvent {
  const event = new Event("pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY }
  });
  return event;
}

function touch(type: string, activeTouches: readonly unknown[] = []): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", { value: activeTouches });
  return event;
}

describe("stylus hand-pan and companion-touch ownership", () => {
  it("lets native touch pass through except while a stylus is active", () => {
    const surface = document.createElement("div");
    const controller = new GestureNavigationController();
    controller.attachSurface(surface);

    const nativeTouch = touch("touchstart");
    expect(controller.blockCompanionTouch(nativeTouch)).toBe(false);
    expect(nativeTouch.defaultPrevented).toBe(false);

    controller.reconcilePenContacts([7]);
    expect(surface.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    const companion = touch("touchstart");
    expect(controller.blockCompanionTouch(companion)).toBe(true);
    expect(companion.defaultPrevented).toBe(true);

    controller.reconcilePenContacts([]);
    expect(surface.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    const nextTouch = touch("touchstart");
    expect(controller.blockCompanionTouch(nextTouch)).toBe(false);
    expect(nextTouch.defaultPrevented).toBe(false);
    controller.destroy();
  });

  it("ends a custom pinch when the final touch ends without a matching pointerup", () => {
    const surface = document.createElement("div");
    const onPinchEnd = vi.fn();
    const controller = new GestureNavigationController({
      getScale: () => 1,
      onPinchStart: () => ({ accepted: true, scale: 1 }),
      onPinchEnd
    });
    controller.attachSurface(surface, true);

    for (const [pointerId, x] of [[31, 10], [32, 90]] as const) {
      controller.handlePointerDown(touchPointer(pointerId, x, 20), {
        surface,
        route: "touch-pan",
        pointerType: "touch",
        customNavigationEnabled: true
      });
    }
    expect(controller.activePointerIds()).toEqual([31, 32]);

    controller.handleTouchTerminal(touch("touchend"));

    expect(controller.activePointerIds()).toEqual([]);
    expect(controller.isActive()).toBe(false);
    expect(onPinchEnd).toHaveBeenCalledWith(1, "touch-terminal");
    controller.destroy();
  });

  it("keeps stylus Drag as the only custom hand-pan route", () => {
    const surface = document.createElement("div");
    const pan = vi.fn();
    const controller = new GestureNavigationController({ onPan: pan });
    const down = pointer("pointerdown", 19, 20, 30);

    expect(controller.handlePointerDown(down, {
      surface,
      route: "drag",
      pointerType: "pen"
    })).toMatchObject({ handled: true, route: "drag", reason: "stylus-hand-tool" });
    expect(down.defaultPrevented).toBe(true);
    expect(surface.classList.contains("native-pdf-handwriting-panning")).toBe(true);

    const move = pointer("pointermove", 19, 33, 48);
    expect(controller.handlePointerMove(move)).toBe(true);
    expect(pan).toHaveBeenCalledWith(13, 18, 33, 48);
    const end = pointer("pointerup", 19, 33, 48);
    expect(controller.handlePointerEnd(end)).toBe(true);
    expect(controller.isActive()).toBe(false);
    expect(surface.classList.contains("native-pdf-handwriting-panning")).toBe(false);

    const mouse = pointer("pointerdown", 20, 0, 0);
    expect(controller.handlePointerDown(mouse, { surface, route: "drag", pointerType: "mouse" }))
      .toMatchObject({ handled: false });
    expect(mouse.defaultPrevented).toBe(false);
    controller.destroy();
  });
});
