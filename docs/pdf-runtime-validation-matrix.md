# PDF runtime validation matrix

This matrix is the manual-runtime companion to the deterministic compatibility fixtures. Unit tests are not substituted for a current Obsidian qualification run. A row may be promoted to `known-good` only when the captured per-instance profile and lifecycle trace are attached to the row.

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

`not-run` is the current honest state: this checkout has no approved current Obsidian desktop/iPadOS/Android runtime evidence. Do not convert a row to `known-good` from jsdom or fixture output.

| Target/build | Status | Profile/traces to capture | Expected strategy and safety result |
| --- | --- | --- | --- |
| Desktop, current supported Obsidian | `not-run` | one direct profile; attach → zoom → replacement → reload trace | viewer generation increments on replacement; native/EventBus strategy when present, DOM/geometry fallback otherwise; unsafe duplicate blocks ink |
| Desktop, split panes and duplicate leaves | `not-run` | one profile per leaf plus lifecycle generations | adapters and page mount generations stay independent; inner-layer churn does not remount pages |
| iPadOS, current supported Obsidian | `not-run` | embedded/direct profile, mobile scroll/zoom trace, background/resume trace | mobile bounded page set; zoom/sidebar follow suppresses nonessential work; validated pages recover after resume |
| Android, current supported Obsidian | `not-run` | embedded/direct profile, pinch/scroll and replacement trace | same safe fallback contract; missing optional capabilities degrade without disabling validated pages |

## Capture checklist

For each live row, record only bounded diagnostics: target/build identifier, adapter kind, profile schema/status, selected viewer/page/scroll/scale/zoom/sidebar strategies, capability booleans, viewer generation, page mount generations, fallback counters, warnings, and unsafe-gating reason when exercised. Keep screenshots, raw DOM, private objects, document contents, and account data out of the issue record.

1. Attach direct and embedded views; capture the first profile for each viewer instance.
2. Open/close the native sidebar and toolbar, then resize the pane; verify geometry fallback and cleanup.
3. Zoom with wheel/trackpad/pinch; verify no page remount during the burst and one generation-safe settle/rebind.
4. Force a PDF.js page/canvas replacement, reload the view, switch split panes/leaves, and background/resume the app; verify stale callbacks are ignored.
5. Exercise an indistinguishable duplicate shell and invalid geometry; verify `annotation-safety-blocked`, no new stroke, and no unsafe sidecar write.
6. Repeat after optional find/sidebar/boosted-zoom capabilities are absent; validated pages remain annotatable.

## Known-good promotion

A row is `known-good` only after all checklist steps pass on the named build and its first profile plus lifecycle summary are preserved separately from fixture assumptions. Until then, the row remains `not-run` and parent issue #131 remains dependent on runtime qualification.
