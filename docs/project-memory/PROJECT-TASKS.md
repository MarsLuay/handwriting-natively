# Project Tasks

Project: `native-pdf-handwriting` — Handwriting Natively

## runtime-compatibility — pending

Validate the plugin-owned PDF viewer and native toolbar bridge against current Obsidian desktop, Android, and iPad builds.

Paths: `src/integration/`, `docs/current-limitations.md`

Checks: `npm test`; `npm run build`; the Obsidian 1.14.4 child-before-toolbar regression test; manual PDF checks on current desktop, Android, and iPad builds.

## source-pdf-write-contract — complete

Resolve the source-PDF write contract for explicit page actions.

Paths: `src/main.ts`, `docs/architecture.md`, `AGENTS.md`

Check: decide whether page insertion/deletion may mutate the source PDF, then align code and documentation.

## large-document-profiling — pending

Profile dense-page erasing and lasso resize/clipboard behavior on large documents.

Paths: `docs/current-limitations.md`, `src/ink/`, `src/tools/`

Checks: profile dense pages; profile lasso resize and clipboard behavior.

## unified-gesture-navigation — pending

Centralize touch, pinch, hand-tool, and modifier-wheel navigation and provide a movable toolbar fallback when a sidebar rail is unavailable.

Paths: `src/input/GestureNavigationController.ts`, `src/input/PointerRouter.ts`, `src/runtime/ViewerInkSession.ts`, `docs/input-gesture-architecture.md`

Checks: focused gesture, sidebar, settings, and toolbar fallback tests; `npm test`; `npm run lint`; `npm run build` when the shared generated `main.js` is no longer being edited.
