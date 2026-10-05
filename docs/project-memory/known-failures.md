# Known Failures and Uncertainties

- The source-PDF write contract is resolved: ordinary annotation edits and Export PDF remain non-destructive, while explicit Add/Delete/Import/Scan page actions use `app.vault.modifyBinary` through `writePdfAndAnnotationStoresAtomic` and remap sidecar/recovery data. Live Obsidian host compatibility for those private viewer reloads remains unverified.
- Runtime compatibility against current Obsidian desktop, Android, and iPad builds remains unverified. Undocumented viewer selectors/object paths may change; the adapter is intended to fail closed and report compatibility details.
- Circular erasing on very dense pages needs device profiling. Lasso resize and clipboard behavior need large-document profiling.
- Editable PDF annotation support varies by the PDF viewer; the vault sidecar remains the canonical editable data.
- The generated `main.js` bundle is approximately 1.39 MB (1,393,297 bytes), exceeding the configured 921,600-byte bundle budget and the stated 1 MB error budget; the local PDF.js runtime remains external to this bundle.
