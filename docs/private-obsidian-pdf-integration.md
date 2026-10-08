# Private Obsidian PDF integration

## Boundary

Every undocumented PDF object lookup, extension-registry operation, toolbar constructor, and selector is confined to `src/integration/`. Annotation, tools, input, storage, and UI consume the page surface and viewer commands; they do not own Obsidian's private PDF objects.

## Direct viewer and native toolbar

Direct `.pdf` leaves use the plugin-owned `PluginPdfView`. `PdfJsViewAdapter` loads the vault bytes with the pinned PDF.js 4.10.38 `getDocument` API and renders `PDFPageProxy` pages into the plugin's page shells. It is the only document renderer and the only navigation/page-state owner for that direct leaf. `ObsidianPdfToolbarBridge` constructs Obsidian's actual `PDFToolbar` against a small state/command facade and supplies the plugin adapter's state and callbacks to its `.pdf-toolbar`; it does not load a PDF document or create a second document renderer.

The observed running host reports Obsidian 1.14.4. Earlier inspection of the Obsidian 1.12.7 bundle found a private `PDFToolbar` class that is not exported; the installed `obsidian.d.ts` and PDF.js 4.10.38 web declarations do not declare it. The PDF++ 0.40.31 reference typings describe `PDFViewerChild.toolbar` and its DOM/method surface; its implementation decorates `child.toolbar` rather than constructing it. The inspected toolbar constructor takes `(app, host, child)`, creates `.pdf-toolbar` with a `.pdf-toolbar-right` action container, updates itself through `setPagesCount`, `setPageNumber`, and `setPageScale`, and dispatches page, zoom, sidebar, outline, and spread-mode events. Revalidate that private contract against the current host before treating it as supported.

The private toolbar's concrete dependencies in the installed bundle are `child.pdfViewer.eventBus`, `child.pdfViewer.pdfSidebar.{isOpen,active,switchView}`, `child.pdfViewer.pdfOutlineViewer.outline`, `child.pdfViewer.pdfViewer.{currentScaleValue,spreadMode}`, `child.onCSSChange()`, and `app.loadLocalStorage` / `app.saveLocalStorage`. It creates controls and dispatches commands; it does not load PDF bytes. `ObsidianPdfToolbarBridge` supplies those state/action facades from the plugin adapter. The native display menu handles fit width, fit height, and theme changes; the added selector keeps page-fit and fixed/custom scales. Plugin actions fill native-toolbar gaps such as previous/next, find, hand mode, rotation, presentation, print, and download. The native menu also offers spread modes, which the current continuous-page renderer does not support; the bridge reports those commands as unsupported instead of changing a second viewer's state.

Because the constructor is private and not reachable independently through a public API, startup reuses a constructor from an existing native child when one exists. On a cold start with no native PDF child, the bridge briefly opens a fileless native PDF leaf to obtain the constructor, verifies both `view.file`/`child.file` and `pdfDocument` are empty, then detaches that leaf before registering the plugin view for `.pdf`. Obsidian initializes an empty viewer shell during this bootstrap, but no PDF document is loaded or rendered there. Constructor-discovery errors are logged without rejecting plugin activation; opening a PDF then shows that exact error in the plugin-owned viewer. The plugin does not substitute a toolbar imitation or route an opened plugin view to Obsidian's renderer. Failure to claim the `.pdf` registry remains a visible load failure because the plugin cannot preserve single-viewer ownership otherwise.

In the installed Obsidian 1.14.4 bundle, the native PDF viewer component assigns its `child` before awaiting that child's asynchronous load; the child creates `toolbar` during that load, and the component's `then` callback runs after initialization. Therefore `viewer.child` alone is not a readiness signal. The bridge accepts an already-created child only when its actual `.pdf-toolbar` contract is present; otherwise it waits for the component callback before checking the toolbar. This fixes cold-start constructor capture without opening a PDF or starting another renderer.

Obsidian's public `registerExtensions` refuses to replace the core `pdf` mapping. `PdfExtensionRegistration` therefore capability-checks the private registry, requires the existing owner to be `pdf`, transfers only the `.pdf` mapping to `PluginPdfView`, and restores the prior owner on unload. `PdfViewStateMigration` maps existing native `{page,left,top,zoom}` state into the plugin's canonical `ViewerState`; new direct leaves use plugin state thereafter.

## Versioned per-viewer contract

The adapter reports a schema-versioned compatibility profile for each viewer instance. The profile is evidence about the current DOM/object graph, not a compatibility claim derived from the Obsidian version. Its status is one of `supported`, `supported-with-fallback`, `degraded`, or `unsafe`, and it records the selected viewer-root, page, scroll-root, scale/zoom, page-lifecycle, and sidebar strategies. Capability flags cover viewer root, trustworthy page identity, geometry, scroll ownership, private viewer, EventBus, readable scale/rotation, page-render and replacement observation, sidebar observation, and embedded mode. Failed probes, bounded warnings, and replacement/fallback counters are sanitized and capped; private objects and DOM trees are never copied into diagnostics.

A viewer generation changes when its root/private viewer is replaced, an embed remounts, a PDF mutation reloads the viewer, or the adapter is reattached. A mounted page is identified by `viewerGeneration + pageNumber + mountGeneration`: the page number is the logical document location, while the mount generation identifies the current ephemeral DOM shell. Any asynchronous page, geometry, overlay, or event callback must verify both generations before mutating the surface. Semantic adapter events (`pages changed`, `zoom phase`, `viewer replaced`, and geometry validity) are preferred over exposing raw PDF.js EventBus objects; an EventBus is an optional source used only after capability probing.

A page is annotatable only after the adapter validates logical identity, live-shell ownership, plausible dimensions, rotation/scale, and scroll/viewer ownership. Missing optional signals may use bounded DOM/geometry fallbacks, but ambiguous duplicate shells, invalid geometry, contradictory ownership, or stale generations are `unsafe` and block that page/view until revalidation. Scale change and final geometry settlement are separate events. Scroll and inner-layer mutation do not trigger full adapter rediscovery or overlay rebuilds.

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

## Dependency classification and strategy order

| Dependency | Classification | Safe strategy |
| --- | --- | --- |
| Workspace/file/leaf lifecycle, DOM APIs, scroll, resize, and mutation observers | public host/browser primitives | use directly, with scoped listeners and cancellation |
| `.pdf-viewer`, `.pdfViewer`, numbered page shells, canvases, text/annotation layers | observable but host-owned DOM | probe per viewer; validate identity/geometry; ignore inner-layer churn |
| `host.pdfViewer`, `currentScale`, `pagesRotation`, page/render signals, EventBus, find controller | private Obsidian/PDF.js graph | feature-detect behind `PdfViewerCompatibility`; never required for basic ink |
| `PdfPageLocator` sequential page-number stamping and canvas/rect inference | heuristic evidence | report low confidence; reject ambiguous identity |
| `PdfScrollRoot` candidates and private viewer container | fallback layout capability | return element, strategy, and confidence; host fallback is degraded |
| sidebar/toolbar rail, CSS width, and thumbnail menu | optional/invasive integration | isolate from core annotation; bounded cleanup and independent degradation |

Page discovery prefers a validated private/page-render signal, then EventBus plus DOM validation, numbered DOM shells, and finally bounded initial-attach retries. Scroll resolves once and is revalidated only after viewer replacement. Mutation observers target the smallest validated page owner and filter plugin-owned nodes, text-layer churn, annotation-layer churn, and paint-only changes. Resize/geometry work is coalesced. Every retry, observer, EventBus subscription, and rAF is generation-cancelled on replacement or destroy.

## Lifecycle and cleanup

Adapters register scroll handlers, mutation observers, and PDF.js event-bus callbacks at construction. `destroy()` removes them in reverse order, removes every mounted overlay/toolbar, and is idempotent. No prototype or method is patched. If a future release requires a monkey patch, the adapter must register restoration in the same cleanup stack before enabling it.

Page overlays mount transparent with `pointer-events: none`. Annotation mode explicitly adds `.is-editing`; leaving annotation mode removes it. This prevents the adapter from stealing text selection, links, search, mouse, touch, or trackpad behavior by default.

Direct and embedded adapters differ only in discovery and compatibility probing. Both expose the same state, page, overlay, toolbar, profile, and cleanup contract. The profile is evidence for runtime validation, not a claim that a released Obsidian build has been tested. A profile is per viewer instance; Obsidian version metadata may be included as context but never selects compatibility by itself. Missing optional capabilities keep core annotation available through a bounded fallback or degraded status, while missing viewer/page/geometry evidence remains unsafe and blocks attachment.

## Runtime qualification boundary

Automated fixtures establish probe ordering, generation guards, cleanup, duplicate-shell handling, and safe degradation. They cannot establish which private objects or events a released Obsidian build exposes. The release matrix must therefore capture one bounded profile for desktop native PDF, iPadOS native PDF, Android native PDF, embedded PDF, split panes, multiple leaves, sidebar open/close, zoom, lazy page replacement, PDF reload, close/reopen, plugin restart, and mobile background/resume. A matrix row is qualified only when page identity, geometry, scroll strategy, viewer generation, replacement counts, zoom source, fallback count, and unsafe gating are observed; absent hardware/runtime evidence remains an explicit validation gap rather than an inferred success.

## Annotation safety gate

`AnnotationSurface` exposes a bounded evidence gate for the runtime. Detached pages, invalid dimensions, explicit unsafe geometry, ambiguous identity, and stale mount generations cannot accept pointer input. The runtime revalidates the live page before routing and reports one sanitized `annotation-safety-blocked` lifecycle event per surface state. Autosave/manual persistence also skips snapshots containing currently unsafe page evidence, preserving the last validated sidecar instead of writing uncertain coordinates. Once the adapter reports the same live page generation with valid evidence, routing and persistence recover deterministically.
