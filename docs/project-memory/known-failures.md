# Known Failures and Uncertainties

- Contract conflict: `README.md` and `docs/architecture.md` state that original/source PDFs remain unchanged and exports are separate, while `src/main.ts` page insertion/deletion paths call `app.vault.modifyBinary`. `AGENTS.md` also requires no in-place PDF writes. This must be resolved before the no-in-place-write statement is treated as verified behavior.
- Runtime compatibility against current Obsidian desktop, Android, and iPad builds remains unverified. Undocumented viewer selectors/object paths may change; the adapter is intended to fail closed and report compatibility details.
- Circular erasing on very dense pages needs device profiling. Lasso resize and clipboard behavior need large-document profiling.
- Editable PDF annotation support varies by the PDF viewer; the vault sidecar remains the canonical editable data.
- The generated `main.js` bundle is above the 750 KB monitoring threshold described by the project rules, although it remains within the stated 1 MB error budget and 5 MB sync limit.
