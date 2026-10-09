import { describe, expect, it } from "vitest";
import { HandwritingViewport } from "../src/integration/HandwritingViewport";
import { ImageViewAdapter } from "../src/integration/ImageViewAdapter";
import { resolvePageCoordinateLayout } from "../src/pdf/PageCoordinateLayout";
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
  it("keeps image ink in natural-image coordinates across native zoom and resize", () => {
    const host = document.createElement("div");
    const image = document.createElement("img");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1200 },
      naturalHeight: { configurable: true, value: 800 }
    });
    let imageRect = rect(210, 140, 1200, 800);
    image.getBoundingClientRect = () => imageRect;
    host.style.overflow = "auto";
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 400 }
    });
    host.append(image);
    document.body.append(host);

    const adapter = ImageViewAdapter.attach(host);
    const page = adapter.pages()[0]!;
    const overlay = adapter.mountOverlay(1);
    adapter.root.getBoundingClientRect = () => imageRect;
    overlay.getBoundingClientRect = () => imageRect;
    const viewport = new HandwritingViewport({
      getContainerRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
      getContentSize: () => ({ width: page.width, height: page.height }),
      initialRenderedScale: 1,
      initialState: { scale: 1 }
    });
    const inkPoint = { x: page.width * 0.42, y: page.height * 0.63 };
    const imageScales = [
      { x: 0.25, y: 0.25 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 4, y: 4 },
      { x: 1.5, y: 1.25 }
    ];

    try {
      for (const scale of imageScales) {
        const width = page.width * scale.x;
        const height = page.height * scale.y;
        const scrollLeft = Math.max(0, width - 600) * 0.2;
        const scrollTop = Math.max(0, height - 400) * 0.3;
        host.scrollLeft = scrollLeft;
        host.scrollTop = scrollTop;
        imageRect = rect(210 - scrollLeft, 140 - scrollTop, width, height);
        const layout = resolvePageCoordinateLayout(adapter.pages()[0]!);
        const coordinates = new PageCoordinateSpace(
          viewport,
          overlay,
          new PageCoordinateMapper({
            width: page.width,
            height: page.height,
            scale: layout.scale,
            scaleX: layout.scaleX,
            scaleY: layout.scaleY,
            origin: page.coordinateOrigin ?? "top-left"
          })
        );
        const clientPoint = coordinates.pageToClient(inkPoint, imageRect);
        const context = `imageScaleX=${scale.x}, imageScaleY=${scale.y}`;

        expect((clientPoint.x - imageRect.left) / imageRect.width, `${context}: horizontal image position`)
          .toBeCloseTo(inkPoint.x / page.width, 6);
        expect((clientPoint.y - imageRect.top) / imageRect.height, `${context}: vertical image position`)
          .toBeCloseTo(inkPoint.y / page.height, 6);
        const restored = coordinates.clientToPage(clientPoint, imageRect);
        expect(restored.x, `${context}: restored image x`).toBeCloseTo(inkPoint.x, 5);
        expect(restored.y, `${context}: restored image y`).toBeCloseTo(inkPoint.y, 5);
      }
    } finally {
      viewport.destroy();
      adapter.destroy();
      host.remove();
    }
  });

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
