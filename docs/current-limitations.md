# Current limitations

Automated compatibility evidence covers the adapter boundary and explicit host-shape fixtures. It does not validate a live Obsidian build. Runtime compatibility still needs testing against current Obsidian desktop, Android, and iPad builds.

- Undocumented PDF viewer selectors may change; adapter fails closed and reports compatibility details.
- Platform/version reports accept explicit host signals and Obsidian API versions. Unknown or malformed values remain unknown; jsdom and user-agent strings are not treated as desktop, Android, or iPad evidence.
- The automated fixtures cover supported DOM shapes, missing viewer/page fail-closed errors, viewer reload notification, idempotent teardown, and zoom/page alignment. They do not prove private object paths on a released Obsidian build.
- Circular erasing preserves untouched stroke segments; very dense pages still need device profiling.
- Export offers both the existing flattened copy and a separate editable PDF annotation copy (`/Ink` and `/FreeText`). Viewer support for editable annotations varies by PDF app; the vault sidecar remains canonical.
- Pencil uses graphite grit with broken ribbon + fine elliptical tooth (Texture slider). Screen-capped stamp size so thick tips stay porous, not mega-blobs. Not a physical deposition sim.
- Highlighter is a wide translucent flat marker (alpha overlay). Not multiply-blend or text-region fill.
- Lasso resize and clipboard behavior are initial implementations and need large-document profiling.
- OCR and handwriting recognition are intentionally absent.
- Typed text annotations are searchable in Obsidian’s native PDF find bar (Cmd/Ctrl+F) via a viewer-only bridge; freehand ink is not searchable.
- Shape recognition is on by default in each drawing tool's Advanced settings. Holding a stroke still for 0.5 seconds recognises confident lines, arrows, ellipses, rectangles, triangles, diamonds, stars, and hearts; ambiguous writing remains ink. This is intentionally not claimed as an exact clone of another app's shape set.
- MacBook Force Touch trackpad pressure is not available in Obsidian (Electron); stylus pressure works when the OS exposes it.
- Annotation edits do not modify source PDFs. Add/Delete/Import/Scan page actions intentionally rewrite the open PDF and remap sidecar/recovery data; export remains a separate-copy workflow. Reorder/duplicate and persistent page UUIDs are not yet supported.
- Drawing presets are local settings, capped at eight entries, and do not change saved annotation data. Preset selection is one action; device-specific toolbar sizing still needs the release matrix.
- Image annotation is intentionally not shipped yet. A future one-page image adapter must establish EXIF orientation, transparency, large-image memory, and export behavior before changing the PDF-only integration boundary.

Remaining manual compatibility evidence:

- Desktop: record the Obsidian API version and observed `view.viewer` graph; open direct and embedded PDFs; verify draw-off native scrolling/selection, draw-on overlay alignment across zoom/rotation/resize, page redraw/reload, close/reopen cleanup, and no duplicate listeners or overlays.
- Android: record the Obsidian API version and observed viewer graph; repeat the direct/embedded, delayed-page, pinch/zoom alignment, reload, and teardown checks after the mobile PDF has rendered.
- iPad: record the Obsidian API version and observed viewer graph; repeat the direct/embedded, Apple Pencil plus finger-scroll/pinch, zoom alignment, reload, and teardown checks. Confirm companion touch handling does not leave the PDF in an intercepted state.

These manual checks remain unverified until performed on the named builds. Use `docs/issue-resolution-matrix.md` as the evidence ledger, record the bounded copied-log profile for failures, fix only confirmed compatibility regressions, and profile large PDFs before changing mount/cache policy.
