# Decisions

- Keep undocumented Obsidian PDF integration behind the adapter boundary in `src/integration/`; the annotation engine and tests should not depend on private host objects.
- Treat sidecar JSON as the canonical editable annotation data, with page-space coordinates; use separate recovery data for crash recovery and separate files for exports.
- Pencil-first / device-aware input: stylus (`pointerType === "pen"`) annotates with the active tool immediately; finger touch stays native PDF pan/pinch (never inks); mouse follows explicit `mouseInputMode` (`pan` | `annotate` | `native`) without a Draw checkbox. Do not globally apply `touch-action: none`.
- Default autosave on. Completed annotation commands schedule persistence after the documented 750 ms debounce; closing a PDF flushes, and manual-save mode requires an explicit save/discard/cancel choice when dirty.
- Keep operation local to the vault/device: no telemetry, hosted service, CDN, remote AI, OCR, or handwriting recognition.
- Share one toolbar, tool state, history, storage, autosave, export, and recovery path between direct and embedded PDF views.
- Import page (More menu): copy selected native pages via `PDFDocument.copyPages` into the open PDF after the current page in one source-PDF write, then shift later sidecar page indices by the imported count. Destination and source bytes load independently so self-import cannot corrupt the open document; picker cancel and load failures leave PDF+sidecar unchanged.
