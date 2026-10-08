# Project Tasks

Project: `native-pdf-handwriting` — Handwriting Natively

## runtime-compatibility — pending

Validate the plugin-owned PDF viewer and shared movable toolbar against current Obsidian desktop, Android, and iPad builds.

Paths: `src/integration/`, `docs/current-limitations.md`

Checks: `npm test`; `npm run lint`; `npm run build`; verify direct PDF startup without a native `PDFToolbar` dependency; manual PDF checks on current desktop, Android, and iPad builds.

## source-pdf-write-contract — complete

Resolve the source-PDF write contract for explicit page actions.

Paths: `src/main.ts`, `docs/architecture.md`, `AGENTS.md`

Check: decide whether page insertion/deletion may mutate the source PDF, then align code and documentation.

## large-document-profiling — pending

Profile dense-page erasing and lasso resize/clipboard behavior on large documents.

Paths: `docs/current-limitations.md`, `src/ink/`, `src/tools/`

Checks: profile dense pages; profile lasso resize and clipboard behavior.

## unified-gesture-navigation — pending

Centralize touch, pinch, hand-tool, and modifier-wheel navigation and validate the canonical floating toolbar.

Paths: `src/input/GestureNavigationController.ts`, `src/input/PointerRouter.ts`, `src/runtime/ViewerInkSession.ts`, `docs/input-gesture-architecture.md`

Checks: focused gesture and orientation tests, including persisted toolbar rotation; `npm test`; `npm run lint`; `npm run build` when the shared generated `main.js` is no longer being edited.

## unified-developer-logs — done

Route plugin diagnostic events through Obsidian's developer console and the same vault log used by Copy logs.

Paths: `src/logging/SessionLogger.ts`, `src/logging/VaultDebugLog.ts`, `src/logging/VaultLogSink.ts`, `src/settings.ts`, `src/runtime/ViewerInkSession.ts`

Checks: focused logger tests; `npm test`.

## markdown-surface-preference — done

Expose and persist the Markdown enabled-surface preference while Markdown view attachment remains scaffold-only.

Paths: `src/settings.ts`, `tests/settings.test.ts`

Checks: `tests/settings.test.ts`; `npm run lint`.
