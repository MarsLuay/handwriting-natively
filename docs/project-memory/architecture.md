# Architecture

- `src/main.ts` is the plugin entrypoint. It composes direct and embedded PDF adapters, per-view `ViewerInkSession` instances, settings, storage, recovery, PDF services, and vault debug logging.
- `src/integration/` owns undocumented Obsidian PDF objects, DOM selectors, viewer discovery, compatibility probes, page location, and cleanup. `src/focus-view/` handles embedded annotate chrome and opening a PDF leaf.
- `src/input/`, `src/ink/`, `src/tools/`, `src/history/`, and `src/ui/` implement shared pointer policy, page-space ink, tool behavior, edit history, and toolbar/dropdown UI. Both viewing routes consume the same session/engine behavior.
- `src/storage/` owns document identity, versioned sidecars, autosave/manual save coordination, recovery, and vault writes. Sidecar JSON is the documented canonical editable annotation store; recovery is separate.
- `src/pdf/` creates blank PDFs, inserts/deletes pages, maps coordinates, and exports annotated copies. Explicit page insertion/deletion/import/scan actions rewrite the open source PDF through `writePdfAndAnnotationStoresAtomic`; export writes a separate copy.
- Each attached viewer owns a disposable session. Close, note switching, and unload flush persistence, release captures/listeners, remove overlays, restore integration state, and release viewer references.
- `esbuild.config.mjs` bundles `src/main.ts` to `main.js`, externalizing `obsidian`, `electron`, and Node built-ins; production mode minifies and copies the plugin artifacts to the vault plugin directory.
