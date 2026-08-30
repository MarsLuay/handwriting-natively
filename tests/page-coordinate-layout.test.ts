import { describe, expect, it } from "vitest";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { normalizeRotation, resolvePageCoordinateLayout, overlayOffsetInParent } from "../src/pdf/PageCoordinateLayout";

function page(element: HTMLElement, width = 612, height = 792): PdfPageInfo {
  return { pageNumber: 1, width, height, scale: 1, rotation: 0, element };
}

describe("normalizeRotation", () => {
  it("keeps standard 90-degree intervals", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  it("handles values equal to or greater than 360", () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(540)).toBe(180);
    expect(normalizeRotation(630)).toBe(270);
    expect(normalizeRotation(720)).toBe(0);
  });

  it("handles negative values", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(-360)).toBe(0);
    expect(normalizeRotation(-450)).toBe(270);
  });

  it("snaps fractional values by rounding", () => {
    expect(normalizeRotation(89.5)).toBe(90);
    expect(normalizeRotation(90.4)).toBe(90);
    expect(normalizeRotation(269.8)).toBe(270);
    expect(normalizeRotation(-90.3)).toBe(270);
    expect(normalizeRotation(-89.6)).toBe(270);
  });

  it("defaults non-right angles to 0", () => {
    expect(normalizeRotation(45)).toBe(0);
    expect(normalizeRotation(120)).toBe(0);
    expect(normalizeRotation(-60)).toBe(0);
    expect(normalizeRotation(1)).toBe(0);
    expect(normalizeRotation(89.4)).toBe(0);
  });
});

describe("overlayOffsetInParent", () => {
  it("calculates offsets using fractional borders from getComputedStyle", () => {
    const parent = document.createElement("div");
    parent.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120,
      width: 100, height: 100, toJSON: () => ({})
    });

    // Mock defaultView and getComputedStyle
    const mockWindow = {
      getComputedStyle: () => ({ borderLeftWidth: "1.5px", borderTopWidth: "2.5px" }) as CSSStyleDeclaration
    } as Window & typeof globalThis;
    Object.defineProperty(parent.ownerDocument, "defaultView", { value: mockWindow, configurable: true });

    const contentRect = {
      x: 30, y: 50, left: 30, top: 50, right: 80, bottom: 90,
      width: 50, height: 40, toJSON: () => ({})
    } as DOMRect;

    const result = overlayOffsetInParent(parent, contentRect);
    // offsetX: 30 - 10 - 1.5 = 18.5
    // offsetY: 50 - 20 - 2.5 = 27.5
    expect(result.offsetX).toBe(18.5);
    expect(result.offsetY).toBe(27.5);
  });

  it("falls back to clientLeft/clientTop when getComputedStyle does not return finite numeric values", () => {
    const parent = document.createElement("div");
    parent.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120,
      width: 100, height: 100, toJSON: () => ({})
    });

    // Provide non-numeric computed style
    const mockWindow = {
      getComputedStyle: () => ({ borderLeftWidth: "thin", borderTopWidth: "" }) as CSSStyleDeclaration
    } as Window & typeof globalThis;
    Object.defineProperty(parent.ownerDocument, "defaultView", { value: mockWindow, configurable: true });

    // Set clientLeft/clientTop for fallback
    Object.defineProperty(parent, "clientLeft", { value: 2, configurable: true });
    Object.defineProperty(parent, "clientTop", { value: 3, configurable: true });

    const contentRect = {
      x: 30, y: 50, left: 30, top: 50, right: 80, bottom: 90,
      width: 50, height: 40, toJSON: () => ({})
    } as DOMRect;

    const result = overlayOffsetInParent(parent, contentRect);
    // offsetX: 30 - 10 - 2 = 18
    // offsetY: 50 - 20 - 3 = 27
    expect(result.offsetX).toBe(18);
    expect(result.offsetY).toBe(27);
  });

  it("defaults to parent.getBoundingClientRect() if parentRect is not provided", () => {
    const parent = document.createElement("div");
    parent.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120,
      width: 100, height: 100, toJSON: () => ({})
    });

    // Mock defaultView and getComputedStyle
    const mockWindow = {
      getComputedStyle: () => ({ borderLeftWidth: "0px", borderTopWidth: "0px" }) as CSSStyleDeclaration
    } as Window & typeof globalThis;
    Object.defineProperty(parent.ownerDocument, "defaultView", { value: mockWindow, configurable: true });

    const contentRect = {
      x: 30, y: 50, left: 30, top: 50, right: 80, bottom: 90,
      width: 50, height: 40, toJSON: () => ({})
    } as DOMRect;

    // Explicitly call with just two arguments
    const result = overlayOffsetInParent(parent, contentRect);
    // offsetX: 30 - 10 - 0 = 20
    // offsetY: 50 - 20 - 0 = 30
    expect(result.offsetX).toBe(20);
    expect(result.offsetY).toBe(30);
  });

  it("handles missing ownerDocument.defaultView gracefully", () => {
    const parent = document.createElement("div");
    parent.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120,
      width: 100, height: 100, toJSON: () => ({})
    });

    // Force defaultView to be null
    Object.defineProperty(parent.ownerDocument, "defaultView", { value: null, configurable: true });

    // Set clientLeft/clientTop for fallback
    Object.defineProperty(parent, "clientLeft", { value: 4, configurable: true });
    Object.defineProperty(parent, "clientTop", { value: 5, configurable: true });

    const contentRect = {
      x: 30, y: 50, left: 30, top: 50, right: 80, bottom: 90,
      width: 50, height: 40, toJSON: () => ({})
    } as DOMRect;

    const result = overlayOffsetInParent(parent, contentRect);
    // offsetX: 30 - 10 - 4 = 16
    // offsetY: 50 - 20 - 5 = 25
    expect(result.offsetX).toBe(16);
    expect(result.offsetY).toBe(25);
  });
});

describe("page coordinate layout", () => {
  it("uses the smaller axis scale when the PDF is width-fitted", () => {
    const host = document.createElement("div");
    host.className = "page";
    const canvas = document.createElement("canvas");
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 500,
      width: 400, height: 500, toJSON: () => ({})
    });
    canvas.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    host.append(canvas);

    const layout = resolvePageCoordinateLayout(page(host));
    expect(layout.scaleX).toBeCloseTo(250 / 612, 4);
    expect(layout.scaleY).toBeCloseTo(500 / 792, 4);
    expect(layout.scale).toBeCloseTo(layout.scaleX, 4);
    expect(layout.offsetX).toBe(75);
    expect(layout.offsetY).toBe(0);
  });

  it("offsets overlay to the PDF canvas within the page padding box", () => {
    const host = document.createElement("div");
    host.className = "page";
    const wrapper = document.createElement("div");
    wrapper.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 500,
      width: 400, height: 500, toJSON: () => ({})
    });
    wrapper.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    canvas.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    wrapper.append(canvas);
    host.append(wrapper);

    const layout = resolvePageCoordinateLayout(page(host));
    expect(layout.offsetX).toBe(75);
    expect(layout.offsetY).toBe(0);
    expect(layout.contentWidth).toBe(250);
  });

  it("keeps fractional PDF.js page borders out of the overlay origin", () => {
    const host = document.createElement("div");
    host.style.borderLeftWidth = "0.5px";
    host.style.borderTopWidth = "0.5px";
    const canvas = document.createElement("canvas");
    host.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 550,
      width: 400, height: 500, toJSON: () => ({})
    });
    // Browser clientLeft/clientTop round the true 0.5px border to 1px.
    Object.defineProperty(host, "clientLeft", { configurable: true, value: 1 });
    Object.defineProperty(host, "clientTop", { configurable: true, value: 1 });

    // Ensure the defaultView is available since JSDOM might not automatically populate it the way we expect if it isn't attached
    const mockWindow = {
      getComputedStyle: () => ({ borderLeftWidth: "0.5px", borderTopWidth: "0.5px" }) as CSSStyleDeclaration
    } as Window & typeof globalThis;
    Object.defineProperty(host.ownerDocument, "defaultView", { value: mockWindow, configurable: true });

    canvas.getBoundingClientRect = () => ({
      x: 110.5, y: 60.5, left: 110.5, top: 60.5, right: 360.5, bottom: 560.5,
      width: 250, height: 500, toJSON: () => ({})
    });
    host.append(canvas);

    const layout = resolvePageCoordinateLayout(page(host));
    expect(layout.offsetX).toBe(10);
    expect(layout.offsetY).toBe(10);
  });

  it("keeps the reported PDF scale while the viewer briefly reports zero dimensions", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0,
      width: 0, height: 0, toJSON: () => ({})
    });

    const layout = resolvePageCoordinateLayout({ ...page(host), scale: 1.75 });

    expect(layout.contentWidth).toBe(0);
    expect(layout.contentHeight).toBe(0);
    expect(layout.scale).toBe(1.75);
    expect(layout.scaleX).toBe(1.75);
    expect(layout.scaleY).toBe(1.75);
  });
});
