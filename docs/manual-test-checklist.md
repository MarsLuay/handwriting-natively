# Manual test checklist

## Input and viewing

- Desktop mouse: PDF links, text selection, scroll, zoom work until edit tool active.
- Drawing tablet and Apple Pencil: pen input draws; pressure values update in vault debug log when enabled.
- Stylus-first input: fingers scroll/pinch natively; stylus inks with the selected tool; mouse follows the configured input policy. Trackpad behavior remains native.
- Note PDF embed (`![[file.pdf|alias]]`) shows an **Annotate** button left of ⋮; click opens the PDF in a new tab (ink attaches on that leaf).
- Direct / tab PDF overlay stays aligned across zoom, scroll, resize, page change, rotation.
- Note switching, embed removal, PDF close, plugin disable/re-enable leave no stray Annotate chrome.

## Tools and toolbar

- Open a direct PDF and PNG and verify each shows the same draggable floating toolbar. Rotate it from horizontal to vertical and back, then confirm the orientation persists after reopening. Drag the toolbar by its handle and confirm it stays within the window. Select an ink tool, then verify Sidecar Apple Pencil-as-mouse can draw, erase, and lasso. Switch to Drag and confirm mouse PDF navigation returns immediately. Use the More menu for page navigation, zoom, thumbnails, outline, search, print, and download.
- Open every dropdown with mouse, touch, stylus, keyboard.
- Click outside and Escape close dropdown; focus returns to button.
- Dropdown fits above/below toolbar at phone, tablet, desktop widths.
- Pen/Pencil/Highlighter selection, colors, opacity, sizes, previews, stabilization persist.
- Pencil looks distinct from pen (visible graphite grit via Texture); highlighter is wide and translucent; circular eraser cursor matches size and removes only touched ink.
- One eraser gesture can split a stroke into multiple pieces; undo restores the original stroke and redo restores the erased result.
- Freeform / rectangle lasso settings persist; only supported actions appear.
- Undo/redo and selection actions update dirty/save status.

## Saving and recovery

- Fresh install: Autosave on, 750 ms.
- Completed stroke, erase, transform, undo, redo schedule one serialized save.
- Pending autosave flushes on PDF close, note switch, plugin unload.
- Autosave off: status shows unsaved, Save works, close offers save/discard/cancel.
- Simulated write failure keeps last valid sidecar, shows failure, permits retry/recovery.
- Rename PDF, sync conflict, large PDF, thousands of strokes remain recoverable.

## Export

- Export uses latest autosaved and unsaved in-memory edits.
- Exported filename defaults to `name_export.pdf`; original PDF bytes unchanged.
- Export always writes a separate annotated copy — never replaces the source PDF.
