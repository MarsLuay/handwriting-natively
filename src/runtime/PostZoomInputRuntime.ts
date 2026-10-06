import * as bundledPostZoomInputModule from "./PostZoomInputTrace";
import type * as PostZoomInputModule from "./PostZoomInputTrace";

export type PostZoomInputRuntimeModule = typeof PostZoomInputModule;

let loader: () => Promise<PostZoomInputRuntimeModule> = () => Promise.resolve(
  bundledPostZoomInputModule
);
let loaded: Promise<PostZoomInputRuntimeModule> | undefined;

export function configurePostZoomInputRuntime(_app: { vault: { adapter: unknown } }, _pluginDir: string): void {
  loader = () => Promise.resolve(bundledPostZoomInputModule);
  loaded = undefined;
}

export async function loadPostZoomInputRuntime(): Promise<PostZoomInputRuntimeModule> {
  loaded ??= loader();
  return loaded;
}
