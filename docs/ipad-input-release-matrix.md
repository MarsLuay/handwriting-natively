# iPadOS/WKWebView input release matrix

Protocol: `ipad-input-release-matrix/v1`

This is the physical-device release checklist for issue #363 and the
hardware portion of #130. It complements
[`ipad-pointer-touch-trace-harness.md`](ipad-pointer-touch-trace-harness.md),
which is the passive event observer, and
[`ipad-zoom-benchmark.md`](ipad-zoom-benchmark.md), which owns the detailed
zoom-performance workload.

The current state is `not-run`. Synthetic DOM tests, Safari, desktop Obsidian,
or a capability probe cannot promote an iPadOS/WKWebView row. Do not publish a
supported-device claim until the required rows have a named build and bounded
copied evidence.

## Run context

Record this metadata before each clean run and keep it with the result:

| Field | Required value |
| --- | --- |
| Obsidian | exact iPadOS build and Obsidian version/channel |
| Plugin | version and commit under test |
| Hardware | iPad model, Pencil generation, and whether a keyboard/palm rest is present |
| Display | orientation, DPR, viewport, and observed refresh rate |
| View | direct PDF or embedded PDF, with the fixture identity |
| Input settings | active tool, stylus policy, touch policy, mouse policy, Scribble state |
| Evidence | bounded Copy Logs, pointer/touch trace, visual/routing result |

Use a fresh PDF session for each row. Open both a direct PDF and an embedded
PDF before release qualification is complete. Capture Copy Logs immediately
after a failure or high-risk row; later Settings navigation must not be the
only way to obtain the evidence.

## Physical matrix

Every row gets `pass`, `fail`, `blocked`, or `not-run`. A pass requires both
the expected Pointer/Touch lifecycle and the user-visible routing/cleanup
result. The required observations are bounded summaries, not raw event dumps.

| ID | Scenario | Required input evidence | Required outcome |
| --- | --- | --- | --- |
| P1 | Normal Pencil stroke | pen over/enter/down, pressure/tilt availability, moves, up, capture, terminal IDs | stroke starts and commits on the page; no unexpected touch owner |
| P2 | Rapid Pencil re-contact | distinct down/up pairs and fresh physical/contact IDs | every contact routes or is explicitly classified; no stale owner |
| P3 | Pencil hover then contact | hover/move ordering and pressure transition | hover does not create ink; contact claims the page only at down |
| P4 | Pencil crosses page boundary | leave/enter, capture/lost-capture, page hit and mount generations | the stroke terminates or transfers safely; no cross-page ink |
| P5 | One-finger native drag | Pointer/Touch pairing, touch-action, scroll delta, no pen evidence | native PDF scroll/pan wins; no annotation stroke |
| P6 | Two-finger native pinch | both identifiers, pairing/order, scale events, terminal cleanup | native pinch completes; all contacts clear; zoom handoff settles |
| P7 | Finger during Pencil | pen and companion touch identity/ownership transitions | Pencil remains the annotation owner; finger remains native |
| P8 | Palm before and during Pencil | cancellation/order, active ID sets, capture and cleanup | palm does not leave a stale pen/touch owner or block the next stroke |
| P9 | Pencil during finger pan | pan/scroll evidence before pen down, route decision, capture | an actual Pencil contact can claim annotation without corrupting native pan |
| U1 | Toolbar and sidebar contact | target classes, UI occlusion classification, lifecycle surface IDs | UI interaction does not create page ink; Pencil resumes after UI closes |
| U2 | Text field and Scribble | beforeinput/composition order, input type, composing state, no text content | native text/Scribble behavior remains intact; editor caret/selection survives |
| L1 | Cancellation and background | pointercancel/touchcancel, blur, visibility/pagehide, capture loss | plugin ownership, pending drafts, and cleanup state clear deterministically |
| L2 | Unload and disable/re-enable | session destroy/recreate, listener/overlay/router counts | no duplicate collector, router, toolbar, overlay, or stale callback |
| L3 | Rotation and resize | orientation/resize, page geometry, viewer generation, page mounts | page-local coordinates and overlay alignment remain correct |
| L4 | Sidebar open/close | sidebar lifecycle, rail offset, layout strategy, zoom state | genuine sidebar changes sync; watcher churn does not steal input |
| L5 | Native generation replacement | canvas/text replacement, mutation/render callbacks, router binding | current page/overlay/router generation is used after replacement |
| L6 | Zoom then first Pencil contacts | zoom burst/settle ID, first three page contacts, router/stroke chain | the first three Pencil attempts work without reload; finger pinch remains native |

Rows P1–P9 are the input-ownership contract. Rows U1–U2 and L1–L6 are the
host lifecycle and WebKit uncertainty boundary. A row that cannot be
performed on the available build is `blocked`, not `pass`.

## Run order

1. Enable vault debug logging and verify the plugin reports one active session
   and one document input collector.
2. Run P1–P5 on a direct PDF, then repeat on an embedded PDF.
3. Run P6–P9 in the same session, including the #243 sequence of Pencil,
   pinch, and the first three post-zoom Pencil attempts. Use the #348 zoom
   protocol for the performance fields.
4. Run U1–U2 with the toolbar, sidebar, native text field, and Scribble
   interactions. Do not treat a synthetic contenteditable as Scribble proof.
5. Run L1–L6 one at a time: cancel, background/resume, unload/re-enable,
   rotate/resize, toggle the sidebar, and force the available PDF.js/native
   generation replacement path.
6. Repeat any failed row once from a fresh session. Attach the bounded trace
   and exact metadata before changing a fallback or assigning a code fix.

The release run is not complete when only the first three post-zoom contacts
pass. Continue normal use long enough to detect a later Pencil-to-touch or
Pencil-to-native-pan regression, and record it under a separate row/result.

## Fallback decisions

These decisions are part of the release record. They describe safe behavior;
they are not permission to infer hardware support.

| Capability or failure | Required fallback | Release implication |
| --- | --- | --- |
| Pointer Events with pen identity | Pen may claim annotation on a validated page; touch stays native | qualify P1–P4 and P7–P9 with a physical Pencil |
| Pointer Events absent or stylus identity unknown | Preserve native touch/navigation; explicit touch drawing fallback remains opt-in | do not claim Pencil support from touch evidence |
| Missing private viewer/EventBus signal | Use the documented DOM/geometry fallback and record `degraded` | optional host capability alone does not fail a safe page |
| Missing page identity or trustworthy geometry | Reject annotation on that page and emit the bounded unsafe reason | fail the affected row; never write unsafe coordinates |
| Pointer/touch cancellation, blur, pagehide, or unload | Clear plugin captures, routes, IDs, and pending drafts before native behavior resumes | L1/L2 must pass with no stale owner |
| Native text/Scribble target | Do not route annotation shortcuts or replace the editor while focused | U2 must pass independently of Pencil rows |
| Long-task/event-timing observer unsupported | Keep the limitation in the bounded profile; do not invent a cause | timing evidence may be incomplete, never silently promoted |
| Generation replacement during input | Reconcile to the connected page and preserve the active owner only when binding is current | fail L5/L6 if a contact falls into an unowned gap |

Do not apply a global `touch-action: none`, force every post-zoom contact into
drawing, or treat a generic touch contact as Pencil. Any such change requires a
new measured device failure and a narrowly scoped review.

## Release gate

Before marking iPadOS/WKWebView support `known-good`, confirm all of the
following for the named build/device combination:

- [ ] P1–P9 are `pass`, including native one-/two-finger navigation.
- [ ] U1–U2 are `pass`, including toolbar/sidebar and Scribble/text behavior.
- [ ] L1–L6 are `pass`, including cancellation, unload, rotation, sidebar, and
      generation replacement.
- [ ] Direct and embedded PDF rows have bounded evidence.
- [ ] No row relies on a desktop, synthetic, Safari, or capability-probe run.
- [ ] No stale pointer/touch ID, duplicate collector/router, detached overlay,
      or unsafe page-identity result remains unexplained.
- [ ] Any #243 input failure and #262 visibility failure are recorded as
      separate outcomes rather than merged into a generic `zoom failed` row.
- [ ] Supported iPadOS/Obsidian versions and the selected fallback decisions
      are written into the release record.

If any checkbox is incomplete, leave the target `not-run`, `blocked`, or
`failed` and keep the existing safe fallback. A failing row is evidence for a
new narrowly scoped issue; it is not a reason to weaken routing globally.

## Bounded result record

```yaml
matrix: ipad-input-release-matrix/v1
status: pass | fail | blocked | not-run
capturedAt: <UTC>
context:
  ipadModel: <model>
  pencil: <generation>
  ipados: <version>
  obsidian: <version-and-channel>
  plugin: <version-or-commit>
  refreshRateHz: <observed-number>
  dpr: <observed-number>
  orientation: portrait | landscape
  view: direct | embedded
rows:
  P1: pass | fail | blocked | not-run
  P2: pass | fail | blocked | not-run
  P3: pass | fail | blocked | not-run
  P4: pass | fail | blocked | not-run
  P5: pass | fail | blocked | not-run
  P6: pass | fail | blocked | not-run
  P7: pass | fail | blocked | not-run
  P8: pass | fail | blocked | not-run
  P9: pass | fail | blocked | not-run
  U1: pass | fail | blocked | not-run
  U2: pass | fail | blocked | not-run
  L1: pass | fail | blocked | not-run
  L2: pass | fail | blocked | not-run
  L3: pass | fail | blocked | not-run
  L4: pass | fail | blocked | not-run
  L5: pass | fail | blocked | not-run
  L6: pass | fail | blocked | not-run
copyLogs: <sanitized-issue-attachment>
fallbackDecision: <selected-safe-fallback>
notes: <short-bounded-observation>
```

The result record must exclude annotation contents, raw DOM/private viewer
objects, account data, full hashes, and unbounded event streams.
