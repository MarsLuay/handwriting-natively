import type * as PostZoomInputModule from "./PostZoomInputTrace";

export type PostZoomInputRuntimeModule = typeof PostZoomInputModule;

const DEFAULT_SPECIFIER = "./PostZoomInputTrace";
let loader: () => Promise<PostZoomInputRuntimeModule> = () => import(DEFAULT_SPECIFIER) as unknown as Promise<PostZoomInputRuntimeModule>;
let loaded: Promise<PostZoomInputRuntimeModule> | undefined;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function configurePostZoomInputRuntime(app: { vault: { adapter: unknown } }, pluginDir: string): void {
  const adapter = app.vault.adapter as { getResourcePath?: (path: string) => string };
  if (typeof adapter.getResourcePath !== "function") return;
  const root = normalizePath(`${pluginDir.replace(/[\\/]$/, "")}/pdfjs/post-zoom-input.mjs`);
  const resource = adapter.getResourcePath(root);
  if (!resource) return;
  loader = () => import(/* @vite-ignore */ resource) as unknown as Promise<PostZoomInputRuntimeModule>;
  loaded = undefined;
}

export async function loadPostZoomInputRuntime(): Promise<PostZoomInputRuntimeModule> {
  loaded ??= loader();
  return loaded;
}
