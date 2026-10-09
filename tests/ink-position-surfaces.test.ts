import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { ImageViewAdapter } from "../src/integration/ImageViewAdapter";
import { MarkdownViewAdapter } from "../src/integration/MarkdownViewAdapter";
import { PdfJsViewAdapter } from "../src/integration/PdfJsViewAdapter";
import {
  loadPdfJsRuntime,
  type PdfJsDocumentProxy,
  type PdfJsRuntime
} from "../src/integration/PdfJsRuntime";
import { DEFAULT_SETTINGS, type InkStroke } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { VIEWER_ZOOM_STEP } from "../src/runtime/ViewerState";
import {
  inkBackingSize,
  markdownInkBackingBudget,
  MAX_INK_EDGE_PX,
  MAX_INK_PIXELS
} from "../src/runtime/inkBackingSize";
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

function overrideDevicePixelRatio(
  value: number,
  targetWindow: Window & typeof globalThis = window
): () => void {
  const previous = Object.getOwnPropertyDescriptor(targetWindow, "devicePixelRatio");
  Object.defineProperty(targetWindow, "devicePixelRatio", { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(targetWindow, "devicePixelRatio", previous);
    else Reflect.deleteProperty(targetWindow, "devicePixelRatio");
  };
}

/** JSDOM has no layout engine; project the real CSS dimensions into DOMRects. */
function installScrollMetrics(
  element: HTMLElement,
  width: () => number,
  height: () => number,
  clientWidth: number,
  clientHeight: number,
  padding = { left: 0, top: 0, right: 0, bottom: 0 }
): void {
  let left = 0;
  let top = 0;
  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => clientWidth },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollWidth: { configurable: true, get: () => Math.max(clientWidth, width() + padding.left + padding.right) },
    scrollHeight: { configurable: true, get: () => Math.max(clientHeight, height() + padding.top + padding.bottom) },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, Math.min(Math.max(0, width() + padding.left + padding.right - clientWidth), value));
      }
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(Math.max(0, height() + padding.top + padding.bottom - clientHeight), value));
      }
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

function installCanvasContexts(targetWindow: Window & typeof globalThis = window): void {
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
  vi.spyOn(targetWindow.HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
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

class TestResizeObserver {
  static readonly instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void { this.observed.add(target); }
  unobserve(target: Element): void { this.observed.delete(target); }
  disconnect(): void { this.observed.clear(); }

  notify(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function newSettings(): typeof DEFAULT_SETTINGS {
  return structuredClone(DEFAULT_SETTINGS);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function pdfRuntimeWithDocumentProxy(
  app: App,
  pluginDir: string,
  wrap: (document: PdfJsDocumentProxy) => PdfJsDocumentProxy
): Promise<PdfJsRuntime> {
  const runtime = await loadPdfJsRuntime(app, pluginDir);
  return {
    ...runtime,
    module: {
      ...runtime.module,
      getDocument: (options) => {
        const task = runtime.module.getDocument(options);
        return {
          promise: task.promise.then(wrap),
          destroy: () => task.destroy?.()
        };
      }
    }
  };
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

function markdownHost(
  mode: "preview" | "source",
  ownerDocument: Document = document
): { host: HTMLElement; root: HTMLElement } {
  const host = ownerDocument.createElement("div");
  host.className = "workspace-leaf-content";
  const root = ownerDocument.createElement("div");
  root.style.overflow = "auto";
  if (mode === "preview") {
    root.className = "markdown-preview-view";
    host.append(root);
  } else {
    const source = ownerDocument.createElement("div");
    source.className = "markdown-source-view is-live-preview";
    const editor = ownerDocument.createElement("div");
    editor.className = "cm-editor";
    root.className = "cm-scroller";
    const content = ownerDocument.createElement("div");
    content.className = "cm-content";
    content.setAttribute("contenteditable", "true");
    root.append(content);
    editor.append(root);
    source.append(editor);
    host.append(source);
  }
  ownerDocument.body?.append(host);
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
    let liveSession: ViewerInkSession | null = null;
    const adapter = await PdfJsViewAdapter.create({
      app,
      file,
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

    const baseLeft = 90;
    const baseTop = 70;
    scroll.style.padding = "20px";
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
      600,
      { left: 20, top: 20, right: 20, bottom: 20 }
    );
    setRect(pageShell, getPageBox);
    setRect(pdfCanvas, getPageBox);

    const session = await createSession(adapter, "Notes/zoomed.pdf");
    liveSession = session;
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

      // The real PDF toolbar's Ctrl/Cmd+wheel path zooms around the cursor.
      // Keep the same ink point under that cursor with the viewer's 20 px
      // scroll padding and a nonzero scroll offset.
      session.setViewerState({
        viewport: { ...session.getViewerState().viewport, scale: 1, x: 0, y: 0 },
        scale: 1,
        scaleMode: "custom"
      });
      scroll.scrollLeft = 0;
      scroll.scrollTop = 80;
      scroll.dispatchEvent(new Event("scroll"));
      const focal = {
        x: scroll.getBoundingClientRect().left + 400,
        y: scroll.getBoundingClientRect().top + 350
      };
      const beforeFocalBox = getPageBox();
      const anchorFraction = {
        x: (focal.x - beforeFocalBox.left) / beforeFocalBox.width,
        y: (focal.y - beforeFocalBox.top) / beforeFocalBox.height
      };
      const focalStroke = drawAtPageFraction(session, pageShell, getPageBox, anchorFraction, 190);
      const focalPoint = focalStroke.points[0]!;
      const coordinateProbe = session as unknown as {
        surfaces: Map<number, unknown>;
        mapper: (surface: unknown) => { toViewport(point: { x: number; y: number }): { x: number; y: number } };
      };
      const focalSurface = coordinateProbe.surfaces.get(1);
      if (!focalSurface) throw new Error("ViewerInkSession did not retain its PDF coordinate surface");
      const screenPosition = (): { x: number; y: number } => {
        const local = coordinateProbe.mapper(focalSurface).toViewport(focalPoint);
        const box = getPageBox();
        return { x: box.left + local.x, y: box.top + local.y };
      };
      expect(screenPosition().x).toBeCloseTo(focal.x, 0);
      expect(screenPosition().y).toBeCloseTo(focal.y, 0);
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
        clientX: focal.x,
        clientY: focal.y
      });
      scroll.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      expect(adapter.getViewState().scale).toBeGreaterThan(1);
      expect(scroll.scrollLeft).toBeGreaterThan(0);
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(screenPosition().x).toBeCloseTo(focal.x, 0);
      expect(screenPosition().y).toBeCloseTo(focal.y, 0);

      // Keyboard zoom keeps the viewport center fixed and follows the same
      // padding-aware correction path when it has no explicit cursor focal.
      const center = {
        x: scroll.getBoundingClientRect().left + scroll.clientWidth / 2,
        y: scroll.getBoundingClientRect().top + scroll.clientHeight / 2
      };
      const beforeCenterBox = getPageBox();
      const centerFraction = {
        x: (center.x - beforeCenterBox.left) / beforeCenterBox.width,
        y: (center.y - beforeCenterBox.top) / beforeCenterBox.height
      };
      const centerStroke = drawAtPageFraction(session, pageShell, getPageBox, centerFraction, 191);
      const centerPoint = centerStroke.points[0]!;
      const centerScreenPosition = (): { x: number; y: number } => {
        const local = coordinateProbe.mapper(focalSurface).toViewport(centerPoint);
        const box = getPageBox();
        return { x: box.left + local.x, y: box.top + local.y };
      };
      const scaleBeforeKeyboardZoom = adapter.getViewState().scale;
      const restoreViewState = vi.spyOn(adapter, "restoreViewState");
      const keyboardZoom = new KeyboardEvent("keydown", {
        key: "=", ctrlKey: true, bubbles: true, cancelable: true
      });
      adapter.root.dispatchEvent(keyboardZoom);
      expect(keyboardZoom.defaultPrevented).toBe(true);
      const expectedKeyboardZoomScale = Math.min(10, scaleBeforeKeyboardZoom * VIEWER_ZOOM_STEP);
      expect(adapter.getViewState().scale).toBeCloseTo(expectedKeyboardZoomScale, 4);
      expect(session.getViewerState().viewport.scale).toBeCloseTo(expectedKeyboardZoomScale, 4);
      expect(restoreViewState).not.toHaveBeenCalled();
      expect(centerScreenPosition().x).toBeCloseTo(center.x, 0);
      expect(centerScreenPosition().y).toBeCloseTo(center.y, 0);

      // The adapter's unmodified shortcut must use the same anchored zoom
      // callback and return to the prior scale without restoring stale x/y.
      const keyboardZoomOut = new KeyboardEvent("keydown", {
        key: "-", bubbles: true, cancelable: true
      });
      adapter.root.dispatchEvent(keyboardZoomOut);
      expect(keyboardZoomOut.defaultPrevented).toBe(true);
      expect(adapter.getViewState().scale).toBeCloseTo(scaleBeforeKeyboardZoom, 4);
      expect(session.getViewerState().viewport.scale).toBeCloseTo(scaleBeforeKeyboardZoom, 4);
      expect(restoreViewState).not.toHaveBeenCalled();
      expect(centerScreenPosition().x).toBeCloseTo(center.x, 0);
      expect(centerScreenPosition().y).toBeCloseTo(center.y, 0);
      restoreViewState.mockRestore();

      // Rapid reversals issue overlapping PDF.js render requests. Only the
      // newest scale may own the final page and ink backing geometry.
      const stressScales = [4.8, 0.25, 4.2, 0.5, 3.6, 0.75, 1.25];
      for (const scale of stressScales) {
        session.setViewerState({
          viewport: { ...session.getViewerState().viewport, scale, x: 0, y: 0 },
          scale,
          scaleMode: "custom"
        });
      }
      await vi.waitFor(() => {
        expect(adapter.getViewState().scale).toBeCloseTo(1.25, 4);
        expect(stylePixels(pageShell, "width", 0)).toBeCloseTo(page.width * 1.25, 1);
        expect(pdfCanvas.width).toBeGreaterThan(0);
        const surface = (session as unknown as {
          surfaces: Map<number, {
            inkLayer: HTMLCanvasElement | null;
            inkLayerValid: boolean;
            inkLayerBackingScale: number;
            inkLayerBurstCapture: boolean;
            inkLayerRevision: number;
          }>;
        }).surfaces.get(1);
        expect(surface?.inkLayer).not.toBeNull();
        expect(surface?.inkLayerValid).toBe(true);
        expect(surface?.inkLayerBurstCapture).toBe(false);
        expect(surface?.inkLayerRevision).toBe(
          (session as unknown as { ink: { pageRevision(pageNumber: number): number } }).ink.pageRevision(1)
        );
        expect(pdfCanvas.width).toBeCloseTo(
          stylePixels(pageShell, "width", page.width) * (window.devicePixelRatio || 1),
          0
        );
        expect(surface?.inkLayer?.width).toBeCloseTo(
          stylePixels(pageShell, "width", page.width) * surface!.inkLayerBackingScale,
          0
        );
      }, { timeout: 5_000, interval: 20 });
      const finalPdfCanvasWidth = pdfCanvas.width;
      const finalInkCanvasWidth = (session as unknown as {
        surfaces: Map<number, { inkLayer: HTMLCanvasElement | null }>;
      }).surfaces.get(1)?.inkLayer?.width;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      expect(adapter.getViewState().scale).toBeCloseTo(1.25, 4);
      expect(pdfCanvas.width).toBe(finalPdfCanvasWidth);
      expect((session as unknown as {
        surfaces: Map<number, { inkLayer: HTMLCanvasElement | null }>;
      }).surfaces.get(1)?.inkLayer?.width).toBe(finalInkCanvasWidth);
      expect(committedStrokes(session)).toHaveLength(observed.length + 2);
    } finally {
      await session.destroy({ silent: true });
    }
  }, 30_000);

  it("uses each PDF page's actual dimensions for high-resolution render budgeting", async () => {
    installCanvasContexts();
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([1_200, 300]);
    const data = await source.save();
    const app = {
      vault: { readBinary: async () => data.slice().buffer },
      loadLocalStorage: () => null
    } as unknown as App;
    const host = document.createElement("div");
    document.body.append(host);
    const adapter = await PdfJsViewAdapter.create({
      app,
      file: { name: "mixed-page-sizes.pdf" } as TFile,
      pluginDir: "pdfjs",
      host
    });
    const internal = adapter as unknown as {
      lifecycleCoordinator: { getRecord(pageNumber: number): { naturalWidth: number; naturalHeight: number } | undefined };
      renderScheduler: { getRenderedPage(pageNumber: number): { pixelCount: number } | undefined };
    };
    try {
      await vi.waitFor(() => {
        const record = internal.lifecycleCoordinator.getRecord(2);
        const rendered = internal.renderScheduler.getRenderedPage(2);
        const pageCanvas = adapter.root.querySelector<HTMLCanvasElement>(
          '.hn-owned-pdf-page[data-page-number="2"] .hn-owned-pdf-canvas'
        );
        expect(record?.naturalWidth).toBeCloseTo(1_200, 2);
        expect(record?.naturalHeight).toBeCloseTo(300, 2);
        expect(rendered).toBeDefined();
        expect(pageCanvas).not.toBeNull();
        expect(rendered?.pixelCount).toBe(pageCanvas!.width * pageCanvas!.height);
      }, { timeout: 5_000, interval: 20 });
    } finally {
      adapter.destroy();
    }
  }, 30_000);

  it("keeps mixed-size PDF page-two ink page-relative through real zoom cycles", async () => {
    installCanvasContexts();
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([1_200, 300]);
    const data = await source.save();
    const app = {
      vault: { readBinary: async () => data.slice().buffer },
      loadLocalStorage: () => null
    } as unknown as App;
    const host = document.createElement("div");
    document.body.append(host);
    let liveSession: ViewerInkSession | null = null;
    const adapter = await PdfJsViewAdapter.create({
      app,
      file: { name: "mixed-page-ink.pdf" } as TFile,
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
    const page = adapter.page(2);
    if (!scroll || !page) throw new Error("The mixed-size PDF did not expose page two");
    const pageShell = page.element;
    const pdfCanvas = pageShell.querySelector<HTMLCanvasElement>(".hn-owned-pdf-canvas");
    if (!pdfCanvas) throw new Error("PDF.js did not create the mixed-size page-two canvas");
    setRect(scroll, () => rect(0, 0, 800, 600));
    installScrollMetrics(scroll, () => 2_400, () => 1_800, 800, 600);
    const getPageBox = (): DOMRect => rect(
      40 - scroll.scrollLeft,
      80 - scroll.scrollTop,
      stylePixels(pageShell, "width", page.width),
      stylePixels(pageShell, "height", page.height)
    );
    setRect(pageShell, getPageBox);
    setRect(pdfCanvas, getPageBox);

    const session = await createSession(adapter, "Notes/mixed-page-ink.pdf");
    liveSession = session;
    const internal = session as unknown as {
      commandController: { setZoom(scale: number): boolean };
      surfaces: Map<number, {
        inkLayer: HTMLCanvasElement | null;
        inkLayerBackingScale: number | null;
        inkLayerValid: boolean;
      }>;
    };
    try {
      session.setViewerState({
        pageNumber: 2,
        viewport: { scale: 1, x: 0, y: 0 },
        scale: 1,
        scaleMode: "custom"
      });
      await vi.waitFor(() => {
        expect(internal.surfaces.has(2)).toBe(true);
        expect(adapter.getViewState().scale).toBeCloseTo(1, 4);
      }, { timeout: 5_000, interval: 20 });
      const overlay = pageShell.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
      if (!overlay) throw new Error("ViewerInkSession did not mount the mixed-size page-two overlay");
      setRect(overlay, getPageBox);

      const fraction = { x: 0.3, y: 0.5 };
      const retained = drawAtPageFraction(session, pageShell, getPageBox, fraction, 811);
      expect(retained.points[0]!.x).toBeCloseTo(1_200 * fraction.x, 2);
      expect(retained.points[0]!.y).toBeCloseTo(300 * (1 - fraction.y), 2);

      for (const [index, targetScale] of [2, 0.5, 1.25, 1].entries()) {
        expect(internal.commandController.setZoom(targetScale)).toBe(true);
        await vi.waitFor(() => {
          expect(adapter.getViewState().scale).toBeCloseTo(targetScale, 4);
          expect(stylePixels(pageShell, "width", 0)).toBeCloseTo(1_200 * targetScale, 1);
          expect(stylePixels(pageShell, "height", 0)).toBeCloseTo(300 * targetScale, 1);
          const surface = internal.surfaces.get(2);
          expect(surface?.inkLayer).not.toBeNull();
          expect(surface?.inkLayerBackingScale).toBeGreaterThan(0);
          expect(surface?.inkLayerValid).toBe(true);
          expect(surface?.inkLayer?.width).toBeCloseTo(
            stylePixels(pageShell, "width", 0) * surface!.inkLayerBackingScale!,
            0
          );
          expect(surface?.inkLayer?.height).toBeCloseTo(
            stylePixels(pageShell, "height", 0) * surface!.inkLayerBackingScale!,
            0
          );
        }, { timeout: 5_000, interval: 20 });

        const nextStroke = drawAtPageFraction(session, pageShell, getPageBox, fraction, 812 + index);
        expect(nextStroke.points[0]!.x).toBeCloseTo(retained.points[0]!.x, 2);
        expect(nextStroke.points[0]!.y).toBeCloseTo(retained.points[0]!.y, 2);
        expect(committedStrokes(session)[0]).toEqual(retained);
      }
    } finally {
      await session.destroy({ silent: true });
    }
  }, 30_000);

  it("does not retain page-one placeholder geometry when a mixed-size PDF page loads after navigation", async () => {
    installCanvasContexts();
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([1_200, 300]);
    const data = await source.save();
    const app = {
      vault: { readBinary: async () => data.slice().buffer },
      loadLocalStorage: () => null
    } as unknown as App;
    const pageTwoGate = deferred<void>();
    let pageTwoRequested = false;
    const runtime = await pdfRuntimeWithDocumentProxy(app, "pdfjs", (pdfDocument) => new Proxy(pdfDocument, {
      get(target, property) {
        if (property === "getPage") {
          return (pageNumber: number) => {
            if (pageNumber === 2) pageTwoRequested = true;
            return pageNumber === 2
              ? pageTwoGate.promise.then(() => target.getPage(pageNumber))
              : target.getPage(pageNumber);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }));
    const host = document.createElement("div");
    document.body.append(host);
    let adapter: PdfJsViewAdapter | null = null;
    let session: ViewerInkSession | null = null;
    let liveSession: ViewerInkSession | null = null;

    try {
      adapter = await PdfJsViewAdapter.create({
        app,
        file: { name: "delayed-mixed-page.pdf" } as TFile,
        pluginDir: "pdfjs",
        host,
        runtime,
        callbacks: {
          onViewStateChange: (state, eventSource) => liveSession?.onViewStateChange(state, eventSource),
          onPagesChanged: (reason) => liveSession?.onPagesChanged(reason),
          onPageLifecycleChange: (change) => liveSession?.onPageLifecycleChange(change),
          onZoomChange: (change) => liveSession?.onZoomChange(change),
          onPageContentMutationTrace: (change) => liveSession?.onPdfPageContentMutation(change)
        }
      });
      await vi.waitFor(() => expect(pageTwoRequested).toBe(true), { timeout: 5_000, interval: 20 });

      const scroll = host.querySelector<HTMLElement>(".hn-owned-pdf-scroll");
      const placeholderPage = adapter.page(2);
      if (!scroll || !placeholderPage) throw new Error("The delayed PDF did not expose its page-two shell");
      expect(placeholderPage.geometryConfidence).toBe("derived");
      expect(placeholderPage.geometrySafe).toBe(false);
      expect(placeholderPage.width).toBe(612);
      expect(placeholderPage.height).toBe(792);
      const pageShell = placeholderPage.element;
      const pdfCanvas = pageShell.querySelector<HTMLCanvasElement>(".hn-owned-pdf-canvas");
      if (!pdfCanvas) throw new Error("PDF.js did not create the delayed page-two canvas");
      setRect(scroll, () => rect(0, 0, 800, 600));
      installScrollMetrics(
        scroll,
        () => stylePixels(pageShell, "width", adapter?.page(2)?.width ?? placeholderPage.width),
        () => stylePixels(pageShell, "height", adapter?.page(2)?.height ?? placeholderPage.height),
        800,
        600
      );
      const getPageBox = (): DOMRect => rect(
        40 - scroll.scrollLeft,
        80 - scroll.scrollTop,
        stylePixels(pageShell, "width", adapter?.page(2)?.width ?? placeholderPage.width),
        stylePixels(pageShell, "height", adapter?.page(2)?.height ?? placeholderPage.height)
      );
      setRect(pageShell, getPageBox);
      setRect(pdfCanvas, getPageBox);

      session = await createSession(adapter, "Notes/delayed-mixed-page.pdf");
      liveSession = session;
      session.setViewerState({
        pageNumber: 2,
        viewport: { scale: 1, x: 0, y: 0 },
        scale: 1,
        scaleMode: "custom"
      });
      const internal = session as unknown as {
        commandController: { setZoom(scale: number): boolean };
        surfaces: Map<number, {
          page: { width: number; height: number };
          inkLayer: HTMLCanvasElement | null;
          inkLayerBackingScale: number | null;
          inkLayerValid: boolean;
        }>;
        mapper(surface: unknown): { toViewport(point: { x: number; y: number }): { x: number; y: number } };
      };
      await vi.waitFor(() => {
        expect(session?.getViewerState().pageNumber).toBe(2);
        expect(internal.surfaces.has(2)).toBe(true);
      }, { timeout: 5_000, interval: 20 });

      pageTwoGate.resolve(undefined);
      await vi.waitFor(() => {
        expect(adapter?.page(2)).toMatchObject({
          width: 1_200,
          height: 300,
          geometryConfidence: "authoritative",
          geometrySafe: true
        });
        expect(internal.surfaces.get(2)?.page).toMatchObject({ width: 1_200, height: 300 });
      }, { timeout: 5_000, interval: 20 });
      const overlay = pageShell.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
      if (!overlay) throw new Error("ViewerInkSession did not mount the delayed page-two overlay");
      setRect(overlay, getPageBox);

      const expectedFraction = { x: 0.3, y: 0.5 };
      const stroke = drawAtPageFraction(session, pageShell, getPageBox, expectedFraction, 9_201);
      expect(stroke.points[0]!.x).toBeCloseTo(1_200 * expectedFraction.x, 2);
      expect(stroke.points[0]!.y).toBeCloseTo(300 * (1 - expectedFraction.y), 2);

      const surface = internal.surfaces.get(2);
      if (!surface) throw new Error("ViewerInkSession lost the delayed page-two ink surface");
      for (const scale of [5, 0.25, 1]) {
        expect(internal.commandController.setZoom(scale)).toBe(true);
        await vi.waitFor(() => {
          expect(adapter?.getViewState().scale).toBeCloseTo(scale, 4);
          expect(stylePixels(pageShell, "width", 0)).toBeCloseTo(1_200 * scale, 1);
          expect(stylePixels(pageShell, "height", 0)).toBeCloseTo(300 * scale, 1);
          expect(surface.inkLayer).not.toBeNull();
          expect(surface.inkLayerValid).toBe(true);
          expect(surface.inkLayerBackingScale).toBeGreaterThan(0);
          expect(surface.inkLayer!.width).toBeCloseTo(
            stylePixels(pageShell, "width", 0) * surface.inkLayerBackingScale!,
            0
          );
        }, { timeout: 5_000, interval: 20 });
        const mapped = internal.mapper(surface).toViewport(stroke.points[0]!);
        const pageBox = getPageBox();
        expect(mapped.x / pageBox.width).toBeCloseTo(expectedFraction.x, 3);
        expect(mapped.y / pageBox.height).toBeCloseTo(expectedFraction.y, 3);
        expect(committedStrokes(session)[0]).toEqual(stroke);
      }
    } finally {
      pageTwoGate.resolve(undefined);
      if (session) await session.destroy({ silent: true });
      adapter?.destroy();
    }
  }, 30_000);

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
    const getPageBox = (): DOMRect => {
      const transform = adapter.viewportContentElement().style.transform;
      const projection = /scale\(([-\d.]+)\)/.exec(transform);
      const translation = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(transform);
      const projectionScale = Number(projection?.[1] ?? 1);
      const translateX = Number(translation?.[1] ?? 0);
      const translateY = Number(translation?.[2] ?? 0);
      return rect(
        baseLeft - scroll.scrollLeft + translateX,
        baseTop - scroll.scrollTop + translateY,
        stylePixels(pageShell, "width", page.width) * projectionScale,
        stylePixels(pageShell, "height", page.height) * projectionScale
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
      inkLayerBackingScale: number | null;
      inkLayerBurstCapture: boolean;
      inkLayerRevision: number | null;
    };
    const internal = session as unknown as {
      ink: { pageRevision(pageNumber: number): number };
      surfaces: Map<number, InkSurfaceProbe>;
      handwritingViewport: {
        getState(): { scale: number; x: number; y: number };
        getRenderedScale(): number;
        setState(state: { scale: number; x: number; y: number }): void;
        syncRenderedState(scale: number, scrollLeft: number, scrollTop: number): void;
      };
      beginZoomCompositing(): void;
      endZoomCompositing(): void;
      releaseZoomCompositeLayers(forceAfterTimeout?: boolean): void;
      pendingViewportProjectionRepaint: boolean;
    };
    const surface = internal.surfaces.get(1);
    if (!surface) throw new Error("ViewerInkSession did not create the PDF ink surface");

    try {
      const fraction = { x: 0.2, y: 0.3 };
      const stroke = drawAtPageFraction(session, pageShell, getPageBox, fraction, 501);
      expect(stroke.points[0]!.x).toBeCloseTo(page.width * fraction.x, 2);
      expect(stroke.points[0]!.y).toBeCloseTo(page.height * (1 - fraction.y), 2);
      expect(committedStrokes(session)).toHaveLength(1);

      // Exercise HandwritingViewport's temporary CSS projection while PDF.js
      // still owns the rendered scale. New ink must map through the projection
      // and return to stable PDF coordinates at both magnifications.
      const renderedScale = internal.handwritingViewport.getRenderedScale();
      const baselineBox = getPageBox();
      const pinchStrokes: InkStroke[] = [];
      for (const [index, projectionScale] of [5, 0.25, 4, 0.5, 2, 1].entries()) {
        const previousLayer = surface.inkLayer;
        const previousCallCount = previousLayer ? canvasArcCalls.get(previousLayer)?.length ?? 0 : 0;
        // CSS-only pinch can overlap a native PDF compositor handoff. Its
        // backing refresh must defer until that handoff releases, then run.
        if (index === 0) internal.beginZoomCompositing();
        internal.handwritingViewport.setState({ scale: renderedScale * projectionScale, x: 0, y: 0 });
        const projectedBox = getPageBox();
        expect(projectedBox.width).toBeCloseTo(baselineBox.width * projectionScale, 2);
        if (index === 0) {
          await vi.waitFor(() => expect(internal.pendingViewportProjectionRepaint).toBe(true), {
            timeout: 3_000,
            interval: 20
          });
          internal.endZoomCompositing();
          internal.releaseZoomCompositeLayers(true);
        }
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          if (!current?.inkLayer || current.inkLayerBackingScale === null) {
            throw new Error("PDF ink backing did not settle after CSS-projected zoom");
          }
          expect(current.inkLayerValid).toBe(true);
          expect(current.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(
            current.inkLayerBackingScale / projectionScale,
            `PDF projection ${projectionScale}x; backing=${current.inkLayerBackingScale}; viewport=${internal.handwritingViewport.getState().scale}; rendered=${internal.handwritingViewport.getRenderedScale()}; dpr=${window.devicePixelRatio}`
          ).toBeCloseTo(Math.max(window.devicePixelRatio, 0.5 / projectionScale), 2);
          expect(current.inkLayer.width).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
          expect(current.inkLayer.height).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
          expect(current.inkLayer.width * current.inkLayer.height)
            .toBeLessThanOrEqual(MAX_INK_PIXELS + MAX_INK_EDGE_PX * 2);
          const calls = canvasArcCalls.get(current.inkLayer) ?? [];
          if (current.inkLayer === previousLayer) expect(calls.length).toBeGreaterThan(previousCallCount);
          else expect(calls.length).toBeGreaterThan(0);
          expect(committedStrokes(session)[0]).toEqual(stroke);
        }, { timeout: 3_000, interval: 20 });
        const projectedStroke = drawAtPageFraction(session, pageShell, getPageBox, fraction, 502 + index);
        pinchStrokes.push(projectedStroke);
        expect(projectedStroke.points[0]!.x).toBeCloseTo(page.width * fraction.x, 2);
        expect(projectedStroke.points[0]!.y).toBeCloseTo(page.height * (1 - fraction.y), 2);
      }
      internal.handwritingViewport.syncRenderedState(renderedScale, scroll.scrollLeft, scroll.scrollTop);
      expect(committedStrokes(session)).toEqual([stroke, ...pinchStrokes]);

      type ZoomObservation = {
        previousPageBox: DOMRect;
        pageBox: DOMRect;
        pdfWidth: number;
        pdfHeight: number;
        inkWidth: number;
        inkHeight: number;
        rotation: number;
        arc: number[];
      };

      const zoomAndCapture = async (key: "=" | "-" = "="): Promise<ZoomObservation> => {
        const zoomingIn = key === "=";
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
          key,
          bubbles: true,
          cancelable: true
        }));
        if (zoomingIn) {
          expect(adapter.getViewState().scale).toBeGreaterThan(previousScale);
          expect(getPageBox().width).toBeGreaterThan(previousPageBox.width);
          expect(getPageBox().height).toBeGreaterThan(previousPageBox.height);
        } else {
          expect(adapter.getViewState().scale).toBeLessThan(previousScale);
          expect(getPageBox().width).toBeLessThan(previousPageBox.width);
          expect(getPageBox().height).toBeLessThan(previousPageBox.height);
        }

        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          const calls = current?.inkLayer ? canvasArcCalls.get(current.inkLayer) : undefined;
          expect(current?.inkLayer).not.toBeNull();
          expect(current?.inkLayerValid).toBe(true);
          expect(current?.inkLayerBurstCapture).toBe(false);
          expect(current?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(current?.inkLayer?.width).toBe(current?.canvas.width);
          expect(current?.inkLayer?.height).toBe(current?.canvas.height);
          if (zoomingIn) {
            expect(current?.canvas.width).toBeGreaterThan(previousCanvasWidth);
            expect(current?.canvas.height).toBeGreaterThan(previousCanvasHeight);
            expect(pdfCanvas.width).toBeGreaterThan(previousPdfWidth);
            expect(pdfCanvas.height).toBeGreaterThan(previousPdfHeight);
          } else {
            expect(current?.canvas.width).toBeLessThan(previousCanvasWidth);
            expect(current?.canvas.height).toBeLessThan(previousCanvasHeight);
            expect(pdfCanvas.width).toBeLessThan(previousPdfWidth);
            expect(pdfCanvas.height).toBeLessThan(previousPdfHeight);
          }
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
          rotation: adapter.getViewState().rotation,
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

      const reverseGesture = await zoomAndCapture("-");
      const reverseToFitGesture = await zoomAndCapture("-");
      expect(adapter.getViewState().scale).toBeCloseTo(firstScale, 4);
      expect(reverseGesture.pageBox.width).toBeLessThan(second.pageBox.width);
      expect(reverseToFitGesture.pageBox.width).toBeCloseTo(page.width, 2);

      // The actual canonical pen stamps must keep the same page-relative center
      // and thickness when the retained PDF-space stroke is repainted at zoom.
      const normalizedCenterX = stroke.points[0]!.x / page.width;
      const normalizedCenterY = (page.height - stroke.points[0]!.y) / page.height;
      const normalizedPenRadius = first.arc[2]! / first.pageBox.width;
      expect(first.arc[0]! / first.pageBox.width).toBeCloseTo(normalizedCenterX, 3);
      expect(first.arc[1]! / first.pageBox.height).toBeCloseTo(normalizedCenterY, 3);
      expect(second.arc[0]! / second.pageBox.width).toBeCloseTo(normalizedCenterX, 3);
      expect(second.arc[1]! / second.pageBox.height).toBeCloseTo(normalizedCenterY, 3);
      expect(second.arc[2]! / second.pageBox.width).toBeCloseTo(first.arc[2]! / first.pageBox.width, 3);

      const repaintAtScale = async (
        scale: number,
        rotation = adapter.getViewState().rotation
      ): Promise<ZoomObservation> => {
        const previousLayer = internal.surfaces.get(1)?.inkLayer;
        const previousCalls = previousLayer ? canvasArcCalls.get(previousLayer) : undefined;
        if (previousCalls) previousCalls.length = 0;
        session.setViewerState({
          viewport: { ...session.getViewerState().viewport, scale, x: 0, y: 0 },
          scale,
          rotation,
          scaleMode: "custom"
        });
        expect(adapter.getViewState().scale).toBeCloseTo(scale, 4);

        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          const calls = current?.inkLayer ? canvasArcCalls.get(current.inkLayer) : undefined;
          expect(current?.inkLayer).not.toBeNull();
          expect(current?.inkLayerValid).toBe(true);
          expect(current?.inkLayerBurstCapture).toBe(false);
          expect(current?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(current?.inkLayerBackingScale).toBeGreaterThan(0);
          expect(current?.inkLayer?.width).toBe(current?.canvas.width);
          expect(current?.inkLayer?.height).toBe(current?.canvas.height);
          expect(calls?.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });

        const current = internal.surfaces.get(1)!;
        const layer = current.inkLayer!;
        const arc = canvasArcCalls.get(layer)?.[0];
        if (!arc) throw new Error(`Canonical PDF ink repaint did not issue a pen stamp at scale ${scale}`);
        return {
          previousPageBox: getPageBox(),
          pageBox: getPageBox(),
          pdfWidth: pdfCanvas.width,
          pdfHeight: pdfCanvas.height,
          inkWidth: layer.width,
          inkHeight: layer.height,
          rotation: adapter.getViewState().rotation,
          arc
        };
      };

      // Keep the same stored PDF-space stroke while the real PDF.js page is
      // rendered at high zoom, zoomed far out, and brought back up again.
      const highMagnification = await repaintAtScale(5);
      const zoomedOut = await repaintAtScale(0.25);
      const zoomedInAgain = await repaintAtScale(4);
      const rotated90 = await repaintAtScale(3.5, 90);
      const rotated180 = await repaintAtScale(0.5, 180);
      const rotated270 = await repaintAtScale(2, 270);
      const restored = await repaintAtScale(1, 0);
      const observations = [
        reverseGesture,
        reverseToFitGesture,
        highMagnification,
        zoomedOut,
        zoomedInAgain,
        rotated90,
        rotated180,
        rotated270,
        restored
      ];
      for (const observation of observations) {
        expect(observation.inkWidth / observation.pdfWidth).toBeCloseTo(1, 2);
        expect(observation.inkHeight / observation.pdfHeight).toBeCloseTo(1, 2);
        const expectedCenter = (() => {
          switch (observation.rotation) {
            case 90: return { x: 1 - normalizedCenterY, y: normalizedCenterX };
            case 180: return { x: 1 - normalizedCenterX, y: 1 - normalizedCenterY };
            case 270: return { x: normalizedCenterY, y: 1 - normalizedCenterX };
            default: return { x: normalizedCenterX, y: normalizedCenterY };
          }
        })();
        const orientationWidth = observation.rotation % 180 === 0 ? page.width : page.height;
        expect(observation.arc[0]! / observation.pageBox.width).toBeCloseTo(expectedCenter.x, 3);
        expect(observation.arc[1]! / observation.pageBox.height).toBeCloseTo(expectedCenter.y, 3);
        expect(observation.arc[2]! / observation.pageBox.width).toBeCloseTo(
          normalizedPenRadius * page.width / orientationWidth,
          3
        );
      }
      expect(highMagnification.pageBox.width).toBeGreaterThan(second.pageBox.width);
      expect(zoomedOut.pageBox.width).toBeLessThan(first.pageBox.width);
      expect(zoomedInAgain.pageBox.width).toBeGreaterThan(zoomedOut.pageBox.width);
      expect(restored.pageBox.width).toBeCloseTo(page.width, 2);
      expect(rotated90.pageBox.width).toBeCloseTo(page.height * 3.5, 2);
      expect(rotated180.pageBox.width).toBeCloseTo(page.width * 0.5, 2);
      expect(rotated270.pageBox.width).toBeCloseTo(page.height * 2, 2);
      expect(committedStrokes(session)).toEqual([stroke, ...pinchStrokes]);

      // Drive the real PDF.js adapter and ink session past the desktop backing
      // edge/area cap. Raster resolution may fall, but page-space ink geometry
      // must remain page-relative and the backing store must remain bounded.
      const restoreDpr = overrideDevicePixelRatio(3);
      try {
        const capped = await repaintAtScale(5);
        await vi.waitFor(() => expect(pdfCanvas.width).toBeGreaterThan(MAX_INK_EDGE_PX), {
          timeout: 5_000,
          interval: 20
        });
        const cappedSurface = internal.surfaces.get(1)!;
        const cappedLayer = cappedSurface.inkLayer!;
        expect(cappedLayer.width).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
        expect(cappedLayer.height).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
        expect(cappedLayer.width * cappedLayer.height).toBeLessThanOrEqual(MAX_INK_PIXELS + MAX_INK_EDGE_PX * 2);
        expect(cappedSurface.inkLayerBackingScale).toBeLessThan(3);
        expect(cappedSurface.inkLayerBackingScale).toBeCloseTo(
          cappedLayer.width / stylePixels(pageShell, "width", page.width),
          3
        );
        expect(capped.arc[0]! / capped.pageBox.width).toBeCloseTo(normalizedCenterX, 3);
        expect(capped.arc[1]! / capped.pageBox.height).toBeCloseTo(normalizedCenterY, 3);
        expect(capped.arc[2]! / capped.pageBox.width).toBeCloseTo(normalizedPenRadius, 3);
      } finally {
        restoreDpr();
      }

      // Verify the production zoom diagnostics normalize by the temporary CSS
      // projection, not by total zoom. At a native 2x render the projection is
      // 1x, so the logged anchor must still match its page-relative position.
      session.setViewerState({
        viewport: { ...session.getViewerState().viewport, scale: 2, x: 0, y: 0 },
        scale: 2,
        scaleMode: "custom"
      });
      await vi.waitFor(() => {
        expect(adapter.getViewState().scale).toBeCloseTo(2, 4);
        expect(internal.handwritingViewport.getRenderedScale()).toBeCloseTo(2, 4);
      }, { timeout: 5_000, interval: 20 });

      const cssWidthBeforeDisplayMove = stylePixels(pageShell, "width", page.width);
      const inkBeforeDisplayMove = internal.surfaces.get(1) as {
        inkLayer: HTMLCanvasElement | null;
      } | undefined;
      const previousInkLayer = inkBeforeDisplayMove?.inkLayer ?? null;
      const previousInkPaintCount = previousInkLayer ? canvasArcCalls.get(previousInkLayer)?.length ?? 0 : 0;
      const restoreDisplayDpr = overrideDevicePixelRatio(2);
      try {
        window.dispatchEvent(new Event("resize"));
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1) as {
            inkLayer: HTMLCanvasElement | null;
            inkLayerBackingScale: number | null;
            inkLayerValid: boolean;
          } | undefined;
          expect(adapter.getViewState().scale).toBeCloseTo(2, 4);
          expect(stylePixels(pageShell, "width", page.width)).toBeCloseTo(cssWidthBeforeDisplayMove, 2);
          expect(pdfCanvas.width).toBeCloseTo(cssWidthBeforeDisplayMove * 2, 0);
          expect(current?.inkLayerBackingScale).toBeCloseTo(2, 2);
          expect(current?.inkLayer?.width).toBeCloseTo(cssWidthBeforeDisplayMove * 2, 0);
          expect(current?.inkLayerValid).toBe(true);
          const calls = current?.inkLayer ? canvasArcCalls.get(current.inkLayer) : undefined;
          const repaintStart = current?.inkLayer === previousInkLayer ? previousInkPaintCount : 0;
          const repainted = calls?.slice(repaintStart) ?? [];
          expect(repainted.length).toBeGreaterThan(0);
          const displayPageBox = getPageBox();
          expect(repainted[0]?.[0]! / displayPageBox.width).toBeCloseTo(normalizedCenterX, 3);
          expect(repainted[0]?.[1]! / displayPageBox.height).toBeCloseTo(normalizedCenterY, 3);
        }, { timeout: 5_000, interval: 20 });
        expect(committedStrokes(session)[0]).toEqual(stroke);
      } finally {
        restoreDisplayDpr();
      }

      const zoomDetails: Array<Record<string, unknown>> = [];
      const logger = (session as unknown as {
        logger: {
          isEnabled: () => boolean;
          zoomInkLayout: (pageNumber: number, phase: string, details: Record<string, unknown>) => void;
        };
        logZoomInkLayout(
          surface: unknown,
          phase: "burst" | "settle" | "native-content" | "handoff-final",
          layout?: unknown,
          geometry?: { contentRect: DOMRect; overlayRect: DOMRect }
        ): void;
        surfaces: Map<number, unknown>;
      }).logger;
      const logZoomInkLayout = (session as unknown as {
        logZoomInkLayout: (
          surface: unknown,
          phase: "burst" | "settle" | "native-content" | "handoff-final",
          layout?: unknown,
          geometry?: { contentRect: DOMRect; overlayRect: DOMRect }
        ) => void;
        surfaces: Map<number, unknown>;
      });
      vi.spyOn(logger, "isEnabled").mockReturnValue(true);
      vi.spyOn(logger, "zoomInkLayout").mockImplementation((_page, _phase, details) => zoomDetails.push(details));
      logZoomInkLayout.logZoomInkLayout(logZoomInkLayout.surfaces.get(1), "handoff-final", undefined, {
        contentRect: getPageBox(),
        overlayRect: getPageBox()
      });
      const loggedAnchor = zoomDetails[0]?.anchor as { normalizedX: number; normalizedY: number } | null;
      expect(loggedAnchor?.normalizedX).toBeCloseTo(normalizedCenterX, 3);
      expect(loggedAnchor?.normalizedY).toBeCloseTo(normalizedCenterY, 3);
    } finally {
      await session.destroy({ silent: true });
    }
  }, 30_000);

  it("keeps image ink in natural-image coordinates while the native image element changes size", async () => {
    installCanvasContexts();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    TestResizeObserver.instances.splice(0);
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
    let liveSession: ViewerInkSession | null = null;
    const adapter = ImageViewAdapter.attach(host, {
      onPagesChanged: (reason) => liveSession?.onPagesChanged(reason)
    });
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
    liveSession = session;
    const pageElement = adapter.root;
    const overlay = pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    if (!overlay) throw new Error("ViewerInkSession did not mount the image annotation surface");
    setRect(pageElement, getImageBox);
    setRect(overlay, getImageBox);

    let restoreDpr: (() => void) | null = null;
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

      const internal = session as unknown as {
        surfaces: Map<number, {
          canvas: HTMLCanvasElement;
          inkLayer: HTMLCanvasElement | null;
          inkLayerValid: boolean;
          inkLayerBackingScale: number;
        }>;
      };
      const initialSurface = internal.surfaces.get(1);
      if (!initialSurface?.inkLayer) throw new Error("ViewerInkSession did not create the image ink backing");
      const previousLayer = initialSurface.inkLayer;
      const previousHeight = previousLayer.height;
      const previousCalls = canvasArcCalls.get(previousLayer);
      if (previousCalls) previousCalls.length = 0;
      const retained = committedStrokes(session)[0]!;
      restoreDpr = overrideDevicePixelRatio(2);

      // A native image load/resize changes display geometry while existing
      // sidecar points remain in natural-image coordinates.
      image.style.width = "2400px";
      image.style.height = "1600px";
      image.dispatchEvent(new Event("load"));
      await vi.waitFor(() => {
        expect(adapter.page(1)?.scale).toBeCloseTo(2, 4);
        const current = internal.surfaces.get(1);
        expect(current?.inkLayer).not.toBeNull();
        expect(current?.inkLayerValid).toBe(true);
        expect(current?.inkLayer?.height).toBeGreaterThan(previousHeight);
        expect(canvasArcCalls.get(current!.inkLayer!)?.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
      expect(committedStrokes(session)[0]).toEqual(retained);
      const resizedSurface = internal.surfaces.get(1)!;
      const resizedArc = canvasArcCalls.get(resizedSurface.inkLayer!)?.[0];
      expect(resizedArc?.[0]! / 2400).toBeCloseTo(fraction.x, 3);
      expect(resizedArc?.[1]! / 1600).toBeCloseTo(fraction.y, 3);
      expect(resizedSurface.inkLayerBackingScale).toBeCloseTo(
        resizedSurface.inkLayer!.width / stylePixels(pageElement, "width", 2400),
        3
      );
      expect(resizedSurface.inkLayerBackingScale).toBeCloseTo(2, 3);

      const imageResizeObserver = TestResizeObserver.instances.find((observer) => observer.observed.has(image));
      if (!imageResizeObserver) throw new Error("ImageViewAdapter did not observe the native image size");
      const previousObserverLayer = resizedSurface.inkLayer!;
      const previousObserverCalls = canvasArcCalls.get(previousObserverLayer)?.length ?? 0;
      // Container/layout changes can resize a native image without a load
      // event. Drive the adapter's actual ResizeObserver callback path.
      image.style.width = "1200px";
      image.style.height = "800px";
      imageResizeObserver.notify(image);
      await vi.waitFor(() => {
        expect(adapter.page(1)?.scale).toBeCloseTo(1, 4);
        const current = internal.surfaces.get(1);
        expect(current?.inkLayer).not.toBeNull();
        expect(current?.inkLayerValid).toBe(true);
        expect(current?.inkLayerBackingScale).toBeCloseTo(2, 3);
        expect(current?.inkLayer?.width).toBe(2400);
        expect(current?.inkLayer?.height).toBe(1600);
        const calls = current?.inkLayer ? canvasArcCalls.get(current.inkLayer) : undefined;
        const repaintStart = current?.inkLayer === previousObserverLayer ? previousObserverCalls : 0;
        const repainted = calls?.slice(repaintStart) ?? [];
        expect(repainted.length).toBeGreaterThan(0);
        expect(repainted[0]?.[0]! / 1200).toBeCloseTo(fraction.x, 3);
        expect(repainted[0]?.[1]! / 800).toBeCloseTo(fraction.y, 3);
      }, { timeout: 5_000, interval: 20 });
      expect(committedStrokes(session)[0]).toEqual(retained);
    } finally {
      restoreDpr?.();
      await session.destroy({ silent: true });
    }
  }, 30_000);

  it("keeps Image toolbar zoom and ink aligned through repeated zoom commands", async () => {
    installCanvasContexts();
    const host = document.createElement("div");
    host.style.overflow = "auto";
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 800 });
    image.style.width = "1200px";
    image.style.height = "800px";
    host.append(image);
    document.body.append(host);

    let liveSession: ViewerInkSession | null = null;
    const adapter = ImageViewAdapter.attach(host, {
      onPagesChanged: (reason) => liveSession?.onPagesChanged(reason)
    });
    const scroll = adapter.scrollElement();
    const baseLeft = 60;
    const baseTop = 80;
    const transform = (): { x: number; y: number; scale: number } => {
      const value = adapter.root.style.transform;
      const translation = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(value);
      const projection = /scale\(([-\d.]+)\)/.exec(value);
      return {
        x: Number(translation?.[1] ?? 0),
        y: Number(translation?.[2] ?? 0),
        scale: Number(projection?.[1] ?? 1)
      };
    };
    const getImageBox = (): DOMRect => {
      const projected = transform();
      return rect(
        baseLeft + projected.x - scroll.scrollLeft,
        baseTop + projected.y - scroll.scrollTop,
        stylePixels(image, "width", image.naturalWidth) * projected.scale,
        stylePixels(image, "height", image.naturalHeight) * projected.scale
      );
    };
    setRect(scroll, () => rect(0, 0, 800, 600));
    installScrollMetrics(scroll, () => getImageBox().width, () => getImageBox().height, 800, 600);
    scroll.scrollLeft = 120;
    scroll.scrollTop = 80;
    setRect(adapter.root, getImageBox);
    setRect(image, getImageBox);

    const session = await createSession(adapter, "Notes/zoom-commands.png");
    liveSession = session;
    const overlay = adapter.root.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    if (!overlay) throw new Error("ViewerInkSession did not mount the image annotation surface");
    setRect(overlay, getImageBox);
    const internal = session as unknown as {
      commandController: { zoomIn(): boolean; zoomOut(): boolean; setZoom(scale: number): boolean };
      ink: { pageRevision(pageNumber: number): number };
      surfaces: Map<number, {
        inkLayer: HTMLCanvasElement | null;
        inkLayerBackingScale: number | null;
        inkLayerValid: boolean;
        inkLayerRevision: number | null;
      }>;
      handwritingViewport: { getRenderedScale(): number };
    };
    const commands = internal.commandController;
    const restoreViewState = vi.spyOn(adapter, "restoreViewState");
    const expectedPoint = { x: image.naturalWidth * 0.22, y: image.naturalHeight * 0.31 };

    try {
      const retained = drawAtPageFraction(session, adapter.root, getImageBox, { x: 0.22, y: 0.31 }, 399);
      expect(retained.points[0]!.x).toBeCloseTo(expectedPoint.x, 2);
      expect(retained.points[0]!.y).toBeCloseTo(expectedPoint.y, 2);
      const viewportCenter = { x: 400, y: 300 };
      const startingBox = getImageBox();
      const anchorFraction = {
        x: (viewportCenter.x - startingBox.left) / startingBox.width,
        y: (viewportCenter.y - startingBox.top) / startingBox.height
      };
      const anchorStroke = drawAtPageFraction(session, adapter.root, getImageBox, anchorFraction, 398);
      let currentScale = 1;
      const targetScales = [
        1.25,
        1.5625,
        1.953125,
        2.44140625,
        3.0517578125,
        3.814697265625,
        4.76837158203125,
        3.814697265625,
        3.0517578125,
        2.44140625,
        1.953125,
        1.5625,
        1.25,
        1
      ];
      for (const [index, targetScale] of targetScales.entries()) {
        const previousLayer = internal.surfaces.get(1)?.inkLayer;
        const previousCalls = previousLayer ? canvasArcCalls.get(previousLayer)?.length ?? 0 : 0;
        if (targetScale > currentScale) commands.zoomIn();
        else commands.zoomOut();
        currentScale = targetScale;

        expect(
          session.getViewerState().viewport.scale,
          `image command iteration ${index} should reach ${targetScale}x`
        ).toBeCloseTo(targetScale, 4);
        expect(adapter.page(1)?.scale, `image layout at iteration ${index}`).toBeCloseTo(targetScale, 4);
        expect(restoreViewState).not.toHaveBeenCalled();
        expect(committedStrokes(session)[0]).toEqual(retained);
        const projectedImage = getImageBox();
        const projection = transform().scale;
        expect(projectedImage.left + anchorStroke.points[0]!.x * projection).toBeCloseTo(viewportCenter.x, 0);
        expect(projectedImage.top + anchorStroke.points[0]!.y * projection).toBeCloseTo(viewportCenter.y, 0);
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          if (!current?.inkLayer || current.inkLayerBackingScale === null) {
            throw new Error(`Image ink backing did not settle at ${targetScale}x`);
          }
          const projectionScale = targetScale / internal.handwritingViewport.getRenderedScale();
          expect(current.inkLayerValid).toBe(true);
          expect(current.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(
            current.inkLayerBackingScale / projectionScale,
            `Image zoom ${targetScale}x; projection=${projectionScale}; backing=${current.inkLayerBackingScale}; viewport=${internal.handwritingViewport.getRenderedScale()}; dpr=${window.devicePixelRatio}`
          ).toBeCloseTo(Math.max(window.devicePixelRatio, 0.5 / projectionScale), 2);
          const calls = canvasArcCalls.get(current.inkLayer) ?? [];
          const repaintCalls = current.inkLayer === previousLayer ? calls.slice(previousCalls) : calls;
          expect(repaintCalls.length).toBeGreaterThan(0);
          expect(repaintCalls[0]?.[0]! / stylePixels(image, "width", image.naturalWidth)).toBeCloseTo(0.22, 2);
          expect(repaintCalls[0]?.[1]! / stylePixels(image, "height", image.naturalHeight)).toBeCloseTo(0.31, 2);
        }, { timeout: 3_000, interval: 20 });
        const stroke = drawAtPageFraction(session, adapter.root, getImageBox, { x: 0.22, y: 0.31 }, 400 + index);
        expect(stroke.points[0]!.x).toBeCloseTo(expectedPoint.x, 2);
        expect(stroke.points[0]!.y).toBeCloseTo(expectedPoint.y, 2);
        const surface = internal.surfaces.get(1);
        if (!surface?.inkLayer || surface.inkLayerBackingScale === null) {
          throw new Error(`Image ink backing disappeared after drawing at ${targetScale}x`);
        }
        const projectionScale = targetScale / internal.handwritingViewport.getRenderedScale();
        expect(surface.inkLayerBackingScale / projectionScale).toBeCloseTo(
          Math.max(window.devicePixelRatio, 0.5 / projectionScale),
          2
        );
        expect(surface.inkLayer.width).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
        expect(surface.inkLayer.height).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
        expect(surface.inkLayer.width * surface.inkLayer.height)
          .toBeLessThanOrEqual(MAX_INK_PIXELS + MAX_INK_EDGE_PX * 2);
      }
      expect(committedStrokes(session)).toHaveLength(targetScales.length + 2);

      // Verify an existing stroke is repainted at the new backing density
      // without drawing another stroke to accidentally refresh the canvas.
      const expectRetainedBackingAtScale = async (scale: number): Promise<void> => {
        const previousLayer = internal.surfaces.get(1)?.inkLayer;
        const previousCallCount = previousLayer ? canvasArcCalls.get(previousLayer)?.length ?? 0 : 0;
        expect(commands.setZoom(scale)).toBe(true);
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          if (!current?.inkLayer || current.inkLayerBackingScale === null) {
            throw new Error("Image ink backing did not settle after zoom");
          }
          const projectionScale = scale / internal.handwritingViewport.getRenderedScale();
          expect(session.getViewerState().viewport.scale).toBeCloseTo(scale, 4);
          expect(committedStrokes(session)[0]).toEqual(retained);
          expect(current.inkLayerValid).toBe(true);
          expect(current.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(current.inkLayerBackingScale / projectionScale).toBeCloseTo(
            Math.max(window.devicePixelRatio, 0.5 / projectionScale),
            2
          );
          expect(current.inkLayer.width).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
          expect(current.inkLayer.height).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
          expect(current.inkLayer.width * current.inkLayer.height)
            .toBeLessThanOrEqual(MAX_INK_PIXELS + MAX_INK_EDGE_PX * 2);
          const calls = canvasArcCalls.get(current.inkLayer) ?? [];
          if (current.inkLayer === previousLayer) {
            expect(calls.length, `retained ink repaint at ${scale}x / DPR ${window.devicePixelRatio}`)
              .toBeGreaterThan(previousCallCount);
          }
          else expect(calls.length).toBeGreaterThan(0);
          expect(calls[0]?.[0]! / stylePixels(image, "width", image.naturalWidth)).toBeCloseTo(0.22, 2);
          expect(calls[0]?.[1]! / stylePixels(image, "height", image.naturalHeight)).toBeCloseTo(0.31, 2);
        }, { timeout: 3_000, interval: 20 });
      };

      await expectRetainedBackingAtScale(5);
      await expectRetainedBackingAtScale(0.25);
      await expectRetainedBackingAtScale(1);
      const beforeDisplayMove = internal.surfaces.get(1)?.inkLayer;
      const beforeDisplayMoveCalls = beforeDisplayMove ? canvasArcCalls.get(beforeDisplayMove)?.length ?? 0 : 0;
      const restoreDisplayDpr = overrideDevicePixelRatio(2);
      try {
        // A display move can change DPR while image layout and source pixels
        // stay fixed; retained ink must be restamped without an image load.
        window.dispatchEvent(new Event("resize"));
        await vi.waitFor(() => {
          const displayChanged = internal.surfaces.get(1);
          expect(displayChanged?.inkLayerBackingScale).toBeCloseTo(2, 2);
          expect(displayChanged?.inkLayer?.width).toBe(2400);
          expect(displayChanged?.inkLayer?.height).toBe(1600);
          expect(displayChanged?.inkLayerValid).toBe(true);
          expect(displayChanged?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          const calls = displayChanged?.inkLayer ? canvasArcCalls.get(displayChanged.inkLayer) : undefined;
          if (displayChanged?.inkLayer === beforeDisplayMove) {
            expect(calls?.length).toBeGreaterThan(beforeDisplayMoveCalls);
          } else {
            expect(calls?.length).toBeGreaterThan(0);
          }
          expect(calls?.[0]?.[0]! / stylePixels(image, "width", image.naturalWidth)).toBeCloseTo(0.22, 2);
          expect(calls?.[0]?.[1]! / stylePixels(image, "height", image.naturalHeight)).toBeCloseTo(0.31, 2);
        }, { timeout: 3_000, interval: 20 });
        expect(committedStrokes(session)[0]).toEqual(retained);
      } finally {
        restoreDisplayDpr();
      }
      expect(restoreViewState).not.toHaveBeenCalled();
    } finally {
      await session.destroy({ silent: true });
    }
  }, 30_000);

  it.each(["preview", "source"] as const)(
    "keeps Markdown ink at the same note position while Obsidian's %s scroller moves",
    async (mode) => {
      installCanvasContexts();
      const restoreDpr = overrideDevicePixelRatio(2);
      const { host, root } = markdownHost(mode);
      let liveSession: ViewerInkSession | null = null;
      const adapter = MarkdownViewAdapter.attach(host, {
        onPagesChanged: (reason) => liveSession?.onPagesChanged(reason)
      }, { mode });
      const width = 800;
      let height = 2_000;
      const viewportHeight = 600;
      installScrollMetrics(root, () => width, () => height, width, viewportHeight);
      setRect(root, () => rect(50, 40, width, viewportHeight));
      const session = await createSession(adapter, `Notes/scroll-${mode}.md`);
      liveSession = session;
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

        const retained = committedStrokes(session)[0]!;
        const internal = session as unknown as {
          surfaces: Map<number, {
            canvas: HTMLCanvasElement;
            inkLayer: HTMLCanvasElement | null;
            inkLayerValid: boolean;
            inkLayerBackingScale: number;
            inkLayerRevision: number;
          }>;
          ink: { pageRevision(pageNumber: number): number };
        };
        const initialSurface = internal.surfaces.get(1);
        if (!initialSurface?.inkLayer) throw new Error("ViewerInkSession did not create the Markdown ink backing");
        const previousLayer = initialSurface.inkLayer;
        const previousCanvasHeight = initialSurface.canvas.height;
        const previousCalls = canvasArcCalls.get(previousLayer);
        if (previousCalls) previousCalls.length = 0;

        // Markdown content growth must resize and repaint the note-wide layer
        // without moving its existing page-coordinate stroke.
        height = 4_000;
        const addedContent = document.createElement("p");
        addedContent.textContent = "content appended below existing ink";
        root.append(addedContent);
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          expect(current?.canvas.height).toBeGreaterThan(previousCanvasHeight);
          expect(current?.inkLayer).not.toBeNull();
          expect(current?.inkLayerValid).toBe(true);
          expect(current?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(canvasArcCalls.get(current!.inkLayer!)?.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });
        expect(committedStrokes(session)[0]).toEqual(retained);
        const resizedSurface = internal.surfaces.get(1)!;
        expect(resizedSurface.inkLayerBackingScale).toBeCloseTo(2, 3);
        expect(resizedSurface.inkLayer!.width).toBeCloseTo(width * 2, 0);
        expect(resizedSurface.inkLayer!.height).toBeCloseTo(height * 2, 0);
        const reflowArc = canvasArcCalls.get(resizedSurface.inkLayer!)?.[0];
        expect(reflowArc?.[0]! / width).toBeCloseTo(retained.points[0]!.x / width, 3);
        expect(reflowArc?.[1]! / height).toBeCloseTo(retained.points[0]!.y / height, 3);
      } finally {
        await session.destroy({ silent: true });
        restoreDpr();
      }
    }, 30_000
  );

  it.each([
    { mode: "preview", action: "zoom-in" },
    { mode: "preview", action: "zoom-out" },
    { mode: "preview", action: "fit-width" },
    { mode: "source", action: "zoom-in" },
    { mode: "source", action: "zoom-out" },
    { mode: "source", action: "fit-width" }
  ] as const)(
    "keeps $mode Markdown ink anchored after toolbar $action with native scroll",
    async ({ mode, action }) => {
      installCanvasContexts();
      const { host, root } = markdownHost(mode);
      const width = 1_200;
      const height = 2_000;
      const viewportWidth = 800;
      const viewportHeight = 600;
      const origin = { x: 50, y: 40 };
      installScrollMetrics(root, () => width, () => height, viewportWidth, viewportHeight);

      const transform = (): { x: number; y: number; scale: number } => {
        const value = root.style.transform;
        const translation = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(value);
        const scale = /scale\(([-\d.]+)\)/.exec(value);
        return {
          x: Number(translation?.[1] ?? 0),
          y: Number(translation?.[2] ?? 0),
          scale: Number(scale?.[1] ?? 1)
        };
      };
      const getPageBox = (): DOMRect => {
        const projection = transform();
        return rect(
          origin.x + projection.x - root.scrollLeft * projection.scale,
          origin.y + projection.y - root.scrollTop * projection.scale,
          width * projection.scale,
          height * projection.scale
        );
      };
      setRect(root, () => {
        const projection = transform();
        return rect(
          origin.x + projection.x,
          origin.y + projection.y,
          viewportWidth * projection.scale,
          viewportHeight * projection.scale
        );
      });

      let liveSession: ViewerInkSession | null = null;
      const adapter = MarkdownViewAdapter.attach(host, {
        onPagesChanged: (reason) => liveSession?.onPagesChanged(reason)
      }, { mode });
      const session = await createSession(adapter, `Notes/toolbar-zoom-${mode}-${action}.md`);
      liveSession = session;
      const overlay = root.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
      if (!overlay) throw new Error("ViewerInkSession did not mount the Markdown annotation surface");
      setRect(overlay, getPageBox);

      try {
        const viewportCenter = {
          x: origin.x + viewportWidth / 2,
          y: origin.y + viewportHeight / 2
        };

        // JSDOM does not perform browser default scrolling. Confirm the native
        // events remain uncanceled, then model the scroll the browser applies.
        const wheel = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 80,
          clientX: viewportCenter.x,
          clientY: viewportCenter.y
        });
        root.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(false);
        root.scrollLeft = 200;
        root.scrollTop = 360;
        root.dispatchEvent(new Event("scroll"));

        const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
        Object.defineProperty(touchMove, "touches", {
          value: [{ clientX: viewportCenter.x, clientY: viewportCenter.y }]
        });
        root.dispatchEvent(touchMove);
        expect(touchMove.defaultPrevented).toBe(false);
        root.scrollLeft = 240;
        root.scrollTop = 400;
        root.dispatchEvent(new Event("scroll"));
        expect(root.scrollLeft).toBe(240);
        expect(root.scrollTop).toBe(400);

        const drawAtCenter = (pointerId: number): InkStroke => {
          const before = committedStrokes(session).length;
          root.dispatchEvent(pointer("pointerdown", viewportCenter.x, viewportCenter.y, pointerId));
          root.dispatchEvent(pointer("pointermove", viewportCenter.x + 2, viewportCenter.y + 2, pointerId));
          root.dispatchEvent(pointer("pointerup", viewportCenter.x + 2, viewportCenter.y + 2, pointerId));
          const stroke = committedStrokes(session)[before];
          if (!stroke) throw new Error("Markdown toolbar zoom test did not commit its pointer stroke");
          return stroke;
        };
        const retained = drawAtCenter(610);
        const pointOnScreen = (point: { x: number; y: number }): { x: number; y: number } => {
          const box = getPageBox();
          const projectionScale = transform().scale;
          return {
            x: box.left + point.x * projectionScale,
            y: box.top + point.y * projectionScale
          };
        };
        expect(pointOnScreen(retained.points[0]!)).toEqual(viewportCenter);

        const startScale = session.getViewerState().viewport.scale;
        const pageWidth = adapter.page(1)?.width ?? width;
        const targetScale = action === "zoom-in"
          ? Math.min(10, startScale * VIEWER_ZOOM_STEP)
          : action === "zoom-out"
            ? Math.max(0.1, startScale / VIEWER_ZOOM_STEP)
            : Math.max(0.1, Math.min(10, (root.clientWidth - 32) / pageWidth));

        const activateToolbarAction = (toolbarAction: string): void => {
          // Exercise the visible More menu and its actual toolbar action wiring.
          const more = document.querySelector<HTMLButtonElement>('[data-control="more"]');
          if (!more) throw new Error("Markdown annotation toolbar did not expose its More menu");
          more.click();
          const option = document.querySelector<HTMLButtonElement>(`[data-option-id="${toolbarAction}"]`);
          if (!option) throw new Error(`Markdown toolbar did not expose the ${toolbarAction} action`);
          option.click();
        };
        activateToolbarAction(action);

        await vi.waitFor(() => {
          expect(session.getViewerState().viewport.scale).toBeCloseTo(targetScale, 4);
        }, { timeout: 3_000, interval: 20 });

        if (width * targetScale > viewportWidth) {
          expect.soft(root.scrollLeft).toBeGreaterThan(0);
        } else {
          expect.soft(root.scrollLeft).toBe(0);
        }
        expect.soft(root.scrollTop).toBeGreaterThan(0);
        const viewport = session.viewportState();
        expect.soft(pointOnScreen(retained.points[0]!).x).toBeCloseTo(
          origin.x + viewport.x + retained.points[0]!.x * viewport.scale,
          1
        );
        expect.soft(pointOnScreen(retained.points[0]!).y).toBeCloseTo(
          origin.y + viewport.y + retained.points[0]!.y * viewport.scale,
          1
        );

        const newStroke = drawAtCenter(611);
        expect.soft(newStroke.points[0]!.x).toBeCloseTo(
          (viewportCenter.x - origin.x - viewport.x) / viewport.scale,
          1
        );
        expect.soft(newStroke.points[0]!.y).toBeCloseTo(
          (viewportCenter.y - origin.y - viewport.y) / viewport.scale,
          1
        );
        expect.soft(committedStrokes(session)[0]).toEqual(retained);

        // Repeated direction changes and fit-width expose stale scroll/zoom
        // centers and transformed DOM sizes that a single command cannot.
        let verifiedNativeScrollAfterZoom = false;
        for (const [index, stressAction] of ["zoom-in", "zoom-out", "fit-width", "zoom-in", "zoom-out"].entries()) {
          const currentScale = session.getViewerState().viewport.scale;
          const currentPageWidth = adapter.page(1)?.width ?? width;
          const nextScale = stressAction === "zoom-in"
            ? Math.min(10, currentScale * VIEWER_ZOOM_STEP)
            : stressAction === "zoom-out"
              ? Math.max(0.1, currentScale / VIEWER_ZOOM_STEP)
              : Math.max(0.1, Math.min(10, (root.clientWidth - 32) / currentPageWidth));
          activateToolbarAction(stressAction);
          await vi.waitFor(() => {
            expect(session.getViewerState().viewport.scale).toBeCloseTo(nextScale, 4);
          }, { timeout: 3_000, interval: 20 });

          const stressViewport = session.viewportState();
          const stressPage = adapter.page(1);
          expect(stressPage?.width).toBe(width);
          expect(stressPage?.height).toBe(height);
          expect(pointOnScreen(retained.points[0]!).x).toBeCloseTo(
            origin.x + stressViewport.x + retained.points[0]!.x * stressViewport.scale,
            1
          );
          expect(pointOnScreen(retained.points[0]!).y).toBeCloseTo(
            origin.y + stressViewport.y + retained.points[0]!.y * stressViewport.scale,
            1
          );

          if (!verifiedNativeScrollAfterZoom) {
            const wheel = new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaY: 40,
              clientX: viewportCenter.x,
              clientY: viewportCenter.y
            });
            root.dispatchEvent(wheel);
            expect(wheel.defaultPrevented).toBe(false);
            const beforeScroll = session.viewportState();
            const previousLeft = root.scrollLeft;
            const previousTop = root.scrollTop;
            root.scrollLeft = previousLeft + 17;
            root.scrollTop = previousTop + 23;
            const deltaLeft = root.scrollLeft - previousLeft;
            const deltaTop = root.scrollTop - previousTop;
            root.dispatchEvent(new Event("scroll"));
            const afterScroll = session.viewportState();
            expect(afterScroll.x).toBeCloseTo(beforeScroll.x - deltaLeft * afterScroll.scale, 1);
            expect(afterScroll.y).toBeCloseTo(beforeScroll.y - deltaTop * afterScroll.scale, 1);
            expect(pointOnScreen(retained.points[0]!).x).toBeCloseTo(
              origin.x + afterScroll.x + retained.points[0]!.x * afterScroll.scale,
              1
            );
            expect(pointOnScreen(retained.points[0]!).y).toBeCloseTo(
              origin.y + afterScroll.y + retained.points[0]!.y * afterScroll.scale,
              1
            );
            verifiedNativeScrollAfterZoom = true;
          }

          const stressStroke = drawAtCenter(700 + index);
          const finalViewport = session.viewportState();
          expect(stressStroke.points[0]!.x).toBeCloseTo(
            (viewportCenter.x - origin.x - finalViewport.x) / finalViewport.scale,
            1
          );
          expect(stressStroke.points[0]!.y).toBeCloseTo(
            (viewportCenter.y - origin.y - finalViewport.y) / finalViewport.scale,
            1
          );
          expect(committedStrokes(session)[0]).toEqual(retained);
        }
        expect(verifiedNativeScrollAfterZoom).toBe(true);
      } finally {
        await session.destroy({ silent: true });
      }
    },
    30_000
  );

  it.each(["preview", "source"] as const)(
    "keeps $mode Markdown ink backing density current through zoom limits and display changes",
    async (mode) => {
      installCanvasContexts();
      const restoreDpr = overrideDevicePixelRatio(1);
      const { host, root } = markdownHost(mode);
      const width = 640;
      const height = 1_200;
      const viewportWidth = 500;
      const viewportHeight = 500;
      const origin = { x: 30, y: 50 };
      installScrollMetrics(root, () => width, () => height, viewportWidth, viewportHeight);
      const content = mode === "source"
        ? root.querySelector<HTMLElement>(".cm-content")
        : document.createElement("div");
      if (!content) throw new Error("Markdown quality test did not create note content");
      content.textContent = Array.from({ length: 80 }, (_, index) => `Rendered note line ${index + 1}`).join("\n");
      content.style.width = `${width}px`;
      content.style.height = `${height}px`;
      if (mode === "preview") root.append(content);

      const readTransform = (): { x: number; y: number; scale: number } => {
        const value = root.style.transform;
        const translation = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(value);
        const scale = /scale\(([-\d.]+)\)/.exec(value);
        return {
          x: Number(translation?.[1] ?? 0),
          y: Number(translation?.[2] ?? 0),
          scale: Number(scale?.[1] ?? 1)
        };
      };
      const getPageBox = (): DOMRect => {
        const projection = readTransform();
        return rect(
          origin.x + projection.x - root.scrollLeft * projection.scale,
          origin.y + projection.y - root.scrollTop * projection.scale,
          width * projection.scale,
          height * projection.scale
        );
      };
      setRect(root, () => {
        const projection = readTransform();
        return rect(
          origin.x + projection.x,
          origin.y + projection.y,
          viewportWidth * projection.scale,
          viewportHeight * projection.scale
        );
      });

      let liveSession: ViewerInkSession | null = null;
      const adapter = MarkdownViewAdapter.attach(host, {
        onPagesChanged: (reason) => liveSession?.onPagesChanged(reason)
      }, { mode });
      const session = await createSession(adapter, `Notes/markdown-zoom-quality-${mode}.md`);
      liveSession = session;
      const overlay = root.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
      if (!overlay) throw new Error("ViewerInkSession did not mount the Markdown quality overlay");
      setRect(overlay, getPageBox);
      const internal = session as unknown as {
        commandController: { setZoom(scale: number): boolean };
        handwritingViewport: { getRenderedScale(): number };
        ink: { pageRevision(pageNumber: number): number };
        surfaces: Map<number, {
          canvas: HTMLCanvasElement;
          inkLayer: HTMLCanvasElement | null;
          inkLayerBackingScale: number | null;
          inkLayerValid: boolean;
          inkLayerRevision: number | null;
        }>;
      };

      try {
        const fraction = { x: 0.27, y: 0.33 };
        const retained = drawAtPageFraction(session, root, getPageBox, fraction, 9_310);
        expect(retained.points[0]!.x).toBeCloseTo(width * fraction.x, 2);
        expect(retained.points[0]!.y).toBeCloseTo(height * fraction.y, 2);

        const stressSteps = [
          { scale: 0.25, dpr: 1 },
          { scale: 1, dpr: 1 },
          { scale: 5, dpr: 1 },
          { scale: 10, dpr: 2 },
          { scale: 0.1, dpr: 3 },
          { scale: 5, dpr: 3 },
          { scale: 1, dpr: 2 }
        ];
        let currentDpr = 1;
        for (const [index, step] of stressSteps.entries()) {
          const previousLayer = internal.surfaces.get(1)?.inkLayer;
          const previousCalls = previousLayer ? canvasArcCalls.get(previousLayer)?.length ?? 0 : 0;
          if (step.dpr !== currentDpr) {
            Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: step.dpr });
            window.dispatchEvent(new Event("resize"));
            currentDpr = step.dpr;
          }
          expect(internal.commandController.setZoom(step.scale)).toBe(true);

          await vi.waitFor(() => {
            const surface = internal.surfaces.get(1);
            if (!surface?.inkLayer || surface.inkLayerBackingScale === null) {
              throw new Error(`${mode} Markdown ink backing did not settle at step ${index}`);
            }
            expect(session.getViewerState().viewport.scale).toBeCloseTo(step.scale, 4);
            expect(surface.inkLayerValid).toBe(true);
            expect(surface.inkLayerRevision).toBe(internal.ink.pageRevision(1));
            const projectionScale = step.scale / internal.handwritingViewport.getRenderedScale();
            const budget = markdownInkBackingBudget(false);
            const expected = inkBackingSize(
              width,
              height,
              step.dpr * projectionScale,
              budget.maxEdge,
              budget.maxPixels
            );
            expect(surface.inkLayerBackingScale).toBeCloseTo(expected.backingScale, 3);
            expect(surface.inkLayer.width).toBe(expected.pixelWidth);
            expect(surface.inkLayer.height).toBe(expected.pixelHeight);
            expect(surface.canvas.width).toBe(expected.pixelWidth);
            expect(surface.canvas.height).toBe(expected.pixelHeight);
            const calls = canvasArcCalls.get(surface.inkLayer) ?? [];
            if (surface.inkLayer === previousLayer) {
              expect(calls.length, `${mode} retained ink repaint at ${step.scale}x / DPR ${step.dpr}`)
                .toBeGreaterThan(previousCalls);
            } else {
              expect(calls.length).toBeGreaterThan(0);
            }
            expect(calls[0]?.[0]).toBeCloseTo(retained.points[0]!.x, 2);
            expect(calls[0]?.[1]).toBeCloseTo(retained.points[0]!.y, 2);
          }, { timeout: 5_000, interval: 20 });

          if (step.scale === 5 && index === 2) {
            const wheel = new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaY: 50,
              clientX: origin.x + viewportWidth / 2,
              clientY: origin.y + viewportHeight / 2
            });
            root.dispatchEvent(wheel);
            expect(wheel.defaultPrevented).toBe(false);
            root.scrollLeft = 80;
            root.scrollTop = 160;
            root.dispatchEvent(new Event("scroll"));
            const viewport = session.viewportState();
            const projection = readTransform();
            const box = getPageBox();
            expect(box.left + retained.points[0]!.x * projection.scale).toBeCloseTo(
              origin.x + viewport.x + retained.points[0]!.x * viewport.scale,
              1
            );
            expect(box.top + retained.points[0]!.y * projection.scale).toBeCloseTo(
              origin.y + viewport.y + retained.points[0]!.y * viewport.scale,
              1
            );
          }
          expect(committedStrokes(session)[0]).toEqual(retained);
        }
      } finally {
        await session.destroy({ silent: true });
        restoreDpr();
      }
    }, 30_000
  );

  it.each(["preview", "source"] as const)(
    "sizes %s Markdown ink from its owning popout window's device pixel ratio",
    async (mode) => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const popoutWindow = frame.contentWindow as (Window & typeof globalThis) | null;
      const popoutDocument = frame.contentDocument;
      if (!popoutWindow || !popoutDocument) throw new Error("Could not create the Markdown popout test document");

      const restoreAmbientDpr = overrideDevicePixelRatio(1);
      const restorePopoutDpr = overrideDevicePixelRatio(2, popoutWindow);
      // The test runner shares the parent realm, while Obsidian loads each
      // popout's plugin code inside that popout window.
      vi.stubGlobal("AbortController", popoutWindow.AbortController);
      installCanvasContexts(popoutWindow);
      let session: ViewerInkSession | null = null;
      try {
        const { host, root } = markdownHost(mode, popoutDocument);
        const width = 640;
        const height = 600;
        installScrollMetrics(root, () => width, () => height, width, 600);
        setRect(root, () => rect(0, 0, width, 600));
        const adapter = MarkdownViewAdapter.attach(host, {}, { mode });
        session = await createSession(adapter, `Notes/popout-${mode}.md`);
        const internal = session as unknown as {
          surfaces: Map<number, {
            canvas: HTMLCanvasElement;
            inkLayer: HTMLCanvasElement | null;
            inkLayerBackingScale: number;
          }>;
        };
        const surface = internal.surfaces.get(1);
        if (!surface?.inkLayer) throw new Error("ViewerInkSession did not create the popout Markdown ink backing");
        expect(surface.canvas.width).toBe(width * 2);
        expect(surface.canvas.height).toBe(height * 2);
        expect(surface.inkLayer.width).toBe(width * 2);
        expect(surface.inkLayer.height).toBe(height * 2);
        expect(surface.inkLayerBackingScale).toBe(2);

        session.setViewerState({
          viewport: { ...session.getViewerState().viewport, scale: 2, x: 0, y: 0 },
          scale: 2,
          scaleMode: "custom"
        });
        await vi.waitFor(() => {
          const current = internal.surfaces.get(1);
          if (!current?.inkLayer) throw new Error("Markdown zoom lost its retained ink backing");
          expect(current.inkLayerBackingScale / 2).toBeCloseTo(2, 1);
        }, { timeout: 3_000, interval: 20 });

        const restoreChangedDpr = overrideDevicePixelRatio(3, popoutWindow);
        try {
          // A popout display move changes only the owner window's DPR. The
          // zoomed Markdown backing must repaint at the new screen density.
          popoutWindow.dispatchEvent(new popoutWindow.Event("resize"));
          await vi.waitFor(() => {
            const current = internal.surfaces.get(1);
            if (!current?.inkLayer) throw new Error("Markdown display change lost its ink backing");
            expect(current.inkLayerBackingScale / 2).toBeCloseTo(3, 1);
            expect(current.inkLayer.width).toBeCloseTo(width * 6, 0);
            expect(current.inkLayer.height).toBeCloseTo(height * 6, 0);
          }, { timeout: 3_000, interval: 20 });
        } finally {
          restoreChangedDpr();
        }
      } finally {
        if (session) await session.destroy({ silent: true });
        restorePopoutDpr();
        restoreAmbientDpr();
        frame.remove();
      }
    }, 30_000
  );

  it.each(["preview", "source"] as const)(
    "repaints %s Markdown ink after an existing content block resizes without DOM mutation",
    async (mode) => {
      installCanvasContexts();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      TestResizeObserver.instances.splice(0);
      const restoreDpr = overrideDevicePixelRatio(1);
      const { host, root } = markdownHost(mode);
      const width = 800;
      const viewportHeight = 600;
      let height = 2_000;
      let contentHeight = height;
      const content = mode === "source"
        ? root.querySelector<HTMLElement>(".cm-content")
        : document.createElement("div");
      if (!content) throw new Error("Markdown test host did not expose its content block");
      if (mode === "preview") root.append(content);
      setRect(content, () => rect(0, 0, width, contentHeight));
      installScrollMetrics(root, () => width, () => height, width, viewportHeight);
      setRect(root, () => rect(50, 40, width, viewportHeight));

      let liveSession: ViewerInkSession | null = null;
      const pageChanges: string[] = [];
      const adapter = MarkdownViewAdapter.attach(host, {
        onPagesChanged: (reason) => {
          pageChanges.push(reason);
          liveSession?.onPagesChanged(reason);
        }
      }, { mode });
      const session = await createSession(adapter, `Notes/resize-${mode}.md`);
      liveSession = session;
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
        const stroke = drawAtPageFraction(session, root, getPageBox, { x: 0.2, y: 0.25 }, 320);
        const internal = session as unknown as {
          surfaces: Map<number, {
            canvas: HTMLCanvasElement;
            inkLayer: HTMLCanvasElement | null;
            inkLayerValid: boolean;
            inkLayerRevision: number;
          }>;
          ink: { pageRevision(pageNumber: number): number };
        };
        const before = internal.surfaces.get(1);
        if (!before?.inkLayer) throw new Error("ViewerInkSession did not create the Markdown ink backing");
        const previousCanvasHeight = before.canvas.height;
        const resizeObserver = TestResizeObserver.instances.find((observer) => observer.observed.has(content));
        expect(resizeObserver).toBeDefined();

        // Simulate an image/widget's intrinsic-size or CSS reflow change. The
        // existing element and text stay untouched, so MutationObserver cannot
        // report it; only observation of layout content can refresh the page.
        height = 4_000;
        contentHeight = height;
        resizeObserver!.notify(content);
        await vi.waitFor(() => {
          expect(adapter.page(1)?.height).toBe(height);
          const current = internal.surfaces.get(1);
          expect(current?.canvas.height).toBeGreaterThan(previousCanvasHeight);
          expect(current?.inkLayer).not.toBeNull();
          expect(current?.inkLayerValid).toBe(true);
          expect(current?.inkLayerRevision).toBe(internal.ink.pageRevision(1));
          expect(canvasArcCalls.get(current!.inkLayer!)?.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 20 });
        expect(pageChanges).toContain("markdown-resize");
        expect(committedStrokes(session)[0]).toEqual(stroke);
        const repaintedLayer = internal.surfaces.get(1)!.inkLayer!;
        expect(repaintedLayer.height).toBe(height);
        const repaintedArc = canvasArcCalls.get(repaintedLayer)?.[0];
        expect(repaintedArc?.[0]).toBeCloseTo(stroke.points[0]!.x, 2);
        expect(repaintedArc?.[1]).toBeCloseTo(stroke.points[0]!.y, 2);
      } finally {
        await session.destroy({ silent: true });
        restoreDpr();
      }
    }, 30_000
  );
});
