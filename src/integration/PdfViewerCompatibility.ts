import { hasHeuristicPdfPageNumber, queryPdfPageNodes } from "./pdfPageSelectors";
import { PlatformCapabilities, type PlatformCapabilityReport } from "./PlatformCapabilities";

export type PdfIntegrationStatus = "supported" | "supported-with-fallback" | "degraded" | "unsafe";

/** Stable, bounded evidence emitted for one live PDF adapter instance. */
export interface PdfIntegrationProfile {
  schemaVersion: 1;
  adapter: "direct" | "embedded";
  status: PdfIntegrationStatus;
  /** The viewer generation is advanced by adapter lifecycle work (#148). */
  viewerGeneration: number;
  strategies: {
    viewerRoot: string;
    pages: string;
    scrollRoot: string;
    scale: string;
    zoomEvents: string;
    pageLifecycle: string;
    sidebar: string;
  };
  /** Capability names are stable; values never contain DOM or private objects. */
  capabilities: Record<string, boolean>;
  /** Bounded counters are suitable for copied diagnostics and session summaries. */
  counters: {
    rebinds: number;
    viewerReplacements: number;
    pageReplacements: number;
    fallbackUses: number;
    attachRetries: number;
  };
  failedProbes: string[];
  warnings: string[];
}

export interface CompatibilityResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  profile: PdfIntegrationProfile;
  /** Present for reports produced by this compatibility layer; optional for legacy callers. */
  platform?: PlatformCapabilityReport;
  viewerRoot?: HTMLElement;
  toolbarHost?: HTMLElement;
  privateViewer?: PdfJsViewerLike;
  findController?: PdfFindControllerLike;
}

export interface PdfJsEventBus {
  on?(name: string, callback: (event: unknown) => void): void;
  off?(name: string, callback: (event: unknown) => void): void;
  dispatch?(name: string, data?: unknown): void;
}

export interface PdfJsViewerLike {
  currentPageNumber?: number;
  currentScale?: number;
  currentScaleValue?: string | number;
  pagesRotation?: number;
  container?: HTMLElement;
  viewer?: HTMLElement;
  findController?: PdfFindControllerLike;
  updateScale?(options: {
    drawingDelay?: number;
    scaleFactor?: number | null;
    steps?: number | null;
    origin?: unknown;
  }): void;
  eventBus?: PdfJsEventBus;
}

/** PDF.js find controller surface used by AnnotationFindBridge (private fields vary by build). */
export interface PdfFindControllerLike {
  eventBus?: PdfJsEventBus;
  /** Some Obsidian/PDF.js builds only expose the bus as `_eventBus`. */
  _eventBus?: PdfJsEventBus;
  _pageContents?: string[];
  pageContents?: string[];
  /**
   * Diff maps from `normalize()` used by `getOriginalIndex`.
   * Must be cleared (or rebuilt) when `_pageContents` is extended with HN text,
   * or suffix matches are dropped.
   */
  _pageDiffs?: Array<unknown>;
  /** Per-page text extraction promises filled lazily on first find. */
  _extractTextPromises?: Array<Promise<unknown> | undefined | null>;
  _pageMatches?: unknown[];
  pageMatches?: unknown[];
  _pageMatchesLength?: unknown[];
  pageMatchesLength?: unknown[];
  _selected?: { pageIdx?: number; matchIdx?: number; [key: string]: unknown } | null;
  selected?: { pageIdx?: number; matchIdx?: number; [key: string]: unknown } | null;
  _state?: { query?: string | string[] | null; highlightAll?: boolean; [key: string]: unknown } | null;
  state?: { query?: string | string[] | null; highlightAll?: boolean; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/** Obsidian PDF view shape used by PDF++ / core (`view.viewer.then(child)`). */
export interface ObsidianPdfViewLike {
  containerEl?: HTMLElement;
  viewer?: {
    child?: ObsidianPdfViewerChildLike;
    then?(onFulfilled: (child: ObsidianPdfViewerChildLike) => void): unknown;
  };
}

export interface ObsidianPdfViewerChildLike {
  findController?: PdfFindControllerLike;
  findBar?: unknown;
  eventBus?: PdfJsEventBus;
  pdfViewer?: PdfJsViewerLike & {
    pdfViewer?: PdfJsViewerLike | null;
    findController?: PdfFindControllerLike;
    dom?: {
      viewerContainerEl?: HTMLElement;
      containerEl?: HTMLElement;
    } | null;
  };
}

type PrivateHost = HTMLElement & {
  pdfViewer?: PdfJsViewerLike;
  viewer?: PdfJsViewerLike;
  component?: { pdfViewer?: PdfJsViewerLike; viewer?: PdfJsViewerLike };
  findController?: PdfFindControllerLike;
};

export class PdfViewerCompatibility {
  static direct(
    host: HTMLElement,
    privateViewer?: PdfJsViewerLike,
    findController?: PdfFindControllerLike,
    platform?: PlatformCapabilityReport
  ): CompatibilityResult {
    return this.inspect(
      host,
      "direct",
      [".pdf-viewer", ".pdfViewer"],
      [".pdf-toolbar", ".pdf-toolbar-container"],
      privateViewer,
      findController,
      platform
    );
  }

  static embedded(
    host: HTMLElement,
    privateViewer?: PdfJsViewerLike,
    findController?: PdfFindControllerLike,
    platform?: PlatformCapabilityReport
  ): CompatibilityResult {
    return this.inspect(
      host,
      "embedded",
      [".pdf-embed .pdf-viewer", ".internal-embed .pdf-viewer", ".pdf-viewer", ".pdfViewer"],
      [".pdf-toolbar", ".pdf-toolbar-container"],
      privateViewer,
      findController,
      platform
    );
  }

  /** Wait for PDFViewerChild like PDF++ (`view.viewer.then(child)`). */
  static async waitPdfViewerChild(view: ObsidianPdfViewLike, timeoutMs = 2500): Promise<ObsidianPdfViewerChildLike | undefined> {
    const component = view.viewer;
    if (!component) return undefined;
    if (component.child?.pdfViewer) return component.child;
    if (typeof component.then !== "function") return component.child;

    return await new Promise<ObsidianPdfViewerChildLike | undefined>((resolve) => {
      let settled = false;
      const finish = (child: ObsidianPdfViewerChildLike | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(child);
      };
      try {
        void Promise.resolve(component.then?.((child) => finish(child))).catch(() => {
          finish(component.child);
        });
      } catch {
        finish(component.child);
        return;
      }
      window.setTimeout(() => finish(component.child), timeoutMs);
    });
  }

  /**
   * Prefer nested PDF.js viewer for scale APIs; keep Obsidian viewer eventBus.
   * Graph: view.viewer.child.pdfViewer (Obsidian) → .pdfViewer (PDF.js).
   */
  static bindPrivateViewer(obsidianOrNested?: PdfJsViewerLike & { pdfViewer?: PdfJsViewerLike | null } | null): PdfJsViewerLike | undefined {
    if (!obsidianOrNested) return undefined;
    const nested = obsidianOrNested.pdfViewer ?? null;
    if (nested && (typeof nested.currentScale === "number" || typeof nested.updateScale === "function")) {
      const bound = {
        get currentPageNumber() {
          return nested.currentPageNumber ?? obsidianOrNested.currentPageNumber;
        },
        get currentScale() {
          return nested.currentScale;
        },
        set currentScale(value: number | undefined) {
          if (typeof value === "number") nested.currentScale = value;
        },
        get currentScaleValue() {
          return nested.currentScaleValue;
        },
        set currentScaleValue(value: string | number | undefined) {
          if (value !== undefined) nested.currentScaleValue = value;
        },
        get pagesRotation() {
          return nested.pagesRotation ?? obsidianOrNested.pagesRotation;
        },
        get container() {
          return nested.container
            ?? (obsidianOrNested as { dom?: { viewerContainerEl?: HTMLElement } }).dom?.viewerContainerEl
            ?? obsidianOrNested.container;
        },
        get viewer() {
          return nested.viewer ?? obsidianOrNested.viewer;
        },
        get findController() {
          return nested.findController ?? obsidianOrNested.findController;
        },
        ...(typeof nested.updateScale === "function" ? { updateScale: nested.updateScale.bind(nested) } : {}),
        eventBus: obsidianOrNested.eventBus ?? nested.eventBus
      } as PdfJsViewerLike;
      return bound;
    }
    return obsidianOrNested;
  }

  /** Probe Obsidian/PDF.js private find controller (capability-checked; may be absent). */
  static resolveFindController(
    child?: ObsidianPdfViewerChildLike | null,
    privateViewer?: PdfJsViewerLike | null
  ): PdfFindControllerLike | undefined {
    const candidates: unknown[] = [
      child?.findController,
      child?.pdfViewer?.findController,
      child?.pdfViewer?.pdfViewer?.findController,
      privateViewer?.findController,
      (privateViewer as { pdfViewer?: PdfJsViewerLike } | null | undefined)?.pdfViewer?.findController
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as PdfFindControllerLike;
      if (Array.isArray(record._pageContents) || Array.isArray(record.pageContents) || record._state !== undefined || record.state !== undefined) {
        return record;
      }
      // Object present but not yet extracted — still usable once find runs.
      if ("eventBus" in record || "_extractTextPromises" in record || "linkService" in record) {
        return record;
      }
    }
    return undefined;
  }

  static async resolvePrivateViewerFromPdfView(view: ObsidianPdfViewLike): Promise<PdfJsViewerLike | undefined> {
    const child = await this.waitPdfViewerChild(view);
    return this.bindPrivateViewer(child?.pdfViewer ?? null);
  }

  /** Resolve viewer + find controller together for adapter attach. */
  static async resolveViewerGraphFromPdfView(view: ObsidianPdfViewLike): Promise<{
    privateViewer?: PdfJsViewerLike;
    findController?: PdfFindControllerLike;
  }> {
    const child = await this.waitPdfViewerChild(view);
    const privateViewer = this.bindPrivateViewer(child?.pdfViewer ?? null);
    const findController = this.resolveFindController(child, privateViewer);
    const graph: {
      privateViewer?: PdfJsViewerLike;
      findController?: PdfFindControllerLike;
    } = {};
    if (privateViewer) graph.privateViewer = privateViewer;
    if (findController) graph.findController = findController;
    return graph;
  }

  private static inspect(
    host: HTMLElement,
    adapter: "direct" | "embedded",
    viewerSelectors: string[],
    toolbarSelectors: string[],
    resolvedPrivateViewer?: PdfJsViewerLike,
    resolvedFindController?: PdfFindControllerLike,
    platform: PlatformCapabilityReport = PlatformCapabilities.probe()
  ): CompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    // A PDF replacement can briefly leave the previous viewer shell connected
    // beside the new one. `querySelector` would select that stale first shell,
    // causing attach to fail for missing pages or mounting the shared toolbar
    // into a viewer that is no longer visible. Prefer the private viewer hint,
    // then the newest candidate with rendered pages.
    const viewerRoot = this.findViewerRoot(host, viewerSelectors, resolvedPrivateViewer);
    if (!viewerRoot) errors.push(`PDF viewer root missing; tried ${viewerSelectors.join(", ")}`);
    const page = viewerRoot ? queryPdfPageNodes(viewerRoot)[0] : undefined;
    if (viewerRoot && !page) {
      errors.push("PDF page nodes missing; expected .page[data-page-number] or .pdf-page-view[data-page-number]");
    }
    const toolbarHost = this.findToolbarHost(host, toolbarSelectors);
    if (!toolbarHost) warnings.push("Native PDF toolbar host missing; annotation toolbar will mount beside the viewer");
    const privateHost = host as PrivateHost;
    const privateViewer = resolvedPrivateViewer
      ?? privateHost.pdfViewer
      ?? privateHost.viewer
      ?? privateHost.component?.pdfViewer
      ?? privateHost.component?.viewer;
    if (!privateViewer) warnings.push("Private PDF.js viewer object unavailable; DOM page metrics fallback is active");
    const findController = resolvedFindController
      ?? this.resolveFindController(null, privateViewer)
      ?? privateHost.findController;
    if (!findController) {
      warnings.push("PDF find controller unavailable; Handwriting Natively text will not appear in the PDF find bar");
    }
    const eventBus = privateViewer?.eventBus ?? findController?.eventBus ?? findController?._eventBus;
    const hasEventBus = Boolean(eventBus &&
      typeof (eventBus as unknown as { on?: unknown }).on === "function" &&
      typeof (eventBus as unknown as { off?: unknown }).off === "function");
    const hasPageNumber = Boolean(page?.dataset.pageNumber && Number(page.dataset.pageNumber) >= 1);
    const trustworthyPageNumbers = hasPageNumber && !hasHeuristicPdfPageNumber(page!);
    const hasGeometry = Boolean(page);
    const sidebarObservable = Boolean(toolbarHost || hasEventBus);
    const profile: PdfIntegrationProfile = {
      schemaVersion: 1,
      adapter,
      status: errors.length
        ? "unsafe"
        : !sidebarObservable
          ? "degraded"
          : warnings.length
            ? "supported-with-fallback"
            : "supported",
      viewerGeneration: 1,
      strategies: {
        viewerRoot: viewerRoot ? "validated-dom-selector" : "missing",
        pages: page
          ? (trustworthyPageNumbers ? "numbered-dom-shell" : "heuristic-page-shell")
          : "missing",
        scrollRoot: "adapter-fallback-chain",
        scale: typeof privateViewer?.currentScale === "number" ? "private-viewer" : "page-geometry-fallback",
        zoomEvents: hasEventBus ? "optional-event-bus" : "geometry-fallback",
        pageLifecycle: "bounded-dom-observation",
        sidebar: toolbarHost ? "native-toolbar-or-geometry" : "shared-toolbar-fallback"
      },
      capabilities: {
        viewerRoot: Boolean(viewerRoot),
        pageElements: Boolean(page),
        trustworthyPageNumbers,
        geometryReadable: hasGeometry,
        scrollRoot: Boolean(viewerRoot),
        toolbarHost: Boolean(toolbarHost),
        privateViewer: Boolean(privateViewer),
        eventBus: hasEventBus,
        scaleReadable: typeof privateViewer?.currentScale === "number" || hasGeometry,
        pageRenderEvent: hasEventBus,
        scaleEvent: hasEventBus,
        rotationReadable: typeof privateViewer?.pagesRotation === "number" || hasGeometry,
        pageReplacementObservable: Boolean(viewerRoot),
        sidebarObservable,
        embedded: adapter === "embedded"
      },
      counters: {
        rebinds: 0,
        viewerReplacements: 0,
        pageReplacements: 0,
        fallbackUses: hasEventBus ? 0 : 1,
        attachRetries: 0
      },
      // These fields are copied into normal diagnostics; keep them bounded and
      // never include selectors beyond the fixed probe messages above.
      failedProbes: errors.slice(0, 8),
      warnings: warnings.slice(0, 8)
    };
    const result: CompatibilityResult = {
      compatible: errors.length === 0,
      errors,
      warnings,
      profile,
      platform
    };
    if (viewerRoot) result.viewerRoot = viewerRoot;
    if (toolbarHost) result.toolbarHost = toolbarHost;
    if (privateViewer) result.privateViewer = privateViewer;
    if (findController) result.findController = findController;
    return result;
  }

  private static findViewerRoot(
    host: HTMLElement,
    selectors: string[],
    privateViewer?: PdfJsViewerLike
  ): HTMLElement | undefined {
    const candidates = this.all<HTMLElement>(host, selectors);
    if (candidates.length <= 1) return candidates[0];

    const hints = [privateViewer?.viewer, privateViewer?.container]
      .filter((hint): hint is HTMLElement => Boolean(hint));
    for (const hint of hints) {
      const match = candidates.find((candidate) => candidate === hint || candidate.contains(hint) || hint.contains(candidate));
      if (match) return match;
    }

    const withPages = candidates.filter((candidate) => queryPdfPageNodes(candidate).length > 0);
    const pool = withPages.length > 0 ? withPages : candidates;
    return [...pool].sort((left, right) => {
      const pageDelta = queryPdfPageNodes(left).length - queryPdfPageNodes(right).length;
      if (pageDelta !== 0) return pageDelta;
      const canvasDelta = left.querySelectorAll("canvas").length - right.querySelectorAll("canvas").length;
      if (canvasDelta !== 0) return canvasDelta;
      return candidates.indexOf(left) - candidates.indexOf(right);
    }).at(-1);
  }

  private static all<T extends Element>(host: HTMLElement, selectors: string[]): T[] {
    const selector = selectors.join(", ");
    const candidates: T[] = host.matches(selector) ? [host as unknown as T] : [];
    candidates.push(...host.querySelectorAll<T>(selector));
    return [...new Set(candidates)];
  }

  private static findToolbarHost(host: HTMLElement, selectors: string[]): HTMLElement | undefined {
    const candidates = this.all<HTMLElement>(host, selectors);
    // Toolbar shells are siblings of the PDF viewer in Obsidian. During a
    // document replacement the old shell can remain connected, so the newest
    // host is the one that can actually present the shared tools.
    return candidates.at(-1);
  }
}
