# Private Obsidian PDF integration

## Boundary

Every undocumented PDF object lookup and selector is confined to `src/integration/`. Annotation, tools, input, storage, and UI consume only `ObsidianPdfAdapter`. No private Obsidian type escapes that boundary.

## Verified first-pass surface

The adapter verifies observable DOM before attaching:

- viewer root: `.pdf-viewer` or PDF.js `.pdfViewer`;
- rendered page: `.page[data-page-number]` or `.pdf-page-view[data-page-number]`;
- optional toolbar: `.pdf-toolbar` or `.pdf-toolbar-container`;
- embedded host: `.internal-embed[src$='.pdf']`, `.internal-embed[data-type='pdf']`, or `.pdf-embed`.

The page element and its canvas provide a safe fallback for page bounds. A missing viewer root or page is a hard `PdfAdapterCompatibilityError` with every selector attempted. A missing native toolbar is a warning; the shared toolbar mounts beside the viewer. `PdfPageLocator` reports logical page number separately from the current DOM mount, including mount generation, geometry confidence, candidate count, and identity safety. If duplicate shells cannot be distinguished by connectivity, native canvas, hit testing, or existing overlay evidence, the selected page is marked `identitySafe: false` rather than silently trusted. Sequential page-number stamping is tracked as heuristic evidence and is not safe identity by itself.

## Page observation and cleanup

Page-shell mutation records are filtered to page structure; PDF.js text/annotation-layer churn and plugin-owned nodes do not trigger page remounts. Scroll only emits view-state updates, while bounded resize/mutation fallback is coalesced through the adapter. Viewer-generation guards ignore callbacks from detached roots, and destroy cancels observers, EventBus subscriptions, and pending zoom-settle work.

## Optional sidebar and toolbar layout

Sidebar rail tracking is an optional layout capability, not a prerequisite for page discovery or ink. The adapter prefers normal in-flow layout and geometry/`ResizeObserver` signals; bounded animation follow is used only for known open/close transitions. If neither a native toolbar nor a sidebar event is observable, the profile reports `degraded` with `sidebarObservable: false`, while safe page annotation remains available through the shared-toolbar/geometry fallback. During zoom bursts, nonessential rail follow is suppressed and resumes once geometry settles; it never triggers page remounts.

## Assumed/private object graph

The compatibility layer cautiously probes these host-owned paths:

```text
host.pdfViewer
host.viewer
host.component.pdfViewer
host.component.viewer
```

When present, the object may provide `currentPageNumber`, `currentScale`, `pagesRotation`, and an `eventBus`. These paths are assumptions, not public Obsidian API. They are optional; DOM metrics remain the fallback. Compatibility reporting includes a stable schema-versioned, per-adapter profile with status `supported`, `supported-with-fallback`, `degraded`, or `unsafe`; selected viewer/page/scale/zoom/sidebar strategies; capability booleans for viewer root, page identity, geometry, scroll, private viewer, EventBus, scale, page lifecycle, replacement, sidebar, and embedded mode; bounded counters; failed probes; and bounded warnings. The adapter emits one sanitized `pdf integration profile` record on attach. A changed object graph is therefore visible in session diagnostics without dumping private DOM or object contents.

## Lifecycle and cleanup

Adapters register scroll handlers, mutation observers, and PDF.js event-bus callbacks at construction. `destroy()` removes them in reverse order, removes every mounted overlay/toolbar, and is idempotent. No prototype or method is patched. If a future release requires a monkey patch, the adapter must register restoration in the same cleanup stack before enabling it.

Page overlays mount transparent with `pointer-events: none`. Annotation mode explicitly adds `.is-editing`; leaving annotation mode removes it. This prevents the adapter from stealing text selection, links, search, mouse, touch, or trackpad behavior by default.

Direct and embedded adapters differ only in discovery and compatibility probing. Both expose the same state, page, overlay, toolbar, profile, and cleanup contract. The profile is evidence for runtime validation, not a claim that a released Obsidian build has been tested. A profile is per viewer instance; Obsidian version metadata may be included as context but never selects compatibility by itself. Missing optional capabilities keep core annotation available through a bounded fallback or degraded status, while missing viewer/page/geometry evidence remains unsafe and blocks attachment.
