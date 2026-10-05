# Plugin-owned PDF viewer research (#462)

**Status:** research-only input to #460. This note does not authorize replacing the
current viewer, changing the default backend, or removing the existing
`ObsidianPdfAdapter`.

## Evidence

This review used the public MIT repository at the pinned `main` source paths;
no source was copied or vendored.

- [`src/main.ts` — view registration, worker setup, and PDF interception](https://github.com/voidash/obsidian-pdf-tools/blob/main/src/main.ts)
- [`src/views/PdfViewerView.ts` — state, loading, page lifecycle, and rendering](https://github.com/voidash/obsidian-pdf-tools/blob/main/src/views/PdfViewerView.ts)
- [repository license](https://github.com/voidash/obsidian-pdf-tools/blob/main/LICENSE)

## Verified patterns

### View ownership and file state

The plugin registers a normal Obsidian `ItemView` with `registerView`, persists
the selected vault PDF through `getState()` / `setState()`, and loads bytes with
`vault.readBinary(file)` before passing a `Uint8Array` to PDF.js. This is a
useful proof that a plugin-owned view can preserve the active file without
depending on the native PDF view's private object graph.

The `.pdf` redirect instead mutates the internal
`app.viewRegistry.typeByExtension.pdf` entry and restores the previous value in
a registered unload callback. That is an effective proof-of-concept seam, not a
portable public API: the registry shape may change, and an extension mapping
can affect every PDF leaf. It must therefore be isolated behind a capability
probe, be reversible, and fail closed when the expected registry is absent.

### Worker and vault loading

The worker setup creates a Blob URL from bundled worker text and assigns it to
`GlobalWorkerOptions.workerSrc`. This avoids a separate server, but Blob workers
still need explicit CSP, WebView, and lifetime testing. The worker URL must be
revoked on plugin unload, and the worker, PDF.js runtime, and auxiliary assets
must be version-pinned together.

`loadFile()` increments a load generation, destroys the previous document,
cancels render tasks, clears page state, reads the vault bytes, and checks the
generation after asynchronous boundaries. Those checks are the right conceptual
shape for this project, but Handwriting Natively should retain its stronger
session-generation and transactional cleanup rules rather than copy the view.

### Page placeholders and cancellation

The view creates a placeholder for every page using the first-page aspect ratio
and page metadata, then uses `IntersectionObserver` to start rendering pages as
they approach the viewport. It tracks rendered pages and render tasks by page;
when a page is re-rendered or the view closes, the existing task is cancelled.
Rendered pages retain a DOM wrapper and text layer while their canvas is replaced
or released.

This is a useful small-document baseline. It is not sufficient by itself for a
large-document viewer: one global observer, a fixed preload margin, and a
single `renderedPages` set do not express generation priority, memory budgets,
visible-page protection, or cancellation of stale low-priority work.

### Text, search, outline, and annotations

The view mounts a PDF.js text layer beside each rendered canvas, exposes a
plugin-owned search bar by extracting page text, and builds an outline from the
PDF document. It also provides its own annotation list and links annotations
back to vault files. These are parity clues, not components to transplant:
search based on repeated `getTextContent()` calls is weaker than a shared
find-controller pipeline, and a separate annotation format would conflict with
this project's canonical sidecar.

## Recommendation for #460

1. **View shell:** register a plugin-owned `ItemView` through the public
   `registerView` API. Keep PDF extension interception as a small, versioned
   compatibility adapter that snapshots and restores the prior mapping. Do not
   make `viewRegistry.typeByExtension` part of the core engine or assume it
   exists on mobile.
2. **File identity:** keep the Obsidian `TFile` and leaf state at the host
   boundary. Read source bytes through the vault API, then pass an immutable
   byte/document handle into a viewer session. `getState()` / `setState()`
   should preserve the file path and bounded reading position only.
3. **Page lifecycle:** retain logical placeholders for every page, but let a
   generation-aware scheduler protect visible pages, preload a bounded radius,
   and evict only offscreen raster resources. Every page render needs a cancel
   handle and a generation check before it commits canvas, text, annotation, or
   ink layers.
4. **Coordinate ownership:** keep one page-space coordinate system for PDF.js
   output and Handwriting Natively overlays. The page wrapper should expose
   stable logical geometry while canvas resolution changes. Do not derive
   sidecar coordinates from a transient CSS transform.
5. **Zoom:** use the project's focal-point gesture contract for a temporary
   visual transform, then commit canonical layout scale and schedule visible
   page rerenders. The source's scroll-ratio correction is a useful desktop
   fallback but is not sufficient for mobile pinch anchoring or rotation.
6. **Parity:** build text selection, links/destinations, search, outline,
   annotations, thumbnails, rotation, and accessibility from public PDF.js
   components where possible. Feature-gate each capability and preserve the
   current native behavior until the standalone path has parity evidence.
7. **Runtime:** test desktop, Android, and iPad separately. Avoid Electron-only
   assumptions in the view, worker bootstrap, file loading, pointer routing,
   and cleanup. A missing private interception seam should leave the current
   viewer active rather than silently breaking PDF opening.

## What not to adapt

- Do not copy the internal extension-registry mutation as an unconditional
  startup action.
- Do not use a fixed page-count preload window as the large-document policy.
- Do not treat an HTML text-layer search loop as the final search architecture.
- Do not use a page canvas or the viewer's CSS scale as persisted ink geometry.
- Do not reuse the source's annotation storage or AI integration; sidecar JSON,
  recovery, and local-only behavior remain Handwriting Natively contracts.

## Decision

Use this source as proof that a plugin-owned `ItemView` plus PDF.js can be
assembled, and borrow its explicit generation/cancellation and placeholder
concepts. Build #460 around a compatibility-gated host adapter, a bounded
viewer scheduler, PDF.js-owned page/text/annotation primitives, and the
existing page-space annotation session. Keep implementation blocked until the
explicit authorization gate in #460 is satisfied.
