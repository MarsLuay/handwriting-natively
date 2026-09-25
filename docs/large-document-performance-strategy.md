# Large-document performance strategy

**Status:** architecture baseline; physical-device qualification remains `not-run` until a named Obsidian build/device produces bounded traces.

## Evidence boundary

`PerformanceMetrics` and the existing large-document fixtures provide bounded summaries and deterministic spatial-index workloads. They do not measure PDF.js compositing, WebView memory, refresh cadence, or mobile suspension. No desktop or mobile runtime target is promoted from fixture output. Live qualification uses the manual rows in [`pdf-runtime-validation-matrix.md`](./pdf-runtime-validation-matrix.md), and every result records the exact build, device, DPR, refresh rate, adapter profile, and trace summary.

## Workload matrix

A benchmark run varies one dimension at a time, then repeats the combined workload. The canonical deterministic plan and bounded trace serializer live in `tests/fixtures/largeDocumentWorkloads.ts`; the workload id and schema version must be copied into any browser-emulator or physical-device capture:

- 10, 100, 500, and 1,000 pages;
- sparse and dense ink, including tens of thousands of strokes;
- text-only, ink-only, and mixed text/ink/shape pages;
- rapid scroll, repeated zoom, page insertion/deletion, and close/reopen;
- direct and embedded PDFs, split panes, and duplicate leaves.

Each run emits one bounded record per page-remount burst, zoom burst, render burst, persistence operation, and cache eviction. Records contain counts, duration summaries, p50/p95/max timings, working-set pages, raster pixels/bytes, vector-stroke counts, and bounded eviction/rejection reasons. They never contain PDF contents, raw DOM, pointer streams, or per-frame log lines.

## Working-set and virtualization policy

1. Keep the visible page set mounted. Add a small, configurable preload radius only when traces show that remount latency causes visible pop-in; the radius is a measured policy input, not a hard-coded claim about all devices.
2. Mount overlays only for validated live page shells. Offscreen logical ink remains in the sidecar/model and is remounted from page-space data; detached DOM and canvas references are never retained as identity.
3. A page replacement invalidates its mount generation, discards geometry derived from the old shell, and redraws from logical state after validation. It must not migrate mutable pixels or DOM state from the old shell.
4. Scroll work is visibility/position work. It must not rediscover the adapter or rebuild every overlay on each event.
5. Prefetch neighboring pages only when the bounded trace shows a benefit greater than its raster and mount cost. Eviction is deterministic and observable.

## Rendering stages

- **Synchronous:** accept the input sample, update the bounded wet-ink path, and preserve page-local logical state.
- **Coalesced:** commit finalized vector data, update the affected overlay geometry, and repaint only the dirty page/region.
- **Deferred:** HQ/vector upgrades, neighboring-page prefetch, cache warming, and nonessential sidebar/layout follow-up.
- **Cancelled:** obsolete work from a replaced page/viewer generation, detached surface, or superseded zoom burst.

A scale change is not treated as settled geometry. HQ work is scheduled after the validated settle signal and is never allowed to block the next input sample. Full-page repaint is a fallback when dirty-region evidence is unavailable, not the default for a local stroke.

## Cache and memory policy

Cache keys include document identity, logical page, viewport scale/rotation, content revision, and renderer generation. A source-PDF mutation or annotation revision invalidates affected keys; a viewer-generation replacement invalidates DOM-bound entries without changing sidecar data. Raster entries are charged by actual pixel bytes (including backing-store scale), vector entries by bounded serialized/object estimate, and page/overlay mounts by their measured working-set cost.

The plugin owns a bounded cache budget with separate counters for mounted pages, raster pixels/bytes, vector objects, and indexes. Evict least-recently-used raster/preload entries first, then unmount non-visible pages; never evict the visible validated page or the canonical sidecar/model. A memory-pressure or allocation failure event triggers the same bounded eviction path. System-wide RAM APIs are not required, and no target byte budget is promoted until a constrained-device trace establishes it.

## Spatial indexing

Keep the page-local spatial index for erasing, selection, redraw, and hit testing. Benchmark candidate count and query duration against stroke count and dirty-region size. A future threshold may change index granularity or page partitioning only when traces show a regression; correctness never falls back to scanning an unsafe or detached page.

## Measurement gates and target promotion

Targets are promoted only from named traces:

| Metric | Trace fields | Promotion rule |
| --- | --- | --- |
| pointer-to-render | p50/p95/max, late frames, dropped estimate | compare wet-ink path on each qualified device |
| scroll/zoom work | burst duration, remounts, stale callbacks, raster bytes | compare visible-set policy and cancellation |
| page remount | first-valid geometry, overlay-ready duration, pop-in count | choose preload radius per device class |
| persistence | snapshot/atomic-write duration and size | keep writes off the input-critical path |
| plugin-owned memory | mounted pages, raster/vector/index bytes, evictions | set a bounded cap below observed pressure/failure |

Until each metric has representative desktop and constrained-device traces, the target is explicitly `unqualified`; fixture timings are regression signals, not release budgets. This prevents synthetic tests from being presented as mobile support evidence.

## Implementation order

1. Capture the workload records through the existing bounded diagnostics.
2. Add working-set accounting and deterministic eviction without changing page identity or sidecar data.
3. Schedule wet/finalized/HQ stages and cancellation around viewer/page generations.
4. Add dirty-region and cache-key instrumentation, then compare traces.
5. Promote per-device budgets and preload radius only after manual qualification; split follow-up implementation issues from the measured bottleneck rather than assumptions.
