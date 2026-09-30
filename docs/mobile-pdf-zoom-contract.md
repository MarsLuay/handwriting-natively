# Mobile-only CSS-owned PDF pinch-zoom contract

This document defines the experimental replacement path for mobile PDF pinch zoom. The persisted `customMobilePdfPinchZoom` setting defaults to `true`, can be explicitly disabled, is independent of `boostedPdfZoom`, and does not change desktop behavior. PDF.js remains the renderer and keeps its canonical scale; the custom path owns only the visual container zoom.

## Activation gate

`planMobileCustomPdfZoom` must receive all of the following explicit evidence:

- `customMobilePdfPinchZoom` is enabled;
- the surface is a PDF and the adapter is identified separately as `direct` or `embedded`;
- `PlatformCapabilityReport` identifies Android or iPad, reports `isMobile: true`, and reports both Pointer Events and Touch Events as available;
- the PDF compatibility profile has a viewer root, rendered page elements, a scroll root, readable geometry, trustworthy page numbers, a private viewer, a readable scale, and an observable page replacement path;
- the current page has safe geometry and identity.

Desktop, an unknown platform, an unknown mobile flag, an unknown runtime capability, or a missing private viewer always selects `native-fallback`. A writable PDF.js scale is not required because the custom path never commits `currentScale`. No user-agent, viewport, CSS class, or guessed tablet classification may opt in. A missing optional EventBus or page-render event does **not** by itself disable the path: the existing DOM geometry/mutation fallback is selected and recorded.

The gate is evaluated again when the viewer, page mount, or compatibility generation changes. A failed evaluation leaves native Obsidian/PDF.js ownership intact.

## Ownership and state machine

The owner is selected before any temporary compositor transform is applied:

| State | Entry | Owner | Exit |
| --- | --- | --- | --- |
| `native-idle` | gate is disabled, unsupported, or no active custom gesture | Obsidian/PDF.js | qualified two-touch candidate, or ordinary native navigation |
| `candidate` | first finger is observed on a qualified PDF page | native one-finger navigation | second touch with no pen promotes to `active`; release/cancel returns native |
| `active` | two touch contacts, no active pen, and a valid page generation | CSS/container compositor | pointer/touch cancel, pen admission, page replacement, hidden view, or release of a touch |
| `settled` | last pinch contact ends | CSS/container zoom | final visual zoom remains until reset, native zoom, page replacement, or teardown |
| `cancelled` | any unsafe or ambiguous condition | native fallback | temporary state removed, then `native-idle` |

One finger remains native. A confirmed pen owns annotation immediately; a companion finger remains native and cannot promote to pinch. Ineligible surfaces and disabled mode never enter `candidate` for custom ownership. The implementation may observe both Pointer Events and Touch Events, but must reconcile them by contact identity and must not count a paired browser event twice.

The page surface may use the narrow mobile policy needed to keep native one-finger panning while excluding the host pinch path (for example, `pan-x pan-y`). This policy is applied only to a qualified PDF page during the opt-in path. It must never become a global `touch-action: none`, a document-wide listener, or a drawing-mode policy.

## Compositor and coordinate contract

During `active`:

1. Capture the two admitted contact IDs and their midpoint in the PDF viewport coordinate system.
2. Measure the initial distance and page/scroll geometry. Accumulate a visual zoom factor from distance ratios.
3. Apply the browser `zoom` property to the validated PDF viewer root so PDF pixels and child handwriting overlays remain in one visual coordinate system. Do not zoom the scroll root, sidebar, toolbar, or outer Obsidian shell.
4. Solve scroll coordinates from the original root/focal geometry so the same content point remains under the moving midpoint.
5. Normalize pointer/page-layout coordinates by the active root zoom; child overlays and canvas backing sizes remain in their unzoomed PDF coordinate space while screen projections multiply the root zoom.
6. Coalesce visual updates to one animation frame. No annotation model mutation, sidecar write, PDF rewrite, or PDF.js scale commit is part of the gesture.

The final CSS/container zoom remains after `settled`; cancellation restores the pre-gesture zoom and scroll. PDF.js continues rendering and keeps its own canonical scale unchanged.

## PDF.js boundary

There is no release-time native scale handoff. The coordinator does not call `updateScale`, write `currentScale`, or wait for PDF.js canvas replacement before releasing the gesture. This is intentional: keeping one CSS/container owner removes the visible transform-to-PDF.js resize seam.

PDF.js remains responsible for rendering, text, links, search, and its own explicit toolbar/native zoom actions. An explicit native zoom event clears the CSS zoom so the two owners never compound. Page identity, geometry, and viewer-generation checks still gate custom input and cancellation; unsafe geometry cancels instead of leaving a partial CSS zoom.

A viewer-generation change always cancels the temporary transform. The new generation must be reconciled and re-gated before a later gesture can start. A page identity change or unsafe geometry has the same result. This prevents a replacement page from inheriting a previous page's transform or anchor.

## Cancellation and lifecycle

Cancellation removes the temporary CSS zoom, releases captures/listeners, clears contact and anchor state, and restores the pre-gesture scroll/zoom. It covers pointer cancel, TouchEvent cancel, lost capture, visibility/pagehide/background, viewer or page replacement, capability loss, native scrolling observed before admission, and CSS-zoom setup failure. Cancellation is fail-closed: native navigation resumes rather than leaving a half-owned gesture.

Close, note switching, plugin unload, and adapter teardown run the same cleanup even if no final touch event arrives. A stale listener or old adapter must not receive the next generation's contacts.

## Diagnostics and compatibility targets

Copied session diagnostics expose only bounded mode evidence: `settingEnabled`, `mode` (`custom-mobile` or `native-fallback`), fallback reasons, the active CSS-zoom phase, and the last observed trace mode/phase. Copy Logs always appends a compact per-session status after the log tail, including whether a custom gesture was observed and bounded CSS-zoom timing; native commit wait and canonical PDF.js render work remain absent for this path. They do not expose private viewer objects, raw pointer streams, document contents, or network telemetry. A `native-fallback` result is expected for disabled settings, desktop/unknown hosts, missing capability evidence, or unsafe page generations.

Physical validation remains separate from the gate. A diagnostic mode is evidence of the selected branch, not a device support claim.

## Compatibility targets and validation gate

Direct and embedded PDF views are separate compatibility targets. Each needs its own capability evidence and a named host/device run; success on one does not imply success on the other. Desktop native zoom, mouse/trackpad zoom, stylus annotation, and unsupported hosts remain outside this replacement path.

The feature remains capability-gated until physical evidence is copied for at least:

- a named iPadOS/iOS host using a direct PDF view and an embedded PDF view;
- a named Android host using a direct PDF view and an embedded PDF view; and
- desktop regression checks confirming native pinch/trackpad behavior, one-finger navigation, pen-plus-finger input, links/search, page changes, and scroll anchoring.

Each run must record the plugin build, Obsidian build, adapter kind, input mode, whether the EventBus/private viewer path was available, and bounded observations for midpoint anchoring, handoff resolution, cancellation, and generation replacement. Synthetic tests can prove decisions and invariants, but cannot mark physical rows as validated or enable the default.
