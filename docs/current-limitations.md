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
- Typed text annotations are searchable in the plugin-owned PDF find bar (Cmd/Ctrl+F); freehand ink is not searchable. Obsidian's native toolbar search command is bridged to this same adapter.
- Obsidian's native display menu exposes odd/even two-page spread modes. The plugin-owned renderer currently uses continuous vertical pages, so the toolbar bridge reports spread-mode commands as unsupported and keeps the renderer in its current layout.
- Shape recognition is on by default in each drawing tool's Advanced settings. Holding a stroke still for 0.5 seconds recognises confident lines, arrows, ellipses, rectangles, triangles, diamonds, stars, and hearts; ambiguous writing remains ink. This is intentionally not claimed as an exact clone of another app's shape set.
- MacBook Force Touch trackpad pressure is not available in Obsidian (Electron); stylus pressure works when the OS exposes it.
- Annotation edits do not modify source PDFs. Add/Delete/Import/Scan page actions intentionally rewrite the open PDF and remap sidecar/recovery data; export remains a separate-copy workflow. Reorder/duplicate and persistent page UUIDs are not yet supported.
- Pen, Pencil, and Highlighter settings are independent local preferences and do not change saved annotation data; device-specific toolbar sizing still needs the release matrix.
- Static PNG and JPEG/JPG image annotation uses the shared one-page surface and sidecar; source images remain read-only, browser-native EXIF orientation is not applied a second time, and the More menu exports a bounded flattened copy in the source PNG/JPEG format. PNG alpha is preserved; JPEG uses an opaque background. WebP, HEIC/HEIF, GIF, SVG, embedded images, and live Obsidian image-view/device coverage remain unsupported manual evidence.
- Markdown Reading, Source, and Live Preview views use the shared annotation session and toolbar. Editing overlays mount beside CodeMirror's contenteditable subtree and follow the full scrollable note. Native typing, selection, keyboard input, and scrolling remain native unless the existing pointer policy claims an annotation gesture. Live Obsidian desktop/mobile editor behavior still needs manual compatibility checks.

Remaining manual compatibility evidence:

- Use [`ipad-pointer-touch-trace-harness.md`](ipad-pointer-touch-trace-harness.md)
  for the physical Pointer/Touch/Scribble ordering rows. These rows remain
  `not-run` until captured on a current Obsidian iPadOS build.
- Use [`ipad-input-release-matrix.md`](ipad-input-release-matrix.md) for the
  complete physical input release gate, including cancellation, background,
  unload, rotation, sidebar, and generation replacement. These rows remain
  `not-run` until the named build/device evidence is attached.
- Desktop: record the Obsidian API version and observed `view.viewer` graph; open direct and embedded PDFs; verify draw-off native scrolling/selection, draw-on overlay alignment across zoom/rotation/resize, page redraw/reload, close/reopen cleanup, and no duplicate listeners or overlays.
- Android: record the Obsidian API version and observed viewer graph; repeat the direct/embedded, delayed-page, pinch/zoom alignment, reload, and teardown checks after the mobile PDF has rendered.
- iPad: record the Obsidian API version and observed viewer graph; repeat the direct/embedded, Apple Pencil plus finger-scroll/pinch, zoom alignment, reload, and teardown checks. Confirm companion touch handling does not leave the PDF in an intercepted state.

These manual checks remain unverified until performed on the named builds. Use `docs/issue-resolution-matrix.md` as the evidence ledger, record the bounded copied-log profile for failures, fix only confirmed compatibility regressions, and profile large PDFs before changing mount/cache policy.
