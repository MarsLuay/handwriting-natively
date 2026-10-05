import type { App } from "obsidian";

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
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }): PdfJsRenderTask;
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
  resolve(asset: string): string;
}

export interface PdfJsRuntime {
  readonly module: PdfJsModule;
  readonly assets: PdfJsAssetResolver;
}

const ASSET_ROOT = "pdfjs";

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

/** Load only the version-pinned, locally packaged PDF.js display runtime. */
export async function loadPdfJsRuntime(app: App, pluginDir: string, supplied?: PdfJsRuntime): Promise<PdfJsRuntime> {
  if (supplied) return supplied;
  const assets = createPdfJsAssetResolver(app, pluginDir);
  // The specifier is derived solely from the plugin manifest directory and is
  // never user-controlled. Keeping it dynamic prevents esbuild bundling PDF.js.
  // eslint-disable-next-line no-unsanitized/method -- import is restricted to the packaged plugin asset.
  const module = await import(/* @vite-ignore */ assets.resolve("pdf.mjs")) as unknown as PdfJsModule;
  if (!module || typeof module.getDocument !== "function") throw new Error("Packaged PDF.js display runtime is unavailable");
  if (module.GlobalWorkerOptions) module.GlobalWorkerOptions.workerSrc = assets.resolve("pdf.worker.mjs");
  return { module, assets };
}

function directoryAsset(assets: PdfJsAssetResolver, directory: string): string {
  const path = assets.resolve(directory);
  return path.endsWith("/") ? path : `${path}/`;
}

export function pdfJsDocumentOptions(assets: PdfJsAssetResolver, data: Uint8Array): Record<string, unknown> {
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
