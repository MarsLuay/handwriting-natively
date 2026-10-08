# iPad Pointer/Touch trace harness

This is an iPad-only, debug-gated observation harness for the real Obsidian
PDF viewer. `IpadPointerTouchTrace` listens passively at document capture and
keeps the last 256 ordered events plus a bounded summary in Copy Logs. It does
not call `preventDefault()`, stop propagation, set or release pointer capture,
change `touch-action`, route gestures, store coordinates, or store annotation
content. Multiple HN viewer sessions share one document observer.

The trace is enabled only when the host reports an iPadOS Obsidian runtime and
vault debug logging is enabled. Ordered pointer boundary events are retained
alongside contact events. Each retained event includes the browser's
`eventTimeStamp` and the observer's `at` time, plus pointer/touch IDs, capture
observations, target class, `touch-action`, event phase, cancellation state,
pressure, contact width/height, tilt, and twist. Passive Pencil hover moves
stay out of the event buffer; the first and last bounded hover samples retain
their timestamp and sensor metadata so hover-to-contact transitions can be
checked without logging every move. `beforeinput` and composition data are
recorded as event type, `inputType`, and composing state only; text is never
persisted. The extended trace uses `schemaVersion: 5`; a missing numeric
sensor value is `null`, while an observed zero remains `0`.

## Physical run

Use a current Obsidian iPadOS build with an Apple Pencil and the Handwriting
Natively plugin enabled. Turn on vault debug logging, open a direct PDF and an
embedded PDF, then use Copy Logs after each run. Save the copied JSONL/log
profile with the exact Obsidian version, plugin version, iPadOS version,
device model, Pencil generation, display scale, orientation, and refresh-rate
setting. Keep the report attached to the issue or release record before
removing or weakening any compatibility fallback.

For the repeatable pinch/zoom workload, page-count matrix, 60 Hz/ProMotion
comparison, and visual-alignment checks, use
[`ipad-zoom-benchmark.md`](ipad-zoom-benchmark.md). This harness supplies the
passive input evidence required by that protocol; it does not replace the
zoom profile or visual checklist.

For the full physical input release gate, use
[`ipad-input-release-matrix.md`](ipad-input-release-matrix.md). The rows in
that matrix combine this observer with routing, cleanup, UI, generation, and
visual outcomes; a copied event trace alone is not a release pass.

Run each row from a clean PDF session. Do not use the harness to draw, pan,
zoom, or cancel a gesture; it is an observer only.

| Row | Gesture | Required observations |
| --- | --- | --- |
| P1 | Normal Pencil stroke | `pointerover/enter/down`, moves, `pointerup`; pointer ID/type, target class, capture, pressure/tilt availability, and no unexpected touch ownership |
| P2 | Rapid Pencil re-contact | Distinct down/up sequences and IDs; no stale active pointer or touch ID |
| P3 | Pencil hover then contact | Hover/move ordering, pressure transition, and whether capture starts only on contact |
| P4 | Pencil leaves page bounds | `pointerleave` and capture/lost-capture ordering; terminal cleanup and page-boundary target classes |
| T1 | One-finger native drag | Touch identifiers, pointer/touch ordering, `touch-action`, native pass-through, and no duplicate ink/pan action |
| T2 | Two-finger pinch | Both touch IDs, pointer pairing/order, gesture/scale events if present, and terminal cleanup for both contacts |
| T3 | Pencil plus finger | Pen and companion touch relationship, capture, `touch-action`, and no touch transfer of pen ownership |
| T4 | Palm before and during Pencil | Pointer/touch ordering and cancellation/cleanup without a stale pen or touch ID |
| U1 | Toolbar/sidebar/page-boundary contact | Target classes and page/UI classification for native UI, thumbnail/sidebar, page, and empty viewer space |
| U2 | Scribble/text-field interaction | `beforeinput`/composition event order, `inputType`, composing state, target class, and no text content in the trace |
| L1 | Cancellation/backgrounding | `pointercancel`, `touchcancel`, `visibilitychange`, `pagehide/pageshow`, capture loss, and cleanup order |
| L2 | Rotation and reload | Orientation/resize, viewer/page replacement, router generation changes, and fresh IDs after reload |

## Evidence decision

Record `pass`, `fail`, or `not-run` for every row. A synthetic DOM test,
Safari run, desktop Obsidian run, or standalone capability-pad run cannot
promote an iPad row. A failed row must include the copied bounded trace and
the exact build/device metadata. Compatibility fallbacks remain in place until
the relevant physical rows are attached and reviewed.
