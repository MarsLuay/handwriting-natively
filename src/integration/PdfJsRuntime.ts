import type { App } from "obsidian";
import * as bundledPdfJs from "pdfjs-dist";

interface PdfJsWorkerClass {
  readonly _setupFakeWorkerGlobal: Promise<unknown>;
  readonly prototype: {
    _initialize(this: PdfJsWorkerInstance): void;
  };
}

interface PdfJsWorkerInstance {
  _setupFakeWorker(): void;
}

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
  /** Resolves named outline destinations to PDF.js explicit destinations. */
  getDestination?(id: string): Promise<readonly unknown[] | null>;
  /** Maps a PDF.js page reference from an explicit destination to a zero-based page index. */
  getPageIndex?(ref: unknown): Promise<number>;
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
  PDFWorker?: PdfJsWorkerClass;
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

let bundledFakeWorkerConfigured = false;
let bundledWorkerMessageHandler: Promise<unknown> | null = null;

type PdfJsWorkerGlobal = Window & { pdfjsWorker?: unknown };

/**
 * pdf.worker.mjs assigns its export namespace to `globalThis.pdfjsWorker` as a
 * module side effect. Intercept that assignment while importing the bundled
 * worker so Obsidian continues to see its own PDF.js handler throughout.
 */
function loadBundledWorkerMessageHandler(): Promise<unknown> {
  if (bundledWorkerMessageHandler) return bundledWorkerMessageHandler;

  const target = window as PdfJsWorkerGlobal;
  const previous = Object.getOwnPropertyDescriptor(target, "pdfjsWorker");
  if (previous && !previous.configurable) {
    throw new Error("Obsidian's PDF.js worker global cannot be isolated");
  }

  const readPrevious = (): unknown => previous?.get
    ? previous.get.call(target)
    : previous?.value;
  const interceptAssignment = (): void => undefined;
  Object.defineProperty(target, "pdfjsWorker", {
    configurable: true,
    enumerable: previous?.enumerable ?? true,
    get: readPrevious,
    set: interceptAssignment
  });

  const restoreGlobal = (): void => {
    const current = Object.getOwnPropertyDescriptor(target, "pdfjsWorker");
    if (current?.get !== readPrevious || current.set !== interceptAssignment) return;
    if (previous) Object.defineProperty(target, "pdfjsWorker", previous);
    else delete target.pdfjsWorker;
  };

  const loading = import("pdfjs-dist/build/pdf.worker.mjs")
    .then((workerModule) => workerModule.WorkerMessageHandler)
    .finally(restoreGlobal);
  bundledWorkerMessageHandler = loading.catch((error: unknown) => {
    bundledWorkerMessageHandler = null;
    bundledFakeWorkerConfigured = false;
    throw error;
  });
  return bundledWorkerMessageHandler;
}

/**
 * Route PDF.js's fake worker to this bundled PDF.js copy. Obsidian has its own
 * PDF.js runtime and reads the same `globalThis.pdfjsWorker` name, so never
 * publish this plugin's worker handler on that shared global.
 */
async function configureBundledFakeWorker(module: PdfJsModule): Promise<void> {
  if (bundledFakeWorkerConfigured) return;
  const workerClass = module.PDFWorker;
  if (!workerClass) throw new Error("Bundled PDF.js worker class is unavailable");
  const descriptor = Object.getOwnPropertyDescriptor(workerClass, "_setupFakeWorkerGlobal");
  if (!descriptor?.configurable) throw new Error("Bundled PDF.js fake worker hook cannot be isolated");
  Object.defineProperty(workerClass, "_setupFakeWorkerGlobal", {
    configurable: true,
    value: loadBundledWorkerMessageHandler(),
    writable: false
  });

  // The one-file plugin bundle has no addressable workerSrc. PDF.js's browser
  // initializer reads that setting before it can fall back to a fake worker,
  // so route this bundled copy directly to its in-process worker.
  const initializeDescriptor = Object.getOwnPropertyDescriptor(workerClass.prototype, "_initialize");
  if (!initializeDescriptor?.configurable) throw new Error("Bundled PDF.js worker initializer cannot be isolated");
  Object.defineProperty(workerClass.prototype, "_initialize", {
    configurable: true,
    value: function (this: PdfJsWorkerInstance): void {
      this._setupFakeWorker();
    },
    writable: true
  });
  bundledFakeWorkerConfigured = true;
}

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
  await configureBundledFakeWorker(module);
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
