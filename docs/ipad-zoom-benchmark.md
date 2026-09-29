# iPad/WKWebView zoom benchmark

Protocol: `ipad-zoom-benchmark/v1`

This is the repeatable physical-device protocol for issue #348. It defines
the workload, copied-log fields, and visual checks needed to compare a
baseline build with a post-change build. It does not turn desktop or synthetic
results into iPad support evidence.

The current repository state is `not-run`: no device result is claimed by this
document. Keep a row `not-run`, `blocked`, or `failed` until its bounded Copy
Logs evidence is attached to the issue record. For #438, every workload/cell
has one `native` baseline row and one `custom-mobile` candidate row; an
unsupported or unsafe candidate is recorded as `native-fallback`, never as a
custom result.

## Evidence boundary

Run this protocol in a current Obsidian iPadOS/WKWebView build with an Apple
Pencil. The existing `IpadPointerTouchTrace` remains a passive observer; it
must not be changed into a gesture router or a per-event log stream. Keep
annotation contents, raw DOM, coordinates, account data, and unbounded
pointer/per-frame logs out of the result.

Record the exact context before each run:

| Field | Required value |
| --- | --- |
| iPad model and Pencil generation | named hardware, not `iPad`/`Pencil` only |
| iPadOS and Obsidian versions | exact released/build identifiers |
| plugin version/commit | baseline or post-change identifier |
| display mode | fixed 60 Hz, or ProMotion with observed 120 Hz/other rate |
| orientation, DPR, viewport | values reported by the runtime |
| PDF view | direct or embedded |
| benchmark workload | workload ID below |

Do not infer a refresh rate from the device model. Record the observed value
from the run and repeat the matrix after changing the display setting when the
device supports both 60 Hz and ProMotion.

## Benchmark matrix

Use the deterministic workload definitions in
`tests/fixtures/largeDocumentWorkloads.ts`; the IDs below preserve the
existing page-count and stroke-density contract.

| Workload | Pages | Stroke/text density | Purpose |
| --- | ---: | --- | --- |
| `10-sparse` | 10 | 8 strokes/page, mixed text | small-document baseline |
| `100-sparse` | 100 | 8 strokes/page, mixed text | ordinary document |
| `500-dense` | 500 | 80 strokes/page, dense text and mixed shapes | dense-page stress |
| `1000-dense` | 1,000 | 80 strokes/page, dense text and mixed shapes | large-document stress |
| `rapid-scroll-zoom` | 500 | 16 strokes/page, mixed text | rapid native scroll/zoom; requires hardware |
| `mobile-reopen` | 1,000 | 24 strokes/page, dense text and mixed shapes | mobile replacement/reopen; requires hardware |

For every workload, capture these gesture cells at both the baseline and
post-change build:

| Cell | Gesture prompt | Required native behavior |
| --- | --- | --- |
| Z1 | short pinch, about 0.5–1 s, 1x to about 2x | scale-changing events coalesce; ink stays aligned |
| Z2 | medium pinch, about 2 s, 1x to about 4x | active compositing stays smooth; no visible flash |
| Z3 | long pinch, about 5 s, 1x across the available range | no stuck settle or repeated refresh loop |
| Z4 | pinch that causes PDF.js canvas/text replacement, then pause | native replacement is correlated and the release gate waits for canonical ink |
| Z5 | pinch, then three Pencil strokes and a two-finger pinch | Pencil remains routed; finger navigation remains native |
| Z6 | pinch across a page boundary, then return to the original page | page/overlay alignment and router generation remain valid |

Run the same Z1–Z6 prompts in both modes. The custom row must additionally
record gesture begin/promote/cancel/commit, sampled midpoint and scale range,
transform frame timing, native commit wait, release reason, focal-anchor error,
visible page count, and whether PDF.js performed canonical render work. The
native row records the same fields as `null` or `not-applicable`; an unsafe
candidate records only the bounded fallback reason and native ownership.
The durations and scale ranges are prompts for repeatability, not pass/fail
thresholds. Record the observed duration and scale range in the result. Run
each cell three times in a clean session when practical; retain every bounded
profile, including a failed or anomalous run.

## Run procedure

1. Open a fresh direct PDF session and enable vault debug logging. Repeat with
   an embedded PDF after the direct-view matrix is complete.
2. Load the selected workload and let the initial page set settle. Do not
   change the PDF, annotation model, device display setting, or orientation
   between the baseline and post-change runs.
3. Draw the reference strokes before the first pinch. Capture Copy Logs
   immediately after each cell so the zoom diagnosis is not displaced by later
   Settings/UI activity.
4. Repeat the same cells on the post-change build in the same order. Record
   any native canvas/text replacement and the first three post-zoom Pencil
   contacts for Z5.
5. Perform the visual checks below at the minimum, midpoint, and maximum
   observed scale, during native replacement, immediately after release, and
   after returning to 1x.
6. Attach the sanitized result record and bounded Copy Logs to issue #348.
   Reference the #243 input-routing and #262 ink-visibility behavior being
   checked; do not mark either behavior proven from desktop-only output.

## Copy Logs evidence map

The required metrics are spread across the bounded records already emitted
by the plugin. Capture the complete `ink zoom profile` and `ink zoom diagnosis`
records, including the nested `zoomNativeHandoffSummary` (`event:
zoom-native-handoff`), plus the related `ink zoom composite`, `ink-visibility`,
and `ink stroke profile` records for each cell.

| Acceptance evidence | Copy Logs record and fields |
| --- | --- |
| frame p50/p95/max | `ink zoom profile`: `p50FrameDeltaMs`, `p95FrameDeltaMs`, `maxFrameDeltaMs`, `frameCount` |
| long-frame count | `lateFrameCount`, `droppedFrameEstimate`, `longestLongTaskMs`; corroborate `frameAttributionSummary.slowFrameCount` |
| plugin work | `pluginWorkMs`, `longestTaskMs`, `frameAttributionSummary.maxMeasuredPluginWorkMs`, `zoomPipelineSummary.stageTotals` |
| native wait | `zoomNativeHandoffSummary.nativeWaitMs`, `callbackToStableRafMs`, native signal counts, and replacement records |
| canonical paint | `zoomPipelineSummary.stageTotals["canonical-paint"]` plus `ink zoom composite` phase `final-canonical` |
| release gate | `ink zoom composite` phases `release-scheduled` and `release`; `zoomNativeHandoffSummary.stableRafHeldCount`, `stableRafReleasedCount`, and `compositorHeldAtLastStableRaf` |
| input latency | `ink stroke profile`: `p50InputToRenderMs`, `p95InputToRenderMs`, `maxInputToRenderMs`, `paintAcknowledgementMs`, `outcome` |
| Pencil continuity | `lastZoomTrace.firstPostZoomContacts[0..2]`, router/stroke outcomes, and the passive iPad pointer/touch trace |
| visual flash cause | `ink-visibility` checkpoints and any `ink-visibility-flash` record, with the matching zoom burst ID |
| mode and custom lifecycle | `mobilePdfZoom.trace`: `mode`, gesture counts, bounded midpoint/scale range, transform frame count/timing, `releaseReason`, `fallbackReason`, `focalAnchorErrorPx`, `pageCount`, and `pdfJsCanonicalRenderWork` |
| mode attribution | `frameAttributionSummary.mode`/`modes`, `zoomPipelineSummary.mode`, `zoomNativeHandoffSummary.mode`, `lastZoomTrace.mode`, and post-zoom durability `mode`; no custom fields are expected for native-fallback |

`p50FrameDeltaMs` is part of the zoom profile specifically so the physical
benchmark does not have to reconstruct a percentile from raw frame events.
The `ink stroke profile` is required for Z5 because input-to-render latency is
an input trace, not a native-scale interval.

## Visual-alignment checklist

Record `pass`, `fail`, or `blocked` for each check and include the scale,
page, and cell in a failed observation. A pass requires the reference strokes
to remain aligned with the PDF page rather than merely remaining visible.

- [ ] Ink stays aligned at the minimum, midpoint, and maximum scale.
- [ ] Ink remains aligned while PDF.js replaces a page canvas or text layer.
- [ ] No all-ink visibility flash occurs before, during, or after handoff.
- [ ] The final canonical paint is sharp and aligned after the compositor is released.
- [ ] Returning to 1x preserves page-local alignment and stroke geometry.
- [ ] Page-boundary pinch/scroll does not move ink to a neighboring page.
- [ ] The first three Pencil contacts after Z5 route to the current page and
      complete without a reload.
- [ ] Finger one-finger navigation and two-finger pinch remain native and do
      not create annotation strokes.
- [ ] Direct and embedded PDF views produce the same alignment and release
      outcome.

The #243 check is the first-three-contact and native-finger-routing portion.
The #262 check is the visibility, canonical-paint, replacement, and first two
post-release-frame portion. These are separate observations in the result.

## Comparison worksheet

Keep baseline and post-change rows side by side. Do not invent a device budget
from one run; use this worksheet to identify regressions and to decide which
physical result needs follow-up.

| Workload/cell | Mode | Build | Frame p50/p95/max | Long frames | Plugin/native wait | Transform/anchor | Canonical/release | Input latency | Visual result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<id>/<Z#>` | native | baseline | `<...>` | `<...>` | `<...>` | n/a | `<...>` | `<...>` | pass/fail/blocked |
| `<id>/<Z#>` | custom-mobile/native-fallback | post-change | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` | pass/fail/blocked |

## Result record

Use one bounded record per workload/cell. This is a template, not a result:

```yaml
benchmark: ipad-zoom-benchmark/v1
runId: <bounded-id>
status: pass | fail | blocked | not-run
capturedAt: <UTC>
context:
  device: <model>
  pencil: <generation>
  ipados: <version>
  obsidian: <version>
  plugin: <version-or-commit>
  refreshRateHz: <observed-number>
  dpr: <observed-number>
  orientation: portrait | landscape
  view: direct | embedded
workload:
  id: <fixture-id>
  cell: Z1 | Z2 | Z3 | Z4 | Z5 | Z6
  observedDurationMs: <number>
  observedScaleStart: <number>
  observedScaleEnd: <number>
metrics:
  frame: { p50Ms: <number>, p95Ms: <number>, maxMs: <number>, longFrames: <number> }
  plugin: { totalMs: <number>, maxMs: <number> }
  native: { waitMs: <number-or-null>, callbackToStableRafMs: <number-or-null> }
  canonicalPaint: { count: <number>, totalMs: <number>, maxMs: <number> }
  releaseGate: { held: <number>, released: <number>, finalPhase: <string> }
  input: { p50Ms: <number>, p95Ms: <number>, maxMs: <number> }
custom:
  mode: native | custom-mobile | native-fallback
  gesture: { begin: <number>, promote: <number>, cancel: <number>, commit: <number> }
  samples: { count: <number>, firstMidpoint: [<x>, <y>] | null, lastMidpoint: [<x>, <y>] | null, minScale: <number> | null, maxScale: <number> | null }
  transform: { frames: <number>, totalMs: <number>, maxMs: <number> }
  nativeCommitWaitMs: <number> | null
  releaseReason: <string> | null
  fallbackReason: <string> | null
  focalAnchorErrorPx: <number> | null
  pageCount: <number>
  pdfJsCanonicalRenderWork: true | false
visual:
  alignment: pass | fail | blocked
  visibility: pass | fail | blocked
  sharpness: pass | fail | blocked
  inputRouting: pass | fail | blocked
copyLogs: <issue-attachment-or-sanitized-file-reference>
notes: <short bounded observation>
```

If hardware is unavailable, record `not-run` or `blocked` with the reason;
never replace the physical result with a desktop or synthetic result.
