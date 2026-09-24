import { describe, expect, it } from "vitest";
import { PdfPageLocator } from "../src/integration/PdfPageLocator";
import { PdfViewerCompatibility } from "../src/integration/PdfViewerCompatibility";
import { annotationPageSafetyReason } from "../src/runtime/AnnotationSurface";

function pdfFixture(options: { embedded?: boolean; toolbar?: boolean; privateViewer?: boolean } = {}): HTMLElement {
  const host = document.createElement("div");
  const embed = document.createElement("div");
  if (options.embedded) embed.className = "internal-embed";
  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.dataset.pdfWidth = "612";
  page.dataset.pdfHeight = "792";
  page.append(document.createElement("canvas"));
  viewer.append(page);
  embed.append(viewer);
  host.append(embed);
  if (options.toolbar) {
    const toolbar = document.createElement("div");
    toolbar.className = "pdf-toolbar";
    host.append(toolbar);
  }
  if (options.privateViewer) {
    Object.assign(host, {
      pdfViewer: {
        currentScale: 1,
        eventBus: { on: () => undefined, off: () => undefined }
      },
      findController: {
        eventBus: { on: () => undefined, off: () => undefined }
      }
    });
  }
  document.body.append(host);
  return host;
}

describe("deterministic PDF integration fixtures", () => {
  it.each([
    ["direct", false],
    ["embedded", true]
  ] as const)("attaches the %s fixture through the shared page contract", (adapter, embedded) => {
    const host = pdfFixture({ embedded, toolbar: true, privateViewer: true });
    const result = adapter === "direct"
      ? PdfViewerCompatibility.direct(host)
      : PdfViewerCompatibility.embedded(host);

    expect(result.compatible).toBe(true);
    expect(result.profile).toMatchObject({
      adapter,
      status: "supported",
      viewerGeneration: 1,
      strategies: {
        pages: "numbered-dom-shell",
        scale: "private-viewer",
        zoomEvents: "optional-event-bus"
      },
      capabilities: {
        pageElements: true,
        geometryReadable: true,
        sidebarObservable: true,
        embedded
      }
    });
    host.remove();
  });

  it("keeps missing optional capability fixtures degraded but attachable", () => {
    const host = pdfFixture();
    const result = PdfViewerCompatibility.direct(host);
    expect(result.compatible).toBe(true);
    expect(result.profile.status).toBe("degraded");
    expect(result.profile.capabilities).toMatchObject({
      pageElements: true,
      geometryReadable: true,
      privateViewer: false,
      eventBus: false,
      sidebarObservable: false
    });
    host.remove();
  });

  it("keeps duplicate generations and unsafe geometry deterministic", () => {
    const host = pdfFixture();
    const viewer = host.querySelector<HTMLElement>(".pdf-viewer")!;
    const first = viewer.querySelector<HTMLElement>(".page")!;
    const locator = new PdfPageLocator(viewer);
    expect(locator.page(1)?.mountGeneration).toBe(1);
    const replacement = first.cloneNode(true) as HTMLElement;
    viewer.replaceChildren(replacement);
    expect(locator.page(1)?.mountGeneration).toBe(2);
    expect(locator.page(1)?.identitySafe).toBe(true);

    const unsafe = {
      pageNumber: 1,
      width: 0,
      height: 792,
      scale: 1,
      rotation: 0,
      element: replacement,
      geometrySafe: false,
      identitySafe: true
    };
    expect(annotationPageSafetyReason(unsafe)).toBe("geometry-unsafe");
    host.remove();
  });
});
