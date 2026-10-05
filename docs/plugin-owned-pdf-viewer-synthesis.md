# Plugin-owned PDF viewer research synthesis (#461)

**Status:** research/design only. This is the synthesis requested by #461 and
an input to #460. It does not authorize implementation, default-backend change,
viewer migration, or removal of the current native viewer.

## Evidence set

The five source investigations are now landed:

- [obsidian-pdf-tools patterns](./plugin-owned-pdf-viewer-research.md) —
  plugin-owned Obsidian view, vault loading, worker setup, lifecycle, and
  capability risks.
- [Mozilla PDF.js components](./pdfjs-component-research.md) — official
  component/API boundaries, cancellation, layers, search, links, and packaging.
- [dealfonso/pdfjs-viewer virtualization](./pdfjs-viewer-virtualization-research.md)
  — visible-page retention, cleanup, zoom anchoring, and raster scheduling.
- [PDF++ compatibility](./pdf-plus-compatibility-research.md) — Obsidian
  private surfaces, parity behaviors, mobile observations, and hacks to avoid.
- [runtime assets](./pdfjs-runtime-asset-research.md) — exact-version runtime
  assets, workers, auxiliary resources, CSP, and cleanup.

All are research notes. No donor source is copied or vendored.

## 1. Recommended viewer shell architecture

```text
Obsidian registerView / plugin-owned ItemView
  └─ ViewerSession (document + viewer generation)
      ├─ page shell registry and priority scheduler
      ├─ PDF.js document/page adapter
      ├─ text/link/find/annotation capability adapters
      ├─ page-space overlay host for ink
      └─ shared AnnotationSurface / sidecar / input / UI runtime
```

Register a plugin-owned `ItemView` through Obsidian's public view registration
surface. Keep `TFile`, leaf state, direct/embedded host discovery, and bounded
reading state at the integration boundary. Load vault bytes into a versioned
viewer session; do not instantiate a second upstream viewer inside an existing
direct PDF view and do not reparent the native viewer DOM.

PDF extension interception is a compatibility adapter, not the engine. If the
current host requires a private `.pdf` mapping, probe it, snapshot the prior
mapping, install only after capability validation, restore it on unload, and
fail closed when the registry shape changes. The current native viewer remains
the fallback. Embedded PDFs and hover previews need separate host adapters but
share the same generic page/ink session contract.

## 2. Recommended PDF.js component/API layer

Use an exact, reviewed PDF.js version behind `src/integration/`:

- `getDocument({ data, ...assetOptions })` and
  `PDFDocumentLoadingTask.destroy()` for document loading/cleanup;
- `PDFPageView` for page-owned canvas/viewport/raster lifecycle;
- `TextLayerBuilder` for selectable text;
- `AnnotationLayerBuilder` for links/forms/PDF annotations;
- `PDFLinkService` for destinations and page navigation;
- `PDFFindController` for document search;
- `EventBus` only as an adapter input, translated to semantic project events;
- `PageViewport` conversion for the page-space coordinate boundary.

Prefer these lower-level components over `PDFViewerApplication`'s global shell.
The project owns outer scroll, input ownership, gesture phases, overlays,
toolbar, persistence, and lifecycle generations. Never make private `_pages`,
`_location`, host DOM class names, or customized Obsidian fields engine
contracts.

## 3. Recommended page virtualization strategy

Keep a logical shell and page geometry for every page, but mount heavy resources
only in a bounded working set:

1. `IntersectionObserver` and coalesced scroll/settle signals classify visible,
   near-visible, and cold page shells.
2. A generation-aware priority queue renders visible pages first, then nearby
   previews, then settled high-resolution upgrades.
3. Visible pages and active ink surfaces are protected. Offscreen raster/text/
   annotation resources are evicted by a measured byte/page budget while shell
   geometry and sidecar state remain.
4. Each render key includes document, page, scale, rotation, content revision,
   and viewer generation. Late promises cannot attach a stale canvas or overlay.
5. Cancellation is explicit for document replacement, page eviction, zoom
   supersession, rotation, and view disposal.

The fixed preload window and serialized queue from the virtualization reference
are useful concepts, not sufficient policy. Queue priority, memory budget,
visible-page protection, and generation checks are required for large PDFs and
mobile devices.

## 4. Recommended zoom and render-resolution strategy

Use two phases:

- **Gesture/compositor:** preserve the pinch focal point with one bounded visual
  transform applied to the protected page surface and ink overlay. Do not call
  PDF.js for every pointer sample and do not persist CSS transform values.
- **Canonical/render:** on settle, commit logical scale and rotation, recalculate
  page bounds, render visible pages at a fast baseline, then schedule cancellable
  high-resolution upgrades. Retain old pixels until replacements are ready.

Persist only page-local document coordinates. Canvas backing-store dimensions,
CSS transforms, scroll offsets, device-pixel-ratio, and transient viewport
geometry are render-time inputs. Rotation is part of the viewport/render key.

## 5. Text, links, search, and annotation layers

Use sibling layers in one page host:

```text
page host (logical geometry / viewport)
  ├─ PDF.js canvas
  ├─ TextLayerBuilder layer
  ├─ AnnotationLayerBuilder layer (links/forms/PDF annotations)
  └─ Handwriting Natively ink overlay (pointer-events policy controlled)
```

`PDFLinkService` owns PDF destinations and external-link policy; the project
parser owns Obsidian subpaths and routes supported destinations through it.
`PDFFindController` is the search authority; do not fork repeated
`getTextContent()` searches. Text selection/copy remains available, including
the mobile OS copy path. PDF annotation links/forms must not be swallowed by
ink input unless annotation mode has explicit pointer ownership.

The sidecar remains the canonical editable ink model. PDF.js annotation storage,
export bytes, or native viewer editor state are never substituted for it.
Backlink, selection, and rectangle highlights are transient page-space siblings
that wait for validated page readiness and clear on viewer/page generation
change.

## 6. Worker and auxiliary asset packaging

Pin the core/runtime/worker to one exact PDF.js release and package an explicit
manifest outside the main bundle:

```text
pdf.mjs                         core display runtime
pdf.worker.min.mjs              module worker
cmaps/*.bcmap                   arbitrary/CJK document support
standard_fonts/*                fallback standard fonts
wasm/*                          feature-gated image/color decoders
iccs/*                          color profiles when enabled
pdf.sandbox.mjs                 only if scripting/forms are authorized
viewer.mjs + viewer.css         only for adopted stock viewer features
locale/*, images/*              only for corresponding optional UI
```

Use one runtime URL resolver after esbuild relocation and validate emitted
plugin-package paths, not only repository development paths. Keep CMaps/fonts/
WASM/ICC external to the CJS bundle to respect the plugin budget. Prefer a
packaged same-release module worker over a Blob worker; gate any Blob fallback
against CSP and desktop/Android/iPadOS capability tests. No CDN or remote
runtime fallback is allowed for offline operation.

The host CSP controls a same-DOM plugin. Qualify worker/module/WASM/style/font/
image paths without adding broad `unsafe-eval`, `connect-src *`, or unneeded
`blob:`/`data:` allowances. Preserve PDF.js and auxiliary asset license/notice
files in the release boundary.

## 7. Obsidian registration and interception

- Public `registerView` is the primary plugin-owned shell seam.
- Workspace/file/leaf lifecycle remains at the host adapter.
- The private extension-registry PDF interception seam is optional, isolated,
  versioned, reversible, and capability-gated.
- No private Obsidian object or selector crosses into input, ink, storage, or
  UI modules.
- Missing viewer registry, toolbar, sidebar, find controller, or EventBus is an
  independent degraded capability; missing page identity/geometry is unsafe and
  blocks annotation for that page/view.
- Direct and embedded sessions use the same `AnnotationSurface`, sidecar,
  toolbar, autosave, recovery, and input policy.

A changed native viewer object graph increments the adapter viewer generation.
Mounted pages also carry a mount generation. Every async page/geometry/overlay/
event callback validates both before mutating state.

## 8. Mobile gesture and scroll-runway implications

Desktop PDF behavior cannot establish mobile safety. Qualify Android and iPadOS
separately for:

- stylus drawing, finger scroll, two-finger pinch, mouse/trackpad where present;
- text selection, OS copy menu, links/forms, find, outline/sidebar, and focus;
- lazy page replacement, resize/rotation, background/resume, split/embedded
  views, plugin unload, and document replacement;
- packaged module-worker handshake, CMaps/fonts/WASM/ICC paths, and CSP;
- memory pressure and raster eviction while the ink overlay remains stable.

Use Pointer Events and the existing single-owner policy: pen is plugin-local,
touch remains host navigation unless explicit annotation mode owns it, and no
global `touch-action: none` is permitted. The scroll runway must keep native
navigation responsive while low/high raster work is queued and cancelled.

## 9. Concepts to borrow versus rewrite

| Borrow conceptually | Rewrite inside this project |
| --- | --- |
| Plugin-owned `ItemView` and vault-byte loading | Obsidian state, leaf, embed, and fallback integration |
| PDF.js `getDocument`, page view, text/link/find/annotation components | Viewer shell, toolbar, input routing, lifecycle ownership |
| Logical page shells and visible/near-visible retention | Generation-aware priority scheduler and measured cache |
| Low-resolution/live-transform/high-resolution rendering phases | Focal-point zoom and page-space ink mapping |
| Explicit worker/asset manifest and independent capability checks | esbuild release resolver and Obsidian desktop/mobile packaging |
| Page-ready callbacks and transient sibling highlight layers | `AnnotationSurface` mount/teardown and sidecar-safe overlay session |
| PDF.js event semantics | Sanitized project events; no private fields or host class contracts |
| PDF++ parity inventory and mobile failure evidence | Public/upstream equivalents rather than prototype patches |
| Reversible cleanup and task cancellation | Existing session disposal, autosave/recovery, and pointer-capture order |

Do not copy code from AGPL/CC BY-NC-ND/production-restricted sources, bundle
third-party reference viewers, or inherit their storage/monolith architectures.
PDF.js and other runtime dependencies retain their own licenses and notices.

## 10. Unresolved risks and authorization gates

Research does not resolve:

1. Which Obsidian desktop, Android, and iPad builds permit a packaged module
   worker and the selected PDF.js asset URLs under their CSP/origin model.
2. Whether all target PDFs can render with the selected CMap/font/WASM/ICC
   subset and memory budget.
3. Whether PDF.js's selected version has parity for forms, annotations,
   accessibility, search, outline, thumbnails, labels, links, and mobile focus.
4. How a private `.pdf` extension interception seam changes across Obsidian
   releases, and whether a public open-view command can avoid it.
5. How to preserve every direct/embedded/hover-preview/file-reload/subpath
   behavior without reparenting native viewer DOM.
6. Whether the runtime asset set fits release/package constraints with license
   notices and without weakening privacy/offline guarantees.
7. Hardware-dependent gesture, text selection/copy, background/resume, and
   memory-pressure behavior; unit tests cannot close these gates.

Before any #460 implementation begins, the project owner must separately
authorize it. That authorization must be followed by an explicit capability
matrix, packaged-asset prototype, desktop/Android/iPad qualification plan,
parity acceptance criteria, rollback/fallback behavior, and a decision on
whether native PDF remains the default during staged rollout.

## Synthesis decision

The safest target is a plugin-owned, same-DOM `ItemView` backed by PDF.js
components and a narrow Obsidian compatibility adapter. It combines the
official component lifecycle with a generation-aware page scheduler, focal-point
zoom, page-space overlays, exact-version offline assets, and native fallback.
The research track is complete; the production replacement remains blocked by
#460's explicit authorization requirement.
