# PDF.js component research (#463)

**Status:** research-only input to #460. This note does not authorize a
production viewer or a change to the current Obsidian-backed default.

## Evidence

The review uses the Apache-2.0 PDF.js `master` source and examples:

- [`pageviewer.mjs`](https://github.com/mozilla/pdf.js/blob/master/examples/components/pageviewer.mjs)
- [`singlepageviewer.mjs`](https://github.com/mozilla/pdf.js/blob/master/examples/components/singlepageviewer.mjs)
- [`PDFViewer`](https://github.com/mozilla/pdf.js/blob/master/web/pdf_viewer.js)
- [`PDFPageView`](https://github.com/mozilla/pdf.js/blob/master/web/pdf_page_view.js)
- [`PDFLinkService`](https://github.com/mozilla/pdf.js/blob/master/web/pdf_link_service.js)
- [`PDFFindController`](https://github.com/mozilla/pdf.js/blob/master/web/pdf_find_controller.js)
- [`EventBus`](https://github.com/mozilla/pdf.js/blob/master/web/event_utils.js)
- [`TextLayerBuilder`](https://github.com/mozilla/pdf.js/blob/master/web/text_layer_builder.js)
- [`AnnotationLayerBuilder`](https://github.com/mozilla/pdf.js/blob/master/web/annotation_layer_builder.js)
- [`getDocument` and loading-task cleanup](https://github.com/mozilla/pdf.js/blob/master/src/display/api.js)

No upstream source is copied or vendored by this research change.

## Recommended component stack

Use the smallest upstream surface that satisfies the feature, with a thin
project adapter around it:

```text
Plugin-owned ItemView / scroll shell
  ├─ EventBus
  ├─ PDFLinkService
  ├─ PDFPageView per mounted page
  │    ├─ canvas/render task
  │    ├─ TextLayerBuilder
  │    └─ AnnotationLayerBuilder
  ├─ PDFFindController + project search UI
  └─ project page scheduler + page-space ink overlays
```

`pageviewer.mjs` demonstrates the minimum page-owned path: configure
`GlobalWorkerOptions.workerSrc`, create an `EventBus`, call `getDocument`,
obtain a `PDFPageProxy`, and construct `PDFPageView` with a plugin-owned
container. `singlepageviewer.mjs` demonstrates the larger parity path with
`PDFLinkService`, `PDFFindController`, `PDFSinglePageViewer`, worker/CMap
configuration, and `setDocument` on both the viewer and link service.

Recommendation: start with `PDFPageView` plus a project scheduler rather than
making `PDFViewerApplication` the owner of the plugin. Adopt `PDFViewer` or
`PDFSinglePageViewer` only where their public component contract reduces parity
risk without taking ownership of the outer scroll, gesture, and lifecycle
state. Keep the choice behind an adapter so a later PDF.js update does not
leak upstream classes into `src/ink/`, `src/tools/`, or `src/storage/`.

## Lifecycle and cancellation

```text
open TFile
  → vault.readBinary / Uint8Array
  → getDocument({ data, workerSrc, cMapUrl, wasmUrl, ... })
  → loadingTask.promise
  → PDFPageProxy
  → page scheduler mounts logical wrapper
  → PDFPageView.draw()
       → canvas
       → text layer
       → annotation layer
  → EventBus reports page/render/location changes
  → close or generation replacement
       → cancel page tasks
       → destroy text/annotation layers
       → await PDFDocumentLoadingTask.destroy()
```

The `PDFDocumentLoadingTask` owns `destroy()` and aborts loading/worker
transport. `PDFPageView` owns page rendering, layer creation, viewport updates,
and cancellation. `TextLayerBuilder.cancel()` and
`AnnotationLayerBuilder.cancel()` are separate cleanup boundaries. The viewer
also has a rendering queue and page-view buffer, but the plugin must still gate
every completion by its own session/viewer generation before attaching a layer
or overlay.

`setDocument()` is a lifecycle boundary, not just a data setter: the upstream
viewer cancels old rendering, detaches find/scripting state, and destroys old
page views. The plugin equivalent must additionally flush or preserve the
sidecar transaction, release pointer capture, and tear down Handwriting
Natively overlays before the old document is discarded.

## Zoom and resolution

PDF.js separates logical scale from page rendering. `PDFViewer` updates page
views and emits scale/location events; `PDFPageView.update()` can retain layer
nodes while deciding whether a new render is required. This is compatible with
our two-phase policy:

1. Pointer gesture owns a temporary, focal-point-preserving visual transform.
2. The settled gesture commits canonical layout scale and rotation.
3. Visible pages render at a fast baseline resolution.
4. A generation-cancellable upgrade renders higher resolution for protected
   visible pages and bounded nearby pages.
5. Stale tasks are cancelled before they can replace a newer page generation.

Do not persist CSS transform values or use a raw canvas resize as annotation
geometry. PDF.js viewports and the project's page-space mapper remain the only
coordinate conversion boundary. Rotation belongs in the viewport key and in
ink overlay transforms.

## Search, links, text, and annotations

- `PDFLinkService` owns internal destinations, page navigation, named targets,
  and external-link policy. Use it rather than reimplementing PDF destination
  parsing.
- `PDFFindController` owns document-wide text search and match state. A plugin
  search bar can drive its public find events/controller methods; a repeated
  page-by-page `getTextContent()` loop should remain only a fallback.
- `TextLayerBuilder` supplies selectable/searchable text and its own cancellation
  and selection coordination. It must share page geometry with the ink overlay
  but never become the persisted annotation store.
- `AnnotationLayerBuilder` handles PDF links, annotations, and form controls.
  It needs an explicit pointer-policy boundary so annotation/link interaction
  is not accidentally captured as handwriting.
- `EventBus` is the local lifecycle signal surface. Subscribe to documented
  component events and unregister every listener on session disposal; do not
  make private viewer fields such as `_pages` or `_location` project contracts.
- Outline, thumbnails, accessibility, and page labels should be added through
  the corresponding PDF.js components or narrowly wrapped services after the
  core page lifecycle is stable.

## What not to copy

- Do not copy `PDFViewerApplication`'s global application singleton or stock
  toolbar/outer-scroll ownership.
- Do not depend on private buffer fields, `_pages`, `_location`, or internal
  rendering-queue heuristics as durable project contracts.
- Do not replace the sidecar with PDF.js editor storage; the sidecar remains the
  canonical editable annotation data and recovery remains separate.
- Do not assume upstream PDF.js's DOM/CSS or event timing is identical to
  Obsidian's customized build. Pin the version and validate every update.

## Packaging and version strategy

Ship one explicitly pinned PDF.js version and keep these assets from the same
version: display/runtime modules, worker, CMaps, standard fonts, WASM, viewer
CSS, and optional sandbox/locale resources. Prefer esbuild asset copies and
runtime URLs that are resolved from the plugin directory; do not silently use a
CDN. A Blob worker is an option, not a guarantee: test worker construction,
CSP, `blob:` policy, WebView/Capacitor behavior, and unload revocation on
Windows/macOS desktop, Android, and iPadOS.

`getDocument` options should be capability-driven. CMaps, standard font data,
WASM, ICC, and sandbox assets may be omitted only when the supported PDF feature
set and target runtime prove they are unnecessary. Missing optional assets must
produce a bounded compatibility result rather than a half-rendered page.

## Prototype boundary for #460

The first prototype should prove only: opening vault bytes, one page view,
page-space geometry, text selection, links, cancellation, and one ink overlay.
Add scheduler/virtualization, search, outline, forms, thumbnails, and mobile
zoom as independently testable capability slices. Keep the existing native
adapter as the fallback until a release matrix demonstrates equivalent cleanup,
input ownership, navigation, search, and accessibility behavior.
