import { BasePdfAdapter } from "./BasePdfAdapter";
import { PdfAdapterCompatibilityError, type PdfAdapterCallbacks } from "./ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./PdfViewerCompatibility";
import type { PlatformCapabilityReport } from "./PlatformCapabilities";

export class EmbeddedPdfAdapter extends BasePdfAdapter {
  readonly kind = "embedded" as const;

  static runtimeDiagnostic(host: HTMLElement, surfaceRoot: HTMLElement): Record<string, unknown> {
    const view = host.ownerDocument.defaultView;
    const styleFor = (element: HTMLElement | null): Record<string, string> | null => {
      if (!element || !view) return null;
      const style = view.getComputedStyle(element);
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        zIndex: style.zIndex,
        contain: style.contain,
        isolation: style.isolation,
        transform: style.transform === "none" ? "none" : "transformed",
        overflow: style.overflow
      };
    };
    const labelFor = (element: HTMLElement): string => {
      const classes = [...element.classList]
        .filter((name) => name !== "node-insert-event" && name !== "cm-focused" && name !== "cm-blurred")
        .slice(0, 8)
        .join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`.slice(0, 160);
    };
    const hostRect = host.getBoundingClientRect();
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const hostStyle = styleFor(host);
    const opacity = Number(hostStyle?.opacity ?? "1");
    const viewer = host.querySelector<HTMLElement>(".pdf-viewer-container, .pdf-viewer, .pdfViewer");
    const overlay = surfaceRoot.querySelector<HTMLElement>(
      '.native-pdf-handwriting-page-overlay[data-surface-type="markdown"]'
    );
    const ancestors: Array<Record<string, string | null>> = [];
    let current: HTMLElement | null = host;
    while (current && ancestors.length < 8) {
      ancestors.push({ node: labelFor(current), ...(styleFor(current) ?? {}) });
      if (current === surfaceRoot) break;
      current = current.parentElement;
    }
    const layoutVisible = Boolean(
      hostStyle
      && hostStyle.display !== "none"
      && hostStyle.visibility !== "hidden"
      && opacity > 0
      && hostRect.width > 0
      && hostRect.height > 0
      && hostRect.right > 0
      && hostRect.bottom > 0
      && hostRect.left < width
      && hostRect.top < height
    );

    return {
      hostClass: [...host.classList].slice(0, 12),
      loaded: host.classList.contains("is-loaded"),
      viewerPresent: Boolean(viewer),
      pagePresent: Boolean(host.querySelector(".page, .pdf-page, [data-page-number]")),
      canvasPresent: Boolean(host.querySelector("canvas")),
      layoutWithinViewport: layoutVisible,
      bounds: {
        x: Math.round(hostRect.left),
        y: Math.round(hostRect.top),
        width: Math.round(hostRect.width),
        height: Math.round(hostRect.height)
      },
      hostStyle,
      viewerStyle: styleFor(viewer),
      overlayZIndex: styleFor(overlay)?.zIndex ?? null,
      stackingAncestors: ancestors
    };
  }

  static discover(container: HTMLElement): HTMLElement[] {
    const selectors = [".internal-embed[src$='.pdf']", ".internal-embed[data-type='pdf']", ".pdf-embed"];
    const found = new Set<HTMLElement>();
    for (const selector of selectors) {
      if (container.matches(selector)) found.add(container);
      container.querySelectorAll<HTMLElement>(selector).forEach((element) => found.add(element));
    }
    return [...found];
  }

  static attach(
    host: HTMLElement,
    callbacks: PdfAdapterCallbacks = {},
    options: {
      privateViewer?: import("./PdfViewerCompatibility").PdfJsViewerLike;
      findController?: import("./PdfViewerCompatibility").PdfFindControllerLike;
      platform?: PlatformCapabilityReport;
    } = {}
  ): EmbeddedPdfAdapter {
    const compatibility = PdfViewerCompatibility.embedded(
      host,
      options.privateViewer,
      options.findController,
      options.platform
    );
    if (!compatibility.compatible) throw new PdfAdapterCompatibilityError("embedded", compatibility.errors);
    return new EmbeddedPdfAdapter(compatibility, host, callbacks);
  }
}
