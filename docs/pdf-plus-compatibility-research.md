# PDF++ compatibility and parity research (#465)

**Status:** research-only input to #460. This note records behavior to preserve
or deliberately omit; it does not authorize replacing Obsidian's viewer.

## Evidence and scope

The reference is the public PDF++ repository
[`RyotaUshio/obsidian-pdf-plus`](https://github.com/RyotaUshio/obsidian-pdf-plus),
which is an Obsidian integration built around Obsidian's customized viewer. It
is evidence of host behavior and parity work, not a target architecture. The
most useful source files are:

- [`src/typings.d.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/typings.d.ts)
  — documented private Obsidian/PDF.js object graph and event map.
- [`src/patchers/pdf-internals.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/patchers/pdf-internals.ts)
  — lifecycle, event, selection, copy, subpath, and annotation-layer patches.
- [`src/patchers/pdf-view.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/patchers/pdf-view.ts)
  — PDF view state and file-reload integration.
- [`src/lib/highlights/viewer.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/highlights/viewer.ts)
  and [`src/lib/highlights/geometry.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/highlights/geometry.ts)
  — page-space highlight placement and text-selection geometry.
- [`src/lib/vim/search.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/vim/search.ts)
  — find-bar integration and selection restoration.
- [`src/patchers/pdf-embed.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/patchers/pdf-embed.ts)
  and [`src/dom-manager.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/dom-manager.ts)
  — embed/DOM lifecycle integration.
- [`src/lib/outlines.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/outlines.ts),
  [`src/lib/page-labels.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/page-labels.ts),
  and [`src/lib/destinations.ts`](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/destinations.ts)
  — PDF structure and destination behavior.

No PDF++ source is copied or vendored.

## Feature-parity matrix

| Obsidian/PDF++ capability | Current/private surface | Upstream or independent equivalent | Required in plugin-owned viewer? | Proposal |
| --- | --- | --- | --- | --- |
| Current page and view state | `PDFView.getState`/`setState`; `pdfViewer.currentPageNumber`, `_location`, `currentScale` | Own `ItemView` state plus public `PDFViewer.currentPageNumber`, `scrollPageIntoView`, scale events | Yes | Keep file path, page, bounded offsets, zoom, and rotation in host/view state. Never make `_location` canonical. |
| Page lookup and geometry | `PDFViewer.getPageView`, private `_pages`, `PDFPageView.getPagePoint`, `.page` DOM | PDF.js `PDFPageView`, `PageViewport`; project `AnnotationSurface` page evidence | Yes | Adapter returns validated page identity/geometry. Ink uses page-local PDF space. |
| Text layer and selection | `TextLayerBuilder`, version-dependent `textLayer`, `textDivs`, `textContentItems` | PDF.js `TextLayerBuilder`/`TextLayer`; DOM `Selection` and `Range` | Yes | Preserve selectable text and copy. Treat character-bounds extensions as optional; do not depend on Obsidian's old `textLayerNode` structure. |
| Copy as quote/link | `PDFViewerChild.onMobileCopy`, pointer-up handling, `getTextSelectionRangeStr` | Browser clipboard plus project link encoder | Yes | Preserve user-visible copy/link commands and mobile OS copy path; isolate text-range extraction in the PDF adapter. |
| Find/search | `findBar`, `findController`, `VimSearch`, `textlayerrendered` timing | PDF.js `PDFFindController` and find events | Yes | Own the search UI or drive the upstream controller through an adapter. Do not patch the host find bar. |
| Links and destinations | `PDFLinkService`, `applySubpath`, FitR/XYZ/FitBH parsing | PDF.js `PDFLinkService.goToDestination`, `scrollPageIntoView` | Yes | Preserve `#page`, `#search`, `#selection`, `#annotation`, `#rect`, and destination semantics through a versioned parser. |
| Annotation layer/forms | `PDFPageView.annotationLayer`, `AnnotationLayer.getAnnotation`, popup patches | PDF.js `AnnotationLayerBuilder`, links/forms | Yes | Keep PDF links/forms usable; route handwriting only when explicit annotation mode owns the pointer. Never make PDF.js annotation storage the sidecar. |
| Outline/navigation | `PDFOutlineViewer`, PDF++ outline post-processors and context menus | PDF.js outline component/service | Yes | Preserve outline navigation and optional context actions. PDF source-outline mutation remains a separate PDF service. |
| Thumbnails/sidebar | `PDFThumbnailViewer`, `PDFSidebar`, sidebar events and toolbar patches | PDF.js thumbnail/sidebar components or plugin-owned navigation | Yes, optional UI | Preserve navigation, rotation, and sidebar accessibility. Do not require sidebar discovery for ink. |
| Rotation | `ObsidianViewer.rotatePages`, page viewport/rotation | PDF.js viewer rotation and `PageViewport` | Yes | Treat rotation as part of the page transform key and remap display only; persisted ink remains page-local. |
| Page labels | PDF++ `PDFPageLabels` PDF structure service | PDF.js page labels where exposed; own read-only label service | Yes for navigation parity | Display labels without coupling the ink runtime to PDF mutation code. |
| Backlinks/highlights | `ViewerHighlightLib`, `HighlightGeometryLib`, PDF++ subpath highlights | Sibling page overlay using shared page-space geometry | Yes for this plugin's integrations | Render transient backlink/highlight overlays in the adapter/session; wait for page readiness and clear on generation change. |
| Accessibility and event semantics | Host viewer events and DOM patches | Upstream viewer semantics plus accessible plugin UI | Yes | Keep text selection, keyboard navigation, focus, links, and labels usable; expose sanitized semantic adapter events. |
| Direct vs embedded PDF | `PDFViewerComponent`, `PDFViewerChild`, `PDFEmbed`, `isEmbed` branches | Separate plugin-owned direct/embedded host adapters | Yes | Preserve file identity, subpaths, bounded embed height, hover preview, and leaf/embed teardown without sharing private host classes. |

## Mapping private Obsidian APIs to safer boundaries

| PDF++/Obsidian type or field | Why it is private/risky | #460 boundary |
| --- | --- | --- |
| `PDFViewerComponent` / `PDFViewerChild` | Obsidian lifecycle objects; class shape changed across releases | `NativePdfViewAdapter` and `EmbeddedPdfAdapter` discover the host, then expose `AnnotationSurface` only. |
| `ObsidianViewer` / `createObsidianPDFViewer` | Customized viewer; PDF++ notes that Obsidian 1.8 changed the instance from a class to a raw object with a prototype | Capability probe in `integration/`; no engine dependency. |
| `pdfViewer._pages`, `_location` | Private page registry/location; can disagree during transitions | Own page registry and semantic location evidence; use public events/DOM fallbacks and reject ambiguity. |
| `PDFPageView.getPagePoint` | Useful host helper but not guaranteed | Use `PageViewport`/validated adapter conversion and keep a tested local coordinate contract. |
| `TextLayerBuilder.textLayer`, `textDivs`, `textContentItems` | Text-layer shape changed; PDF++ has separate old/new typings | Use the PDF.js version pinned by the owned viewer; use `TextLayerBuilder` and DOM ranges, with character bounds optional. |
| `PDFLinkService`, `PDFFindController`, `EventBus` | PDF.js concepts are reusable but host instances are private | Construct or discover them only behind the PDF compatibility adapter; translate events to semantic project events. |
| `PDFViewerChild.applySubpath` | Host URL/subpath behavior includes Obsidian embed and deep-link policy | Own a parser and route destinations through `PDFLinkService`; keep Obsidian workspace/file navigation at the host boundary. |
| `PDFView.getState` / `setState` / `onLoadFile` | Prototype patch needed only because PDF++ augments native views | Plugin-owned view state; preserve file identity and reading position without patching host prototypes. |
| `.pdf-viewer`, `.pdfViewer`, `.page`, `.textLayerNode`, `.annotationLayer` | Host DOM selectors and version-specific class names | Probed, versioned adapter selectors only; no selector escapes into input, storage, or ink. |
| `PDFSidebar`, toolbar, find bar | Host UI lifetime and DOM are not stable contracts | Shared plugin toolbar plus optional public/viewer components; sidebar is optional and degradable. |

## Complex behavior references

### Text selection, backlinks, and highlights

`HighlightGeometryLib.computeMergedHighlightRects` converts selection item/range
coordinates into PDF-space rectangles, preferring per-character bounds when the
customized text content provides them and falling back to DOM `Range` geometry.
`ViewerHighlightLib.placeRectInPage` adds a sibling layer to the page and maps
PDF coordinates to percentages using the page view box. The design lesson is
sound: highlight geometry is page-local and rendering is transient. The
implementation must be rewritten against the new page adapter, not copied; the
new viewer should not require `textContentItems.chars` or host layer class names.

`patchPDFInternals` waits for text/annotation/page readiness before applying
subpath highlights and clears them through the child lifecycle. A plugin-owned
viewer should use generation-aware page-ready signals and a disposable overlay
controller instead of monkey-patching `PDFViewerChild.highlightText`.

### Search, links, and state

`patchPDFView` patches `getState`, `setState`, and `onLoadFile` to preserve page,
left/top, zoom, and subpaths across workspace reloads. `patchPDFInternals` extends
`applySubpath` for search, selection, annotation, rectangle, FitR, XYZ, and
FitBH behavior. `VimSearch` drives the find bar and restores selection around
find matches. These are parity requirements, not reasons to retain the private
host object graph: the owned viewer should implement a stable state schema and
use PDF.js link/find services behind its own adapter.

### Lifecycle and patch/reload behavior

`patchPDFInternals` wraps `load`, `unload`, and `loadFile`, and
`reloadPDFViewerComponent` unloads/reloads existing views so newly installed
patches take effect. It also unregisters an old Escape key handler to avoid a
stale find-bar instance. This demonstrates how much lifecycle coordination is
needed when extending a host-owned viewer. A plugin-owned view eliminates that
class of patch/reload hazard; every listener, observer, keyboard binding, and
overlay can be registered in the viewer session cleanup stack.

## Obsidian-specific hacks that can be eliminated

- Prototype monkey patches for `PDFViewerComponent`, `PDFViewerChild`,
  `ObsidianViewer`, and `PDFView`.
- Reloading every existing viewer after patch installation and unregistering
  stale host keymaps.
- Version checks for Obsidian 1.7/1.8 text-layer shapes and API 1.8.0-only
  selection fixes.
- Selectors and assumptions about `.pdf-viewer`, `.pdfViewer`, `.page`,
  `.textLayerNode`, toolbar siblings, and sidebar DOM.
- Workarounds for host `applySubpath`, host default zoom/sidebar/spread settings,
  and embed height feedback loops.
- Desktop-only copy listeners that must be disabled because mobile calls
  `PDFViewerChild.onMobileCopy` itself.
- Native host popup suppression and link-annotation special cases caused by
  patching the existing annotation implementation.

These are not defects in PDF++—they are the cost of extending a changing host
viewer. An independent viewer owns these policies directly.

## Obsidian behavior that must remain compatible

- Workspace leaf open/close, split panes, active-view state, file rename/modify,
  reload, plugin unload, and direct-vs-embedded/hover-preview lifetimes.
- Vault file identity and subpath links, including page/offset/zoom/search and
  selection/annotation/rectangle deep links where supported.
- Text selection, copy, keyboard navigation, find, links/destinations, forms,
  rotation, outline, thumbnails, page labels, accessibility, and native touch
  navigation. Handwriting must not steal these unless annotation mode has
  explicit ownership.
- Obsidian commands, context menus, notices, settings, toolbar placement, and
  workspace history semantics that are part of the user-facing plugin contract.
- Backlink/highlight overlays and their scroll-to-target behavior, implemented
  as transient page-space siblings with safe generation checks.
- Source-PDF mutation/export semantics and sidecar identity. The viewer must
  never turn an export or rewritten source PDF into the canonical ink model.

## Mobile observations

PDF++ explicitly uses `Platform.isMobile`, rather than `isDesktopApp`, before
adding a desktop `copy` listener because Obsidian invokes
`PDFViewerChild.onMobileCopy` on mobile. PDF++ also moved its post-selection
behavior from `mouseup` to `pointerup` after an Obsidian change. It carries
version-specific workarounds for text selection across Obsidian 1.9.0–1.9.3
and guards canvas/embed behavior when the viewer is not ready.

For a plugin-owned viewer:

- keep browser/native selection and the OS copy menu available on Android and
  iPadOS;
- use Pointer Events with the existing single-owner policy, never a global
  `touch-action: none`;
- test pen, finger scrolling, two-finger pinch, text selection, annotation
  links/forms, keyboard/trackpad, background/resume, and split/embedded views;
- treat mobile WebView worker/CMap/WASM availability and viewport resize as
  capability probes, not desktop assumptions;
- keep sidebar/toolbar and popup behavior optional; missing mobile chrome must
  not block safe page annotation.

## Decision for #460

Preserve the user-visible PDF contract and the page-space highlight/deep-link
semantics, but do not reproduce PDF++'s host patching architecture. The current
`integration/` boundary is the correct compatibility home: it may observe a
native viewer during the transition, while a future plugin-owned viewer uses
public PDF.js components, its own lifecycle/session state, and the existing
`AnnotationSurface`/sidecar contracts. Keep the native path as a fallback until
parity and physical desktop/Android/iPad evidence cover the matrix above.
