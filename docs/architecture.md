# Architecture

Handwriting Natively adds one annotation system to Obsidian's direct and embedded document experiences. PDF pages and one-page image surfaces implement the same `AnnotationSurface` contract, so both routes share input policy, tools, toolbar, history, sidecar storage, autosave, and recovery. PDF export, page mutation, PDF.js find integration, and thumbnail actions are optional PDF surface extensions rather than requirements of the shared runtime.

## Boundaries

- `integration/`: only owner of undocumented Obsidian PDF objects, DOM selectors, PDF.js compatibility probes, viewer discovery, page location, and reversible patches.
- `focus-view/`: embed Annotate chrome and helpers that open a PDF leaf (not a private-class viewer).
- `input/`: Pointer Events policy. It decides before capture or `preventDefault()`.
- `runtime/AnnotationSurface.ts`: the minimal page-surface contract (`AnnotationPageInfo`, page-local geometry, view/scroll lifecycle, overlay/UI mounting, and teardown) plus optional PDF capability hooks.
- `ink/`: strokes, filtering, rendering, simplification, hit testing. Coordinates use page-local document space for every surface.
- `tools/`: tool state and behavior. Preferences stay outside annotation documents.
- `storage/`: versioned sidecars, identity, serialized autosave, manual save, recovery, atomic writes.
- `pdf/`: PDF-only page transforms, explicit source-PDF page mutations, coordinate mapping, and annotated-copy export.
- `history/`: commands used by edits, undo, redo, autosave scheduling.
- `ui/`: one accessible toolbar and dropdown system used by both viewing routes.

Private viewer changes should require edits only in `integration/`. Engine tests run without Obsidian. The open-issue evidence boundary and remaining hardware gates are tracked in `docs/issue-resolution-matrix.md`.

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

Open PDF, select Pen, Pencil, Highlighter, or Laser. Pen/pencil/highlighter persist to the sidecar. Laser trails fade away after a short hold and are never saved. Stylus input annotates directly, touch keeps native PDF navigation, and mouse behavior follows the selected input policy. Status reads `Saved`, `Saving…`, `Unsaved changes`, or `Save failed`.

## Coordinate and input invariants

- Persisted annotation geometry is page-local document data; viewport CSS pixels, scroll offsets, zoom, rotation, and device-pixel-ratio are render-time inputs only.
- Pointer Events are the authoritative input stream when available. Pen ownership is plugin-local, touch remains host navigation, and no global `touch-action: none` is applied.
- Viewer/page generations invalidate stale async work. A replacement page is revalidated before an overlay accepts input.
- A non-PDF surface may expose only page geometry and lifecycle. The shared session does not require PDF.js objects, PDF selectors, native text layers, or source-PDF mutation callbacks.

## Offline behavior

Core use needs no account, telemetry, hosted service, CDN, or remote AI. Sidecars, settings, recovery, backups, and exports remain inside vault/device storage. Package installation may require downloading dependencies; operation after installation is local.
