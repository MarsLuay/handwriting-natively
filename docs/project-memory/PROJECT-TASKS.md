# Project Tasks

Project: `native-pdf-handwriting` — Handwriting Natively

## runtime-compatibility — pending

Validate the plugin-owned PDF viewer and shared movable toolbar against current Obsidian desktop, Android, and iPad builds.

Paths: `src/integration/`, `docs/current-limitations.md`

Checks: `npm test`; `npm run lint`; `npm run build`; verify direct PDF startup without a native `PDFToolbar` dependency; confirm Markdown `![[PDF#page=27]]` embeds render with Obsidian's core PDF mapping; manual PDF checks on current desktop, Android, and iPad builds.

Progress: Obsidian desktop 1.14.4 verified after rebuild: direct PDF pages and a 36-page Markdown embed rendered, and the selected toolbar tool survived reload. Android and iPad checks remain pending.

## source-pdf-write-contract — complete

Resolve the source-PDF write contract for explicit page actions.

Paths: `src/main.ts`, `docs/architecture.md`, `AGENTS.md`

Check: decide whether page insertion/deletion may mutate the source PDF, then align code and documentation.

## large-document-profiling — pending

Profile dense-page erasing and lasso resize/clipboard behavior on large documents.

Paths: `docs/current-limitations.md`, `src/ink/`, `src/tools/`

Checks: profile dense pages; profile lasso resize and clipboard behavior.

## unified-gesture-navigation — pending

Physically qualify opt-in mouse/touch annotation, confirmed-stylus ownership, stylus hand-pan, and capability-gated iOS/iPadOS/Android PDF pan/pinch.

Paths: `src/input/GestureNavigationController.ts`, `src/input/PointerRouter.ts`, `src/integration/PlatformCapabilities.ts`, `src/integration/MobileCustomPdfZoom.ts`, `src/integration/HandwritingViewport.ts`, `src/integration/ImageViewAdapter.ts`, `src/integration/PdfJsViewAdapter.ts`, `src/runtime/ViewerInkSession.ts`, `styles.css`, `tests/`, `docs/input-gesture-architecture.md`, `docs/mobile-pdf-zoom-contract.md`

Checks: run the physical iOS, iPadOS, and Android input matrix for stylus, companion touch, opt-in mouse/touch annotation, native fallback, qualified PDF pan/pinch/wheel zoom, and image zoom; confirm stylus hand-pan and first post-zoom contacts; keep status pending until named-device traces are captured. `npm test`; `npm run lint`; `npm run build`.

## unified-developer-logs — done

Route plugin diagnostic events through Obsidian's developer console and the same vault log used by Copy logs.

Paths: `src/logging/SessionLogger.ts`, `src/logging/VaultDebugLog.ts`, `src/logging/VaultLogSink.ts`, `src/settings.ts`, `src/runtime/ViewerInkSession.ts`

Checks: focused logger tests; `npm test`.

## markdown-surface-preference — done

Expose and persist the Markdown enabled-surface preference used by runtime attachment.

Paths: `src/settings.ts`, `tests/settings.test.ts`

Checks: `tests/settings.test.ts`; `npm run lint`.

## markdown-reading-annotations — complete

Extend shared Markdown annotation from Reading view to Source and Live Preview editing.

Paths: `src/main.ts`, `src/integration/MarkdownViewAdapter.ts`, `src/runtime/AnnotationSurface.ts`, `src/runtime/ViewerInkSession.ts`, `src/input/PointerRouter.ts`, `src/pdf/PageCoordinateLayout.ts`, `src/settings.ts`, `tests/`, `README.md`, `docs/architecture.md`, `docs/current-limitations.md`

Checks: focused Markdown mode/adapter/session/pointer-routing/geometry tests; `npm test` (132 files, 1,148 tests); `npx tsc --noEmit`; `npm run lint` reported one pre-existing sentence-case warning at `src/settings.ts:582`.
