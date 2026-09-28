# Welcome to Handwriting Natively!

## What Handwriting Natively Does

Handwrite on PDFs and supported static PNG/JPEG images with a stylus or mouse natively in Obsidian. Annotations live in vault metadata, while explicit page insert/delete/import/scan actions update the open PDF and remap its sidecar atomically. Export PDFs as flattened or editable copies, or export an annotated image as a bounded flattened copy in its source PNG/JPEG format. Text boxes are sidecar-backed and editable in Text mode; physical eraser tips and optional whole-stroke/right-click erasing are supported.

I made this plugin after realizing I use Obsidian a lot more than another nameless note taking app.. I hope you find it as useful as I do!

![Handwriting Natively drawing toolbar on a Lorem Ipsum PDF](docs/handwriting-natively.png)

- Pen, graphite pencil, highlighter, laser pointer, eraser, and lasso tools and a nifty toolbar
- Mainly built for stylus, yet mouse is also available to draw and drag
- Autosaving, everyones favorite feature
- Commands to create a GoodNotes inspired blank PDF/notebook.handwritten PDF where you can add pages as you work
- Assignable Hotkeys commands to switch to Pen, Eraser, Laser Pointer, Lasso, or Text , plus undo and redo 

## Setup

### Quick Start

1. Download the latest [GitHub release](https://github.com/MarsLuay/handwriting-natively/releases) assets (`main.js`, `manifest.json`, `styles.css`).
2. Copy them into `<Vault>/.obsidian/plugins/native-pdf-handwriting/`.
3. Reload Obsidian and enable **Handwriting Natively** under **Settings → Community plugins**.
4. Open a PDF, select an ink tool, and annotate. Stylus input is routed directly; touch remains native PDF navigation.

### Manual Setup

1. Download the BRAT plugin
2. Press on its icon to enter a plugin, and paste in https://github.com/MarsLuay/handwriting-natively.git
3. Select any release you desire! (the latest pre-release is my pick..)
4. Press install and enjoy

## License

MIT — see [LICENSE](LICENSE).

If this project is used for any others, all that is required is acknowledging this repo. Thank you! Build cool things

## Privacy

Local-only annotation processing. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). No telemetry or hosted service.
