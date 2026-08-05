# Handwriting Natively agent rules

- Keep `Inspiration/` read-only.
- Keep undocumented Obsidian PDF access inside `src/integration/`.
- Sidecar JSON is the canonical editable annotation store. Original PDFs are never modified.
- Autosave defaults on. Use Export PDF for a separate annotated copy.
- Mouse, touch, and trackpad keep normal PDF behavior unless editing is explicit.
- Use shared toolbar, tools, storage, and engine for direct and embedded PDF views.
- No OCR. No whole-framework embedding. No in-place PDF writes.
- Run `npm test` and `npm run build` before done.

## Input Capability Probe

Sibling plugin `input-capability-probe` writes runtime HID results to
`.obsidian/plugins/input-capability-probe/last-report.json`
(and `document` event `input-probe:capability-report`). Use that file to soft-gate
pressure/tilt features later — do not route pointer-move floods through
`hn-dev-probe:diagnostic`.

Applied from probe findings (MockTab / Electron):
- Mouse tip after pen hover remaps to pen for pressure + palm lock (`PenPresence` / `PalmRejectionPolicy`).
- Off-host continuous wheel pans the PDF (MockTab two-finger scroll at cursor).
- `lostpointercapture` finishes mouse ink routes, not only pen.
- Companion / multi-touch still need real `TouchEvent`s — cannot fake from wheel.
## Code analysis — wont-fix

- `main.js` (`perf/bundle-size`): Soft warn above the pdf-lib 750KB monitor threshold (~823KB). Export/path tooling needs `pdf-lib` in the Obsidian single-file bundle; stays under the 1MB error budget and Sync Standard 5MB limit. Further shrink would drop export capability or require unsupported release sidecars.
