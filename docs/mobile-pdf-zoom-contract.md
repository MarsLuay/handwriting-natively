# Mobile-only hybrid PDF pinch-zoom contract

This document defines the opt-in replacement path for mobile PDF pinch zoom. It is a contract for the later gesture, compositor, and native-handoff work; it does not enable the feature by default and does not change desktop behavior.

## Activation gate

`planMobileCustomPdfZoom` must receive all of the following explicit evidence:

- the future user setting is enabled;
- the surface is a PDF and the adapter is identified separately as `direct` or `embedded`;
- `PlatformCapabilityReport` identifies Android or iPad, reports `isMobile: true`, and reports both Pointer Events and Touch Events as available;
- the PDF compatibility profile has a viewer root, rendered page elements, a scroll root, readable geometry, trustworthy page numbers, a private viewer, a readable scale, and an observable page replacement path;
- the current page has safe geometry and identity; and
- the adapter has positively probed a native scale commit operation.

Desktop, an unknown platform, an unknown mobile flag, an unknown runtime capability, a missing private viewer, or an unavailable native scale commit always selects `native-fallback`. No user-agent, viewport, CSS class, or guessed tablet classification may opt in. A missing optional EventBus or page-render event does **not** by itself disable the path: the existing DOM geometry/mutation fallback is selected and recorded.

The gate is evaluated again when the viewer, page mount, or compatibility generation changes. A failed evaluation leaves native Obsidian/PDF.js ownership intact.

## Ownership and state machine

The owner is selected before any temporary compositor transform is applied:

| State | Entry | Owner | Exit |
| --- | --- | --- | --- |
| `native-idle` | gate is disabled, unsupported, or no active custom gesture | Obsidian/PDF.js | qualified two-touch candidate, or ordinary native navigation |
| `candidate` | first finger is observed on a qualified PDF page | native one-finger navigation | second touch with no pen promotes to `active`; release/cancel returns native |
| `active` | two touch contacts, no active pen, and a valid page generation | plugin compositor | pointer/touch cancel, pen admission, page replacement, hidden view, or release of a touch |
| `settling` | last pinch contact ends | native handoff coordinator | committed scale and geometry settle, or cancellation |
| `cancelled` | any unsafe or ambiguous condition | native fallback | temporary state removed, then `native-idle` |

One finger remains native. A confirmed pen owns annotation immediately; a companion finger remains native and cannot promote to pinch. Ineligible surfaces and disabled mode never enter `candidate` for custom ownership. The implementation may observe both Pointer Events and Touch Events, but must reconcile them by contact identity and must not count a paired browser event twice.

The page surface may use the narrow mobile policy needed to keep native one-finger panning while excluding the host pinch path (for example, `pan-x pan-y`). This policy is applied only to a qualified PDF page during the opt-in path. It must never become a global `touch-action: none`, a document-wide listener, or a drawing-mode policy.

## Compositor and coordinate contract

During `active`:

1. Capture the two admitted contact IDs and their midpoint in the PDF viewport coordinate system.
2. Measure the initial distance and page/scroll geometry. Accumulate preview scale from distance ratios, bounded by the same scale limits used by native PDF.js.
3. Transform the PDF page visual layer and the matching handwriting overlays together around the captured content anchor. Do not transform the scroll root, sidebar, toolbar, or outer Obsidian shell.
4. Convert viewport midpoint to page-local coordinates using the current page geometry and scroll offset. Compensate scroll position so the same page point remains under the midpoint while the preview scale changes.
5. Coalesce visual updates to one animation frame. No annotation model mutation, sidecar write, PDF rewrite, or raw pointer stream is part of the preview.

The transform is temporary. The canonical scale remains PDF.js/Obsidian's scale, and page-space ink remains unchanged.

## Native handoff boundary

At `settling`, the coordinator must verify the captured viewer generation, page identity, page geometry, and current compatibility report. It then commits the final scale through the positively probed private viewer operation (`updateScale` or an equivalent writable native operation), using the midpoint/scroll anchor supported by that operation. EventBus events are preferred for observing the resulting scale and render completion, but are not assumed to exist.

If the viewer, native scale operation, page identity, geometry, render lifecycle, or generation evidence is unavailable, the coordinator removes the temporary transform and returns to native ownership. It must not leave a permanently CSS-scaled low-resolution page, guess a private viewer path, or apply a handoff to a stale page shell. DOM geometry/mutation evidence may confirm a settle when the EventBus is missing; unsafe geometry cancels instead.

A viewer-generation change always cancels the temporary transform. The new generation must be reconciled and re-gated before a later gesture can start. A page identity change or unsafe geometry has the same result. This prevents a replacement page from inheriting a previous page's transform or anchor.

## Cancellation and lifecycle

Cancellation removes the compositor transform, releases captures/listeners, clears contact and anchor state, and restores the last native scroll/scale observation. It covers pointer cancel, TouchEvent cancel, lost capture, visibility/pagehide/background, viewer or page replacement, capability loss, native scrolling observed before admission, and handoff failure. Cancellation is fail-closed: native navigation resumes rather than leaving a half-owned gesture.

Close, note switching, plugin unload, and adapter teardown run the same cleanup even if no final touch event arrives. A stale listener or old adapter must not receive the next generation's contacts.

## Compatibility targets and validation gate

Direct and embedded PDF views are separate compatibility targets. Each needs its own capability evidence and a named host/device run; success on one does not imply success on the other. Desktop native zoom, mouse/trackpad zoom, stylus annotation, and unsupported hosts remain outside this replacement path.

The feature stays opt-in until physical evidence is copied for at least:

- a named iPadOS/iOS host using a direct PDF view and an embedded PDF view;
- a named Android host using a direct PDF view and an embedded PDF view; and
- desktop regression checks confirming native pinch/trackpad behavior, one-finger navigation, pen-plus-finger input, links/search, page changes, and scroll anchoring.

Each run must record the plugin build, Obsidian build, adapter kind, input mode, whether the EventBus/private viewer path was available, and bounded observations for midpoint anchoring, handoff resolution, cancellation, and generation replacement. Synthetic tests can prove decisions and invariants, but cannot mark physical rows as validated or enable the default.
