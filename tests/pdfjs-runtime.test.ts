import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfJsViewAdapter } from "../src/integration/PdfJsViewAdapter";
import type { InkStroke } from "../src/model";
import { createPdfJsAssetResolver, loadPdfJsRuntime, pdfJsDocumentOptions, type PdfJsRuntime } from "../src/integration/PdfJsRuntime";

describe("plugin-owned PDF.js runtime boundary", () => {
  const originalDevicePixelRatio = window.devicePixelRatio;

  afterEach(() => {
    document.body.replaceChildren();
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

  it("exposes stock navigation, zoom, rotation, and document search controls", async () => {
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
    const pdfDocument = {
      numPages: 2,
      getPage,
      getOutline: async () => [{ title: "Chapter 1", dest: [0] }]
    };
    const runtime: PdfJsRuntime = {
      module: { getDocument: () => ({ promise: Promise.resolve(pdfDocument) }) },
      assets: { root: "pdfjs", resolve: (asset) => `app://local/pdfjs/${asset}` }
    };
    const app = { vault: { readBinary: async () => new ArrayBuffer(4) } } as never;
    const file = { name: "toolbar.pdf" } as never;
    const host = document.createElement("div");
    document.body.append(host);

    const adapter = await PdfJsViewAdapter.create({ app, file, pluginDir: "pdfjs", host, runtime });
    expect(getPage.mock.calls.filter(([pageNumber]) => pageNumber === 1)).toHaveLength(1);
    expect(host.querySelector('button[aria-label="Print PDF"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Download PDF"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Presentation mode"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Toggle thumbnails"]')).not.toBeNull();
    expect(host.querySelector('select[aria-label="Zoom"]')).not.toBeNull();

    host.querySelector('button[aria-label="Toggle thumbnails"]')?.dispatchEvent(new Event("click"));
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
    host.querySelector('button[aria-label="Toggle outline"]')?.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((host.querySelector(".hn-owned-pdf-outline-ink") as HTMLCanvasElement | null)?.hidden).toBe(false);

    const pageInput = host.querySelector('input[aria-label="Page number"]') as HTMLInputElement;
    pageInput.value = "2";
    pageInput.dispatchEvent(new Event("change"));
    expect(adapter.getViewState().pageNumber).toBe(2);

    const zoom = host.querySelector('select[aria-label="Zoom"]') as HTMLSelectElement;
    zoom.value = "2";
    zoom.dispatchEvent(new Event("change"));
    expect(adapter.getViewState().scale).toBe(2);

    host.querySelector('button[aria-label="Rotate clockwise"]')?.dispatchEvent(new Event("click"));
    expect(adapter.getViewState().rotation).toBe(90);

    host.querySelector('button[aria-label="Find in document"]')?.dispatchEvent(new Event("click"));
    const find = host.querySelector('input[aria-label="Find in document"]') as HTMLInputElement;
    find.value = "hello toolbar";
    find.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector(".hn-owned-pdf-find-status")?.textContent).toContain("match");
    expect(host.querySelectorAll(".is-find-match")).toHaveLength(4);

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
    const app = { vault: { readBinary: async () => new ArrayBuffer(4) } } as never;
    const host = document.createElement("div");
    document.body.append(host);

    await expect(PdfJsViewAdapter.create({
      app, file: { name: "broken.pdf" } as never, pluginDir: "pdfjs", host, runtime
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
      app: { vault: { readBinary: async () => new ArrayBuffer(4) } } as never,
      file: { name: "zoom.pdf" } as never, pluginDir: "pdfjs", host, runtime
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
