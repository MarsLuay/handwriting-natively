import type { App } from "obsidian";
import * as bundledPdfLib from "pdf-lib";
import type * as PdfLib from "pdf-lib";

export type PdfLibModule = typeof PdfLib;

let loader: () => Promise<PdfLibModule> = () => Promise.resolve(bundledPdfLib);
let loaded: Promise<PdfLibModule> | undefined;

/** Keep the bundled pdf-lib loader explicit at plugin startup. */
export function configurePdfLibRuntime(_app: App, _pluginDir: string): void {
  loader = () => Promise.resolve(bundledPdfLib);
  loaded = undefined;
}

export async function loadPdfLib(): Promise<PdfLibModule> {
  loaded ??= loader();
  return loaded;
}
