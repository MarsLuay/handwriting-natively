# Current limitations

First pass proves architecture and direct-view annotation path. Runtime compatibility still needs testing against current Obsidian desktop, Android, and iPad builds.

- Undocumented PDF viewer selectors may change; adapter fails closed and reports compatibility details.
- Circular erasing preserves untouched stroke segments; very dense pages still need device profiling.
- `Export PDF (editable annotations)` emits standard `/Ink` annotations with appearance streams. Pressure variation, pencil texture, and highlighter blending are approximated because `/Ink` has one width and opacity per stroke.
- Pencil uses graphite grit with broken ribbon + fine elliptical tooth (Texture slider). Screen-capped stamp size so thick tips stay porous, not mega-blobs. Not a physical deposition sim.
- Highlighter is a wide translucent flat marker (alpha overlay). Not multiply-blend or text-region fill.
- Lasso resize and clipboard behavior are initial implementations and need large-document profiling.
- OCR and handwriting recognition are intentionally absent.
- MacBook Force Touch trackpad pressure is not available in Obsidian (Electron); stylus pressure works when the OS exposes it.
- Source PDFs are never modified; annotated copies are export-only.

Next phase: test inside Obsidian, record real private object graph by platform/version, fix compatibility adapter only, profile large PDFs.
