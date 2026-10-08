import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfJsViewAdapter } from "../src/integration/PdfJsViewAdapter";
import type { NativePdfToolbarConstructor } from "../src/integration/ObsidianPdfToolbarBridge";
import type { PdfViewerCommandBridge } from "../src/integration/ObsidianPdfAdapter";
import type { InkStroke } from "../src/model";
import { createPdfJsAssetResolver, loadPdfJsRuntime, pdfJsDocumentOptions, type PdfJsRuntime } from "../src/integration/PdfJsRuntime";

interface TestToolbarChild {
  pdfViewer: {
    eventBus: { dispatch(name: string, data?: Record<string, unknown>): void };
    pdfSidebar: { switchView(view: number, force?: boolean): void };
  };
}

class TestPdfToolbar {
  static readonly instances: TestPdfToolbar[] = [];
  readonly toolbarEl: HTMLElement;
  readonly toolbarRightEl: HTMLElement;
  readonly setPageNumber = vi.fn();
  readonly setPagesCount = vi.fn();
  readonly setPageScale = vi.fn();

  constructor(_app: unknown, host: HTMLElement, child: TestToolbarChild) {
    const doc = host.ownerDocument;
    const bus = child.pdfViewer.eventBus;
    this.toolbarEl = doc.createElement("div");
    this.toolbarEl.className = "pdf-toolbar";
    const button = (label: string, event?: string, data: Record<string, unknown> = {}): HTMLButtonElement => {
      const element = doc.createElement("button");
      element.setAttribute("aria-label", label);
      if (event) element.addEventListener("click", () => bus.dispatch(event, data));
      this.toolbarEl.append(element);
      return element;
    };
    button("Toggle sidebar", "togglesidebar");
    button("Show thumbnails").addEventListener("click", () => child.pdfViewer.pdfSidebar.switchView(1, true));
    button("Show outline").addEventListener("click", () => child.pdfViewer.pdfSidebar.switchView(2, true));
    button("Zoom out", "zoomout");
    button("Zoom in", "zoomin");
    button("Fit width", "scalechanged", { value: "page-width" });
    button("Fit height", "scalechanged", { value: "page-height" });
    button("Go to page 2", "pagenumberchanged", { value: "2" });
    const pageInput = doc.createElement("input");
    pageInput.setAttribute("aria-label", "Page number");
    pageInput.addEventListener("change", () => bus.dispatch("pagenumberchanged", { value: pageInput.value }));
    this.toolbarEl.append(pageInput);
    this.toolbarRightEl = doc.createElement("div");
    this.toolbarRightEl.className = "pdf-toolbar-right";
    this.toolbarEl.append(this.toolbarRightEl);
    host.prepend(this.toolbarEl);
    TestPdfToolbar.instances.push(this);
  }
}

const testToolbarConstructor = TestPdfToolbar as unknown as NativePdfToolbarConstructor;

function testApp(readBinary: () => Promise<ArrayBuffer> = async () => new ArrayBuffer(4)) {
  return { vault: { readBinary }, loadLocalStorage: () => null } as never;
}

describe("plugin-owned PDF.js runtime boundary", () => {
  const originalDevicePixelRatio = window.devicePixelRatio;

  afterEach(() => {
    document.body.replaceChildren();
    TestPdfToolbar.instances.length = 0;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: originalDevicePixelRatio });
    vi.restoreAllMocks();
  });

  it("resolves every runtime asset below the configured plugin directory", () => {
    const getResourcePath = vi.fn((path: string) => `app://local/${path}`);
    const app = { vault: { adapter: { getResourcePath } } } as never;
    const assets = createPdfJsAssetResolver(app, ".obsidian/plugins/handwriting-natively");

    expect(assets.root).toBe(".obsidian/plugins/handwriting-natively/pdfjs");
    expect(assets.resolve("pdf.worker.mjs")).toBe("app://local/.obsidian/plugins/handwriting-natively/pdfjs/pdf.worker.mjs");
    expect(getResourcePath).toHaveBeenCalledWith(".obsidian/plugins/handwriting-natively/pdfjs/pdf.worker.mjs");
  });

  it("loads a self-contained runtime for BRAT installs", async () => {
    const runtime = await loadPdfJsRuntime({} as never, ".obsidian/plugins/handwriting-natively");
    expect(runtime.assets.embedded).toBe(true);
    expect(typeof runtime.module.getDocument).toBe("function");

    const options = pdfJsDocumentOptions(runtime.assets, new Uint8Array([37, 80, 68, 70]));
    expect(options.disableWorker).toBe(true);
    expect(options.useWorkerFetch).toBe(false);
    expect(options.cMapUrl).toBeUndefined();
    expect(options.standardFontDataUrl).toBeUndefined();

    const samplePdf = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
      0x0a, 0x31, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f, 0x54, 0x79,
      0x70, 0x65, 0x2f, 0x43, 0x61, 0x74, 0x61, 0x6c, 0x6f, 0x67, 0x2f, 0x50, 0x61, 0x67,
      0x65, 0x73, 0x20, 0x32, 0x20, 0x30, 0x20, 0x52, 0x3e, 0x3e, 0x0a, 0x65, 0x6e, 0x64,
      0x6f, 0x62, 0x6a, 0x0a, 0x32, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c,
      0x2f, 0x54, 0x79, 0x70, 0x65, 0x2f, 0x50, 0x61, 0x67, 0x65, 0x73, 0x2f, 0x4b, 0x69,
      0x64, 0x73, 0x5b, 0x33, 0x20, 0x30, 0x20, 0x52, 0x5d, 0x2f, 0x43, 0x6f, 0x75, 0x6e,
      0x74, 0x20, 0x31, 0x3e, 0x3e, 0x0a, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x33,
      0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65,
      0x2f, 0x50, 0x61, 0x67, 0x65, 0x2f, 0x50, 0x61, 0x72, 0x65, 0x6e, 0x74, 0x20, 0x32,
      0x20, 0x30, 0x20, 0x52, 0x2f, 0x4d, 0x65, 0x64, 0x69, 0x61, 0x42, 0x6f, 0x78, 0x5b,
      0x30, 0x20, 0x30, 0x20, 0x31, 0x30, 0x30, 0x20, 0x31, 0x30, 0x30, 0x5d, 0x3e, 0x3e,
      0x0a, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x78, 0x72, 0x65, 0x66, 0x0a, 0x30,
      0x20, 0x34, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20,
      0x36, 0x35, 0x35, 0x33, 0x35, 0x20, 0x66, 0x20, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30,
      0x30, 0x30, 0x30, 0x31, 0x35, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6e, 0x20,
      0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x36, 0x38, 0x20, 0x30, 0x30,
      0x30, 0x30, 0x30, 0x20, 0x6e, 0x20, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30,
      0x31, 0x32, 0x35, 0x20, 0x30, 0x30, 0x30, 0x30, 0x30, 0x20, 0x6e, 0x20, 0x0a, 0x74,
      0x72, 0x61, 0x69, 0x6c, 0x65, 0x72, 0x0a, 0x3c, 0x3c, 0x2f, 0x53, 0x69, 0x7a, 0x65,
      0x20, 0x34, 0x2f, 0x52, 0x6f, 0x6f, 0x74, 0x20, 0x31, 0x20, 0x30, 0x20, 0x52, 0x3e,
      0x3e, 0x0a, 0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66, 0x0a, 0x31, 0x39,
      0x33, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a
    ]);
    const task = runtime.module.getDocument(pdfJsDocumentOptions(runtime.assets, samplePdf));
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    await doc.destroy?.();
  });

  it("keeps parsing data and auxiliary font/map assets local", () => {
    const assets = {
      root: "pdfjs",
      resolve: (asset: string) => `app://local/pdfjs/${asset}`
    };
    const data = new Uint8Array([37, 80, 68, 70]);
    const options = pdfJsDocumentOptions(assets, data);

    expect(options.data).toBe(data);
    expect(options.cMapUrl).toBe("app://local/pdfjs/cmaps/");
    expect(options.standardFontDataUrl).toBe("app://local/pdfjs/standard_fonts/");
    expect(options.wasmUrl).toBe("app://local/pdfjs/wasm/");
    expect(options.useWorkerFetch).toBe(true);
    expect(options.isEvalSupported).toBe(false);
  });

  it("hosts native navigation in Obsidian's PDF toolbar and keeps plugin zoom and PDF actions", async () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const page = {
      getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => ({
        width: rotation === 90 ? 800 * scale : 600 * scale,
        height: rotation === 90 ? 600 * scale : 800 * scale,
        scale,
        rotation: rotation ?? 0,
        viewBox: [0, 0, 600, 800],
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale] as [number, number]
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({ items: [
        { str: "Hello", transform: [1, 0, 0, 12, 10, 20] },
        { str: "toolbar", transform: [1, 0, 0, 12, 30, 20] }
      ] }),
      getAnnotations: async () => []
    };
    const getPage = vi.fn(async (_pageNumber: number) => page);
    const getPageIndex = vi.fn(async (ref: unknown) => ((ref as { num?: number }).num === 1 ? 1 : 0));
    const pdfDocument = {
      numPages: 2,
      getPage,
      getOutline: async () => [
        { title: "Chapter 1", dest: [{ num: 0, gen: 0 }] },
        { title: "Chapter 2", dest: "second" }
      ],
      getDestination: async (id: string) => id === "second" ? [{ num: 1, gen: 0 }] : null,
      getPageIndex
    };
    const runtime: PdfJsRuntime = {
      module: { getDocument: () => ({ promise: Promise.resolve(pdfDocument) }) },
      assets: { root: "pdfjs", resolve: (asset) => `app://local/pdfjs/${asset}` }
    };
    const app = testApp();
    const file = { name: "toolbar.pdf" } as never;
    const host = document.createElement("div");
    document.body.append(host);

    const adapter = await PdfJsViewAdapter.create({ app, file, pluginDir: "pdfjs", host, runtime, toolbarConstructor: testToolbarConstructor });
    expect(getPage.mock.calls.filter(([pageNumber]) => pageNumber === 1)).toHaveLength(1);
    expect(host.querySelector(".pdf-toolbar")).not.toBeNull();
    expect(host.querySelector(".hn-owned-pdf-navigation")).toBeNull();
    expect(host.querySelector('[role="button"][aria-label="Print PDF"]')).not.toBeNull();
    expect(host.querySelector('[role="button"][aria-label="Download PDF"]')).not.toBeNull();
    expect(host.querySelector('[role="button"][aria-label="Presentation mode"]')).not.toBeNull();
    expect(host.querySelector('select[aria-label="Zoom"]')).not.toBeNull();

    host.querySelector('button[aria-label="Show thumbnails"]')?.dispatchEvent(new Event("click"));
    expect(host.querySelectorAll(".hn-owned-pdf-thumbnail")).toHaveLength(2);
    const previewStroke: InkStroke = {
      id: "preview-stroke",
      page: 1,
      tool: "pen",
      color: "#000000",
      width: 2,
      opacity: 1,
      inputType: "pen",
      points: [{ x: 20, y: 20, pressure: 1, time: 1 }, { x: 100, y: 100, pressure: 1, time: 2 }],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01"
    };
    adapter.setInkPreviewProvider((pageNumber) => ({
      revision: 1,
      strokes: pageNumber === 1 ? [previewStroke] : []
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((host.querySelector(".hn-owned-pdf-thumbnail-ink") as HTMLCanvasElement | null)?.hidden).toBe(false);
    host.querySelector('button[aria-label="Show outline"]')?.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outlinePreviews = [...host.querySelectorAll<HTMLCanvasElement>(".hn-owned-pdf-outline-ink")];
    expect(outlinePreviews).toHaveLength(2);
    expect(outlinePreviews[0]?.hidden).toBe(false);
    expect(outlinePreviews[1]?.hidden).toBe(true);
    expect(getPageIndex).toHaveBeenCalledTimes(2);

    const pageInput = host.querySelector('input[aria-label="Page number"]') as HTMLInputElement;
    pageInput.value = "2";
    pageInput.dispatchEvent(new Event("change"));
    expect(adapter.getViewState().pageNumber).toBe(2);

    const zoom = host.querySelector('select[aria-label="Zoom"]') as HTMLSelectElement;
    zoom.value = "2";
    zoom.dispatchEvent(new Event("change"));
    expect(adapter.getViewState().scale).toBe(2);

    host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
    expect(adapter.getViewState().scale).toBe(2.5);
    host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')?.click();
    expect(adapter.getViewState().scale).toBe(2);

    host.querySelector('[role="button"][aria-label="Rotate clockwise"]')?.dispatchEvent(new Event("click"));
    expect(adapter.getViewState().rotation).toBe(90);

    host.querySelector('[role="button"][aria-label="Find in document"]')?.dispatchEvent(new Event("click"));
    const find = host.querySelector('input[aria-label="Find in document"]') as HTMLInputElement;
    find.value = "hello toolbar";
    find.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector(".hn-owned-pdf-find-status")?.textContent).toContain("match");
    expect(host.querySelectorAll(".is-find-match")).toHaveLength(4);

    const commands: PdfViewerCommandBridge = {
      zoomIn: vi.fn(() => true),
      zoomOut: vi.fn(() => true),
      setZoom: vi.fn(() => true),
      fitWidth: vi.fn(() => true),
      nextPage: vi.fn(() => true),
      previousPage: vi.fn(() => true),
      goToPage: vi.fn(() => true),
      rotateClockwise: vi.fn(() => true),
      rotateCounterclockwise: vi.fn(() => true),
      toggleHandMode: vi.fn(() => true),
      isHandMode: vi.fn(() => false),
      toggleSearch: vi.fn(() => true),
      closeSearch: vi.fn(() => true),
      handleKeyDown: vi.fn(() => false)
    };
    adapter.setViewerCommandBridge(commands);
    host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
    host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')?.click();
    host.querySelector<HTMLButtonElement>('button[aria-label="Fit width"]')?.click();
    host.querySelector('[role="button"][aria-label="Next page"]')?.dispatchEvent(new Event("click"));
    host.querySelector('[role="button"][aria-label="Previous page"]')?.dispatchEvent(new Event("click"));
    host.querySelector('[role="button"][aria-label="Rotate clockwise"]')?.dispatchEvent(new Event("click"));
    host.querySelector('[role="button"][aria-label="Rotate counterclockwise"]')?.dispatchEvent(new Event("click"));
    host.querySelector('[role="button"][aria-label="Find in document"]')?.dispatchEvent(new Event("click"));
    host.querySelector('[role="button"][aria-label="Hand tool"]')?.dispatchEvent(new Event("click"));
    pageInput.value = "1";
    pageInput.dispatchEvent(new Event("change"));
    zoom.value = "1.5";
    zoom.dispatchEvent(new Event("change"));
    adapter.root.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true, cancelable: true }));
    adapter.root.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));

    expect(commands.zoomIn).toHaveBeenCalledTimes(2);
    expect(commands.zoomOut).toHaveBeenCalledTimes(1);
    expect(commands.fitWidth).toHaveBeenCalledOnce();
    expect(commands.nextPage).toHaveBeenCalledTimes(2);
    expect(commands.previousPage).toHaveBeenCalledOnce();
    expect(commands.goToPage).toHaveBeenCalledWith(1);
    expect(commands.setZoom).toHaveBeenCalledWith(1.5);
    expect(commands.rotateClockwise).toHaveBeenCalledOnce();
    expect(commands.rotateCounterclockwise).toHaveBeenCalledOnce();
    expect(commands.toggleSearch).toHaveBeenCalledOnce();
    expect(commands.toggleHandMode).toHaveBeenCalledOnce();
    expect(commands.handleKeyDown).toHaveBeenCalledTimes(2);
    adapter.setHandToolActive(true);
    expect(host.querySelector('[role="button"][aria-label="Hand tool"]')?.getAttribute("aria-pressed")).toBe("true");

    adapter.destroy();
    host.remove();
    getContext.mockRestore();
  });

  it("destroys the loading task when document initialization fails", async () => {
    const destroy = vi.fn();
    const runtime: PdfJsRuntime = {
      module: { getDocument: () => ({ promise: Promise.reject(new Error("invalid PDF")), destroy }) },
      assets: { root: "pdfjs", resolve: (asset) => `app://local/pdfjs/${asset}` }
    };
    const app = testApp();
    const host = document.createElement("div");
    document.body.append(host);

    await expect(PdfJsViewAdapter.create({
      app, file: { name: "broken.pdf" } as never, pluginDir: "pdfjs", host, runtime, toolbarConstructor: testToolbarConstructor
    })).rejects.toThrow("invalid PDF");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("renders at device scale and rerenders after zoom invalidates an active render", async () => {
    const context = {} as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const renderOptions: Array<{ transform?: readonly number[] }> = [];
    let resolveFirstRender!: () => void;
    let renderCount = 0;
    const firstCancel = vi.fn();
    const page = {
      getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => ({
        width: rotation === 90 ? 800 * scale : 600 * scale,
        height: rotation === 90 ? 600 * scale : 800 * scale,
        scale,
        rotation: rotation ?? 0,
        viewBox: [0, 0, 600, 800],
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale] as [number, number]
      }),
      render: (options: { transform?: readonly number[] }) => {
        renderOptions.push(options);
        renderCount += 1;
        if (renderCount === 1) return { promise: new Promise<void>((resolve) => { resolveFirstRender = resolve; }), cancel: firstCancel };
        return { promise: Promise.resolve(), cancel: vi.fn() };
      },
      getTextContent: async () => ({ items: [] }),
      getAnnotations: async () => []
    };
    const pdfDocument = { numPages: 1, getPage: vi.fn(async () => page), getOutline: async () => [] };
    const runtime: PdfJsRuntime = {
      module: { getDocument: () => ({ promise: Promise.resolve(pdfDocument) }) },
      assets: { root: "pdfjs", resolve: (asset) => `app://local/pdfjs/${asset}` }
    };
    const host = document.createElement("div");
    document.body.append(host);
    const creating = PdfJsViewAdapter.create({
      app: testApp(),
      file: { name: "zoom.pdf" } as never, pluginDir: "pdfjs", host, runtime, toolbarConstructor: testToolbarConstructor
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    host.querySelector('button[aria-label="Zoom in"]')?.dispatchEvent(new Event("click"));
    resolveFirstRender();
    const adapter = await creating;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(renderOptions[0]?.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(renderCount).toBeGreaterThanOrEqual(2);
    expect(adapter.getViewState().scale).toBeGreaterThan(1);
    adapter.destroy();
  });
});
