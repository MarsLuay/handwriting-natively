# Viewer virtualization and zoom research (#464)

**Status:** research-only input to #460. No production viewer or migration is
implemented by this note.

## Evidence

The review used the public Apache-2.0 repository and its primary implementation:

- [`js/pdfjs-viewer.js`](https://github.com/dealfonso/pdfjs-viewer/blob/main/js/pdfjs-viewer.js)
- [`README.md`](https://github.com/dealfonso/pdfjs-viewer/blob/main/README.md)

The source is a useful behavioral reference, not a dependency candidate: its
DOM and scheduling model is older and its integration assumptions do not match
Obsidian's mobile WebViews or this project's page-space sidecar contract.

## Reusable concepts

### Viewer-owned zoom

`PDFjsViewer.setZoom()` captures the scroll offsets, changes a canonical zoom
value, scales the scroll offsets by the old/new zoom ratio, and calls
`_visiblePages(true)`. This establishes the important separation between a
viewer-owned logical scale and page raster resolution. The ratio correction is
adequate as a desktop baseline, but it is not sufficient for a mobile pinch:
it does not preserve an arbitrary focal point through page rotation, nested
scroll containers, or a temporary CSS compositor transform.

Handwriting Natively should retain its focal-point gesture contract: transform
around the gesture anchor first, commit canonical scale only after settle, and
then rerender at an explicit resolution. Never use the temporary transform or
canvas pixel dimensions as persisted annotation coordinates.

### Visible-page set and resource release

The viewer computes visible pages plus `extraPagesToLoad`, renders that working
set, and calls `_cleanPage()` for pages outside the retention window. A cleaned
page keeps its logical placeholder but releases its canvas/heavy content. A
single `_loadingTask()` serializes pending page rendering and avoids launching
unbounded render promises.

These concepts map well to a modern scheduler:

- protect visible validated pages;
- retain a bounded adjacent preload set;
- keep logical page geometry when evicting raster resources;
- serialize or budget expensive render work;
- expose page lifecycle callbacks without making the renderer own annotation
  persistence.

The original implementation uses fixed thresholds and imperative visibility
checks. It should not be copied as the large-document policy: this project
already has generation cancellation, measured budgets, and visible-page
protection requirements.

### Rasterization and logical geometry

`_renderPage(page, i)` asks PDF.js for a viewport at the logical zoom multiplied
by a configurable `renderingScale`, allocates a device-pixel-aware canvas, and
keeps the page's logical dimensions separate from its raster dimensions. That
is the right shape for a fast preview followed by a high-quality upgrade.

The project equivalent should key a render by document, page, scale, rotation,
content revision, and renderer generation. A render completion may update pixels
only when that key is still current. Ink overlays use the logical page
viewport, not the raster backing-store size.

## Proposed modern algorithm for #460

1. **Layout pass:** create stable page shells for all pages using PDF.js page
   geometry or a validated aspect-ratio estimate. Shells own logical top/offset
   state; canvases are optional children.
2. **Visibility pass:** use `IntersectionObserver` plus a scroll/settle signal
   to classify visible, near-visible, and cold pages. Keep visible shells and
   active ink surfaces protected.
3. **Priority queue:** enqueue visible low-resolution work first, then adjacent
   preview work, then settled high-resolution upgrades. Assign each item a
   generation and cancel work superseded by a new document, page, scale, or
   rotation generation.
4. **Compositor phase:** during pinch, apply one bounded visual transform to the
   protected page surface and ink overlay around the focal anchor. Do not call
   PDF.js for every gesture sample.
5. **Canonical phase:** after settle, update logical layout scale, recalculate
   page bounds, and schedule visible-page baseline renders. Keep the old pixels
   until replacement pixels are ready so the page does not flash empty.
6. **Upgrade phase:** render high-resolution canvases opportunistically within
   the measured device budget. Replace pixels only if the page key and viewer
   generation still match.
7. **Eviction:** remove cold raster/text/annotation resources according to a
   bounded LRU/byte budget while retaining shell geometry and persisted ink
   state. Destroy PDF.js page resources only through the adapter's cleanup
   boundary.

This preserves the useful source pattern—visible pages plus adjacent pages—while
adding focal anchoring, generation safety, measured budgets, and explicit
lifecycle ownership.

## Overlay and page extension contract

A mounted page should expose a small adapter record rather than the viewer's
private fields:

```text
PageSurface {
  documentId, pageNumber, generation,
  logicalSize, rotation, viewport,
  hostElement, canvasElement?, textLayerElement?, annotationLayerElement?,
  mount(), updateViewport(), requestRender(priority), cancel(), destroy()
}
```

`onNewPage`-style hooks are useful only if they fire after the page identity and
logical geometry are validated. `onPageRender` should carry the render key and
not imply that ink is persisted. `onZoomChange` should describe a canonical
settled scale, not every temporary compositor tick. `onActivePageChanged` is a
navigation hint and must not be the source of truth for page identity.

The ink session may mount a sibling overlay in the same page host and consume
`logicalSize`, `viewport`, and `rotation`. It must not reach into canvas internals
or let a raster eviction delete sidecar state. Pointer routing remains governed
by the existing pen/touch/mouse ownership contract.

## Cancellation and pitfalls

- The serial loading queue is simple and can delay a visible page behind stale
  work; a priority queue with cancellation is safer for rapid scroll/zoom.
- Imperative page cleanup must be replaced by idempotent generation-aware
  teardown so a late promise cannot reattach a released canvas.
- Fixed `extraPagesToLoad` values do not account for device memory, page size, or
  mobile constraints.
- Scroll-ratio zoom correction loses the pinch focal point in nested/rotated
  layouts.
- jQuery-style DOM access and callbacks should not become project contracts.
- A page callback must never be interpreted as proof that its document/viewer
  generation is still current.

## Decision for #460

Borrow the source's separation of logical page placeholders, visible-page
retention, bounded nearby preloading, and callback-level page extensions. Rebuild
the scheduler with the project's `IntersectionObserver`/rAF lifecycle,
generation keys, focal-point zoom, cancellation, and measured cache policy.
Keep PDF.js rendering and Handwriting Natively page-space ink as separate
replaceable layers, with a compatibility-gated adapter between them.
