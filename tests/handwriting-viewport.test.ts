import { describe, expect, it, vi } from "vitest";
import {
  HandwritingViewport,
  type HandwritingViewportBounds,
  type HandwritingViewportState
} from "../src/integration/HandwritingViewport";

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

describe("HandwritingViewport", () => {
  it("initializes with default state or provided initial state", () => {
    const vp1 = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 600, height: 800 })
    });
    expect(vp1.getState()).toEqual({ scale: 1, x: 0, y: 0 });

    const vp2 = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 600, height: 800 }),
      initialState: { scale: 1.5, x: -50, y: -100 }
    });
    expect(vp2.getState()).toEqual({ scale: 1.5, x: -50, y: -100 });
  });

  it("calculates correct resting bounds for documents larger and smaller than container", () => {
    // Document larger than container (scaledW = 1000 > 600, scaledH = 1200 > 800)
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 })
    });

    const bounds = vp.getBounds(1);
    expect(bounds).toEqual({
      minX: -400, // 600 - 1000
      maxX: 0,
      minY: -400, // 800 - 1200
      maxY: 0
    });

    // Document narrower than container (scaledW = 400 < 600) -> centered
    const boundsSmall = vp.getBounds(0.4);
    // 1000 * 0.4 = 400. minX = (600 - 400) / 2 = 100.
    // 1200 * 0.4 = 480. minY = (800 - 480) / 2 = 160.
    expect(boundsSmall.minX).toBe(100);
    expect(boundsSmall.maxX).toBe(100);
    expect(boundsSmall.minY).toBe(160);
    expect(boundsSmall.maxY).toBe(160);
  });

  it("applies Apple-style rubber banding when panned outside bounds", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 600, height: 800 })
    });

    // resting bounds: minX = 0, maxX = 0 (doc fits container exactly)
    // Pan right by 100px (outside bounds x > 0)
    vp.pan(100, 0);
    const state = vp.getState();
    // Damped x should be positive but significantly less than 100px
    expect(state.x).toBeGreaterThan(0);
    expect(state.x).toBeLessThan(100);

    // Pan further right by another 100px
    vp.pan(100, 0);
    const state2 = vp.getState();
    expect(state2.x).toBeGreaterThan(state.x);
    expect(state2.x).toBeLessThan(200);
  });

  it("pins document content under focal point during pinch zoom", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      minScale: 0.5,
      maxScale: 3.0
    });

    // Initial state: scale = 1, x = 0, y = 0
    // Touch at focal point (200, 200)
    vp.startPinch({ x: 200, y: 200 });

    // Zoom to 2.0 while keeping focal point stationary at (200, 200)
    vp.pinch(2.0, { x: 200, y: 200 });

    // The content point (200, 200) must still be at screen (200, 200)
    // (x_screen - state.x) / scale = (200 - (-200)) / 2 = 400 / 2 = 200
    const state = vp.getState();
    expect(state.scale).toBe(2.0);
    expect(state.x).toBe(-200);
    expect(state.y).toBe(-200);

    const docPoint = vp.screenToViewport({ x: 200, y: 200 });
    expect(docPoint.x).toBeCloseTo(200);
    expect(docPoint.y).toBeCloseTo(200);
  });

  it("tracks simultaneous two-finger panning during pinch zoom", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 2000, height: 2000 }),
      minScale: 0.5,
      maxScale: 4.0
    });

    // Touch down at (200, 200)
    vp.startPinch({ x: 200, y: 200 });

    // Fingers move to (250, 220) while zooming to 1.5
    vp.pinch(1.5, { x: 250, y: 220 });

    // Check that the original document point (200, 200) is now under the new finger position (250, 220)
    const docPoint = vp.screenToViewport({ x: 250, y: 220 });
    expect(docPoint.x).toBeCloseTo(200);
    expect(docPoint.y).toBeCloseTo(200);
  });

  it("handles pure two-finger pan when scale does not change", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 2000, height: 2000 }),
      minScale: 0.5,
      maxScale: 4.0,
      initialState: { scale: 1, x: -300, y: -300 }
    });

    // Touch at (300, 300)
    vp.startPinch({ x: 300, y: 300 });

    // Fingers pan +50px X and +40px Y with scale remaining 1.0
    vp.pinch(1.0, { x: 350, y: 340 });

    const state = vp.getState();
    expect(state.x).toBeCloseTo(-250);
    expect(state.y).toBeCloseTo(-260);
  });

  it("settles overscroll back to valid bounds with spring animation", () => {
    vi.useFakeTimers();
    let currentTime = 1000;
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 600, height: 800 }),
      now: () => currentTime
    });

    // Pan right past maxX (0) into overscroll
    vp.pan(150, 80);
    expect(vp.getState().x).toBeGreaterThan(0);
    expect(vp.getState().y).toBeGreaterThan(0);

    let settledCalled = false;
    vp.settle(() => {
      settledCalled = true;
    });

    // Mid-spring (100ms)
    currentTime += 100;
    vi.advanceTimersByTime(100);
    const midState = vp.getState();
    expect(midState.x).toBeGreaterThan(0); // Still returning
    expect(midState.x).toBeLessThan(100);

    // End of spring (220ms total)
    currentTime += 120;
    vi.advanceTimersByTime(120);

    const endState = vp.getState();
    expect(endState.x).toBeCloseTo(0);
    expect(endState.y).toBeCloseTo(0);
    expect(settledCalled).toBe(true);
    vi.useRealTimers();
  });

  it("converts screen to viewport, viewport to screen, and screen to page-local coordinates", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      initialState: { scale: 2.0, x: -100, y: -50 }
    });

    const screenPoint = { x: 300, y: 450 };
    const docPoint = vp.screenToViewport(screenPoint);
    // x = (300 - (-100)) / 2 = 200
    // y = (450 - (-50)) / 2 = 250
    expect(docPoint).toEqual({ x: 200, y: 250 });

    const roundtrip = vp.viewportToScreen(docPoint);
    expect(roundtrip).toEqual(screenPoint);

    const mockPage = document.createElement("div");
    Object.defineProperty(mockPage, "offsetLeft", { value: 50 });
    Object.defineProperty(mockPage, "offsetTop", { value: 80 });

    const pageLocal = vp.screenToPageLocal(mockPage, screenPoint);
    // pageLocal x = 200 - 50 = 150
    // pageLocal y = 250 - 80 = 170
    expect(pageLocal).toEqual({ x: 150, y: 170 });
  });

  it("projects in-bounds canonical pan into native scroll without double transform", () => {
    const scroll = document.createElement("div");
    const target = document.createElement("div");
    scroll.append(target);
    document.body.append(scroll);

    let scrollLeft = 100;
    let scrollTop = 200;
    Object.defineProperties(scroll, {
      scrollWidth: { value: 1400, configurable: true },
      clientWidth: { value: 600, configurable: true },
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 800, configurable: true },
      scrollLeft: {
        get: () => scrollLeft,
        set: (value: number) => { scrollLeft = value; },
        configurable: true
      },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
        configurable: true
      }
    });

    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1400, height: 1800 }),
      getScrollElement: () => scroll,
      initialState: { scale: 1, x: -100, y: -200 }
    });

    vp.setTarget(target);
    expect(target.style.transform).toBe("");

    vp.pan(40, 20);

    expect(vp.getState()).toEqual({ scale: 1, x: -60, y: -180 });
    expect(scrollLeft).toBe(60);
    expect(scrollTop).toBe(180);
    expect(target.style.transform).toBe("");

    vp.destroy();
    scroll.remove();
  });

  it("reconciles external native scrolling back into canonical viewport state", () => {
    const scroll = document.createElement("div");
    const target = document.createElement("div");
    scroll.append(target);
    document.body.append(scroll);

    let scrollLeft = 0;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      scrollWidth: { value: 1400, configurable: true },
      clientWidth: { value: 600, configurable: true },
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 800, configurable: true },
      scrollLeft: {
        get: () => scrollLeft,
        set: (value: number) => { scrollLeft = value; },
        configurable: true
      },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
        configurable: true
      }
    });

    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1400, height: 1800 }),
      getScrollElement: () => scroll
    });
    vp.setTarget(target);

    scrollLeft = 125;
    scrollTop = 275;
    expect(vp.syncFromScroll(scrollLeft, scrollTop)).toBe(true);
    expect(vp.getState()).toEqual({ scale: 1, x: -125, y: -275 });
    expect(target.style.transform).toBe("");

    // The scroll values now match the viewport's own latest projection, so a
    // delayed programmatic scroll event must not become a second state update.
    expect(vp.syncFromScroll(scrollLeft, scrollTop)).toBe(false);

    vp.destroy();
    scroll.remove();
  });

  it("updates target DOM element with GPU transform and pinch-active class", () => {
    const target = document.createElement("div");
    document.body.append(target);

    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 })
    });

    vp.setTarget(target);
    expect(target.style.getPropertyValue("transform")).toBe("");

    vp.pan(-40, -60);
    expect(target.style.getPropertyValue("transform")).toBe("translate3d(-40px, -60px, 0) scale(1)");
    expect(target.classList.contains("native-pdf-handwriting-pinch-active")).toBe(true);

    vp.destroy();
    expect(target.style.getPropertyValue("transform")).toBe("");
    expect(target.classList.contains("native-pdf-handwriting-pinch-active")).toBe(false);
    target.remove();
  });
});
