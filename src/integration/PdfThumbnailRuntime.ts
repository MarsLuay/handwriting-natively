import type { App, Menu } from "obsidian";
import * as bundledThumbnailModule from "./PdfThumbnailDeleteMenu";
import type * as ThumbnailModule from "./PdfThumbnailDeleteMenu";

export type PdfThumbnailRuntimeModule = typeof ThumbnailModule;

let menuConstructor: typeof Menu | undefined;

function configureThumbnailModule(module: PdfThumbnailRuntimeModule): PdfThumbnailRuntimeModule {
  if (menuConstructor) module.configurePdfThumbnailMenu(menuConstructor);
  return module;
}

let loader: () => Promise<PdfThumbnailRuntimeModule> = () => Promise.resolve(
  configureThumbnailModule(bundledThumbnailModule)
);
let loaded: Promise<PdfThumbnailRuntimeModule> | undefined;

export function configurePdfThumbnailRuntime(_app: App, _pluginDir: string, constructor: typeof Menu): void {
  menuConstructor = constructor;
  loader = () => Promise.resolve(configureThumbnailModule(bundledThumbnailModule));
  loaded = undefined;
}

export async function loadPdfThumbnailRuntime(): Promise<PdfThumbnailRuntimeModule> {
  loaded ??= loader();
  return loaded;
}
