# Decisions

- Keep undocumented Obsidian PDF integration behind the adapter boundary in `src/integration/`; the annotation engine and tests should not depend on private host objects.
- Treat sidecar JSON as the canonical editable annotation data, with page-space coordinates; use separate recovery data for crash recovery and separate files for exports.
- Keep Draw mode opt-in. Mouse, touch, trackpad, links, search, and selection retain ordinary PDF behavior until annotation mode is enabled.
- Default autosave on. Completed annotation commands schedule persistence after the documented 750 ms debounce; closing a PDF flushes, and manual-save mode requires an explicit save/discard/cancel choice when dirty.
- Keep operation local to the vault/device: no telemetry, hosted service, CDN, remote AI, OCR, or handwriting recognition.
- Share one toolbar, tool state, history, storage, autosave, export, and recovery path between direct and embedded PDF views.
