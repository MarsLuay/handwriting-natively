# Current limitations

First pass proves architecture and direct-view annotation path. Runtime compatibility still needs testing against current Obsidian desktop, Android, and iPad builds.

- Undocumented PDF viewer selectors may change; adapter fails closed and reports compatibility details.
- Circular erasing preserves untouched stroke segments; very dense pages still need device profiling.
- Export offers both the existing flattened copy and a separate editable PDF annotation copy (`/Ink` and `/FreeText`). Viewer support for editable annotations varies by PDF app; the vault sidecar remains canonical.
- Pencil uses graphite grit with broken ribbon + fine elliptical tooth (Texture slider). Screen-capped stamp size so thick tips stay porous, not mega-blobs. Not a physical deposition sim.
- Highlighter is a wide translucent flat marker (alpha overlay). Not multiply-blend or text-region fill.
- Lasso resize and clipboard behavior are initial implementations and need large-document profiling.
- OCR and handwriting recognition are intentionally absent.
- Shape recognition is on by default in each drawing tool's Advanced settings. Holding a stroke still for 0.5 seconds recognises confident lines, arrows, ellipses, rectangles, triangles, diamonds, stars, and hearts; ambiguous writing remains ink. This is intentionally not claimed as an exact clone of another app's shape set.
- MacBook Force Touch trackpad pressure is not available in Obsidian (Electron); stylus pressure works when the OS exposes it.
- Source PDFs are never modified; annotated copies are export-only.

Next phase: test inside Obsidian, record real private object graph by platform/version, fix compatibility adapter only, profile large PDFs.
