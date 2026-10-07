import { describe, expect, it, vi } from "vitest";
import { GestureNavigationController } from "../src/input/GestureNavigationController";
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
    width: { value: 1 },
    height: { value: 1 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    getCoalescedEvents: { value: () => [] },
    getPredictedEvents: { value: () => [] }
  });
  return event;
}

function createNavigationController(scrollRoot: HTMLElement, options: {
  onStart?: (frame: { generation: number; points: readonly unknown[] }) => { accepted: boolean; scale?: number };
  onPreview?: (scale: number, focalPoint: { x: number; y: number }) => void;
  onEnd?: (scale: number, reason: string) => void;
  onCancel?: (reason: string) => void;
  isHandMode?: () => boolean;
} = {}): GestureNavigationController {
  return new GestureNavigationController({
    minScale: 0.1,
    maxScale: 10,
    getScale: () => 1,
    getScrollRoot: () => scrollRoot,
    ...(options.isHandMode ? { isHandMode: options.isHandMode } : {}),
    onStart: (frame) => options.onStart?.(frame) ?? { accepted: true, scale: 1 },
    onPreview: (scale, focalPoint) => options.onPreview?.(scale, focalPoint),
    onEnd: (scale, reason) => options.onEnd?.(scale, reason),
    onCancel: (reason) => options.onCancel?.(reason)
  });
}

function createRouter(element: HTMLElement, options: {
  activeTool?: () => "pen" | "drag";
  customNavigationEnabled?: () => boolean;
  navigationController?: GestureNavigationController;
  scrollRoot?: HTMLElement;
  onRoute?: (route: string) => void;
  onStart?: () => void;
} = {}): PointerRouter {
  return new PointerRouter(element, {
    activeTool: options.activeTool ?? (() => "pen"),
    canAnnotatePointer: (event) => event.pointerType === "pen",
    customNavigationEnabled: options.customNavigationEnabled ?? (() => true),
    pointerInputCapabilities: () => ({ pointerEvents: true, pointerCapture: false, touchEvents: true }),
    ...(options.navigationController ? { navigationController: options.navigationController } : {}),
    ...(options.scrollRoot ? { scrollRoot: () => options.scrollRoot! } : {}),
    ...(options.onRoute ? { onRoute: (route) => options.onRoute?.(route) } : {}),
    ...(options.onStart ? { onStart: () => options.onStart?.() } : {})
  });
}

function createSurface(): { element: HTMLElement; scrollRoot: HTMLElement } {
  const scrollRoot = document.createElement("div");
  const element = document.createElement("div");
  scrollRoot.append(element);
  document.body.append(scrollRoot);
  scrollRoot.scrollLeft = 100;
  scrollRoot.scrollTop = 200;
  return { element, scrollRoot };
}

describe("unified gesture navigation ownership", () => {
  it("handles one-finger PDF scrolling and leaves small movements unclaimed", () => {
    const { element, scrollRoot } = createSurface();
    const controller = createNavigationController(scrollRoot);
    const router = createRouter(element, { navigationController: controller, scrollRoot });

    element.dispatchEvent(pointer("pointerdown", "touch", 1, { clientX: 10, clientY: 10 }));
    const smallMove = pointer("pointermove", "touch", 1, { clientX: 11, clientY: 11 });
    element.dispatchEvent(smallMove);
    expect(smallMove.defaultPrevented).toBe(false);
    expect(scrollRoot.scrollLeft).toBe(100);
    expect(scrollRoot.scrollTop).toBe(200);

    const verticalScroll = pointer("pointermove", "touch", 1, { clientX: 14, clientY: 35 });
    element.dispatchEvent(verticalScroll);
    expect(verticalScroll.defaultPrevented).toBe(true);
    expect(scrollRoot.scrollLeft).toBe(97);
    expect(scrollRoot.scrollTop).toBe(176);
    element.dispatchEvent(pointer("pointerup", "touch", 1, { clientX: 14, clientY: 35 }));

    router.destroy();
    element.remove();
    scrollRoot.remove();
  });

  it("routes two fingers to pinch handling, not the one-finger navigation path", async () => {
    const { element, scrollRoot } = createSurface();
    const starts = vi.fn(() => ({ accepted: true, scale: 1 }));
    const previews = vi.fn();
    const ends = vi.fn();
    const controller = createNavigationController(scrollRoot, { onStart: starts, onPreview: previews, onEnd: ends });
    const routes: string[] = [];
    const router = createRouter(element, {
      navigationController: controller,
      scrollRoot,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("pointerdown", "touch", 1, { clientX: 100, clientY: 100 }));
    const secondDown = pointer("pointerdown", "touch", 2, { isPrimary: false, clientX: 200, clientY: 100 });
    element.dispatchEvent(secondDown);
    expect(routes.slice(-2)).toEqual(["touch-pan", "touch-custom-pinch"]);
    expect(secondDown.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledTimes(1);

    element.dispatchEvent(pointer("pointermove", "touch", 2, { isPrimary: false, clientX: 240, clientY: 100 }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(previews).toHaveBeenCalledWith(expect.closeTo(1.4, 2), expect.any(Object));
    expect(scrollRoot.scrollLeft).toBe(100);
    element.dispatchEvent(pointer("pointerup", "touch", 2, { isPrimary: false, clientX: 240, clientY: 100 }));
    expect(ends).toHaveBeenCalledTimes(1);
    expect(controller.activeTouchIds()).toEqual([1]);
    element.dispatchEvent(pointer("pointerup", "touch", 1, { clientX: 100, clientY: 100 }));
    expect(controller.activeTouchIds()).toEqual([]);

    router.destroy();
    element.remove();
    scrollRoot.remove();
  });

  it("blocks a touch navigation candidate while the stylus is active", () => {
    const { element, scrollRoot } = createSurface();
    const routes: string[] = [];
    const router = createRouter(element, { scrollRoot, onRoute: (route) => routes.push(route) });

    element.dispatchEvent(pointer("pointerdown", "pen", 10, { clientX: 20, clientY: 30 }));
    const companion = pointer("pointerdown", "touch", 11, { isPrimary: false, clientX: 20, clientY: 30 });
    element.dispatchEvent(companion);

    expect(routes).toEqual(["draw", "ignored"]);
    expect(companion.defaultPrevented).toBe(true);
    expect(router.activeTouchPointerIds()).toEqual([]);
    element.dispatchEvent(pointer("pointerup", "pen", 10, { pressure: 0 }));
    router.destroy();
    element.remove();
    scrollRoot.remove();
  });

  it("routes ctrl-wheel zoom through the same navigation controller", () => {
    const { element, scrollRoot } = createSurface();
    const frames: Array<(timestamp: number) => void> = [];
    const starts = vi.fn(() => ({ accepted: true, scale: 1 }));
    const previews = vi.fn();
    const controller = new GestureNavigationController({
      minScale: 0.1,
      maxScale: 10,
      getScale: () => 1,
      getScrollRoot: () => scrollRoot,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onStart: starts,
      onPreview: previews,
      onEnd: () => undefined,
      onCancel: () => undefined
    });

    expect(controller.handleWheel({
      ctrlKey: true,
      metaKey: false,
      deltaY: -50,
      clientX: 40,
      clientY: 60,
      target: element
    })).toBe(true);
    expect(starts).toHaveBeenCalledOnce();
    frames.shift()?.(16);
    expect(previews).toHaveBeenCalledWith(expect.closeTo(Math.exp(0.5), 4), { x: 40, y: 60 });

    controller.destroy();
    element.remove();
    scrollRoot.remove();
  });

  it("uses the same controller for hand-tool movement and removes navigation listeners on destroy", () => {
    const { element, scrollRoot } = createSurface();
    const capture = vi.fn();
    Object.assign(element, {
      setPointerCapture: capture,
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const router = createRouter(element, {
      activeTool: () => "drag",
      customNavigationEnabled: () => false,
      scrollRoot,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("pointerdown", "mouse", 20, { isPrimary: true, clientX: 50, clientY: 60 }));
    const move = pointer("pointermove", "mouse", 20, { isPrimary: true, clientX: 70, clientY: 90 });
    element.dispatchEvent(move);
    expect(routes).toEqual(["drag"]);
    expect(capture).toHaveBeenCalledWith(20);
    expect(scrollRoot.scrollLeft).toBe(80);
    expect(scrollRoot.scrollTop).toBe(170);
    expect(move.defaultPrevented).toBe(true);

    router.destroy();
    const afterDestroy = pointer("pointerdown", "mouse", 21, { isPrimary: true, clientX: 90, clientY: 90 });
    element.dispatchEvent(afterDestroy);
    expect(routes).toEqual(["drag"]);
    expect(scrollRoot.scrollLeft).toBe(80);
    element.remove();
    scrollRoot.remove();
  });
});
