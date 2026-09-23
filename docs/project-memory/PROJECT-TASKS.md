# Project Tasks

Project: `native-pdf-handwriting` — Handwriting Natively

## runtime-compatibility — pending

Validate the PDF adapter against current Obsidian desktop, Android, and iPad builds.

Paths: `src/integration/`, `docs/current-limitations.md`

Checks: `npm test`; `npm run build`; manual PDF checks on current desktop, Android, and iPad builds.

## source-pdf-write-contract — complete

Resolve the source-PDF write contract for explicit page actions.

Paths: `src/main.ts`, `docs/architecture.md`, `AGENTS.md`

Check: decide whether page insertion/deletion may mutate the source PDF, then align code and documentation.

## large-document-profiling — pending

Profile dense-page erasing and lasso resize/clipboard behavior on large documents.

Paths: `docs/current-limitations.md`, `src/ink/`, `src/tools/`

Checks: profile dense pages; profile lasso resize and clipboard behavior.
