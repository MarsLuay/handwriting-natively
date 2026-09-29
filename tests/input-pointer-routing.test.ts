import { describe, expect, it, vi } from "vitest";
import { isStylusEraserInput, PointerRouter, safeReleasePointerCapture } from "../src/input/PointerRouter";
import { PalmRejectionPolicy } from "../src/input/PalmRejectionPolicy";
import type { ToolId } from "../src/model";

function pointer(type: string, pointerId: number, extra: Record<string, unknown> = {}): PointerEvent {
  const eventType = (extra.eventType ?? extra.type ?? "pointerdown") as string;
  const event = new Event(eventType, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: type }, pointerId: { value: pointerId }, button: { value: extra.button ?? 0 },
    buttons: { value: extra.buttons ?? 1 }, pressure: { value: extra.pressure ?? 0.5 },
    isPrimary: { value: extra.isPrimary ?? true },
    tiltX: { value: extra.tiltX ?? 0 }, tiltY: { value: extra.tiltY ?? 0 },
    width: { value: extra.width ?? 1 }, height: { value: extra.height ?? 1 },
    clientX: { value: extra.clientX ?? 10 }, clientY: { value: extra.clientY ?? 20 },
    timeStamp: { configurable: true, value: extra.timeStamp ?? event.timeStamp },
    getCoalescedEvents: { value: extra.getCoalescedEvents ?? (() => []) }
  });
  return event;
}

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("PointerRouter", () => {
  it("exposes listener health for diagnostics without changing routing state", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true
    });

    expect(router.boundElement()).toBe(element);
    expect(router.isListenerAborted()).toBe(false);
    router.destroy();
    expect(router.isListenerAborted()).toBe(true);
    element.remove();
  });

  it("does not feed Pencil hover moves into capture-loss recovery", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const moves = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onMove: moves
    });

    element.dispatchEvent(pointer("pen", 91, { pressure: 0.7 }));
    const hover = pointer("pen", 91, { eventType: "pointermove", buttons: 0, pressure: 0 });
    expect(router.acceptDocumentPenStroke(hover)).toBe(false);
    expect(moves).not.toHaveBeenCalled();

    const contact = pointer("pen", 91, { eventType: "pointermove", buttons: 1, pressure: 0.6 });
    expect(router.acceptDocumentPenStroke(contact)).toBe(true);
    expect(moves).toHaveBeenCalledTimes(1);

    router.destroy();
    element.remove();
  });

  it("keeps native touch and pinch available before a stylus tip goes down", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true
    });
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "armed",
      manipulationTouchAction: "pan-xy",
      touchPanXyClassPresent: true,
      touchNoneClassPresent: false
    });
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
    let mouseAnnotate = false;
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      // Pencil-first: pen always may annotate; mouse follows explicit policy flag.
      canAnnotatePointer: (event) => event.pointerType === "pen" || mouseAnnotate,
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
    expect(pen.defaultPrevented).toBe(true);
    expect(routes.at(-1)).toBe("draw");
    expect(captures).toEqual([3]);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.8, tiltX: 12, pointerType: "pen" });
    element.dispatchEvent(pointer("pen", 3, { type: "pointerup" }));
    starts.mockClear();
    captures.length = 0;

    mouseAnnotate = true;
    const sidecarPencil = pointer("mouse", 4, { pressure: 0.8, tiltX: 12 });
    element.dispatchEvent(sidecarPencil);
    expect(sidecarPencil.defaultPrevented).toBe(true);
    expect(captures).toEqual([4]);
    // Pen was already seen above + digitizer pressure → remap.
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.8, tiltX: 12, pointerType: "pen" });

    const stylus = pointer("pen", 5, { pressure: 0.7 });
    element.dispatchEvent(stylus);
    expect(stylus.defaultPrevented).toBe(true);
    expect(captures).toEqual([4, 5]);

    // Plain mouse tip (pressure 0.5) after pen stays mouse.
    starts.mockClear();
    const plainMouse = pointer("mouse", 6, { pressure: 0.5, tiltX: 0 });
    element.dispatchEvent(plainMouse);
    expect(plainMouse.defaultPrevented).toBe(true);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.5, pointerType: "mouse" });
    router.destroy();
  });

  it("classifies a second finger as zoom/pan without intercepting it", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, { activeTool: () => "pen", canAnnotatePointer: () => false, onRoute: (route) => routes.push(route) });
    const first = pointer("touch", 10);
    const second = pointer("touch", 11, { isPrimary: false });
    element.dispatchEvent(first);
    element.dispatchEvent(second);
    expect(routes).toEqual(["touch-pan", "touch-zoom-pan"]);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    router.destroy();
  });

  it("keeps one finger native when annotation policy is available", () => {
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
      canAnnotatePointer: () => true,
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
      canAnnotatePointer: () => true,
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
    expect(router.gesturePolicy().manipulationState).toBe("armed");

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
      canAnnotatePointer: () => true,
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

  it("keeps single-finger touch native without Draw-mode axis lock", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      scrollRoot: () => element,
      onTouchLifecycle: lifecycle
    });
    const finger = pointer("touch", 50, { clientX: 10, clientY: 10 });
    element.dispatchEvent(finger);
    element.dispatchEvent(pointer("touch", 50, { eventType: "pointermove", clientX: 10, clientY: 40 }));
    expect(lifecycle).not.toHaveBeenCalledWith("axis-lock", expect.any(Event), expect.anything());
    expect(finger.defaultPrevented).toBe(false);
    router.destroy();
    element.remove();
  });


  it("does not repeat document terminal diagnostics for an untracked page router", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onTouchLifecycle: lifecycle
    });

    const touchEnd = new Event("touchend", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchEnd, "touches", { value: [] });
    Object.defineProperty(touchEnd, "changedTouches", { value: [{ identifier: 80 }] });
    document.dispatchEvent(touchEnd);

    expect(lifecycle).not.toHaveBeenCalled();
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
      canAnnotatePointer: () => true,
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
      canAnnotatePointer: () => true,
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

  it("keeps pen lock across lostpointercapture until pointerup", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true
    });
    element.dispatchEvent(pointer("pen", 71, { pressure: 0.7 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    element.dispatchEvent(pointer("pen", 71, { eventType: "lostpointercapture", pressure: 0, buttons: 0, clientX: 0, clientY: 0 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    element.dispatchEvent(pointer("pen", 71, { eventType: "pointerup", pressure: 0, buttons: 0, clientX: 40, clientY: 50 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    router.destroy();
    element.remove();
  });

  it("keeps a pen stroke open after lostpointercapture and appends document moves once", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn()
    });
    const moves = vi.fn();
    const ends = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onMove: moves,
      onEnd: ends
    });
    element.dispatchEvent(pointer("pen", 12, { clientX: 10, clientY: 20, pressure: 0.5 }));
    element.dispatchEvent(pointer("pen", 12, { eventType: "lostpointercapture", clientX: 0, clientY: 0, pressure: 0, buttons: 0 }));
    expect(ends).not.toHaveBeenCalled();
    const first = pointer("pen", 12, { eventType: "pointermove", clientX: 30, clientY: 70, pressure: 0.4 });
    const second = pointer("pen", 12, { eventType: "pointermove", clientX: 60, clientY: 80, pressure: 0.4 });
    Object.defineProperty(first, "timeStamp", { value: 1 });
    Object.defineProperty(second, "timeStamp", { value: 2 });
    const curve = pointer("pen", 12, {
      eventType: "pointermove",
      clientX: 80,
      clientY: 30,
      pressure: 0.4,
      getCoalescedEvents: () => [first, second]
    });
    expect(router.acceptDocumentPenStroke(curve)).toBe(true);
    expect(router.acceptDocumentPenStroke(curve)).toBe(true);
    expect(moves).toHaveBeenCalledTimes(1);
    const samples = moves.mock.calls[0]?.[0] as Array<{ clientX: number }>;
    expect(samples.map((sample) => sample.clientX)).toEqual([30, 60, 80]);
    element.dispatchEvent(pointer("pen", 12, { eventType: "pointerup", clientX: 90, clientY: 40, pressure: 0, buttons: 0 }));
    expect(ends).toHaveBeenCalledTimes(1);
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
      canAnnotatePointer: () => true
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

  it("routes mouse and stylus to Draw when annotation is allowed", () => {
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
      canAnnotatePointer: () => true,
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
      canAnnotatePointer: () => true,
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
    let annotateEnabled = false;
    const routes: string[] = [];
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => annotateEnabled,
      onRoute: (route) => routes.push(route),
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("touch", 40));
    expect(routes.at(-1)).toBe("touch-pan");
    document.dispatchEvent(pointer("touch", 40, { eventType: "pointerup" }));
    annotateEnabled = true;
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
      canAnnotatePointer: () => true,
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
      canAnnotatePointer: () => true,
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

  it("routes only enabled mouse drag bindings and leaves disabled buttons native", () => {
    const element = document.createElement("div");
    const starts = vi.fn();
    let leftEnabled = false;
    let rightEnabled = false;
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      mouseAnnotationEnabled: (button = 0) => button === 2 ? rightEnabled : leftEnabled,
      rightMouseEraserEnabled: () => rightEnabled,
      onStart: starts
    });

    const leftNative = pointer("mouse", 40);
    element.dispatchEvent(leftNative);
    expect(leftNative.defaultPrevented).toBe(false);
    expect(starts).not.toHaveBeenCalled();

    const rightNative = pointer("mouse", 41, { button: 2, buttons: 2 });
    element.dispatchEvent(rightNative);
    expect(rightNative.defaultPrevented).toBe(false);
    expect(starts).not.toHaveBeenCalled();

    leftEnabled = true;
    const leftDraw = pointer("mouse", 42);
    element.dispatchEvent(leftDraw);
    expect(leftDraw.defaultPrevented).toBe(true);
    expect(starts.mock.calls.at(-1)?.[1]).toBe("draw");

    rightEnabled = true;
    const rightErase = pointer("mouse", 43, { button: 2, buttons: 2 });
    element.dispatchEvent(rightErase);
    expect(rightErase.defaultPrevented).toBe(true);
    expect(starts.mock.calls.at(-1)?.[1]).toBe("edit");

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
      canAnnotatePointer: () => true,
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
    expect(isStylusEraserInput({ pointerType: "mouse", button: 5, buttons: 32 })).toBe(true);
  });

  it("recovers a MockTab mouse-tip stroke and eraser when pointerdown is missing", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const captures: number[] = [];
    Object.assign(element, {
      setPointerCapture: (id: number) => captures.push(id),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const starts = vi.fn();
    const received = vi.fn();
    const routeDecisions = vi.fn();
    const claims = vi.fn();
    const eraserStart = vi.fn();
    const eraserEnd = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onStart: starts,
      onRouterReceived: received,
      onRouteDecision: routeDecisions,
      onPointerClaim: claims,
      onStylusEraserStart: eraserStart,
      onStylusEraserEnd: eraserEnd
    });

    // Establish MockTab pen presence from hover; the next tip starts on move.
    element.dispatchEvent(pointer("pen", 70, {
      eventType: "pointermove", button: -1, buttons: 0, pressure: 0
    }));
    const tipMove = pointer("mouse", 71, {
      eventType: "pointermove", button: -1, buttons: 1, pressure: 0.4
    });
    element.dispatchEvent(tipMove);
    expect(tipMove.defaultPrevented).toBe(true);
    expect(captures).toContain(71);
    expect(received).toHaveBeenCalledWith(tipMove, router.generation);
    expect(routeDecisions).toHaveBeenCalledWith("draw", "recovered-pointerdown", tipMove);
    expect(claims).toHaveBeenCalledWith("draw", tipMove, expect.objectContaining({
      preventDefaultCalled: true,
      propagationStopped: true,
      captureAttempted: true,
      captureSucceeded: false
    }));
    expect(starts.mock.calls[0]?.[1]).toBe("draw");
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pointerType: "pen", pressure: 0.4 });

    element.dispatchEvent(pointer("mouse", 71, {
      eventType: "pointerup", button: -1, buttons: 0, pressure: 0
    }));
    const eraserMove = pointer("mouse", 72, {
      eventType: "pointermove", button: -1, buttons: 32, pressure: 0
    });
    element.dispatchEvent(eraserMove);
    expect(eraserMove.defaultPrevented).toBe(true);
    expect(starts.mock.calls[1]?.[1]).toBe("edit");
    expect(eraserStart).toHaveBeenCalledOnce();
    element.dispatchEvent(pointer("mouse", 72, {
      eventType: "pointerup", button: -1, buttons: 0, pressure: 0
    }));
    expect(eraserEnd).toHaveBeenCalledOnce();
    router.destroy();
    element.remove();
  });

  it("keeps coalesced Pencil samples so a pointermove is not just the last point", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onMove = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "pencil", canAnnotatePointer: () => true, onMove });
    element.dispatchEvent(pointer("pen", 4));
    const a = pointer("pen", 4, { pressure: 0.2, timeStamp: 1 });
    const b = pointer("pen", 4, { pressure: 0.9, timeStamp: 2 });
    const move = pointer("pen", 4, {
      eventType: "pointermove",
      pressure: 0.9,
      timeStamp: 3,
      getCoalescedEvents: () => [a, b]
    });
    element.dispatchEvent(move);
    // The dispatched event is retained after the coalesced batch when its
    // timestamp differs from the batch tail, so the latest tip sample is not
    // lost on browsers that report a separate terminal event.
    expect(onMove.mock.calls[0]?.[0].map((sample: { pressure: number }) => sample.pressure)).toEqual([0.2, 0.9, 0.9]);
    router.destroy();
  });

  it("skips near-zero Pencil hover samples on move but keeps tip-up", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
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
    const router = new PointerRouter(element, { activeTool: () => "eraser", canAnnotatePointer: () => true, onEnd, onCancel });
    element.dispatchEvent(pointer("pen", 5));
    element.dispatchEvent(pointer("pen", 5, { eventType: "pointercancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    router.destroy();
  });

  it("clears plugin ownership when the page blurs or becomes hidden", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const releasePointerCapture = vi.fn();
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture
    });
    const onCancel = vi.fn();
    const lifecycle = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onCancel,
      onTouchLifecycle: lifecycle
    });

    element.dispatchEvent(pointer("pen", 66));
    window.dispatchEvent(new Event("blur"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(router.activePenIds()).toEqual([]);
    expect(router.activeRoutedPointerIds()).toEqual([]);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    expect(releasePointerCapture).toHaveBeenCalledWith(66);
    expect(lifecycle).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Event),
      expect.objectContaining({ reason: "lifecycle-blur", trackedBefore: 0, trackedAfter: 0 })
    );

    // A later finger starts a fresh native gesture; it is not mistaken for the
    // canceled pen or a second touch in the old gesture.
    const finger = pointer("touch", 67);
    element.dispatchEvent(finger);
    expect(finger.defaultPrevented).toBe(false);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    element.dispatchEvent(pointer("pen", 68));
    const hidden = new Event("visibilitychange");
    document.dispatchEvent(hidden);
    visibility.mockRestore();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(router.activePenIds()).toEqual([]);
    expect(router.activeRoutedPointerIds()).toEqual([]);
    expect(lifecycle).toHaveBeenCalledWith(
      "pointercancel",
      hidden,
      expect.objectContaining({ reason: "lifecycle-visibilitychange", trackedBefore: 1, trackedAfter: 0 })
    );

    element.dispatchEvent(pointer("pen", 69));
    window.dispatchEvent(new Event("pagehide"));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(router.activePenIds()).toEqual([]);
    expect(router.activeRoutedPointerIds()).toEqual([]);

    router.destroy();
    element.remove();
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
      canAnnotatePointer: () => true,
      mouseAnnotationEnabled: () => true,
      eraserCursorDiameter: () => 36
    });

    const hover = pointer("pen", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0, pressure: 0 });
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

    element.dispatchEvent(pointer("touch", 9, { eventType: "pointermove", pressure: 0 }));
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
      canAnnotatePointer: () => true,
      mouseAnnotationEnabled: () => true,
      drawCursorColor: () => "#ff0000"
    });

    const hover = pointer("pen", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0, pressure: 0 });
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

    element.dispatchEvent(pointer("pen", 8, { eventType: "pointerup", clientX: 130, clientY: 90, buttons: 0, pressure: 0 }));
    expect(cursor?.hidden).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-has-draw-cursor")).toBe(false);

    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0, pressure: 0 }));
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
      canAnnotatePointer: () => true,
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
      canAnnotatePointer: () => true,
      mouseAnnotationEnabled: () => true,
      eraserCursorDiameter: () => diameter
    });

    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0, pressure: 0 }));
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
      canAnnotatePointer: () => true,
      mouseAnnotationEnabled: () => true,
      projectCursor
    });

    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 100, clientY: 200, buttons: 0, pressure: 0 }));
    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 110, clientY: 210, buttons: 0, pressure: 0 }));
    element.dispatchEvent(pointer("pen", 8, { eventType: "pointermove", clientX: 120, clientY: 220, buttons: 0, pressure: 0 }));
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
      canAnnotatePointer: () => true,
      onStart
    });
    done.dispatchEvent(pointer("mouse", 6));
    expect(onStart).not.toHaveBeenCalled();
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
      canAnnotatePointer: () => false,
      scrollRoot: () => document.createElement("div"),
      onRoute: (route) => routes.push(route)
    });
    span.dispatchEvent(pointer("mouse", 13));
    expect(routes.at(-1)).toBe("native");
    router.destroy();
  });

  it("does not scroll when mouse drag scroll is disabled", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => false,
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
      canAnnotatePointer: () => true,
      onRouterReceived: (_event, generation) => received.push(generation),
      onPointerHandled: (pointerId) => handled.push(pointerId),
      onRoute: (route) => routes.push(route)
    });
    const gen1 = first.generation;
    first.destroy();
    const second = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
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

  it("does not let a torn-down router suppress a reused pointer id", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const handled = new Map<number, number>();
    const starts = vi.fn();
    const createRouter = (): PointerRouter => new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      isPointerHandled: (pointerId) => handled.has(pointerId),
      onPointerHandled: (pointerId, generation) => handled.set(pointerId, generation),
      onPointerOwnerReleased: (generation) => {
        for (const [pointerId, ownerGeneration] of handled) {
          if (ownerGeneration === generation) handled.delete(pointerId);
        }
      },
      onStart: starts
    });

    const first = createRouter();
    first.acceptPointerDown(pointer("pen", 301));
    expect(starts).toHaveBeenCalledOnce();
    first.destroy();

    const second = createRouter();
    second.acceptPointerDown(pointer("pen", 301));
    expect(starts).toHaveBeenCalledTimes(2);
    second.destroy();
    element.remove();
  });

  it("reports routed pen ownership before teardown so a replacement router can adopt it", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    let handoff: { routed: Array<{ pointerId: number; route: "draw" | "edit" | "text" }>; activePenIds: number[] } | undefined;
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onPointerOwnerReleased: (_generation, state) => { handoff = state; }
    });

    router.acceptPointerDown(pointer("pen", 302));
    expect(router.activeRoutedPointerIds()).toEqual([302]);
    router.destroy();

    expect(handoff).toEqual({ routed: [{ pointerId: 302, route: "draw" }], activePenIds: [302] });
    expect(router.activeRoutedPointerIds()).toEqual([]);
    element.remove();
  });

  it("reports route reason and claim evidence without changing the draw route", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const routeDecisions: Array<{ route: string; reason: string }> = [];
    const claims: Array<Record<string, unknown>> = [];
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn().mockReturnValue(true),
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onRouteDecision: (route, reason) => routeDecisions.push({ route, reason }),
      onPointerClaim: (_route, _event, details) => claims.push(details)
    });

    const event = pointer("pen", 303);
    router.acceptPointerDown(event);

    expect(routeDecisions).toEqual([{ route: "draw", reason: "stylus-draw" }]);
    expect(claims[0]).toMatchObject({
      preventDefaultCalled: true,
      propagationStopped: true,
      captureAttempted: true,
      captureSucceeded: true
    });
    expect(event.defaultPrevented).toBe(true);
    router.destroy();
    element.remove();
  });

  it("destroy swallows NotFoundError from releasePointerCapture during zoom settle", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(() => {
        throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
      })
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true
    });
    router.acceptPointerDown(pointer("pen", 42));
    expect(() => router.destroy()).not.toThrow();
    element.remove();
  });

});

describe("safeReleasePointerCapture", () => {
  it("returns true when element has pointer capture and release succeeds", () => {
    const element = document.createElement("div");
    element.hasPointerCapture = vi.fn().mockReturnValue(true);
    element.releasePointerCapture = vi.fn();

    expect(safeReleasePointerCapture(element, 1)).toBe(true);
    expect(element.hasPointerCapture).toHaveBeenCalledWith(1);
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("returns false when element does not have pointer capture", () => {
    const element = document.createElement("div");
    element.hasPointerCapture = vi.fn().mockReturnValue(false);
    element.releasePointerCapture = vi.fn();

    expect(safeReleasePointerCapture(element, 1)).toBe(false);
    expect(element.hasPointerCapture).toHaveBeenCalledWith(1);
    expect(element.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when optional functions are missing", () => {
    const element = {} as Element;
    expect(safeReleasePointerCapture(element, 1)).toBe(false);
  });

  it("returns false and does not throw when releasePointerCapture throws an exception", () => {
    const element = document.createElement("div");
    element.hasPointerCapture = vi.fn().mockReturnValue(true);
    element.releasePointerCapture = vi.fn(() => {
      throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    });

    expect(safeReleasePointerCapture(element, 1)).toBe(false);
    expect(element.hasPointerCapture).toHaveBeenCalledWith(1);
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});

describe("manipulation touch-action integration", () => {
  function mountedRouter(starts = vi.fn()): { element: HTMLElement; router: PointerRouter; starts: ReturnType<typeof vi.fn>; routes: string[] } {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });
    return { element, router, starts, routes };
  }

  it("keeps the first and second fingers native while the machine enters pinch", () => {
    const { element, router, starts, routes } = mountedRouter();
    element.dispatchEvent(pointer("touch", 1, { isPrimary: true }));
    expect(routes.at(-1)).toBe("touch-pan");
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "native-touch",
      manipulationActiveTouches: 1,
      manipulationTouchAction: "pan-xy",
      touchPanXyClassPresent: true
    });
    element.dispatchEvent(pointer("touch", 2, { isPrimary: false }));
    expect(routes.at(-1)).toBe("touch-zoom-pan");
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "pinch",
      manipulationActiveTouches: 2,
      touchNoneClassPresent: false,
      touchPanXyClassPresent: true
    });
    expect(starts).not.toHaveBeenCalled();
    element.dispatchEvent(pointer("touch", 1, { eventType: "pointerup", buttons: 0, pressure: 0 }));
    element.dispatchEvent(pointer("touch", 2, { eventType: "pointerup", buttons: 0, pressure: 0, isPrimary: false }));
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "armed",
      manipulationActiveTouches: 0,
      manipulationTouchAction: "pan-xy",
      touchPanXyClassPresent: true,
      touchNoneClassPresent: false
    });
    router.destroy();
    element.remove();
  });

  it("restores pan-xy on a replacement page before the next contact", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const oldRouter = new PointerRouter(first, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true
    });
    oldRouter.destroy();
    const router = new PointerRouter(second, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen"
    });
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "armed",
      touchPanXyClassPresent: true,
      touchNoneClassPresent: false,
      manipulationTouchAction: "pan-xy"
    });
    router.destroy();
    first.remove();
    second.remove();
  });

  it("returns to pan-xy after pen, pinch, and pinch end before the next pen down", () => {
    const { element, router, starts, routes } = mountedRouter();
    const pen = pointer("pen", 9, { pressure: 0.6 });
    element.dispatchEvent(pen);
    expect(pen.pointerType).toBe("pen");
    expect(routes.at(-1)).toBe("draw");
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(false);
    element.dispatchEvent(pointer("pen", 9, { eventType: "pointerup", pressure: 0, buttons: 0 }));
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);
    element.dispatchEvent(pointer("touch", 1));
    element.dispatchEvent(pointer("touch", 2, { isPrimary: false }));
    element.dispatchEvent(pointer("touch", 1, { eventType: "pointerup", buttons: 0, pressure: 0 }));
    element.dispatchEvent(pointer("touch", 2, { eventType: "pointerup", buttons: 0, pressure: 0, isPrimary: false }));
    expect(router.gesturePolicy()).toMatchObject({
      manipulationState: "armed",
      touchPanXyClassPresent: true,
      touchNoneClassPresent: false
    });
    const nextPen = pointer("pen", 11, { pressure: 0.4 });
    element.dispatchEvent(nextPen);
    expect(nextPen.pointerType).toBe("pen");
    expect(routes.at(-1)).toBe("draw");
    expect(starts).toHaveBeenCalled();
    router.destroy();
    element.remove();
  });
});

describe("Regression Tests", () => {
  it("applies pan-xy from the manipulation machine, not from annotation availability", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: () => false
    });
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    router.syncToolState();
    expect(element.classList.contains("native-pdf-handwriting-touch-pan-xy")).toBe(true);
    expect(element.classList.contains("native-pdf-handwriting-touch-none")).toBe(false);
    router.destroy();
    element.remove();
  });
});
