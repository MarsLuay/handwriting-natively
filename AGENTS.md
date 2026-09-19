# Handwriting Natively agent rules

<!-- project-memory-bootstrap:v1 -->
## Memory bank bootstrap (technical name: project-memory)

From this project root, before any task, run:

```bash
python3 ../../scripts/project-memory-context.py --root . --task "<current task>"
```

Read every path listed under `Required source reads` before editing. A non-zero result blocks the task; repair the project contract or route before continuing. Edit durable tasks and memory only at contract-listed paths.
<!-- /project-memory-bootstrap:v1 -->


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

## Git

- Always commit and merge to main for changes. Use `/sync` if push is not clean. 
