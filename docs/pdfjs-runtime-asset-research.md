# PDF.js runtime assets and packaging research (#466)

**Status:** research input to #460. The current BRAT release path now bundles
PDF.js and pdf-lib into `main.js`; this note preserves the asset trade-offs and
compatibility evidence behind that decision.

**Implementation update:** BRAT installs only `main.js`, `manifest.json`, and
`styles.css`. The plugin therefore uses PDF.js's self-contained fake-worker mode
for releases instead of depending on sibling worker, CMap, font, or WASM files.
The external-asset resolver remains available for injected test runtimes and
future hosts that can prove a packaged asset directory is present.

## Evidence

The reference is the MIT package/repository
[`missing-elements/pdfjs-viewer`](https://github.com/missing-elements/pdfjs-viewer).
Its iframe is explicitly out of scope for Handwriting Natively: ink and page
surfaces need same-DOM coordinate and gesture ownership. Its packaging evidence
is useful, especially:

- [`src/pdfjs-viewer-element.ts`](https://github.com/missing-elements/pdfjs-viewer/blob/master/src/pdfjs-viewer-element.ts)
  — runtime URL resolution, `applyViewerOptions`, CSP, script injection, locale,
  and connected/disconnected lifecycle.
- [`scripts/sync-pdfjs-assets.mjs`](https://github.com/missing-elements/pdfjs-viewer/blob/master/scripts/sync-pdfjs-assets.mjs)
  — version extraction and asset allowlist from `pdfjs-dist`.
- [`scripts/copy-worker.mjs`](https://github.com/missing-elements/pdfjs-viewer/blob/master/scripts/copy-worker.mjs)
  — copying/minifying runtime modules and bundling viewer CSS.
- [`package.json`](https://github.com/missing-elements/pdfjs-viewer/blob/master/package.json)
  — build order and the `pdfjs-dist` dependency.

The reference package is MIT, while PDF.js and its auxiliary assets retain their
own Apache-2.0 and component-specific license notices. A future implementation
must preserve those notices in the release/package boundary.

## Runtime asset manifest

The exact PDF.js version must be pinned and all runtime files below must come
from that same release. “Required” means required for the proposed feature
set, not that every file belongs in the main bundle.

| Asset | Initial status | Purpose and policy |
| --- | --- | --- |
| `pdf.mjs` (or a deliberately bundled equivalent) | Required | PDF.js display/core runtime. Keep the version coupled to the worker and options. Prefer an external plugin asset when bundle budget or worker resolution makes bundling unsafe. |
| `pdf.worker.min.mjs` | Required | Module worker for normal documents. Set `GlobalWorkerOptions.workerSrc` to a same-release, runtime-resolved URL. |
| `viewer.mjs`, `viewer.css` | Conditional | Needed only if adopting PDF.js's stock viewer/application shell. A component-owned same-DOM viewer can omit the stock application and toolbar. |
| `viewer.html` | Not for #460's same-DOM plan | Required by a stock iframe/HTML viewer only. Do not adopt iframe isolation as the default architecture. |
| `cmaps/*.bcmap` | Recommended for arbitrary PDFs | CJK and other composite-font decoding. Ship the complete packed CMap set unless a measured supported-PDF policy proves a smaller set safe; keep the URL trailing-slash contract. |
| `standard_fonts/*` | Recommended | Fallback standard font data. Missing fonts can make otherwise valid documents render incorrectly, so omission must be an explicit compatibility decision. |
| `wasm/*` | Recommended/feature-gated | JBIG2, JPEG 2000, color-management, and related decoders. Ship the matching WASM plus any required fallback JS; test CSP and WebView support. |
| `iccs/*` | Feature-gated but preferred | ICC/color profiles for color-managed PDFs. Keep the option URL and capability result separate from CMaps/fonts. |
| `pdf.sandbox.mjs` | Conditional | PDF JavaScript/forms sandbox. Start with scripting disabled; ship and configure this only when forms/scripting are supported and security review is complete. |
| `images/*` | Conditional | Stock viewer toolbar/sidebar images. Not required for a plugin-owned toolbar or PDF.js component-only page surface. |
| `locale/*`, `locale.json` | Conditional | Stock viewer localization. Prefer host/plugin localization initially; if shipped, package local resources rather than the reference's remote CDN fallback. |
| debugger, source maps, sample PDF, `paper-and-ink.css` | Not runtime-required | Development/demo or reference-theme files. Exclude from release unless a deliberate debugging or theme feature needs them. |

For the first prototype, the minimum safe package is `pdf.mjs`, the matching
module worker, CMaps, standard fonts, and any WASM/ICC files proven necessary by
the target corpus. Add viewer CSS/modules only for parity features that are
actually used. The first release should not silently fetch runtime assets from a
CDN; core behavior must work offline.

## Runtime URL and esbuild strategy

The reference makes a useful distinction between development URLs such as
`new URL('./build/pdf.worker.mjs', import.meta.url)` and release filenames such
as `pdf.worker.min.mjs`. Its comment also identifies a real bundler hazard:
some consumer bundlers rewrite or skip `new URL(..., import.meta.url)` once a
module has been relocated.

For this repository:

1. Pin `pdfjs-dist` to an exact version (not a caret range), record the selected
   modern/legacy build, and sync its core, worker, CMaps, fonts, WASM, ICC, and
   optional viewer assets through a reviewed script.
2. For BRAT releases, bundle the pinned display runtime and auxiliary runtime
   modules into `main.js`; BRAT does not install arbitrary sibling directories
   from a release asset glob. Keep the bundle budget explicit and verify the
   self-contained fake-worker path.
3. Keep the release asset allowlist to `main.js`, `manifest.json`, and
   `styles.css`. Do not publish an unconsumable `pdfjs/` asset glob; GitHub
   release assets do not preserve directory structure for BRAT's standard
   three-file installer.
4. Resolve URLs through one `PdfRuntimeAssetResolver` at runtime. It should
   return a normalized URL and a diagnostic for each asset, with a platform
   capability probe. Do not scatter relative strings through page/render code.
5. Test both a development build and the packaged Obsidian plugin directory.
   The resolver must work after esbuild relocation, on desktop plugin paths, and
   in Capacitor mobile storage; a build that works only from the repository is
   not a valid result.
6. Keep the runtime and worker version together in one manifest. Refuse a
   mismatched worker/core pair rather than falling back to a remote URL or a
   fake worker silently.

`new URL` can be one resolver implementation when the target build proves that
esbuild preserves and deploys the referenced files. It is not a contract to
assume in the current CJS output. The resolver must be tested against the
actual emitted plugin package and must not expose absolute host paths in
telemetry or diagnostics.

## Worker strategy: desktop and mobile

Use a same-release module worker URL as the normal path:

```text
asset resolver → pdf.worker.min.mjs
GlobalWorkerOptions.workerSrc = resolved URL
getDocument({ data, ...assetOptions })
```

Prefer a direct packaged worker over creating a Blob worker. Blob workers can be
useful where a bundler emits no stable worker file, but they add `blob:` CSP
requirements, URL lifetime/revocation, and WebView compatibility risk. If a
Blob fallback is ever added, it must be capability-gated, revoke the object URL
when the worker/session is destroyed, and be covered by desktop, Android, and
iPadOS tests.

Do not assume that `file:`, `app:`, `capacitor:`, or an Obsidian plugin-relative
URL behaves identically across hosts. Validate worker construction and the
first `getDocument` handshake on each supported runtime. A failed worker probe
should produce a bounded compatibility state and preserve the current native
viewer; it should not silently enable a main-thread fake worker for large PDFs.

Share worker/runtime lifecycle at the plugin/session boundary only after all
loading tasks are tracked. Document replacement cancels render tasks and awaits
`PDFDocumentLoadingTask.destroy()`; plugin unload waits for active sessions and
then releases worker/runtime references.

## Auxiliary resources

`applyViewerOptions()` in the reference sets `workerSrc`, `cMapUrl`, `iccUrl`,
`imageResourcesPath`, `sandboxBundleSrc`, `standardFontDataUrl`, and `wasmUrl`
independently. This is the right separation for diagnostics and fallback:
missing CMaps is not the same failure as missing WASM or a blocked worker.

- **CMaps:** use packed `.bcmap` files and the PDF.js packed-CMap option. Ship
  all CMaps for arbitrary user PDFs unless a tested corpus policy intentionally
  narrows support.
- **Fonts:** ship standard-font data by default. It is small compared with a
  full viewer and avoids document-dependent fallback rendering failures.
- **WASM/image decoders:** ship the exact version's `wasm` directory when the
  supported corpus includes JPEG 2000, JBIG2, or color-managed content. Probe
  module/WASM compilation; record a degraded feature rather than a corrupt page.
- **ICC:** include matching profiles when color fidelity is a requirement;
  otherwise gate color management explicitly and test representative files.
- **Sandbox:** keep PDF scripting disabled in the first prototype. Enabling it
  requires the matching sandbox bundle, an explicit security policy, and forms
  tests; it must not gain unrestricted Obsidian or plugin globals.
- **Locale:** avoid a remote `localeSrcTemplate` for offline operation. Bundle
  the supported locale resources or defer to the host UI. Locale replacement
  must remove old object URLs and links before installing a new resource.
- **Viewer images/CSS:** if stock viewer CSS is used, bundle its image URLs or
  inline/rewrite them; the reference's CSS bundling step exists because a
  relocated `viewer.css` otherwise breaks relative image paths.

## CSP and runtime-loading risks

The reference generates an iframe `srcdoc` CSP with separate script, worker,
style, image, font, media, and connect sources. The most relevant lesson for a
same-DOM Obsidian plugin is that the host CSP—not a plugin-controlled `srcdoc`
meta tag—will decide whether runtime loading works.

Qualify the following without weakening Obsidian's policy:

- `script-src` for the packaged core/viewer modules;
- `worker-src` for same-origin/local worker URLs and, only if necessary, `blob:`;
- `style-src` for viewer CSS and any required inline style behavior;
- `font-src`, `img-src`, and `media-src` for local PDF resources;
- WASM compilation requirements (`wasm-unsafe-eval` where the host permits it);
- `connect-src` for local asset URLs, with no unneeded network wildcard;
- `base-uri`/form behavior for the PDF viewer and annotation forms.

Do not add `unsafe-eval`, broad `connect-src *`, remote CDN resources, or
`data:`/`blob:` allowances merely because the reference iframe does. If a host
blocks a needed capability, report it and retain native PDF fallback. Capture
only sanitized asset name, capability, and failure category in diagnostics.

## Same-DOM decision

The reference's `connectedCallback()` builds an iframe `srcdoc`, injects
`pdf.mjs` and `viewer.mjs`, waits for `PDFViewerApplication.initializedPromise`,
and `disconnectedCallback()` navigates the iframe to `about:blank`. This is a
strong isolation/packaging pattern for a generic web component, but it is the
wrong default for #460: cross-document page and ink layers complicate
coordinates, pointer capture, text selection, focus, accessibility, and
lifecycle ownership.

Use its asset manifest and initialization sequencing without adopting the
iframe. The authorized viewer should load the PDF.js display/runtime modules in
the plugin-owned same-DOM session, expose the PDF page viewport to the ink
adapter, and retain native fallback when runtime initialization is not safe.

## Cleanup checklist

- cancel queued and active render tasks before document replacement;
- await each `PDFDocumentLoadingTask.destroy()` and call document/page cleanup
  at the PDF adapter boundary;
- remove EventBus, DOM, resize, intersection, keyboard, and pointer listeners;
- disconnect page/scroll observers and invalidate viewer/page generations;
- revoke every Blob worker, locale, or temporary resource URL;
- remove injected scripts, styles, locale links, and runtime overlays;
- release PDF.js page, document, worker, find, link, text, and annotation
  references;
- ensure a failed initialization cannot leave a worker running or a stale page
  accepting ink;
- make unload/replacement idempotent and wait for all tracked promises;
- preserve the current viewer if any required asset, worker handshake, or CSP
  capability fails.

## Decision for #460

Adopt a reviewed, exact-version PDF.js asset manifest and a single runtime URL
resolver. Keep `pdf.mjs`/worker and essential auxiliary assets outside the main
bundle, package them offline with license notices, and test emitted assets on
Windows/macOS desktop, Android, and iPadOS. Prefer a direct same-DOM worker and
component stack; do not use the reference iframe or CDN fallback as the viewer
architecture. Treat CMaps, fonts, WASM, ICC, sandbox, locale, and CSP as
independent capability gates with explicit cleanup and native fallback.
