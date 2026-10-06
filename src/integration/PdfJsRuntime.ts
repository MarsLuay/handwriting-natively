import type { App } from "obsidian";
import * as bundledPdfJs from "pdfjs-dist";

export interface PdfJsViewport {
  width: number;
  height: number;
  scale: number;
  rotation: number;
  viewBox: readonly number[];
  transform: readonly number[];
  convertToViewportPoint?(x: number, y: number): [number, number];
  convertToViewportRectangle?(rect: readonly number[]): [number, number, number, number];
}

export interface PdfJsRenderTask {
  promise: Promise<unknown>;
  cancel?(): void;
}

export interface PdfJsTextItem {
  str?: string;
  transform?: readonly number[];
}

export interface PdfJsTextContent { items?: readonly PdfJsTextItem[]; }

export interface PdfJsAnnotation {
  rect?: readonly number[];
  url?: string;
  unsafeUrl?: string;
  title?: string;
  contents?: string;
  fieldName?: string;
  [key: string]: unknown;
}

export interface PdfJsPageProxy {
  getViewport(options: { scale: number; rotation?: number }): PdfJsViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport; transform?: readonly number[] }): PdfJsRenderTask;
  getTextContent?(): Promise<PdfJsTextContent>;
  getAnnotations?(options?: { intent?: string }): Promise<readonly PdfJsAnnotation[]>;
  cleanup?(): void;
}

export interface PdfJsDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPageProxy>;
  getOutline?(): Promise<readonly unknown[] | null>;
  cleanup?(): Promise<void> | void;
  destroy?(): Promise<void> | void;
}

export interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocumentProxy>;
  destroy?(): Promise<void> | void;
}

export interface PdfJsModule {
  getDocument(options: Record<string, unknown>): PdfJsLoadingTask;
  GlobalWorkerOptions?: { workerSrc: string };
}

export interface PdfJsAssetResolver {
  readonly root: string;
  readonly embedded?: boolean;
  resolve(asset: string): string;
}

export interface PdfJsRuntime {
  readonly module: PdfJsModule;
  readonly assets: PdfJsAssetResolver;
}

const ASSET_ROOT = "pdfjs";

const BUNDLED_ASSETS: PdfJsAssetResolver = {
  root: "embedded",
  embedded: true,
  resolve: (asset) => {
    throw new Error(`PDF.js asset is bundled and cannot be resolved externally: ${asset}`);
  }
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function resourcePath(app: App, path: string): string {
  const adapter = app.vault.adapter as unknown as { getResourcePath?: (path: string) => string };
  if (typeof adapter.getResourcePath !== "function") {
    throw new Error("Obsidian vault adapter cannot resolve PDF.js runtime assets");
  }
  const resource = adapter.getResourcePath(path);
  if (!resource) throw new Error(`PDF.js runtime asset path is unavailable: ${path}`);
  return resource;
}

export function createPdfJsAssetResolver(app: App, pluginDir: string): PdfJsAssetResolver {
  const root = normalizePath(`${pluginDir.replace(/[\\/]$/, "")}/${ASSET_ROOT}`);
  return { root, resolve: (asset) => resourcePath(app, normalizePath(`${root}/${asset}`)) };
}

/** Load the version-pinned PDF.js display runtime bundled in main.js.
 *
 * BRAT installs only main.js, manifest.json, and styles.css from a GitHub
 * release. Keeping the runtime in a separate pdfjs/ directory therefore makes
 * every BRAT install fail as soon as the first PDF is opened.
 */
export async function loadPdfJsRuntime(app: App, pluginDir: string, supplied?: PdfJsRuntime): Promise<PdfJsRuntime> {
  void app;
  void pluginDir;
  if (supplied) return supplied;
  const module = bundledPdfJs as unknown as PdfJsModule;
  if (!module || typeof module.getDocument !== "function") throw new Error("Bundled PDF.js display runtime is unavailable");
  return { module, assets: BUNDLED_ASSETS };
}

function directoryAsset(assets: PdfJsAssetResolver, directory: string): string {
  const path = assets.resolve(directory);
  return path.endsWith("/") ? path : `${path}/`;
}

export function pdfJsDocumentOptions(assets: PdfJsAssetResolver, data: Uint8Array): Record<string, unknown> {
  if (assets.embedded) {
    return {
      data,
      // BRAT cannot install sibling worker/cmap/font files. PDF.js's fake
      // worker keeps the complete runtime self-contained in main.js.
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      stopAtErrors: false
    };
  }
  return {
    data,
    cMapUrl: directoryAsset(assets, "cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: directoryAsset(assets, "standard_fonts/"),
    wasmUrl: directoryAsset(assets, "wasm/"),
    useWorkerFetch: true,
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: false
  };
}
