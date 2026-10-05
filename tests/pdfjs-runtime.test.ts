import { describe, expect, it, vi } from "vitest";
import { createPdfJsAssetResolver, pdfJsDocumentOptions } from "../src/integration/PdfJsRuntime";

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
});
