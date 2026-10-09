import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { ImageViewAdapter } from "../src/integration/ImageViewAdapter";
import { MarkdownViewAdapter } from "../src/integration/MarkdownViewAdapter";
import { PdfJsViewAdapter } from "../src/integration/PdfJsViewAdapter";
import { DEFAULT_SETTINGS, type InkStroke } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";

class MemoryFiles implements TextFileAdapter {
  readonly values = new Map<string, string>();

  async exists(path: string): Promise<boolean> { return this.values.has(path); }
  async read(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, contents: string): Promise<void> { this.values.set(path, contents); }
  async remove(path: string): Promise<void> { this.values.delete(path); }
}

const canvasContexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
const canvasArcCalls = new WeakMap<HTMLCanvasElement, number[][]>();

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, right: left + width, bottom: top + height,
    width, height, x: left, y: top, toJSON: () => ({})
  };
}

function setRect(element: HTMLElement, getRect: () => DOMRect): void {
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: getRect });
}

function stylePixels(element: HTMLElement, key: "width" | "height", fallback: number): number {
  const value = Number.parseFloat(element.style[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** JSDOM has no layout engine; project the real CSS dimensions into DOMRects. */
function installScrollMetrics(element: HTMLElement, width: () => number, height: () => number, clientWidth: number, clientHeight: number): void {
  let left = 0;
  let top = 0;
  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => clientWidth },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollWidth: { configurable: true, get: () => Math.max(clientWidth, width()) },
    scrollHeight: { configurable: true, get: () => Math.max(clientHeight, height()) },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => { left = Math.max(0, Math.min(Math.max(0, width() - clientWidth), value)); }
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(Math.max(0, height() - clientHeight), value)); }
    }
  });
}

function pointer(type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, pointerId: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: pointerId },
    pressure: { value: type === "pointerup" ? 0 : 0.7 },
    width: { value: 1 },
    height: { value: 1 },
    buttons: { value: type === "pointerup" ? 0 : 1 },
    getCoalescedEvents: { value: () => [] }
  });
  return event as unknown as PointerEvent;
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const noOp = (): void => undefined;
  const arcCalls: number[][] = [];
  canvasArcCalls.set(canvas, arcCalls);
  const context = new Proxy({
    canvas,
    arc: (...args: number[]) => { arcCalls.push(args); },
    measureText: (text: string) => ({ width: text.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient: () => ({ addColorStop: noOp }),
    createRadialGradient: () => ({ addColorStop: noOp }),
    createPattern: () => null
  } as unknown as CanvasRenderingContext2D, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return typeof key === "string" ? noOp : undefined;
    }
  });
  return context;
}

function installCanvasContexts(): void {
  class TestPath2D {
    addPath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    bezierCurveTo(): void {}
    quadraticCurveTo(): void {}
    closePath(): void {}
    rect(): void {}
    arc(): void {}
    ellipse(): void {}
  }
  vi.stubGlobal("Path2D", TestPath2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = canvasContexts.get(this);
    if (!context) {
      context = canvasContext(this);
      canvasContexts.set(this, context);
    }
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function newSettings(): typeof DEFAULT_SETTINGS {
  return structuredClone(DEFAULT_SETTINGS);
}

async function createSession(
  adapter: ImageViewAdapter | MarkdownViewAdapter | PdfJsViewAdapter,
  path: string,
  settings = newSettings()
): Promise<ViewerInkSession> {
  const files = new MemoryFiles();
  return ViewerInkSession.create({
    adapter,
    documentPath: path,
    settings,
    sidecars: new SidecarRepository(files, "annotations"),
    recovery: new RecoveryRepository(files, "annotations/recovery"),
    saveSettings: async () => undefined,
    notice: () => undefined
  });
}

function committedStrokes(session: ViewerInkSession): InkStroke[] {
  return (session as unknown as { ink: { all(): InkStroke[] } }).ink.all();
}

function drawAtPageFraction(
  session: ViewerInkSession,
  pageElement: HTMLElement,
  readPageRect: () => DOMRect,
  fraction: { x: number; y: number },
  pointerId: number
): InkStroke {
  const pageRect = readPageRect();
  const x = pageRect.left + pageRect.width * fraction.x;
  const y = pageRect.top + pageRect.height * fraction.y;
  pageElement.dispatchEvent(pointer("pointerdown", x, y, pointerId));
  pageElement.dispatchEvent(pointer("pointermove", x + 2, y + 2, pointerId));
  pageElement.dispatchEvent(pointer("pointerup", x + 2, y + 2, pointerId));
  const stroke = committedStrokes(session).at(-1);
  if (!stroke) throw new Error("The production viewer session did not commit the pointer stroke");
  return stroke;
}

function markdownHost(mode: "preview" | "source"): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement("div");
  host.className = "workspace-leaf-content";
  const root = document.createElement("div");
  root.style.overflow = "auto";
  if (mode === "preview") {
    root.className = "markdown-preview-view";
    host.append(root);
  } else {
    const source = document.createElement("div");
    source.className = "markdown-source-view is-live-preview";
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    root.className = "cm-scroller";
    const content = document.createElement("div");
    content.className = "cm-content";
    content.setAttribute("contenteditable", "true");
    root.append(content);
    editor.append(root);
    source.append(editor);
    host.append(source);
  }
  document.body.append(host);
  return { host, root };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ink placement through production surface adapters and viewer sessions", () => {
  it("keeps PDF ink at the same page fraction through the PDF.js viewer's actual zoom path", async () => {
    installCanvasContexts();
    const data = Uint8Array.from(await readFile("tests/fixtures/lorem-ipsum.pdf"));
    const app = {
      vault: { readBinary: async () => data.slice().buffer },
      loadLocalStorage: () => null
    } as unknown as App;
    const file = { name: "lorem-ipsum.pdf" } as TFile;
    const host = document.createElement("div");
    document.body.append(host);
    const adapter = await PdfJsViewAdapter.create({ app, file, pluginDir: "pdfjs", host });
    const scroll = host.querySelector<HTMLElement>(".hn-owned-pdf-scroll");
    const page = adapter.page(1);
    if (!scroll || !page) throw new Error("The actual PDF.js adapter did not mount its first page");

    const baseLeft = 90;
    const baseTop = 70;
    const pageShell = page.element;
    const pdfCanvas = pageShell.querySelector<HTMLCanvasElement>(".hn-owned-pdf-canvas");
    if (!pdfCanvas) throw new Error("PDF.js did not mount the rendered page canvas");
    const getPageBox = (): DOMRect => {
      const transform = adapter.viewportContentElement().style.transform;
      const projection = /scale\(([-\d.]+)\)/.exec(transform);
      const translation = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(transform);
      const scale = Number(projection?.[1] ?? 1);
      const translateX = Number(translation?.[1] ?? 0);
      const translateY = Number(translation?.[2] ?? 0);
      return rect(
        baseLeft - scroll.scrollLeft + translateX,
        baseTop - scroll.scrollTop + translateY,
        stylePixels(pageShell, "width", page.width) * scale,
        stylePixels(pageShell, "height", page.height) * scale
      );
    };
    setRect(scroll, () => rect(baseLeft - 20, baseTop - 20, 800, 600));
    installScrollMetrics(
      scroll,
      () => stylePixels(pageShell, "width", page.width),
      () => stylePixels(pageShell, "height", page.height),
      800,
      600
    );
    setRect(pageShell, getPageBox);
    setRect(pdfCanvas, getPageBox);

    const session = await createSession(adapter, "Notes/zoomed.pdf");
    const overlay = pageShell.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    if (!overlay) throw new Error("ViewerInkSession did not mount the PDF annotation surface");
    setRect(overlay, getPageBox);

    try {
      const fraction = { x: 0.12, y: 0.14 };
      const expected = { x: page.width * fraction.x, y: page.height * (1 - fraction.y) };
      const observed: Array<{ x: number; y: number }> = [];
      for (const [index, scale] of [0.25, 0.5, 1, 2, 4, 2, 0.5].entries()) {
        session.setViewerState({
          viewport: { ...session.getViewerState().viewport, scale, x: 0, y: 0 },
          scale,
          scaleMode: "custom"
        });
        expect(adapter.getViewState().scale).toBeCloseTo(scale, 4);
        const stroke = drawAtPageFraction(session, pageShell, getPageBox, fraction, 100 + index);
        observed.push(stroke.points[0]!);
        expect(stroke.points[0]!.x).toBeCloseTo(expected.x, 2);
        expect(stroke.points[0]!.y).toBeCloseTo(expected.y, 2);
      }
      expect(committedStrokes(session)).toHaveLength(observed.length);
    } finally {
      await session.destroy({ silent: true });
    }
  });

  it("resizes an existing PDF stroke with the PDF.js page during actual zoom", async () => {
    installCanvasContexts();
    const data = Uint8Array.from(await readFile("tests/fixtures/lorem-ipsum.pdf"));
    const app = {
      vault: { readBinary: async () => data.slice().buffer },
      loadLocalStorage: () => null
    } as unknown as App;
    const host = document.createElement("div");
    document.body.append(host);
    let liveSession: ViewerInkSession | null = null;
    const adapter = await PdfJsViewAdapter.create({
      app,
      file: { name: "existing-ink.pdf" } as TFile,
      pluginDir: "pdfjs",
      host,
      callbacks: {
        onViewStateChange: (state, source) => liveSession?.onViewStateChange(state, source),
        onPagesChanged: (reason) => liveSession?.onPagesChanged(reason),
        onPageLifecycleChange: (change) => liveSession?.onPageLifecycleChange(change),
        onZoomChange: (change) => liveSession?.onZoomChange(change),
        onPageContentMutationTrace: (change) => liveSession?.onPdfPageContentMutation(change)
      }
    });
    const scroll = host.querySelector<HTMLElement>(".hn-owned-pdf-scroll");
    const page = adapter.page(1);
    if (!scroll || !page) throw new Error("The actual PDF.js adapter did not mount its first page");
    const pageShell = page.element;
    const pdfCanvas = pageShell.querySelector<HTMLCanvasElement>(".hn-owned-pdf-canvas");
    if (!pdfCanvas) throw new Error("PDF.js did not mount the rendered page canvas");

    const baseLeft = 90;
    const baseTop = 70;
    const getPageBox = (): DOMRect => rect(
      baseLeft - scroll.scrollLeft,
      baseTop - scroll.scrollTop,
      stylePixels(pageShell, "width", page.width),
      stylePixels(pageShell, "height", page.height)
    );
    setRect(scroll, () => rect(baseLeft - 20, baseTop - 20, 800, 600));
    installScrollMetrics(
      scroll,
      () => stylePixels(pageShell, "width", page.width),
      () => stylePixels(pageShell, "height", page.height),
      800,
      600
    );
    setRect(pageShell, getPageBox);
    setRect(pdfCanvas, getPageBox);

    const settings = newSettings();
    settings.toolPreferences.activeTool = "pen";
    settings.toolPreferences.pen.penType = "fountain";
    const session = await createSession(adapter, "Notes/existing-ink.pdf", settings);
    liveSession = session;
    const overlay = pageShell.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    if (!overlay) throw new Error("ViewerInkSession did not mount the PDF annotation surface");
    setRect(overlay, getPageBox);

    type InkSurfaceProbe = {
      canvas: HTMLCanvasElement;
      inkLayer: HTMLCanvasElement | null;
      inkLayerValid: boolean;
      inkLayerBurstCapture: boolean;
      inkLayerRevision: number | null;
    };
    const internal = session as unknown as {
      ink: { pageRevision(pageNumber: number): number };
      surfaces: Map<number, InkSurfaceProbe>;
    };
    const surface = internal.surfaces.get(1);
    if (!surface) throw new Error("ViewerInkSession did not create the PDF ink surface");

    try {
      const fraction = { x: 0.2, y: 0.3 };
      const stroke = drawAtPageFraction(session, pageShell, getPageBox, fraction, 501);
      expect(stroke.points[0]!.x).toBeCloseTo(page.width * fraction.x, 2);
      expect(stroke.points[0]!.y).toBeCloseTo(page.height * (1 - fraction.y), 2);
      expect(committedStrokes(session)).toHaveLength(1);

      type ZoomObservation = {
        previousPageBox: DOMRect;
        pageBox: DOMRect;
        pdfWidth: number;
        pdfHeight: number;
        inkWidth: number;
        inkHeight: number;
        arc: number[];
      };

      const zoomAndCapture = async (): Promise<ZoomObservation> => {
        const before = internal.surfaces.get(1)!;
        const previousPageBox = getPageBox();
        const previousCanvasWidth = before.canvas.width;
        const previousCanvasHeight = before.canvas.height;
        const previousPdfWidth = pdfCanvas.width;
        const previousPdfHeight = pdfCanvas.height;
        const previousCalls = before.inkLayer ? canvasArcCalls.get(before.inkLayer) : undefined;
        if (previousCalls) previousCalls.length = 0;
        const previousScale = adapter.getViewState().scale;
        adapter.root.dispatchEvent(new KeyboardEvent("keydown", {
          key: "=",
          bubbles: true,
          cancelable: true
        }));
        expect(adapter.getViewState().scale).toBeGreaterThan(previousScale);
        expect(getPageBox().width).toBeGreaterThan(previousPageBox.width);
        expect(getPageBox().height).toBeGreaterThan(previousPageBox.height);

        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          const calls = current?.inkLayer ? canvasArcCalls.get(current.inkLayer) : undefined;
          expect(current?.inkLayer).not.toBeNull();
          expect(current?.inkLayerValid).toBe(true);
          expect(current?.inkLayerBurstCapture).toBe(false);
          expect(current?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(current?.inkLayer?.width).toBe(current?.canvas.width);
          expect(current?.inkLayer?.height).toBe(current?.canvas.height);
          expect(current?.canvas.width).toBeGreaterThan(previousCanvasWidth);
          expect(current?.canvas.height).toBeGreaterThan(previousCanvasHeight);
          expect(pdfCanvas.width).toBeGreaterThan(previousPdfWidth);
          expect(pdfCanvas.height).toBeGreaterThan(previousPdfHeight);
          expect(calls?.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });

        const current = internal.surfaces.get(1)!;
        const layer = current.inkLayer!;
        const arc = canvasArcCalls.get(layer)?.[0];
        if (!arc) throw new Error("Canonical PDF ink repaint did not issue a pen stamp");
        return {
          previousPageBox,
          pageBox: getPageBox(),
          pdfWidth: pdfCanvas.width,
          pdfHeight: pdfCanvas.height,
          inkWidth: layer.width,
          inkHeight: layer.height,
          arc
        };
      };

      const firstScale = adapter.getViewState().scale;
      const first = await zoomAndCapture();
      expect(adapter.getViewState().scale).toBeGreaterThan(firstScale);
      expect(first.inkWidth / first.pdfWidth).toBeCloseTo(1, 2);
      expect(first.inkHeight / first.pdfHeight).toBeCloseTo(1, 2);

      const secondScale = adapter.getViewState().scale;
      const second = await zoomAndCapture();
      expect(adapter.getViewState().scale).toBeGreaterThan(secondScale);
      expect(second.pageBox.width).toBeGreaterThan(first.pageBox.width);
      expect(second.pageBox.height).toBeGreaterThan(first.pageBox.height);
      expect(second.inkWidth / second.pdfWidth).toBeCloseTo(1, 2);
      expect(second.inkHeight / second.pdfHeight).toBeCloseTo(1, 2);
      expect(second.inkWidth / first.inkWidth).toBeCloseTo(second.pdfWidth / first.pdfWidth, 2);
      expect(second.inkHeight / first.inkHeight).toBeCloseTo(second.pdfHeight / first.pdfHeight, 2);

      // The actual canonical pen stamps must keep the same page-relative center
      // and thickness when the retained PDF-space stroke is repainted at zoom.
      const normalizedCenterX = stroke.points[0]!.x / page.width;
      const normalizedCenterY = (page.height - stroke.points[0]!.y) / page.height;
      expect(first.arc[0]! / first.pageBox.width).toBeCloseTo(normalizedCenterX, 3);
      expect(first.arc[1]! / first.pageBox.height).toBeCloseTo(normalizedCenterY, 3);
      expect(second.arc[0]! / second.pageBox.width).toBeCloseTo(normalizedCenterX, 3);
      expect(second.arc[1]! / second.pageBox.height).toBeCloseTo(normalizedCenterY, 3);
      expect(second.arc[2]! / second.pageBox.width).toBeCloseTo(first.arc[2]! / first.pageBox.width, 3);
      expect(committedStrokes(session)).toEqual([stroke]);
    } finally {
      await session.destroy({ silent: true });
    }
  }, 15_000);

  it("keeps image ink in natural-image coordinates while the native image element changes size", async () => {
    installCanvasContexts();
    const host = document.createElement("div");
    host.style.overflow = "auto";
    const image = document.createElement("img");
    image.alt = "test image";
    image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'/%3E";
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1200 },
      naturalHeight: { configurable: true, value: 800 }
    });
    host.append(image);
    document.body.append(host);
    const adapter = ImageViewAdapter.attach(host);
    const page = adapter.page(1);
    const scroll = adapter.scrollElement();
    if (!page) throw new Error("ImageViewAdapter did not expose its native image page");
    const baseLeft = 60;
    const baseTop = 80;
    setRect(scroll, () => rect(baseLeft, baseTop, 800, 600));

    const getImageBox = (): DOMRect => rect(
      baseLeft - scroll.scrollLeft,
      baseTop - scroll.scrollTop,
      stylePixels(image, "width", image.naturalWidth),
      stylePixels(image, "height", image.naturalHeight)
    );
    setRect(image, getImageBox);
    installScrollMetrics(scroll, () => getImageBox().width, () => getImageBox().height, 800, 600);

    const session = await createSession(adapter, "Notes/zoomed-image.png");
    const pageElement = adapter.root;
    const overlay = pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    if (!overlay) throw new Error("ViewerInkSession did not mount the image annotation surface");
    setRect(pageElement, getImageBox);
    setRect(overlay, getImageBox);

    try {
      const fraction = { x: 0.12, y: 0.14 };
      const expected = { x: image.naturalWidth * fraction.x, y: image.naturalHeight * fraction.y };
      const observed: Array<{ x: number; y: number }> = [];
      for (const [index, scale] of [0.25, 0.5, 1, 2, 4, 2, 0.5].entries()) {
        image.style.width = `${image.naturalWidth * scale}px`;
        image.style.height = `${image.naturalHeight * scale}px`;
        expect(adapter.page(1)?.scale).toBeCloseTo(scale, 4);
        const stroke = drawAtPageFraction(session, pageElement, getImageBox, fraction, 200 + index);
        observed.push(stroke.points[0]!);
        expect(stroke.points[0]!.x).toBeCloseTo(expected.x, 2);
        expect(stroke.points[0]!.y).toBeCloseTo(expected.y, 2);
      }
      expect(committedStrokes(session)).toHaveLength(observed.length);
    } finally {
      await session.destroy({ silent: true });
    }
  });

  it.each(["preview", "source"] as const)(
    "keeps Markdown ink at the same note position while Obsidian's %s scroller moves",
    async (mode) => {
      installCanvasContexts();
      const { host, root } = markdownHost(mode);
      const adapter = MarkdownViewAdapter.attach(host, {}, { mode });
      const width = 800;
      const height = 2_000;
      const viewportHeight = 600;
      installScrollMetrics(root, () => width, () => height, width, viewportHeight);
      setRect(root, () => rect(50, 40, width, viewportHeight));
      const session = await createSession(adapter, `Notes/scroll-${mode}.md`);
      const overlay = root.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
      if (!overlay) throw new Error("ViewerInkSession did not mount the Markdown annotation surface");
      const getPageBox = (): DOMRect => rect(
        50 - root.scrollLeft,
        40 - root.scrollTop,
        root.scrollWidth,
        root.scrollHeight
      );
      setRect(overlay, getPageBox);

      try {
        const fraction = { x: 0.25, y: 0.2 };
        const expected = { x: width * fraction.x, y: height * fraction.y };
        const observed: Array<{ x: number; y: number }> = [];
        const originalOverlay = getPageBox();
        for (const [index, scrollTop] of [0, 180, 420, 0].entries()) {
          root.scrollTop = scrollTop;
          expect(root.scrollTop).toBe(scrollTop);
          root.dispatchEvent(new Event("scroll"));
          expect(getPageBox().top).toBe(originalOverlay.top - scrollTop);
          const stroke = drawAtPageFraction(session, root, getPageBox, fraction, 300 + index);
          observed.push(stroke.points[0]!);
          expect(stroke.points[0]!.x).toBeCloseTo(expected.x, 2);
          expect(stroke.points[0]!.y).toBeCloseTo(expected.y, 2);
        }
        expect(committedStrokes(session)).toHaveLength(observed.length);
      } finally {
        await session.destroy({ silent: true });
      }
    }
  );
});
