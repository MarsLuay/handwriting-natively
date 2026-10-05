import { describe, expect, it, vi } from "vitest";
import { PdfJsViewAdapter } from "../src/integration/PdfJsViewAdapter";
import { createPdfJsAssetResolver, pdfJsDocumentOptions, type PdfJsRuntime } from "../src/integration/PdfJsRuntime";

describe("plugin-owned PDF.js runtime boundary", () => {
  it("resolves every runtime asset below the configured plugin directory", () => {
    const getResourcePath = vi.fn((path: string) => `app://local/${path}`);
    const app = { vault: { adapter: { getResourcePath } } } as never;
    const assets = createPdfJsAssetResolver(app, ".obsidian/plugins/handwriting-natively");

    expect(assets.root).toBe(".obsidian/plugins/handwriting-natively/pdfjs");
    expect(assets.resolve("pdf.worker.mjs")).toBe("app://local/.obsidian/plugins/handwriting-natively/pdfjs/pdf.worker.mjs");
    expect(getResourcePath).toHaveBeenCalledWith(".obsidian/plugins/handwriting-natively/pdfjs/pdf.worker.mjs");
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
    const context = {} as CanvasRenderingContext2D;
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
      getTextContent: async () => ({ items: [{ str: "Hello toolbar" }] }),
      getAnnotations: async () => []
    };
    const pdfDocument = {
      numPages: 2,
      getPage: async () => page,
      getOutline: async () => []
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
    expect(host.querySelector('button[aria-label="Print PDF"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Download PDF"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Presentation mode"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Toggle thumbnails"]')).not.toBeNull();
    expect(host.querySelector('select[aria-label="Zoom"]')).not.toBeNull();

    host.querySelector('button[aria-label="Toggle thumbnails"]')?.dispatchEvent(new Event("click"));
    expect(host.querySelectorAll(".hn-owned-pdf-thumbnail")).toHaveLength(2);

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
    find.value = "toolbar";
    find.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector(".hn-owned-pdf-find-status")?.textContent).toContain("match");

    adapter.destroy();
    host.remove();
    getContext.mockRestore();
  });
});
