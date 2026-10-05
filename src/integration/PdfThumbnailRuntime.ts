import type { App, Menu } from "obsidian";
import type * as ThumbnailModule from "./PdfThumbnailDeleteMenu";

export type PdfThumbnailRuntimeModule = typeof ThumbnailModule;

const DEFAULT_SPECIFIER = "./PdfThumbnailDeleteMenu";
let menuConstructor: typeof Menu | undefined;

function importThumbnailModule(specifier: string): Promise<PdfThumbnailRuntimeModule> {
  return import(/* @vite-ignore */ specifier) as unknown as Promise<PdfThumbnailRuntimeModule>;
}

function configureThumbnailModule(module: PdfThumbnailRuntimeModule): PdfThumbnailRuntimeModule {
  if (menuConstructor) module.configurePdfThumbnailMenu(menuConstructor);
  return module;
}

let loader: () => Promise<PdfThumbnailRuntimeModule> = () => importThumbnailModule(DEFAULT_SPECIFIER).then(configureThumbnailModule);
let loaded: Promise<PdfThumbnailRuntimeModule> | undefined;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function configurePdfThumbnailRuntime(app: App, pluginDir: string, constructor: typeof Menu): void {
  menuConstructor = constructor;
  const adapter = app.vault.adapter as unknown as { getResourcePath?: (path: string) => string };
  if (typeof adapter.getResourcePath !== "function") return;
  const root = normalizePath(`${pluginDir.replace(/[\\/]$/, "")}/pdfjs/pdf-thumbnail-actions.mjs`);
  const resource = adapter.getResourcePath(root);
  if (!resource) return;
  loader = () => importThumbnailModule(resource).then((module) => {
    module.configurePdfThumbnailMenu(menuConstructor!);
    return module;
  });
  loaded = undefined;
}

export async function loadPdfThumbnailRuntime(): Promise<PdfThumbnailRuntimeModule> {
  loaded ??= loader();
  return loaded;
}
