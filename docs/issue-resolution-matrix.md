# Open issue resolution matrix

This document records what is implemented in the current repository, what is intentionally bounded, and what still requires a live Obsidian/device trace. It is a delivery map, not a substitute for hardware evidence.

## Coordinate contract (#132)

- **PDF/page space** is the persisted authority. Stroke and text coordinates are measured from the page's logical top-left in PDF units.
- **Viewport/CSS space** is transient. Page bounds, zoom, scroll, and rotation map page space to the currently mounted page element.
- **Backing-store space** is a render detail. Device-pixel-ratio changes resize backing stores but never rewrite persisted geometry.
- Input is converted from client coordinates to page space once at the session boundary. Rendering, selection, erasing, and export consume the same page-space model.
- A scroll or zoom event must never mutate sidecar coordinates. During zoom, scale change and final geometry settle are separate signals.
- Required fixture coverage includes non-integer zoom, DPR changes, rotation, mixed page sizes, scrolling, and export alignment. Current automated coverage exercises the mapper and zoom paths; unusual CropBox/MediaBox fixtures and live mobile traces remain follow-up work.
- **Audit outcome:** the current mapper intentionally covers the legacy zero-origin page model and keeps viewport/CSS/backing transforms separate. Full `PageViewport`/`viewBox`/`userUnit` fidelity, asymmetric export fixtures, and hardware traces are scoped follow-ups rather than claims of shipped support; future work must preserve these invariants instead of widening the PDF integration boundary opportunistically.

## Integration contract (#131)

`src/integration/` is the only owner of Obsidian/PDF.js selectors and private object probing. The core session receives generic page/view semantics through `AnnotationSurface`; `ObsidianPdfAdapter` remains the PDF-specific compatibility implementation. Missing private viewer objects, toolbar hosts, find controllers, or EventBus signals degrade independently; missing page identity or trustworthy geometry is unsafe and must fail closed. PDF-only callbacks are optional surface extensions.

The current compatibility evidence is per adapter instance and includes direct/embedded discovery, page-node validation, scroll fallback, optional private viewer access, and bounded teardown. A released Obsidian build is still required to establish a known-good profile.

## Input ownership (#130)

Pointer Events are authoritative when available:

- pen owns annotation only on an annotatable page and with an ink-capable tool;
- touch stays native PDF navigation/pinch and cannot steal an active pen stroke;
- mouse follows the explicit mouse input policy;
- Touch Events are only lifecycle/compatibility observation and never a second drawing engine;
- no global `touch-action: none` is used.

`PointerRouter` generation cleanup, pointer capture loss, cancel, blur, and session destruction clear stale ownership. The detailed ownership contract, fallback boundary, bounded diagnostics, deterministic test boundary, and physical validation matrix are recorded in [`docs/input-gesture-architecture.md`](input-gesture-architecture.md). Real iPadOS/WKWebView traces are still required before removing any compatibility fallback or claiming Pencil/Scribble behavior.

## Lifecycle (#136)

The session owns page routers, observers, rAF/timer work, zoom profiling, toolbar/overlay nodes, and persistence scheduling. Destroy is idempotent and disconnects those resources; router generations and page replacement checks reject stale callbacks. The highest-risk remaining validation is destroy/rebind during attach retry, zoom settle, active persistence, page virtualization, and same-document multi-leaf editing.

No asynchronous callback is allowed to be treated as proof that a newer viewer generation is still valid. New work should use the existing generation and cleanup seams rather than add independent stale flags.

- **Audit outcome:** each viewer session owns its disposable observers, routers, timers, overlays, and persistence handoff; per-document autosave serialization remains the cross-leaf integrity boundary. Deterministic tests cover cancellation, destruction, page replacement, and stale-generation guards, while split/merge leaves and same-document multi-leaf stress remain release validation rather than unverified guarantees.

## Storage and page mutation (#133, #33)

- Sidecar remains the canonical editable store; source-PDF writes are limited to explicit page actions.
- Autosave remains debounced and serialized. Existing sidecar replacement now preserves a validated `.last-good` copy before overwriting an existing primary, so crash recovery does not depend only on exception-time rollback.
- Raw-byte optimistic locking and conflict files remain enabled. Cross-process/device compare-and-swap is not available through the current adapter, so divergent sync branches are preserved rather than auto-merged.
- Add, delete, import, and scan page actions use one compensating PDF/sidecar/recovery transaction and deterministically shift annotated page numbers. That page number is the logical ink identity for these actions. Persistent page UUIDs remain #133.
- pdf-lib 1.17.1 in-place insert and delete keep document metadata, outlines, and the catalog AcroForm. Existing page annotations stay on the original page object, so a blank page inserted before them does not inherit the link or widget. Outline destinations keep pointing at that page object.
- `copyPages` import keeps the copied page's size, rotation, content streams, and page annotations. It does not copy document title, outlines, or the catalog AcroForm, so a copied widget is not a live imported form.
- Image pages from `insertScannedPages` use the caller-supplied pixel size. The long edge is 792pt, the other edge preserves aspect, and the image fills that page with no margin. This writer does not read EXIF.
- A trailer `/Encrypt` entry, an encrypted load error, or a `/Type /Sig` dictionary refuses the rewrite before save. The open file bytes stay unchanged. Copying pages out of a signed source into an unsigned destination is allowed because the signed file is not saved.
- Reorder and duplicate are not shipped. Open-document view restore stays the existing Add Page path. Multi-leaf and mobile viewer reloads stay release-matrix checks.
- **Audit outcome:** the current v1 sidecar/recovery protocol is the supported integrity boundary: staged validation, last-good preservation, raw-byte conflict detection, and compensating page mutations are verified locally. Commit-lineage v2, stable page UUIDs, and cross-device compare-and-swap remain explicitly bounded follow-ups and must not be implied by the current schema.

## Large documents and performance (#128, #129, #134)

Bounded local profiles now summarize zoom, stroke, pan, render, and persistence work without per-frame/per-pointer log floods. The profile is debug-gated and copied with a schema/version footer. The profile records evidence needed to choose mount radius, cache size, dirty-region policy, and mobile budgets; it does not invent targets before representative traces exist.

The remaining large-document decision must be based on 10/100/500/1,000-page fixtures, dense strokes, rapid scroll/zoom, and at least one constrained mobile device. Until then, avoid expanding bitmap caches or eager page mounting merely to improve an unmeasured case.

## Release matrix (#135)

Before a release, run the repeatable smoke sequence in `docs/current-limitations.md` on:

1. desktop native PDF;
2. desktop embedded PDF;
3. iPadOS + Apple Pencil;
4. Android tablet/active stylus where available;
5. touch-only mobile;
6. Windows/macOS mouse and trackpad.

Record plugin/Obsidian/runtime metadata, compatibility strategy, and copied bounded diagnostics for every failure. Synthetic tests cover deterministic routing, mapping, storage, and teardown; they cannot certify hardware-only gestures, pressure, hover, WebKit cancellation, suspension, or native pinch ownership.

## Toolbar and images (#30, #25)

Drawing presets are persisted, capped, selectable in one action, and editable from the drawing menu. Selecting a preset changes the active tool and settings together, so toolbar state and routed tool state cannot disagree. Stylus-first routing remains the default; mouse behavior remains explicit and touch stays native.

Image annotation is not implemented as a second renderer. `ImageViewAdapter` supplies the one-page `AnnotationSurface` implementation for static PNG and JPEG/JPG files and reuses page-local ink, input, tools, sidecar identity, recovery, and lifecycle without converting the image to a PDF. The source image is read-only during annotation; browser-native displayed orientation is not transformed a second time, and the shared backing-store budget bounds handwriting canvases. PDF export, PDF.js find, page insertion/deletion, scan actions, and flattened image export remain unavailable on that surface. WebP, HEIC/HEIF, GIF, SVG, and other unsupported image views remain unannotated.

## Evidence boundary

This matrix separates verified code/tests from claims requiring current Obsidian desktop, Android, iPadOS, and multi-leaf runtime validation. Do not close the hardware-dependent portions solely because unit tests pass.
