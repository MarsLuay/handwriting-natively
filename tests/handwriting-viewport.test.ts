import { describe, expect, it } from "vitest";
import {
  HandwritingViewport,
  type HandwritingViewportBounds,
  type HandwritingViewportState
} from "../src/integration/HandwritingViewport";
import { PageCoordinateMapper, PageCoordinateSpace } from "../src/runtime/PageCoordinateMapper";

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

    // Document narrower than container remains anchored at the viewport origin.
    const boundsSmall = vp.getBounds(0.4);
    expect(boundsSmall).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it("projects only the temporary zoom ratio above the renderer scale", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1200, height: 1600 }),
      initialRenderedScale: 2,
      initialState: { scale: 2 }
    });

    vp.setTarget(target);
    expect(vp.getBounds()).toEqual({ minX: -600, maxX: 0, minY: -800, maxY: 0 });
    expect(target.style.transform).toBe("");

    vp.setState({ scale: 4 });
    expect(target.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");
    expect(vp.getBounds()).toEqual({ minX: -1800, maxX: 0, minY: -2400, maxY: 0 });

    vp.syncRenderedState(4, 0, 0);
    expect(vp.getState().scale).toBe(4);
    expect(vp.getRenderedScale()).toBe(4);
    expect(target.style.transform).toBe("");

    vp.destroy();
    target.remove();
  });

  it("stops pan at document bounds without rubber banding", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      initialState: { scale: 1, x: -300, y: -300 }
    });

    vp.pan(-200, -200);
    expect(vp.getState()).toEqual({ scale: 1, x: -400, y: -400 });

    vp.pan(500, 500);
    expect(vp.getState()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("hard-clamps pinch zoom and keeps the chosen scale when the pinch ends", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      minScale: 0.5,
      maxScale: 3
    });

    vp.startPinch({ x: 200, y: 200 });
    vp.pinch(4, { x: 200, y: 200 });
    expect(vp.getState().scale).toBe(3);
    const chosen = vp.getState();

    vp.endPinch();
    expect(vp.getState()).toEqual(chosen);

    vp.startPinch({ x: 200, y: 200 });
    vp.pinch(0.1, { x: 200, y: 200 });
    expect(vp.getState().scale).toBe(0.5);
    expect(vp.getState().x).toBe(0);
    expect(vp.getState().y).toBe(0);
    const minimum = vp.getState();

    vp.endPinch();
    expect(vp.getState()).toEqual(minimum);
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

  it("keeps the selected zoom transform after the pinch ends", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const viewport = new HandwritingViewport({
      getContainerRect: () => rect(0, 0, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      initialRenderedScale: 1
    });
    viewport.setTarget(target);
    viewport.startPinch({ x: 200, y: 200 });
    viewport.pinch(2, { x: 200, y: 200 });
    const transformDuringPinch = target.style.transform;

    viewport.endPinch();

    expect(viewport.getState()).toMatchObject({ scale: 2, x: -200, y: -200 });
    expect(viewport.getRenderedScale()).toBe(1);
    expect(target.style.transform).toBe(transformDuringPinch);
    viewport.destroy();
    target.remove();
  });

  it("pins the same document point when the viewer container is offset in client space", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(80, 120, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      minScale: 0.5,
      maxScale: 3.0
    });

    vp.startPinch({ x: 280, y: 320 });
    vp.pinch(2.0, { x: 280, y: 320 });

    expect(vp.getState().x).toBe(-200);
    expect(vp.getState().y).toBe(-200);
    expect(vp.screenToViewport({ x: 280, y: 320 })).toEqual({ x: 200, y: 200 });
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

  it("converts client, viewport, and element-local coordinates through one transform", () => {
    const vp = new HandwritingViewport({
      getContainerRect: () => rect(20, 30, 600, 800),
      getContentSize: () => ({ width: 1000, height: 1200 }),
      initialState: { scale: 2.0, x: -100, y: -50 }
    });

    const screenPoint = { x: 320, y: 480 };
    const docPoint = vp.screenToViewport(screenPoint);
    // x = (320 - 20 - (-100)) / 2 = 200
    // y = (480 - 30 - (-50)) / 2 = 250
    expect(docPoint).toEqual({ x: 200, y: 250 });

    const roundtrip = vp.viewportToScreen(docPoint);
    expect(roundtrip).toEqual(screenPoint);

    const mockPage = document.createElement("div");
    Object.defineProperty(mockPage, "getBoundingClientRect", {
      value: () => ({ left: 20, top: 140, right: 220, bottom: 340, width: 200, height: 200, x: 20, y: 140, toJSON: () => ({}) })
    });

    const pageLocal = vp.screenToPageLocal(mockPage, screenPoint);
    expect(pageLocal).toEqual({ x: 150, y: 170 });
    expect(vp.elementLocalToScreen(mockPage, pageLocal)).toEqual(screenPoint);
  });

  it("maps PDF ink correctly while the renderer scale differs from the visible viewport scale", () => {
    const displayScale = 1109.2 / 960;
    const viewport = new HandwritingViewport({
      getContainerRect: () => rect(302.4, 110.23, 1109.2, 623.92),
      getContentSize: () => ({ width: 4800, height: 2700 }),
      initialRenderedScale: 5,
      initialState: { scale: displayScale }
    });
    const overlay = document.createElement("div");
    const overlayRect = {
      left: 302.4,
      top: 110.23,
      right: 1411.6,
      bottom: 734.15,
      width: 1109.2,
      height: 623.92,
      x: 302.4,
      y: 110.23,
      toJSON: () => ({})
    } as DOMRect;
    const space = new PageCoordinateSpace(
      viewport,
      overlay,
      new PageCoordinateMapper({ width: 960, height: 540, scale: 5 })
    );
    const clientPoint = { x: 841.82, y: 445.63 };

    const pagePoint = space.clientToPage(clientPoint, overlayRect);

    expect(pagePoint.x).toBeCloseTo((clientPoint.x - overlayRect.left) / displayScale, 4);
    expect(pagePoint.y).toBeCloseTo(540 - (clientPoint.y - overlayRect.top) / displayScale, 4);
    const projected = space.pageToClient(pagePoint, overlayRect);
    expect(projected.x).toBeCloseTo(clientPoint.x, 4);
    expect(projected.y).toBeCloseTo(clientPoint.y, 4);
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
