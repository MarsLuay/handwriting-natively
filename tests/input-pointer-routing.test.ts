import { describe, expect, it, vi } from "vitest";
import { isStylusEraserInput, PointerRouter } from "../src/input/PointerRouter";
import { PalmRejectionPolicy } from "../src/input/PalmRejectionPolicy";
import type { ToolId } from "../src/model";

function pointer(type: string, pointerId: number, extra: Record<string, unknown> = {}): PointerEvent {
  const event = new Event(extra.eventType as string || "pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: type }, pointerId: { value: pointerId }, button: { value: extra.button ?? 0 },
    buttons: { value: extra.buttons ?? 1 }, pressure: { value: extra.pressure ?? 0.5 },
    isPrimary: { value: extra.isPrimary ?? true },
    tiltX: { value: extra.tiltX ?? 0 }, tiltY: { value: extra.tiltY ?? 0 },
    width: { value: extra.width ?? 1 }, height: { value: extra.height ?? 1 },
    clientX: { value: extra.clientX ?? 10 }, clientY: { value: extra.clientY ?? 20 },
    getCoalescedEvents: { value: extra.getCoalescedEvents ?? (() => []) }
  });
  return event;
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("PointerRouter", () => {
  it("uses touch-pan-xy in Draw mode until a stylus tip goes down", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true
    });
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    element.dispatchEvent(pointer("pen", 90, { pressure: 0.5 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(false);
    router.destroy();
    element.remove();
  });

  it("preserves native touch/mouse defaults and captures only routed ink", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const captures: number[] = [];
    Object.assign(element, {
      setPointerCapture: (id: number) => captures.push(id),
      hasPointerCapture: (id: number) => captures.includes(id),
      releasePointerCapture: vi.fn()
    });
    let tool: ToolId = "pen";
    let drawingEnabled = false;
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      drawingEnabled: () => drawingEnabled,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });

    const touch = pointer("touch", 1);
    element.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("touch-pan");

    const mouse = pointer("mouse", 2);
    element.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("native");

    tool = "pen";
    const pen = pointer("pen", 3, { pressure: 0.8, tiltX: 12 });
    element.dispatchEvent(pen);
    expect(pen.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("native");

    drawingEnabled = true;
    const sidecarPencil = pointer("mouse", 4, { pressure: 0.8, tiltX: 12 });
    element.dispatchEvent(sidecarPencil);
    expect(sidecarPencil.defaultPrevented).toBe(true);
    expect(captures).toEqual([4]);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.8, tiltX: 12, pointerType: "mouse" });

    const stylus = pointer("pen", 5, { pressure: 0.7 });
    element.dispatchEvent(stylus);
    expect(stylus.defaultPrevented).toBe(true);
    expect(captures).toEqual([4, 5]);
    router.destroy();
  });

  it("classifies a second finger as zoom/pan without intercepting it", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, { activeTool: () => "pen", drawingEnabled: () => false, onRoute: (route) => routes.push(route) });
    const first = pointer("touch", 10);
    const second = pointer("touch", 11, { isPrimary: false });
    element.dispatchEvent(first);
    element.dispatchEvent(second);
    expect(routes).toEqual(["touch-pan", "touch-zoom-pan"]);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    router.destroy();
  });

  it("leaves one finger to native scroll even when Draw mode is on", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });
    const finger = pointer("touch", 21);
    element.dispatchEvent(finger);
    expect(routes.at(-1)).toBe("touch-pan");
    expect(finger.defaultPrevented).toBe(false);
    expect(starts).not.toHaveBeenCalled();
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);

    element.dispatchEvent(pointer("touch", 21, { type: "pointerup" }));
    router.destroy();
    element.remove();
  });

  it("blocks companion touch scroll while a stylus stroke is active", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onRoute: (route) => routes.push(route),
      onTouchLifecycle: lifecycle
    });

    const stylus = pointer("pen", 50, { pressure: 0.7 });
    element.dispatchEvent(stylus);
    expect(routes.at(-1)).toBe("draw");
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(false);

    const palm = pointer("touch", 51, { width: 64, height: 64, pressure: 0.6 });
    element.dispatchEvent(palm);
    expect(routes.at(-1)).toBe("ignored");
    expect(palm.defaultPrevented).toBe(true);
    expect(lifecycle).toHaveBeenCalledWith(
      "scroll-block",
      palm,
      expect.objectContaining({ reason: "ignored-pointer", activePens: true })
    );

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchStart, "touches", {
      value: [{ identifier: 50, clientX: 10, clientY: 20 }]
    });
    Object.defineProperty(touchStart, "changedTouches", {
      value: [{ identifier: 50, clientX: 10, clientY: 20 }]
    });
    element.dispatchEvent(touchStart);
    expect(touchStart.defaultPrevented).toBe(true);
    expect(lifecycle).toHaveBeenCalledWith(
      "scroll-block",
      touchStart,
      expect.objectContaining({ reason: "touch-while-pen", activePens: true })
    );

    element.dispatchEvent(pointer("pen", 50, { eventType: "pointerup", pressure: 0 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);

    const fingerScroll = new Event("touchstart", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(fingerScroll, "touches", { value: [{ identifier: 99 }] });
    Object.defineProperty(fingerScroll, "changedTouches", { value: [{ identifier: 99 }] });
    element.dispatchEvent(fingerScroll);
    expect(fingerScroll.defaultPrevented).toBe(false);

    router.destroy();
    element.remove();
  });

  it("clears stale pen lock via document pointerup when page capture never ends the tip", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const ends = vi.fn();
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onEnd: ends,
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("pen", 61, { pressure: 0.7 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);

    // Simulate WebKit omitting the page listener: only document sees the terminal event.
    document.dispatchEvent(pointer("pen", 61, { eventType: "pointerup", pressure: 0, buttons: 0 }));
    expect(ends).toHaveBeenCalledTimes(1);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    expect(lifecycle).toHaveBeenCalledWith(
      "pen-state",
      expect.anything(),
      expect.objectContaining({ reason: "pointerup", activePens: false })
    );

    const fingerScroll = new Event("touchstart", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(fingerScroll, "touches", { value: [{ identifier: 100 }] });
    Object.defineProperty(fingerScroll, "changedTouches", { value: [{ identifier: 100 }] });
    element.dispatchEvent(fingerScroll);
    expect(fingerScroll.defaultPrevented).toBe(false);

    router.destroy();
    element.remove();
  });

  it("locks Draw-mode single-finger vertical pans to the PDF scroll root", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const scrollRoot = document.createElement("div");
    Object.defineProperty(scrollRoot, "scrollTop", { value: 40, writable: true });
    Object.defineProperty(scrollRoot, "scrollHeight", { value: 400 });
    Object.defineProperty(scrollRoot, "clientHeight", { value: 100 });
    const lifecycle = vi.fn();
    const pans = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      scrollRoot: () => scrollRoot,
      onTouchLifecycle: lifecycle,
      onMousePan: pans
    });

    element.dispatchEvent(pointer("touch", 120, { clientX: 10, clientY: 20 }));
    element.dispatchEvent(pointer("touch", 120, {
      eventType: "pointermove",
      clientX: 10,
      clientY: 28,
      buttons: 1
    }));
    expect(lifecycle).toHaveBeenCalledWith(
      "axis-lock",
      expect.any(Event),
      expect.objectContaining({ reason: "lock-vertical", axisLock: "vertical" })
    );
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    expect(pans).toHaveBeenCalledWith(
      "move",
      expect.any(Event),
      expect.objectContaining({ reason: "touch-axis-vertical", deltaY: -8 })
    );

    router.destroy();
    element.remove();
  });

  it("leaves horizontal single-finger Draw pans to native and aborts on second finger", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const scrollRoot = document.createElement("div");
    Object.defineProperty(scrollRoot, "scrollTop", { value: 0, writable: true });
    const lifecycle = vi.fn();
    const pans = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      scrollRoot: () => scrollRoot,
      onTouchLifecycle: lifecycle,
      onMousePan: pans
    });

    element.dispatchEvent(pointer("touch", 121, { clientX: 10, clientY: 20 }));
    const horizontal = pointer("touch", 121, {
      eventType: "pointermove",
      clientX: 22,
      clientY: 21,
      buttons: 1
    });
    element.dispatchEvent(horizontal);
    expect(lifecycle).toHaveBeenCalledWith(
      "axis-lock",
      expect.any(Event),
      expect.objectContaining({ reason: "lock-horizontal", axisLock: "horizontal" })
    );
    expect(horizontal.defaultPrevented).toBe(false);
    expect(pans).not.toHaveBeenCalled();
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);

    element.dispatchEvent(pointer("touch", 122, { isPrimary: false, clientX: 40, clientY: 40 }));
    expect(lifecycle).toHaveBeenCalledWith(
      "axis-lock",
      expect.any(Event),
      expect.objectContaining({ reason: "clear:multi-finger", axisLock: "none" })
    );

    router.destroy();
    element.remove();
  });

  it("clears tracked fingers on document touchend when pointerup was stolen by capture", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onRoute: (route) => routes.push(route),
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("touch", 80));
    expect(routes.at(-1)).toBe("touch-pan");
    element.dispatchEvent(pointer("touch", 81, { isPrimary: false }));
    expect(routes.at(-1)).toBe("touch-zoom-pan");

    const touchEnd = new Event("touchend", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchEnd, "touches", { value: [] });
    Object.defineProperty(touchEnd, "changedTouches", {
      value: [{ identifier: 80 }, { identifier: 81 }]
    });
    document.dispatchEvent(touchEnd);

    expect(lifecycle).toHaveBeenCalledWith(
      "touchend",
      touchEnd,
      expect.objectContaining({
        reason: "touchend-all-clear",
        trackedBefore: 2,
        trackedAfter: 0,
        touchCount: 0,
        stalePenCleared: false
      })
    );

    element.dispatchEvent(pointer("touch", 82));
    expect(routes.at(-1)).toBe("touch-pan");

    router.destroy();
    element.remove();
  });

  it("clears stale pen via document touchend after grace, not within grace", () => {
    let now = 0;
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const palm = new PalmRejectionPolicy({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      stalePenTouchMs: 150,
      penInactivityMs: 10_000
    });
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onTouchLifecycle: lifecycle
    }, palm);

    element.dispatchEvent(pointer("pen", 91, { pressure: 0.7 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);

    now = 4;
    const earlyEnd = new Event("touchend", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(earlyEnd, "touches", { value: [] });
    Object.defineProperty(earlyEnd, "changedTouches", { value: [{ identifier: 500 }] });
    document.dispatchEvent(earlyEnd);
    expect(palm.hasActivePen()).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    expect(lifecycle).toHaveBeenCalledWith(
      "touchend",
      earlyEnd,
      expect.objectContaining({ reason: "touchend-all-clear", stalePenCleared: false, activePens: true })
    );

    now = 200;
    const lateCancel = new Event("touchcancel", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(lateCancel, "touches", { value: [] });
    Object.defineProperty(lateCancel, "changedTouches", { value: [{ identifier: 501 }] });
    document.dispatchEvent(lateCancel);
    expect(palm.hasActivePen()).toBe(false);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    expect(lifecycle).toHaveBeenCalledWith(
      "touchcancel",
      lateCancel,
      expect.objectContaining({
        reason: "touchcancel-all-clear",
        stalePenCleared: true,
        activePens: false
      })
    );
    expect(lifecycle).toHaveBeenCalledWith(
      "pen-state",
      expect.anything(),
      expect.objectContaining({ reason: "touch-after-stale-pen", activePens: false })
    );

    router.destroy();
    element.remove();
  });

  it("clears pen lock on lostpointercapture", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true
    });
    element.dispatchEvent(pointer("pen", 71, { pressure: 0.7 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    element.dispatchEvent(pointer("pen", 71, { eventType: "lostpointercapture", pressure: 0, buttons: 0 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    router.destroy();
    element.remove();
  });

  it("reconciles stale pen before blocking a later finger touchstart", () => {
    let now = 0;
    const policy = new PalmRejectionPolicy({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      stalePenTouchMs: 150,
      penInactivityMs: 10_000
    });
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true
    }, policy);
    element.dispatchEvent(pointer("pen", 81, { pressure: 0.7 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    now = 200;
    const fingerScroll = new Event("touchstart", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(fingerScroll, "touches", { value: [{ identifier: 101 }] });
    Object.defineProperty(fingerScroll, "changedTouches", { value: [{ identifier: 101 }] });
    element.dispatchEvent(fingerScroll);
    expect(fingerScroll.defaultPrevented).toBe(false);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    router.destroy();
    element.remove();
  });

  it("routes mouse and stylus to Draw when Draw mode is on", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });
    const mouse = pointer("mouse", 31);
    const pen = pointer("pen", 32);
    element.dispatchEvent(mouse);
    element.dispatchEvent(pen);
    expect(routes).toEqual(["draw", "draw"]);
    expect(mouse.defaultPrevented).toBe(true);
    expect(pen.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledTimes(2);

    element.dispatchEvent(pointer("mouse", 31, { type: "pointerup" }));
    element.dispatchEvent(pointer("pen", 32, { type: "pointerup" }));
    router.destroy();
    element.remove();
  });

  it("keeps a second finger available for the router's multi-touch path", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });
    const finger = pointer("touch", 21);
    element.dispatchEvent(finger);
    expect(routes.at(-1)).toBe("touch-pan");
    expect(finger.defaultPrevented).toBe(false);
    expect(starts).not.toHaveBeenCalled();
    const second = pointer("touch", 22, { isPrimary: false });
    element.dispatchEvent(second);
    expect(routes.at(-1)).toBe("touch-zoom-pan");
    expect(second.defaultPrevented).toBe(false);
    router.destroy();
    element.remove();
  });

  it("clears a native touch that ends on document before the next drawing touch", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    let drawingEnabled = false;
    const routes: string[] = [];
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => drawingEnabled,
      onRoute: (route) => routes.push(route),
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("touch", 40));
    expect(routes.at(-1)).toBe("touch-pan");
    document.dispatchEvent(pointer("touch", 40, { eventType: "pointerup" }));
    drawingEnabled = true;
    element.dispatchEvent(pointer("touch", 41));

    expect(routes.at(-1)).toBe("touch-pan");
    expect(lifecycle).toHaveBeenCalledWith("pointerup", expect.any(Event), { trackedBefore: 1, trackedAfter: 0 });
    router.destroy();
    element.remove();
  });

  it("does not finish a finger scroll as a draw when pointerup lands outside the page", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const onEnd = vi.fn();
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onEnd,
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("touch", 42));
    document.dispatchEvent(pointer("touch", 42, { eventType: "pointerup" }));

    expect(onEnd).not.toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalledWith("pointerup", expect.any(Event), {
      trackedBefore: 1,
      trackedAfter: 0
    });
    router.destroy();
    element.remove();
  });

  it("routes Text explicitly while preserving right-click eraser as an opt-in", () => {
    const element = document.createElement("div");
    let tool: ToolId = "text";
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      drawingEnabled: () => true,
      rightMouseEraserEnabled: () => true,
      onStart: starts
    });
    const text = pointer("mouse", 30);
    element.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(true);
    expect(starts.mock.calls[0]?.[1]).toBe("text");
    tool = "pen";
    const right = pointer("mouse", 31, { button: 2, buttons: 2 });
    element.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(starts.mock.calls[1]?.[1]).toBe("edit");
    router.destroy();
  });

  it("blocks a stale bubbling router when handling an explicit annotation gesture", () => {
    const element = document.createElement("div");
    const target = document.createElement("span");
    element.append(target);
    document.body.append(element);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const currentStart = vi.fn();
    const staleStart = vi.fn();
    // Mirrors a stale pre-capture router still registered on the PDF page.
    element.addEventListener("pointerdown", staleStart);
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onStart: currentStart
    });

    target.dispatchEvent(pointer("pen", 77));
    expect(currentStart).toHaveBeenCalledOnce();
    expect(staleStart).not.toHaveBeenCalled();
    router.destroy();
  });

  it("identifies physical stylus eraser tips", () => {
    expect(isStylusEraserInput({ pointerType: "pen", button: 5, buttons: 32 })).toBe(true);
    expect(isStylusEraserInput({ pointerType: "pen", button: 0, buttons: 32 })).toBe(true);
    expect(isStylusEraserInput({ pointerType: "mouse", button: 5, buttons: 32 })).toBe(false);
  });

  it("uses one sample per pointermove when coalesced is off", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onMove = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "pencil", drawingEnabled: () => true, onMove });
    element.dispatchEvent(pointer("pen", 4));
    const a = pointer("pen", 4, { pressure: 0.2 });
    const b = pointer("pen", 4, { pressure: 0.9 });
    const move = pointer("pen", 4, { eventType: "pointermove", pressure: 0.9, getCoalescedEvents: () => [a, b] });
    element.dispatchEvent(move);
    // Coalesced intermediates are off by default (xor-fill / positional jitter).
    expect(onMove.mock.calls[0]?.[0].map((sample: { pressure: number }) => sample.pressure)).toEqual([0.9]);
    router.destroy();
  });

  it("skips near-zero Pencil hover samples on move but keeps tip-up", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onMove,
      onEnd
    });
    element.dispatchEvent(pointer("pen", 44, { pressure: 0.5 }));
    element.dispatchEvent(pointer("pen", 44, {
      eventType: "pointermove",
      pressure: 0.005
    }));
    expect(onMove).not.toHaveBeenCalled();

    element.dispatchEvent(pointer("pen", 44, {
      eventType: "pointermove",
      pressure: 0.55
    }));
    expect(onMove.mock.calls[0]?.[0].map((sample: { pressure: number }) => sample.pressure)).toEqual([0.55]);

    element.dispatchEvent(pointer("pen", 44, { eventType: "pointerup", pressure: 0, buttons: 0 }));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0, pointerType: "pen" });
    router.destroy();
  });

  it("cancels routed gestures without committing them", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "eraser", drawingEnabled: () => true, onEnd, onCancel });
    element.dispatchEvent(pointer("pen", 5));
    element.dispatchEvent(pointer("pen", 5, { eventType: "pointercancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    router.destroy();
  });

  it("shows a circular, scale-adjusted eraser cursor without intercepting hover", async () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 650,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    const router = new PointerRouter(element, {
      activeTool: () => "eraser",
      drawingEnabled: () => true,
      eraserCursorDiameter: () => 36
    });

    const hover = pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 });
    element.dispatchEvent(hover);
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-cursor");
    expect(hover.defaultPrevented).toBe(false);
    await nextAnimationFrame();
    expect(cursor).toMatchObject({ hidden: false });
    expect(cursor?.style.width).toBe("36px");
    expect(cursor?.style.height).toBe("36px");
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(element.classList.contains("native-pdf-handwriting-has-eraser-cursor")).toBe(true);

    element.dispatchEvent(pointer("touch", 9, { eventType: "pointermove" }));
    expect(cursor?.hidden).toBe(true);
    router.destroy();
    expect(cursor?.isConnected).toBe(false);
  });

  it("shows a small dot cursor while drawing and clears it when the pointer ends or loses capture", async () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 650,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      drawCursorColor: () => "#ff0000"
    });

    const hover = pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 });
    element.dispatchEvent(hover);
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-draw-cursor");
    expect(hover.defaultPrevented).toBe(false);
    await nextAnimationFrame();
    expect(cursor).toMatchObject({ hidden: false });
    expect(cursor?.style.width).toBe("6px");
    expect(cursor?.style.height).toBe("6px");
    expect(cursor?.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(element.classList.contains("native-pdf-handwriting-has-draw-cursor")).toBe(true);

    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointerup", clientX: 130, clientY: 90, buttons: 0 }));
    expect(cursor?.hidden).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-has-draw-cursor")).toBe(false);

    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 }));
    await nextAnimationFrame();
    expect(cursor?.hidden).toBe(false);
    element.dispatchEvent(pointer("pen", 8, { eventType: "lostpointercapture" }));
    expect(cursor?.hidden).toBe(true);

    element.dispatchEvent(pointer("touch", 9, { eventType: "pointermove" }));
    expect(cursor?.hidden).toBe(true);
    router.destroy();
    expect(cursor?.isConnected).toBe(false);
  });

  it("routes laser pointer freehand as draw when Draw is on", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "laser",
      drawingEnabled: () => true,
      onStart: starts
    });
    const mouse = pointer("mouse", 42);
    element.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledOnce();
    expect(starts.mock.calls[0]?.[1]).toBe("draw");
    router.destroy();
  });

  it("keeps the eraser cursor anchored to the pointer when the page layout shifts", async () => {
    const element = document.createElement("div");
    let left = 100;
    let top = 50;
    element.getBoundingClientRect = () => ({
      x: left, y: top, left, top, right: left + 400, bottom: top + 600,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    let diameter = 36;
    const router = new PointerRouter(element, {
      activeTool: () => "eraser",
      drawingEnabled: () => true,
      eraserCursorDiameter: () => diameter
    });

    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 }));
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-cursor");
    await nextAnimationFrame();
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");

    left = 220;
    top = 140;
    diameter = 48;
    router.refreshCursors();
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(cursor?.style.width).toBe("48px");
    expect(cursor?.style.height).toBe("48px");
    router.destroy();
  });

  it("batches hover cursor projection to one animation frame and keeps the newest position", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const projectCursor = vi.fn((x: number, y: number) => ({ x, y }));
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      projectCursor
    });

    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointermove", clientX: 100, clientY: 200, buttons: 0 }));
    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointermove", clientX: 110, clientY: 210, buttons: 0 }));
    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointermove", clientX: 120, clientY: 220, buttons: 0 }));
    expect(projectCursor).not.toHaveBeenCalled();

    await nextAnimationFrame();
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-draw-cursor");
    expect(projectCursor).toHaveBeenCalledTimes(1);
    expect(cursor?.style.left).toBe("120px");
    expect(cursor?.style.top).toBe("220px");
    router.destroy();
  });

  it("ignores pointer gestures that start on the selection toolbar", () => {
    const element = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-selection-toolbar";
    const done = document.createElement("button");
    toolbar.append(done);
    element.append(toolbar);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onStart = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "lasso",
      drawingEnabled: () => true,
      onStart
    });
    done.dispatchEvent(pointer("mouse", 6));
    expect(onStart).not.toHaveBeenCalled();
    router.destroy();
  });

  it("scrolls vertically on mouse drag when draw mode is off", () => {
    const element = document.createElement("div");
    const scroller = document.createElement("div");
    let scrollTop = 100;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => scroller,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("mouse", 12, { clientX: 40, clientY: 100 }));
    expect(routes.at(-1)).toBe("mouse-pan");
    element.dispatchEvent(pointer("mouse", 12, { eventType: "pointermove", clientX: 40, clientY: 140 }));
    expect(scrollTop).toBe(60);
    router.destroy();
  });

  it("scrolls vertically on stylus drag when draw mode is off", () => {
    const element = document.createElement("div");
    const scroller = document.createElement("div");
    let scrollTop = 100;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => scroller,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("pen", 21, { clientX: 40, clientY: 100 }));
    expect(routes.at(-1)).toBe("mouse-pan");
    element.dispatchEvent(pointer("pen", 21, { eventType: "pointermove", clientX: 40, clientY: 140 }));
    expect(scrollTop).toBe(60);
    router.destroy();
  });

  it("keeps native routing over pdf text so selection still works", () => {
    const element = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "Selectable";
    textLayer.append(span);
    element.append(textLayer);
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => document.createElement("div"),
      onRoute: (route) => routes.push(route)
    });
    span.dispatchEvent(pointer("mouse", 13));
    expect(routes.at(-1)).toBe("native");
    router.destroy();
  });

  it("routes mouse pan through empty text layer padding", () => {
    const element = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    element.append(textLayer);
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => document.createElement("div"),
      onRoute: (route) => routes.push(route)
    });
    textLayer.dispatchEvent(pointer("mouse", 15));
    expect(routes.at(-1)).toBe("mouse-pan");
    router.destroy();
  });

  it("does not scroll when mouse drag scroll is disabled", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => null,
      onRoute: (route) => routes.push(route)
    });
    element.dispatchEvent(pointer("mouse", 14));
    expect(routes.at(-1)).toBe("native");
    expect(router.bindsTo(element)).toBe(true);
    expect(router.bindsTo(document.createElement("div"))).toBe(false);
    router.destroy();
  });

  it("acceptPointerDown uses a fresh listener generation and marks handle path", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const received: number[] = [];
    const handled: number[] = [];
    const routes: string[] = [];
    const first = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onRouterReceived: (_event, generation) => received.push(generation),
      onPointerHandled: (pointerId) => handled.push(pointerId),
      onRoute: (route) => routes.push(route)
    });
    const gen1 = first.generation;
    first.destroy();
    const second = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      onRouterReceived: (_event, generation) => received.push(generation),
      onPointerHandled: (pointerId) => handled.push(pointerId),
      onRoute: (route) => routes.push(route)
    });
    expect(second.generation).toBeGreaterThan(gen1);
    const down = pointer("pen", 99);
    second.acceptPointerDown(down);
    expect(received.at(-1)).toBe(second.generation);
    expect(handled).toContain(99);
    expect(routes.at(-1)).toBe("draw");
    expect(down.defaultPrevented).toBe(true);
    second.destroy();
  });

});
