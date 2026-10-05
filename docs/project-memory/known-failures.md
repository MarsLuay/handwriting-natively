# Known Failures and Uncertainties

- The source-PDF write contract is resolved: ordinary annotation edits and Export PDF remain non-destructive, while explicit Add/Delete/Import/Scan page actions use `app.vault.modifyBinary` through `writePdfAndAnnotationStoresAtomic` and remap sidecar/recovery data. Live Obsidian host compatibility for those private viewer reloads remains unverified.
- Runtime compatibility against current Obsidian desktop, Android, and iPad builds remains unverified. Undocumented viewer selectors/object paths may change; the adapter is intended to fail closed and report compatibility details.
- Circular erasing on very dense pages needs device profiling. Lasso resize and clipboard behavior need large-document profiling.
- Editable PDF annotation support varies by the PDF viewer; the vault sidecar remains the canonical editable data.
- The generated `main.js` bundle is approximately 918 KB (917,762 bytes), just below the configured 921,600-byte budget after moving PDF.js, pdf-lib, thumbnail actions, and post-zoom diagnostics to local packaged assets; the production build now enforces this budget.
