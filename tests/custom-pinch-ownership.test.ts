import { describe, expect, it, vi } from "vitest";
import { GestureOwnership } from "../src/input/GestureOwnership";
import { PointerRouter } from "../src/input/PointerRouter";

function pointer(
  type: string,
  pointerType: "pen" | "touch" | "mouse",
  pointerId: number,
  extra: Record<string, unknown> = {}
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    button: { value: extra.button ?? 0 },
    buttons: { value: extra.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : 1) },
    pressure: { value: extra.pressure ?? (pointerType === "pen" ? 0.5 : 0.5) },
    isPrimary: { value: extra.isPrimary ?? pointerId === 1 },
    clientX: { value: extra.clientX ?? pointerId * 10 },
    clientY: { value: extra.clientY ?? pointerId * 20 },
    width: { value: extra.width ?? 1 },
    height: { value: extra.height ?? 1 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    getCoalescedEvents: { value: () => [] },
    getPredictedEvents: { value: () => [] }
  });
  return event;
}

function customRouter(element: HTMLElement, overrides: Record<string, unknown> = {}): PointerRouter {
  return new PointerRouter(element, {
    activeTool: () => "pen",
    canAnnotatePointer: (event) => event.pointerType === "pen",
    customPinchEnabled: () => true,
    pointerInputCapabilities: () => ({ pointerEvents: true, pointerCapture: false, touchEvents: true }),
    ...overrides
  });
}

function touch(identifier: number, clientX: number, clientY: number, target: EventTarget): Touch {
  return { identifier, clientX, clientY, target } as Touch;
}

function touchEvent(type: "touchstart" | "touchmove" | "touchend", touches: Touch[], changedTouches: Touch[] = touches): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches }
  });
  return event;
}

describe("mobile custom pinch ownership", () => {
  it("promotes one-finger native navigation to custom pinch and cleans up", () => {
    const ownership = new GestureOwnership({ customPinchEnabled: true });
    const first = ownership.pointerDown({ pointerId: 1, pointerType: "touch" });
    const second = ownership.pointerDown({ pointerId: 2, pointerType: "touch" });

    expect(first.state.owner).toBe("native-touch-navigation");
    expect(first.preventDefault).toBe(false);
    expect(second.state.owner).toBe("custom-touch-pinch");
    expect(second.action).toBe("preview");
    expect(second.preventDefault).toBe(true);
    expect(ownership.pointerMove({ pointerId: 1, pointerType: "touch" }).action).toBe("preview");

    const firstLift = ownership.pointerUp({ pointerId: 1, pointerType: "touch" });
    expect(firstLift.action).toBe("preview");
    expect(firstLift.state.owner).toBe("native-touch-navigation");
    ownership.pointerCancel({ pointerId: 2, pointerType: "touch" });
    expect(ownership.snapshot().owner).toBe("idle");
  });

  it("never promotes pen-plus-finger, UI, or text-target contacts", () => {
    const ownership = new GestureOwnership({ customPinchEnabled: true });
    ownership.pointerDown({ pointerId: 10, pointerType: "pen", target: "page", inkToolSelected: true });
    const companion = ownership.pointerDown({ pointerId: 11, pointerType: "touch", target: "page" });
    expect(companion.state.owner).toBe("pen-ink");
    expect(companion.action).toBe("observe");
    expect(ownership.pointerDown({ pointerId: 12, pointerType: "touch", target: "ui" }).action).toBe("ignore");

    const element = document.createElement("div");
    document.body.append(element);
    const routes: string[] = [];
    const textRouter = customRouter(element, {
      touchTextTarget: () => true,
      onRoute: (route: string) => routes.push(route)
    });
    element.dispatchEvent(pointer("pointerdown", "touch", 1));
    element.dispatchEvent(pointer("pointerdown", "touch", 2, { isPrimary: false }));
    expect(routes).toEqual(["text", "touch-zoom-pan"]);
    textRouter.destroy();
    element.remove();
  });

  it("emits a bounded start/frame/end stream without creating an ink stroke", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const starts = vi.fn();
    const frames = vi.fn();
    const ends = vi.fn();
    const routes: string[] = [];
    const router = customRouter(element, {
      onRoute: (route: string) => routes.push(route),
      onStart: vi.fn(),
      onCustomPinchStart: starts,
      onCustomPinchFrame: frames,
      onCustomPinchEnd: ends
    });

    const first = pointer("pointerdown", "touch", 1, { clientX: 10, clientY: 20 });
    const second = pointer("pointerdown", "touch", 2, { isPrimary: false, clientX: 40, clientY: 20 });
    element.dispatchEvent(first);
    element.dispatchEvent(second);
    expect(routes).toEqual(["touch-pan", "touch-custom-pinch"]);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(starts.mock.calls[0]?.[0].points).toHaveLength(2);

    element.dispatchEvent(pointer("pointermove", "touch", 2, { isPrimary: false, clientX: 50, clientY: 20 }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(frames).toHaveBeenCalledTimes(1);
    expect(frames.mock.calls[0]?.[0].points).toHaveLength(2);

    element.dispatchEvent(pointer("pointerup", "touch", 2, { isPrimary: false }));
    expect(ends).toHaveBeenCalledWith("pointerup");
    element.dispatchEvent(pointer("pointerup", "touch", 1));
    expect(router.activeTouchPointerIds()).toEqual([]);
    expect(router.activeRoutedPointerIds()).toEqual([]);
    router.destroy();
    element.remove();
  });

  it("uses the iOS TouchEvent stream when the second PointerEvent is withheld", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const starts = vi.fn();
    const frames = vi.fn();
    const ends = vi.fn();
    const router = customRouter(element, {
      onCustomPinchStart: starts,
      onCustomPinchFrame: frames,
      onCustomPinchEnd: ends
    });

    element.dispatchEvent(pointer("pointerdown", "touch", 1, { clientX: 10, clientY: 20 }));
    element.dispatchEvent(touchEvent("touchstart", [touch(1, 10, 20, element)]));
    const secondTouch = touch(2, 40, 20, element);
    const secondStart = touchEvent("touchstart", [touch(1, 10, 20, element), secondTouch], [secondTouch]);
    element.dispatchEvent(secondStart);
    expect(secondStart.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(starts.mock.calls[0]?.[0].points).toHaveLength(2);

    element.dispatchEvent(touchEvent("touchmove", [touch(1, 10, 20, element), touch(2, 55, 20, element)], [touch(2, 55, 20, element)]));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(frames).toHaveBeenCalledTimes(1);
    expect(frames.mock.calls[0]?.[0].points).toHaveLength(2);

    const firstTouch = touch(1, 10, 20, element);
    element.ownerDocument.dispatchEvent(touchEvent("touchend", [touch(2, 55, 20, element)], [firstTouch]));
    expect(ends).toHaveBeenCalledWith("pointerup");
    router.destroy();
    element.remove();
  });

  it("cancels on blur, generation replacement, and feature disable without leaking ownership", () => {
    const element = document.createElement("div");
    document.body.append(element);
    let enabled = true;
    const ends = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      customPinchEnabled: () => enabled,
      pointerInputCapabilities: () => ({ pointerEvents: true, pointerCapture: false, touchEvents: true }),
      onCustomPinchEnd: ends
    });
    expect(router.gesturePolicy().customPinchGuardClassPresent).toBe(true);
    element.dispatchEvent(pointer("pointerdown", "touch", 1));
    element.dispatchEvent(pointer("pointerdown", "touch", 2, { isPrimary: false }));
    window.dispatchEvent(new Event("blur"));
    expect(ends).toHaveBeenCalledWith("lifecycle");
    expect(router.activeTouchPointerIds()).toEqual([]);

    element.dispatchEvent(pointer("pointerdown", "touch", 3));
    element.dispatchEvent(pointer("pointerdown", "touch", 4, { isPrimary: false }));
    enabled = false;
    router.syncToolState();
    expect(ends).toHaveBeenCalledWith("disabled");
    expect(router.gesturePolicy().customPinchGuardClassPresent).toBe(false);
    expect(router.activeTouchPointerIds()).toEqual([3, 4]);
    router.destroy();
    element.remove();
  });

  it("aborts through the existing router ownership on lifecycle replacement", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const ends = vi.fn();
    const router = customRouter(element, { onCustomPinchEnd: ends });
    element.dispatchEvent(pointer("pointerdown", "touch", 1));
    element.dispatchEvent(pointer("pointerdown", "touch", 2, { isPrimary: false }));
    router.cancelCustomPinch("lifecycle");
    expect(ends).toHaveBeenCalledWith("lifecycle");
    expect(router.activeTouchPointerIds()).toEqual([]);
    expect(router.gesturePolicy().manipulationActiveTouches).toBe(0);
    router.destroy();
    element.remove();
  });

  it("keeps desktop and missing-pointer paths native", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => false,
      customPinchEnabled: () => true,
      pointerInputCapabilities: () => ({ pointerEvents: false, pointerCapture: false, touchEvents: false }),
      onRoute: (route) => routes.push(route)
    });
    element.dispatchEvent(pointer("pointerdown", "touch", 1));
    element.dispatchEvent(pointer("pointerdown", "touch", 2, { isPrimary: false }));
    expect(routes).toEqual([]);
    expect(router.activeTouchPointerIds()).toEqual([]);
    router.destroy();
    element.remove();
  });
});
