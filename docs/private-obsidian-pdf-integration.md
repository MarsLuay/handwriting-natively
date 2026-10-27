# Private Obsidian PDF integration

## Boundary

Every undocumented PDF object lookup and selector is confined to `src/integration/`. Annotation, tools, input, storage, and UI consume the page surface and viewer commands; they do not own Obsidian's private PDF objects.

## Direct viewer and shared toolbar

Direct `.pdf` leaves use the plugin-owned `PluginPdfView`. `PdfJsViewAdapter` loads vault bytes with the pinned PDF.js 4.10.38 `getDocument` API and renders `PDFPageProxy` pages into plugin page shells. It is the only document renderer and the only navigation/page-state owner for that direct leaf. `ViewerInkSession` mounts the same draggable floating `AnnotationToolbar` used by image surfaces. The More menu keeps PDF page navigation, zoom, thumbnails, outline, search, print, and download actions available, and rotates the toolbar between persisted horizontal and vertical layouts. Old main/left/right placement values migrate to horizontal/vertical orientation and are removed from saved settings. Direct PDF startup does not capture or instantiate Obsidian's private `PDFToolbar` and does not depend on a host `.pdf-toolbar` element.

Keep Obsidian's global `pdf` extension mapping unchanged. Markdown PDF embeds use that host mapping to create their native viewer; replacing it leaves a loaded embed shell without rendered pages. Direct PDF leaves remain plugin-owned: plugin-created tabs select `PluginPdfView` explicitly, and scans migrate any native direct PDF leaves with their page, position, zoom, and rotation state preserved by `PdfViewStateMigration`.

The plugin's pinned PDF.js runtime routes its own `PDFWorker` initializer directly to the bundled in-process `WorkerMessageHandler`. The one-file BRAT bundle has no addressable `workerSrc`, and PDF.js's browser runtime reads that setting while initializing before it can use the in-process handler; this route keeps direct PDFs self-contained. Never assign the handler to `globalThis.pdfjsWorker`: Obsidian's native Markdown embed renderer reads the same global for its separate PDF.js build, and replacing that handler prevents embeds from creating PDF pages on startup.

## Versioned per-viewer contract

The adapter reports a schema-versioned compatibility profile for each viewer instance. The profile is evidence about the current DOM/object graph, not a compatibility claim derived from the Obsidian version. Its status is one of `supported`, `supported-with-fallback`, `degraded`, or `unsafe`, and it records the selected viewer-root, page, scroll-root, scale/zoom, page-lifecycle, and sidebar strategies. Capability flags cover viewer root, trustworthy page identity, geometry, scroll ownership, private viewer, EventBus, readable scale/rotation, page-render and replacement observation, sidebar observation, and embedded mode. Failed probes, bounded warnings, and replacement/fallback counters are sanitized and capped; private objects and DOM trees are never copied into diagnostics.

A viewer generation changes when its root/private viewer is replaced, an embed remounts, a PDF mutation reloads the viewer, or the adapter is reattached. A mounted page is identified by `viewerGeneration + pageNumber + mountGeneration`: the page number is the logical document location, while the mount generation identifies the current ephemeral DOM shell. Any asynchronous page, geometry, overlay, or event callback must verify both generations before mutating the surface. Semantic adapter events (`pages changed`, `zoom phase`, `viewer replaced`, and geometry validity) are preferred over exposing raw PDF.js EventBus objects; an EventBus is an optional source used only after capability probing.

A page is annotatable only after the adapter validates logical identity, live-shell ownership, plausible dimensions, rotation/scale, and scroll/viewer ownership. Missing optional signals may use bounded DOM/geometry fallbacks, but ambiguous duplicate shells, invalid geometry, contradictory ownership, or stale generations are `unsafe` and block that page/view until revalidation. Scale change and final geometry settlement are separate events. Scroll and inner-layer mutation do not trigger full adapter rediscovery or overlay rebuilds.

## Verified first-pass surface

The adapter verifies observable DOM before attaching:

- viewer root: `.pdf-viewer` or PDF.js `.pdfViewer`;
- rendered page: `.page[data-page-number]` or `.pdf-page-view[data-page-number]`;
- optional embedded-view toolbar: `.pdf-toolbar` or `.pdf-toolbar-container`;
- embedded host: `.internal-embed[src$='.pdf']`, `.internal-embed[data-type='pdf']`, or `.pdf-embed`.

The page element and its canvas provide a safe fallback for page bounds. A missing viewer root or page is a hard `PdfAdapterCompatibilityError` with every selector attempted. In embedded views, a missing host toolbar is a warning; the shared toolbar can mount beside the viewer. Direct PDF toolbar mounting is plugin-owned and independent of host toolbar availability. `PdfPageLocator` reports logical page number separately from the current DOM mount, including mount generation, geometry confidence, candidate count, and identity safety. If duplicate shells cannot be distinguished by connectivity, native canvas, hit testing, or existing overlay evidence, the selected page is marked `identitySafe: false` rather than silently trusted. Sequential page-number stamping is tracked as heuristic evidence and is not safe identity by itself.

## Page observation and cleanup

Page-shell mutation records are filtered to page structure; PDF.js text/annotation-layer churn and plugin-owned nodes do not trigger page remounts. Scroll only emits view-state updates, while bounded resize/mutation fallback is coalesced through the adapter. Viewer-generation guards ignore callbacks from detached roots, and destroy cancels observers, EventBus subscriptions, and pending zoom-settle work.

## Shared floating toolbar

Every plugin annotation session mounts the shared toolbar as a movable floating overlay. Main/left/right placement choices are not exposed; the drag handle controls position, and the More menu rotates horizontal/vertical orientation. Embedded PDF viewer ownership and its native sidebar remain with Obsidian; the annotation toolbar does not use that sidebar as a mount target. PDF-specific navigation and sidebar actions remain available through the shared toolbar.

## Assumed/private object graph

The compatibility layer cautiously probes these host-owned paths:

```text
host.pdfViewer
host.viewer
host.component.pdfViewer
host.component.viewer
```

When present, the object may provide `currentPageNumber`, `currentScale`, `pagesRotation`, and an `eventBus`. These paths are assumptions, not public Obsidian API. They are optional; DOM metrics remain the fallback. Compatibility reporting includes a stable schema-versioned, per-adapter profile with status `supported`, `supported-with-fallback`, `degraded`, or `unsafe`; selected viewer/page/scale/zoom/sidebar strategies; capability booleans for viewer root, page identity, geometry, scroll, private viewer, EventBus, scale, page lifecycle, replacement, sidebar, and embedded mode; bounded counters; failed probes; and bounded warnings. The adapter emits one sanitized `pdf integration profile` record on attach. A changed object graph is therefore visible in session diagnostics without dumping private DOM or object contents.

## Dependency classification and strategy order

| Dependency | Classification | Safe strategy |
| --- | --- | --- |
| Workspace/file/leaf lifecycle, DOM APIs, scroll, resize, and mutation observers | public host/browser primitives | use directly, with scoped listeners and cancellation |
| `.pdf-viewer`, `.pdfViewer`, numbered page shells, canvases, text/annotation layers | observable but host-owned DOM | probe per viewer; validate identity/geometry; ignore inner-layer churn |
| `host.pdfViewer`, `currentScale`, `pagesRotation`, page/render signals, EventBus, find controller | private Obsidian/PDF.js graph | feature-detect behind `PdfViewerCompatibility`; never required for basic ink |
| `PdfPageLocator` sequential page-number stamping and canvas/rect inference | heuristic evidence | report low confidence; reject ambiguous identity |
| `PdfScrollRoot` candidates and private viewer container | fallback layout capability | return element, strategy, and confidence; host fallback is degraded |
| host PDF sidebar, CSS width, and thumbnail menu | optional/invasive integration | isolate host controls from core annotation; keep the plugin toolbar floating; bounded cleanup and independent degradation |

Page discovery prefers a validated private/page-render signal, then EventBus plus DOM validation, numbered DOM shells, and finally bounded initial-attach retries. Scroll resolves once and is revalidated only after viewer replacement. Mutation observers target the smallest validated page owner and filter plugin-owned nodes, text-layer churn, annotation-layer churn, and paint-only changes. Resize/geometry work is coalesced. Every retry, observer, EventBus subscription, and rAF is generation-cancelled on replacement or destroy.

## Lifecycle and cleanup

Adapters register scroll handlers, mutation observers, and PDF.js event-bus callbacks at construction. `destroy()` removes them in reverse order, removes every mounted overlay/toolbar, and is idempotent. No Obsidian host prototype or method is patched. The pinned PDF.js worker initializer is patched only inside the plugin-owned runtime; if an upgrade changes that hook, update the runtime boundary tests and compatibility notes.

Page overlays mount transparent with `pointer-events: none`. Annotation mode explicitly adds `.is-editing`; leaving annotation mode removes it. This prevents the adapter from stealing text selection, links, search, mouse, touch, or trackpad behavior by default.

Direct and embedded adapters differ only in discovery and compatibility probing. Both expose the same state, page, overlay, toolbar, profile, and cleanup contract. The profile is evidence for runtime validation, not a claim that a released Obsidian build has been tested. A profile is per viewer instance; Obsidian version metadata may be included as context but never selects compatibility by itself. Missing optional capabilities keep core annotation available through a bounded fallback or degraded status, while missing viewer/page/geometry evidence remains unsafe and blocks attachment.

## Runtime qualification boundary

Automated fixtures establish probe ordering, generation guards, cleanup, duplicate-shell handling, and safe degradation. They cannot establish which private objects or events a released Obsidian build exposes. The release matrix must therefore capture one bounded profile for desktop native PDF, iPadOS native PDF, Android native PDF, embedded PDF, split panes, multiple leaves, sidebar open/close, zoom, lazy page replacement, PDF reload, close/reopen, plugin restart, and mobile background/resume. A matrix row is qualified only when page identity, geometry, scroll strategy, viewer generation, replacement counts, zoom source, fallback count, and unsafe gating are observed; absent hardware/runtime evidence remains an explicit validation gap rather than an inferred success.

## Annotation safety gate

`AnnotationSurface` exposes a bounded evidence gate for the runtime. Detached pages, invalid dimensions, explicit unsafe geometry, ambiguous identity, and stale mount generations cannot accept pointer input. The runtime revalidates the live page before routing and reports one sanitized `annotation-safety-blocked` lifecycle event per surface state. Autosave/manual persistence also skips snapshots containing currently unsafe page evidence, preserving the last validated sidecar instead of writing uncertain coordinates. Once the adapter reports the same live page generation with valid evidence, routing and persistence recover deterministically.
