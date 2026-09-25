# PDF runtime validation matrix

**Matrix schema:** `pdf-runtime-validation-matrix/v1`

This versioned matrix is the manual-runtime companion to the deterministic compatibility fixtures. Unit tests are not substituted for a current Obsidian qualification run. A row may be promoted to `known-good` only when the captured per-instance profile and lifecycle trace are attached to the row. `not-run`, `blocked`, and `failed` are honest release states; none may be treated as support evidence.

## Deterministic fixture coverage

| Scenario | Fixture/check | Evidence expected |
| --- | --- | --- |
| Direct attach with native page shell | `tests/integration-compatibility.test.ts` | `adapter: direct`, numbered page strategy, viewer generation `1` |
| Embedded attach | `tests/pdf-integration-fixtures.test.ts` | `adapter: embedded`, same page/geometry contract |
| Missing toolbar/private viewer/EventBus | compatibility tests | optional fallback or `degraded`; annotation remains available when page evidence is safe |
| Duplicate or stale page shell | `tests/pdf-page-locator.test.ts` | independent mount generation; ambiguous identity is unsafe |
| Zoom fallback and inner-layer churn | `tests/pdf-sidebar-rail-offset.test.ts`, `tests/zoom-ink-compositing.test.ts`, `tests/runtime-viewer-session.test.ts` | geometry/event fallback, no plugin-owned remount, generation-safe reattachment |
| Unsafe geometry/identity | `tests/annotation-safety.test.ts` | pointer and persistence gates reject the affected page |
| Full synthetic interaction matrix | `tests/fixtures/pdfInteractionScenarios.ts`, `tests/pdf-interaction-fixtures.test.ts` | versioned direct/embedded scenarios cover sidecar, export/reopen, generation, zoom, sidebar, and cleanup assertions |
| Explicit page-end creation | `tests/add-page-control.test.ts`, `tests/pdf-page-actions.test.ts` | accessible control follows the highest page, debounces activation, and reuses guarded page mutation |

## Manual qualification rows

`not-run` is the current honest state: this checkout has no approved current Obsidian runtime evidence. Do not convert a row to `known-good` from jsdom or fixture output. Capture the exact Obsidian build, plugin version, platform, device, DPR, refresh rate, adapter kind, and profile schema for every run.

| Target/build | Status | Runtime combination | Profile/traces to capture | Expected strategy and safety result |
| --- | --- | --- | --- | --- |
| Current Obsidian desktop | `not-run` | Windows + mouse/trackpad; DPR 1/2; 60/120 Hz where available | direct profile; attach, input, zoom, replacement, reload | native/EventBus strategy when present; DOM/geometry fallback otherwise; unsafe duplicate blocks ink |
| Current Obsidian desktop | `not-run` | Windows + pen/stylus; DPR 1/2; 60/120 Hz where available | direct profile; pen draw, pan, page boundary, replacement, reload | validated pen contacts annotate; native navigation remains available outside annotation policy |
| Current Obsidian desktop | `not-run` | macOS + mouse/trackpad; representative DPR/refresh rate | direct profile; input, zoom, split/duplicate leaf, reload | adapters and page generations remain independent; optional failures degrade without unsafe ink |
| Current Obsidian iPadOS | `not-run` | iPad + Apple Pencil; 60/120 Hz; device DPR | direct and embedded profiles; Pencil, touch/pinch, UI transition, replacement, background/resume | mobile working set remains bounded; Pencil/touch policies stay distinct; validated pages recover after resume |
| Current Obsidian iOS | `not-run` | iPhone touch-only; device DPR and refresh rate | embedded/direct profile when available; scroll, pinch, page boundary, background/resume | touch remains native; no annotation is accepted without validated page evidence |
| Current Obsidian Android | `not-run` | tablet + stylus and touch; device DPR/refresh rate | embedded/direct profile; stylus, pinch, replacement, reload, background/resume | same safe fallback contract; missing optional capabilities do not disable validated pages |
| Cross-platform display variants | `not-run` | DPR 1/2 and 60/120 Hz combinations represented above | profile plus zoom/render timing summary for each distinct combination | scale change and geometry settle remain distinct; no threshold is promoted without a named run |
| Desktop split panes/duplicate leaves | `not-run` | two simultaneous PDF leaves on a supported desktop build | one profile and lifecycle trace per leaf; switch/close/reopen | viewer and page mount generations stay isolated; stale callbacks are ignored |

## Release smoke checklist

Run the applicable rows above on the named build. Keep each result `not-run`, `blocked`, or `failed` until its evidence is captured.

1. Fresh install and plugin enable: open one direct PDF and one embedded PDF; capture the first bounded profile for each viewer instance.
2. Input policy: exercise mouse/trackpad, pen/Apple Pencil/stylus, and touch according to the target row; verify native navigation remains available where policy says it should.
3. Page boundaries: draw at the top, center, and bottom of a page; scroll across a page boundary; verify page-local coordinates and no cross-page ink.
4. Zoom and replacement: use wheel/trackpad/pinch; resize; force a PDF.js page/canvas replacement; verify no plugin-owned remount during the burst and one generation-safe settle/rebind afterward.
5. Structure actions: exercise Add page, Delete page, Import page, and Scan document where supported; verify sidecar/recovery remapping and cancellation/error safety.
6. Export and reopen: export an annotated copy, confirm the source PDF is unchanged, close/reopen the source, and verify sidecar-backed ink survives.
7. Lifecycle: switch split panes/leaves, close/reopen the PDF, background/resume the app, and disable/re-enable the plugin; verify cleanup and recovery.
8. Degraded/unsafe paths: repeat with optional viewer, sidebar, find, or boosted-zoom capabilities absent; exercise duplicate/invalid page evidence and verify `annotation-safety-blocked`, no new stroke, and no unsafe sidecar write.

## Capture checklist

For each live row, record only bounded diagnostics: target/build identifier, adapter kind, profile schema/status, selected viewer/page/scroll/scale/zoom/sidebar strategies, capability booleans, viewer generation, page mount generations, fallback counters, warnings, and unsafe-gating reason when exercised. Keep screenshots, raw DOM, private objects, document contents, and account data out of the issue record.

1. Attach direct and embedded views; capture the first profile for each viewer instance.
2. Open/close the native sidebar and toolbar, then resize the pane; verify geometry fallback and cleanup.
3. Zoom with wheel/trackpad/pinch; verify no page remount during the burst and one generation-safe settle/rebind.
4. Force a PDF.js page/canvas replacement, reload the view, switch split panes/leaves, and background/resume the app; verify stale callbacks are ignored.
5. Exercise an indistinguishable duplicate shell and invalid geometry; verify `annotation-safety-blocked`, no new stroke, and no unsafe sidecar write.
6. Repeat after optional find/sidebar/boosted-zoom capabilities are absent; validated pages remain annotatable.

## Known-good promotion

A row is `known-good` only after all applicable smoke steps pass on the named build and its first profile plus lifecycle summary are preserved separately from fixture assumptions. Until then, the row remains `not-run` and parent issue #131 remains dependent on runtime qualification.
