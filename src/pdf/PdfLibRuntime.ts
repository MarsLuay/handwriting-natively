import type { App } from "obsidian";
import type * as PdfLib from "pdf-lib";

export type PdfLibModule = typeof PdfLib;

let loader: () => Promise<PdfLibModule> = () => import("pdf-lib") as unknown as Promise<PdfLibModule>;
let loaded: Promise<PdfLibModule> | undefined;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Configure the packaged, local-only pdf-lib runtime used by production builds. */
export function configurePdfLibRuntime(app: App, pluginDir: string): void {
  const adapter = app.vault.adapter as unknown as { getResourcePath?: (path: string) => string };
  if (typeof adapter.getResourcePath !== "function") return;
  const root = normalizePath(`${pluginDir.replace(/[\\/]$/, "")}/pdfjs/pdf-lib.mjs`);
  const resource = adapter.getResourcePath(root);
  if (!resource) return;
  loader = () => import(/* @vite-ignore */ resource) as unknown as Promise<PdfLibModule>;
  loaded = undefined;
}

export async function loadPdfLib(): Promise<PdfLibModule> {
  loaded ??= loader();
  return loaded;
}
