import { describe, expect, it } from "vitest";
import { HandwritingViewport } from "../src/integration/HandwritingViewport";
import { PageCoordinateMapper, PageCoordinateSpace } from "../src/runtime/PageCoordinateMapper";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}

describe("PageCoordinateSpace", () => {
  it("round-trips client through viewport and bottom-left PDF/page coordinates", () => {
    const viewport = new HandwritingViewport({
      getContainerRect: () => ({ left: 50, top: 80, width: 600, height: 800 }),
      getContentSize: () => ({ width: 1200, height: 1600 }),
      initialState: { scale: 2, x: -120, y: -200 }
    });
    const overlay = document.createElement("div");
    const overlayRect = rect(90, 140, 600, 800);
    Object.defineProperty(overlay, "getBoundingClientRect", { value: () => overlayRect });

    const mapper = new PageCoordinateMapper({
      width: 600,
      height: 800,
      scale: 1,
      rotation: 0,
      origin: "bottom-left"
    });
    const coordinates = new PageCoordinateSpace(viewport, overlay, mapper);

    const client = { x: 290, y: 340 };
    expect(coordinates.clientToViewport(client, overlayRect)).toEqual({ x: 100, y: 100 });
    expect(coordinates.clientToPage(client, overlayRect)).toEqual({ x: 100, y: 700 });
    expect(coordinates.clientToPdf(client, overlayRect)).toEqual({ x: 100, y: 700 });
    expect(coordinates.pageToClient({ x: 100, y: 700 }, overlayRect)).toEqual(client);
    expect(coordinates.pdfToClient({ x: 100, y: 700 }, overlayRect)).toEqual(client);
  });

  it("keeps client/page round trips correct through page rotation", () => {
    const viewport = new HandwritingViewport({
      getContainerRect: () => ({ left: 25, top: 40, width: 500, height: 700 }),
      getContentSize: () => ({ width: 1000, height: 1400 }),
      initialState: { scale: 1.5, x: -75, y: -90 }
    });
    const overlay = document.createElement("div");
    const overlayRect = rect(70, 115, 450, 600);
    Object.defineProperty(overlay, "getBoundingClientRect", { value: () => overlayRect });

    const mapper = new PageCoordinateMapper({
      width: 600,
      height: 800,
      scale: 1,
      rotation: 90,
      origin: "bottom-left"
    });
    const coordinates = new PageCoordinateSpace(viewport, overlay, mapper);

    const page = { x: 120, y: 100 };
    const client = coordinates.pageToClient(page, overlayRect);
    expect(coordinates.pageToViewport(page)).toEqual({ x: 100, y: 120 });
    expect(coordinates.clientToPage(client, overlayRect).x).toBeCloseTo(page.x);
    expect(coordinates.clientToPage(client, overlayRect).y).toBeCloseTo(page.y);
  });

  it("uses the same path for anisotropic rendered page scale", () => {
    const viewport = new HandwritingViewport({
      getContainerRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
      getContentSize: () => ({ width: 1200, height: 1600 }),
      initialState: { scale: 2, x: 0, y: 0 }
    });
    const overlay = document.createElement("div");
    const overlayRect = rect(100, 200, 600, 800);
    Object.defineProperty(overlay, "getBoundingClientRect", { value: () => overlayRect });

    const mapper = new PageCoordinateMapper({
      width: 300,
      height: 400,
      scale: 1,
      scaleX: 2,
      scaleY: 1.5,
      rotation: 0,
      origin: "bottom-left"
    });
    const coordinates = new PageCoordinateSpace(viewport, overlay, mapper);

    const page = { x: 50, y: 300 };
    const client = coordinates.pageToClient(page, overlayRect);
    expect(coordinates.pageToViewport(page)).toEqual({ x: 100, y: 150 });
    expect(client).toEqual({ x: 300, y: 500 });
    expect(coordinates.clientToPage(client, overlayRect).x).toBeCloseTo(page.x);
    expect(coordinates.clientToPage(client, overlayRect).y).toBeCloseTo(page.y);
  });
});
