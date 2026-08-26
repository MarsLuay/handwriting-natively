# Quirks

- Laser pointer trails fade and are never saved. Pen, pencil, highlighter, and typed text are sidecar-backed; typed text is searchable through the viewer-only bridge, while freehand ink is not searchable.
- The adapter checks known viewer/page selectors and falls back to DOM page bounds. A missing viewer root or page is a hard compatibility error; a missing native toolbar is a warning because the shared toolbar can mount beside the viewer.
- Pointer samples update in-memory strokes. Completed commands—not every pointer sample—mark the document dirty and schedule persistence. One queue entry serializes writes per document; newer snapshots follow an in-flight write.
- Pointer capture cleanup handles `lostpointercapture` for mouse ink as well as pen ink. The capability probe reports pen remapping after hover, off-host wheel panning, and that real `TouchEvent`s are still required for companion/multi-touch behavior.
- MacBook Force Touch pressure is unavailable through Obsidian/Electron; stylus pressure works only when exposed by the host OS.
- Shape recognition is enabled by default in each drawing tool's Advanced settings and uses a 0.5-second hold for confident supported shapes; ambiguous writing remains ink.
