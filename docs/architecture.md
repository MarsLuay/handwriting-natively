# Architecture

Handwriting Natively adds one annotation system to Obsidian's direct and embedded document experiences. PDF pages, one-page image surfaces, and Markdown Reading/editing surfaces implement the same `AnnotationSurface` contract, so all share input policy, tools, toolbar, history, sidecar storage, autosave, and recovery. The Markdown adapter mounts outside CodeMirror's editable content and maps the full scrollable note. Native typing, selection, keyboard input, wheel/touch scrolling, and hand-tool movement remain with Obsidian on Markdown. PDF export, page mutation, PDF.js find integration, and thumbnail actions are optional PDF surface extensions rather than requirements of the shared runtime. Direct PDFs default to the plugin-owned `PluginPdfView` and `PdfJsViewAdapter`; that adapter owns the PDF document, page rendering, navigation state, and page lifecycle. PDF, image, and Markdown sessions use one draggable floating `AnnotationToolbar`, with a persisted horizontal or vertical orientation. Each toolbar lives in a document-level fixed portal outside view clipping and transform contexts; an `IntersectionObserver` hides it when its owner view is not visible. Existing native PDF leaves are adopted with their page, zoom, position, and rotation state preserved. Embedded PDFs keep their existing host-owned viewer.

## Boundaries

- `integration/`: only owner of undocumented Obsidian PDF objects, DOM selectors, PDF.js compatibility probes, viewer discovery, page location, and reversible patches. The plugin leaves Obsidian's global `.pdf` extension mapping intact for Markdown embeds; direct PDF leaves select `PluginPdfView` explicitly or migrate to it during the normal leaf scan.
- `focus-view/`: embed Annotate chrome and helpers that open a PDF leaf (not a private-class viewer).
- `input/`: Pointer Events policy. Confirmed stylus input annotates by default; mouse annotation and touch drawing are opt-in, and touch drawing is disabled after confirmed stylus evidence. Committed text boxes retain a narrow touch-edit route. `GestureNavigationController` owns stylus hand-pan, active-stylus companion-touch blocking, and capability-gated mobile PDF pan/pinch. Unsupported surfaces keep native navigation. PDF modifier-wheel zoom remains in `PdfJsViewAdapter`; image zoom and viewport projection remain in `ViewerInkSession` and `HandwritingViewport`. See `docs/input-gesture-architecture.md`.
- `runtime/AnnotationSurface.ts`: the minimal page-surface contract (`AnnotationPageInfo`, page-local geometry, view/scroll lifecycle, overlay/UI mounting, and teardown). PDF capability extensions live in `integration/ObsidianPdfAdapter.ts` and are never required by the shared runtime. `surfaceType` distinguishes PDF, image, and Markdown content without changing the direct/embedded host distinction.
- `ink/`: strokes, filtering, rendering, simplification, hit testing. Coordinates use page-local document space for every surface.
- `tools/`: tool state and behavior. Preferences stay outside annotation documents.
- `storage/`: versioned sidecars, identity, serialized autosave, manual save, recovery, atomic writes.
- `pdf/`: PDF-only page transforms, explicit source-PDF page mutations, coordinate mapping, and annotated-copy export.
- `history/`: commands used by edits, undo, redo, autosave scheduling.
- `ui/`: one accessible toolbar and dropdown system shared by PDF, image, and Markdown routes.

Private viewer changes should require edits only in `integration/`. Engine tests run without Obsidian. The input ownership decision and physical iPadOS evidence boundary are documented in `docs/input-gesture-architecture.md`; the remaining issue gates are tracked in `docs/issue-resolution-matrix.md`.

## Canonical data

Sidecar JSON is canonical editable annotation data. Screen coordinates are transient. Annotation edits remain sidecar-only. Explicit Add page, Delete page, Import page, and Scan document actions rewrite the open source PDF together with remapped sidecar/recovery stores through one compensating transaction. `Export PDF` still creates a separate annotated copy.

## Lifecycle

Each attached viewer owns one disposable session. Closing PDF, removing embed, switching note, or unloading plugin performs this order:

1. stop accepting new edits;
2. release pointer capture;
3. close dropdowns and overlays;
4. flush autosave, or request save/discard/cancel when manual mode is dirty;
5. disconnect observers and listeners;
6. restore patches;
7. release viewer references.

## First use

Open PDF, select Pen, Pencil, Highlighter, or Laser. Pen/pencil/highlighter persist to the sidecar. Laser trails fade away after a short hold and are never saved. Confirmed stylus input annotates directly. Mouse annotation and finger drawing can be enabled separately; a toolbar control returns mouse input to native selection. One-finger touch double-tap switches between the eraser and the previous tool. Qualified mobile PDF pages use custom pan/pinch navigation, while unsupported surfaces keep native gestures. Active stylus input blocks companion touch from scrolling beneath a stroke. Status reads `Saved`, `Saving…`, `Unsaved changes`, or `Save failed`.

## Coordinate and input invariants

- Persisted annotation geometry is page-local document data; viewport CSS pixels, scroll offsets, zoom, rotation, and device-pixel-ratio are render-time inputs only.
- Pointer Events are the authoritative input stream when available. `GestureOwnership` tracks stylus and opt-in mouse annotation contacts; `GestureNavigationController` owns touch navigation, stylus hand-pan, and active-stylus companion-touch blocking. Losing pointer capture alone does not release active-pen exclusion. `touch-action: none` is limited to a qualified mobile PDF surface or an active stylus guard.
- The shared toolbar always floats with a drag handle. Its More menu rotates it between horizontal and vertical layouts; the orientation persists across sessions. Session teardown aborts drag listeners.
- Viewer/page generations invalidate stale async work. A replacement page is revalidated before an overlay accepts input.
- A non-PDF surface may expose only page geometry and lifecycle. The shared session does not require PDF.js objects, PDF selectors, native text layers, or source-PDF mutation callbacks.

## Offline behavior

Core use needs no account, telemetry, hosted service, CDN, or remote AI. Sidecars, settings, recovery, backups, and exports remain inside vault/device storage. Package installation may require downloading dependencies; operation after installation is local.
