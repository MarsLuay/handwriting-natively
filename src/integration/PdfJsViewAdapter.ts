import type { App, TFile } from "obsidian";
import type { ToolbarPlacement } from "../model";
import type {
  AnnotationSurfaceCallbacks,
  AnnotationViewState
} from "../runtime/AnnotationSurface";
import { setElementCssProps } from "../dom/typeGuards";
import type { PdfIntegrationProfile } from "./PdfViewerCompatibility";
import type { PdfPageInfo } from "./PdfPageLocator";
import type { PdfSurfaceExtensions } from "./ObsidianPdfAdapter";
import {
  loadPdfJsRuntime,
  pdfJsDocumentOptions,
  type PdfJsDocumentProxy,
  type PdfJsPageProxy,
  type PdfJsRenderTask,
  type PdfJsRuntime,
  type PdfJsTextItem,
  type PdfJsViewport
} from "./PdfJsRuntime";

interface OwnedPage {
  pageNumber: number;
  page?: PdfJsPageProxy;
  shell: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  annotationLayer: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
  viewport?: PdfJsViewport;
  renderTask: PdfJsRenderTask | undefined;
  generation: number;
  mountGeneration: number;
  renderedAtScale: number | undefined;
  renderedAtRotation: number | undefined;
  renderQueued: boolean;
}

export interface PdfJsViewAdapterOptions {
  app: App;
  file: TFile;
  pluginDir: string;
  host: HTMLElement;
  callbacks?: AnnotationSurfaceCallbacks;
  runtime?: PdfJsRuntime;
}

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.15;
const PAGE_GAP = 20;
const RENDER_NEIGHBOR_RADIUS = 2;
const MAX_TEXT_ITEMS = 4_000;
const MAX_ANNOTATIONS = 1_000;
const MAX_TEXT_CONTENT_CACHE_PAGES = 32;
const THUMBNAIL_FALLBACK_PRELOAD = 12;

function clampScale(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, value)) : DEFAULT_SCALE;
}

function normalizeFindText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizeRotation(value: number): number {
  const result = ((Math.round(value) % 360) + 360) % 360;
  return result === 90 || result === 180 || result === 270 ? result : 0;
}

// Create through the owner document's Obsidian DOM helpers so popout windows
// retain their own document and stylesheet context.
function createElement<T extends keyof HTMLElementTagNameMap>(ownerDocument: Document, tag: T, className?: string): HTMLElementTagNameMap[T] {
  if (!ownerDocument.body) throw new Error("PDF viewer document body is unavailable");
  const element = ownerDocument.body.createEl(tag);
  element.remove();
  if (className) element.className = className;
  return element;
}

function setPixelSize(element: HTMLElement, width: number, height: number): void {
  setElementCssProps(element, { width: `${Math.max(1, width)}px`, height: `${Math.max(1, height)}px` });
}

function transformForText(item: PdfJsTextItem): readonly number[] | undefined {
  return item.transform && item.transform.length >= 6 ? item.transform : undefined;
}

function viewportPoint(viewport: PdfJsViewport, x: number, y: number): [number, number] {
  if (viewport.convertToViewportPoint) return viewport.convertToViewportPoint(x, y);
  const t = viewport.transform;
  return [t[0]! * x + t[2]! * y + t[4]!, t[1]! * x + t[3]! * y + t[5]!];
}

function viewportRect(viewport: PdfJsViewport, rect: readonly number[]): [number, number, number, number] {
  if (viewport.convertToViewportRectangle && rect.length >= 4) return viewport.convertToViewportRectangle(rect);
  const a = viewportPoint(viewport, rect[0] ?? 0, rect[1] ?? 0);
  const b = viewportPoint(viewport, rect[2] ?? 0, rect[3] ?? 0);
  return [a[0], a[1], b[0], b[1]];
}

function safeUrl(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:", "mailto:", "tel:", "obsidian:"].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** PDF.js-owned parsing/rendering surface with plugin-owned DOM and ink space. */
export class PdfJsViewAdapter implements PdfSurfaceExtensions {
  readonly kind = "direct" as const;
  readonly surfaceType = "pdf" as const;
  readonly supportsPdfExport = true as const;
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  readonly viewerGeneration = 1;

  private readonly callbacks: AnnotationSurfaceCallbacks;
  private readonly fileName: string;
  private readonly pdfDocument: PdfJsDocumentProxy;
  private readonly sourceData: Uint8Array;
  private readonly loadingTask: { destroy?(): Promise<void> | void };
  private readonly pagesByNumber = new Map<number, OwnedPage>();
  private readonly mounted = new Set<HTMLElement>();
  private readonly cleanups: Array<() => void> = [];
  private readonly pendingRenders = new Map<number, Promise<void>>();
  private readonly visiblePages = new Set<number>();
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lifecycleGeneration = 0;
  private thumbnailGeneration = 0;
  private destroyed = false;
  private scale = DEFAULT_SCALE;
  private rotation = 0;
  private currentPageNumber = 1;
  private currentScaleMode: string | number = "auto";
  private zoomTimer: number | null = null;
  private layoutFrame: number | null = null;
  private readonly toolbarHost: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly pageContainer: HTMLElement;
  private readonly pageIndicator: HTMLElement;
  private readonly pageNumberInput: HTMLInputElement;
  private readonly pageCountLabel: HTMLElement;
  private readonly zoomSelect: HTMLSelectElement;
  private readonly findBar: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly findStatus: HTMLElement;
  private readonly outlinePanel: HTMLElement;
  private readonly thumbnailPanel: HTMLElement;
  private readonly thumbnailTasks = new Set<PdfJsRenderTask>();
  private readonly thumbnailQueued = new Set<number>();
  private readonly thumbnailRendered = new Set<number>();
  private thumbnailObserver: IntersectionObserver | null = null;
  private readonly textContentByPage = new Map<number, Promise<{ items?: readonly PdfJsTextItem[] }>>();
  private findGeneration = 0;
  private findMatches: Array<{ pageNumber: number; offset: number }> = [];
  private findIndex = -1;
  private handToolActive = false;
  private handPointerId: number | null = null;
  private handStartX = 0;
  private handStartY = 0;
  private handScrollLeft = 0;
  private handScrollTop = 0;

  private constructor(
    options: PdfJsViewAdapterOptions,
    loadingTask: { destroy?(): Promise<void> | void },
    pdfDocument: PdfJsDocumentProxy,
    sourceData: Uint8Array
  ) {
    this.host = options.host;
    this.fileName = options.file.name;
    this.callbacks = options.callbacks ?? {};
    this.loadingTask = loadingTask;
    this.pdfDocument = pdfDocument;
    this.sourceData = sourceData;
    const ownerDocument = options.host.ownerDocument;
    this.root = createElement(ownerDocument, "div", "hn-owned-pdf-viewer");
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "document");
    this.root.setAttribute("aria-label", options.file.name);
    this.toolbarHost = createElement(ownerDocument, "div", "hn-owned-pdf-toolbar-host");
    this.toolbarHost.setAttribute("role", "toolbar");
    this.toolbarHost.setAttribute("aria-label", "PDF navigation");
    this.scroll = createElement(ownerDocument, "div", "hn-owned-pdf-scroll");
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("role", "region");
    this.scroll.setAttribute("aria-label", "PDF pages");
    this.pageContainer = createElement(ownerDocument, "div", "hn-owned-pdf-pages");
    this.outlinePanel = createElement(ownerDocument, "aside", "hn-owned-pdf-outline");
    this.outlinePanel.hidden = true;
    this.outlinePanel.setAttribute("aria-label", "PDF outline");
    this.thumbnailPanel = createElement(ownerDocument, "aside", "hn-owned-pdf-thumbnails");
    this.thumbnailPanel.hidden = true;
    this.thumbnailPanel.setAttribute("aria-label", "PDF page thumbnails");
    this.pageIndicator = createElement(ownerDocument, "span", "hn-owned-pdf-page-indicator");
    this.pageNumberInput = createElement(ownerDocument, "input");
    this.pageNumberInput.type = "number";
    this.pageNumberInput.min = "1";
    this.pageNumberInput.max = String(this.pdfDocument.numPages);
    this.pageNumberInput.inputMode = "numeric";
    this.pageNumberInput.setAttribute("aria-label", "Page number");
    this.pageCountLabel = createElement(ownerDocument, "span");
    this.pageCountLabel.setAttribute("aria-hidden", "true");
    this.pageIndicator.append(this.pageNumberInput, " / ", this.pageCountLabel);
    this.zoomSelect = createElement(ownerDocument, "select");
    this.zoomSelect.setAttribute("aria-label", "Zoom");
    this.findBar = createElement(ownerDocument, "div", "hn-owned-pdf-find-bar");
    this.findInput = createElement(ownerDocument, "input");
    this.findInput.type = "search";
    this.findInput.placeholder = "Find in document";
    this.findInput.setAttribute("aria-label", "Find in document");
    this.findStatus = createElement(ownerDocument, "span", "hn-owned-pdf-find-status");
    this.findStatus.setAttribute("aria-live", "polite");
    this.findBar.append(this.findInput, this.findStatus);
    this.findBar.hidden = true;
    this.scroll.append(this.pageContainer);
    this.root.append(this.toolbarHost, this.outlinePanel, this.thumbnailPanel, this.scroll);
    options.host.replaceChildren(this.root);
    this.installControls(ownerDocument);
    this.installScrollTracking();
    this.installKeyboardNavigation();
    this.installHandToolInteraction();
    this.installIntersectionObserver();
    this.installResizeObserver();
  }

  static async create(options: PdfJsViewAdapterOptions): Promise<PdfJsViewAdapter> {
    const runtime = await loadPdfJsRuntime(options.app, options.pluginDir, options.runtime);
    const data = new Uint8Array(await options.app.vault.readBinary(options.file));
    const loadingTask = runtime.module.getDocument(pdfJsDocumentOptions(runtime.assets, data));
    let adapter: PdfJsViewAdapter | undefined;
    let pdfDocument: PdfJsDocumentProxy | undefined;
    try {
      pdfDocument = await loadingTask.promise;
      adapter = new PdfJsViewAdapter(options, loadingTask, pdfDocument, data);
      await adapter.initialize();
      return adapter;
    } catch (error) {
      if (adapter) adapter.destroy();
      else {
        await Promise.resolve(loadingTask.destroy?.()).catch(() => undefined);
        await Promise.resolve(pdfDocument?.destroy?.()).catch(() => undefined);
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    if (this.pdfDocument.numPages < 1) throw new Error("PDF document has no pages");
    const first = await this.pdfDocument.getPage(1);
    const viewport = first.getViewport({ scale: 1, rotation: this.rotation });
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    for (let pageNumber = 1; pageNumber <= this.pdfDocument.numPages; pageNumber += 1) {
      this.createPageShell(pageNumber, width, height);
    }
    const firstOwnedPage = this.pagesByNumber.get(1);
    if (firstOwnedPage) firstOwnedPage.page = first;
    await this.loadPage(1);
    const preloadPages = this.intersectionObserver
      ? [2, 3].filter((value) => value <= this.pdfDocument.numPages)
      : Array.from({ length: Math.min(8, this.pdfDocument.numPages) }, (_, index) => index + 1);
    for (const pageNumber of preloadPages) this.queuePageRender(pageNumber);
    await this.loadOutline();
    this.callbacks.onPagesChanged?.("pdfjs-document-ready");
    this.emitViewState("pages-dom");
  }

  private createPageShell(pageNumber: number, naturalWidth: number, naturalHeight: number): OwnedPage {
    const ownerDocument = this.root.ownerDocument;
    const shell = createElement(ownerDocument, "section", "hn-owned-pdf-page");
    shell.dataset.pageNumber = String(pageNumber);
    shell.setAttribute("aria-label", `Page ${pageNumber}`);
    shell.tabIndex = -1;
    const canvas = createElement(ownerDocument, "canvas", "hn-owned-pdf-canvas");
    const textLayer = createElement(ownerDocument, "div", "hn-owned-pdf-text-layer");
    const annotationLayer = createElement(ownerDocument, "div", "hn-owned-pdf-annotation-layer");
    annotationLayer.setAttribute("aria-label", `PDF annotations on page ${pageNumber}`);
    shell.append(canvas, textLayer, annotationLayer);
    const page: OwnedPage = {
      pageNumber,
      shell,
      canvas,
      textLayer,
      annotationLayer,
      naturalWidth,
      naturalHeight,
      renderTask: undefined,
      generation: 1,
      mountGeneration: 1,
      renderedAtScale: undefined,
      renderedAtRotation: undefined,
      renderQueued: false
    };
    this.pagesByNumber.set(pageNumber, page);
    this.pageContainer.append(shell);
    this.intersectionObserver?.observe(shell);
    setPixelSize(shell, naturalWidth * this.scale, naturalHeight * this.scale);
    if (pageNumber < this.pdfDocument.numPages) {
      const gap = createElement(ownerDocument, "div", "hn-owned-pdf-page-gap");
      gap.setAttribute("aria-hidden", "true");
      setElementCssProps(gap, { height: `${PAGE_GAP}px` });
      this.pageContainer.append(gap);
    }
    return page;
  }

  private installControls(ownerDocument: Document): void {
    const controls = createElement(ownerDocument, "div", "hn-owned-pdf-navigation");
    const zoomOptions: Array<[string, string]> = [
      ["Automatic", "auto"], ["50%", "0.5"], ["75%", "0.75"], ["100%", "1"],
      ["125%", "1.25"], ["150%", "1.5"], ["200%", "2"], ["300%", "3"], ["400%", "4"]
    ];
    for (const [label, value] of zoomOptions) {
      const option = createElement(ownerDocument, "option");
      option.textContent = label;
      option.value = value;
      this.zoomSelect.append(option);
    }
    const findButton = this.navigationButton(ownerDocument, "Find in document", "Find", () => this.toggleFindBar());
    const handButton = this.navigationButton(ownerDocument, "Hand tool", "Hand", () => this.toggleHandTool());
    controls.append(
      this.navigationButton(ownerDocument, "Previous page", "‹", () => this.focusPage(this.currentPageNumber - 1)),
      this.navigationButton(ownerDocument, "Next page", "›", () => this.focusPage(this.currentPageNumber + 1)),
      this.pageIndicator,
      this.zoomSelect,
      this.navigationButton(ownerDocument, "Zoom out", "−", () => this.setScale(this.scale / SCALE_STEP)),
      this.navigationButton(ownerDocument, "Zoom in", "+", () => this.setScale(this.scale * SCALE_STEP)),
      this.navigationButton(ownerDocument, "Fit page width", "Fit", () => this.fitWidth()),
      this.navigationButton(ownerDocument, "Rotate counterclockwise", "↶", () => this.setRotation(this.rotation - 90)),
      this.navigationButton(ownerDocument, "Rotate clockwise", "↷", () => this.setRotation(this.rotation + 90)),
      this.navigationButton(ownerDocument, "Toggle outline", "Outline", () => this.toggleSidebar("outline")),
      this.navigationButton(ownerDocument, "Toggle thumbnails", "Thumbs", () => this.toggleSidebar("thumbnails")),
      findButton,
      handButton,
      this.navigationButton(ownerDocument, "Presentation mode", "Present", () => this.togglePresentationMode()),
      this.navigationButton(ownerDocument, "Print PDF", "Print", () => this.printPdf()),
      this.navigationButton(ownerDocument, "Download PDF", "Download", () => this.downloadPdf())
    );
    const findPrevious = this.navigationButton(ownerDocument, "Previous match", "↑", () => this.moveFind(-1));
    const findNext = this.navigationButton(ownerDocument, "Next match", "↓", () => this.moveFind(1));
    const findClose = this.navigationButton(ownerDocument, "Close find bar", "×", () => this.toggleFindBar(false));
    this.findBar.append(findPrevious, findNext, findClose);
    this.toolbarHost.append(controls, this.findBar);
    const onPageChange = (): void => { this.focusPage(Number(this.pageNumberInput.value)); };
    const onPageKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter") { event.preventDefault(); onPageChange(); }
    };
    const onZoomChange = (): void => {
      const value = this.zoomSelect.value;
      if (value === "auto") this.fitWidth();
      else this.setScale(Number(value));
    };
    const onFindInput = (): void => { void this.findDocument(this.findInput.value); };
    this.pageNumberInput.addEventListener("change", onPageChange);
    this.pageNumberInput.addEventListener("keydown", onPageKeyDown);
    this.zoomSelect.addEventListener("change", onZoomChange);
    this.findInput.addEventListener("input", onFindInput);
    this.cleanups.push(
      () => this.pageNumberInput.removeEventListener("change", onPageChange),
      () => this.pageNumberInput.removeEventListener("keydown", onPageKeyDown),
      () => this.zoomSelect.removeEventListener("change", onZoomChange),
      () => this.findInput.removeEventListener("input", onFindInput)
    );
    this.updatePageIndicator();
    this.updateZoomControl();
  }

  private navigationButton(ownerDocument: Document, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = createElement(ownerDocument, "button");
    button.type = "button";
    button.textContent = text;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    this.cleanups.push(() => button.removeEventListener("click", onClick));
    return button;
  }

  private installScrollTracking(): void {
    const onScroll = (): void => { this.scheduleLayoutUpdate(); this.emitViewState("scroll"); };
    this.scroll.addEventListener("scroll", onScroll, { passive: true });
    this.cleanups.push(() => this.scroll.removeEventListener("scroll", onScroll));
  }

  private installKeyboardNavigation(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        this.toggleFindBar(true);
        return;
      }
      if (event.key === "Escape" && !this.findBar.hidden) {
        event.preventDefault();
        this.toggleFindBar(false);
        return;
      }
      if (event.key === "PageDown" || event.key === "ArrowDown") {
        event.preventDefault(); this.focusPage(Math.min(this.pdfDocument.numPages, this.currentPageNumber + 1));
      } else if (event.key === "PageUp" || event.key === "ArrowUp") {
        event.preventDefault(); this.focusPage(Math.max(1, this.currentPageNumber - 1));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault(); this.setScale(this.scale * SCALE_STEP);
      } else if (event.key === "-") {
        event.preventDefault(); this.setScale(this.scale / SCALE_STEP);
      }
    };
    this.root.addEventListener("keydown", onKeyDown);
    this.cleanups.push(() => this.root.removeEventListener("keydown", onKeyDown));
  }

  private installIntersectionObserver(): void {
    if (typeof IntersectionObserver !== "function") return;
    this.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (entry.isIntersecting || entry.intersectionRatio > 0) {
          this.visiblePages.add(pageNumber);
          this.queuePageRender(pageNumber);
        } else {
          this.visiblePages.delete(pageNumber);
        }
      }
      this.evictOffscreenPages();
    }, { root: this.scroll, rootMargin: "800px 0px" });
    this.cleanups.push(() => {
      this.intersectionObserver?.disconnect();
      this.visiblePages.clear();
    });
  }

  private installResizeObserver(): void {
    if (typeof ResizeObserver !== "function") return;
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.scroll);
    this.cleanups.push(() => this.resizeObserver?.disconnect());
  }

  private scheduleLayoutUpdate(): void {
    if (this.layoutFrame !== null) return;
    this.layoutFrame = this.root.ownerDocument.defaultView?.requestAnimationFrame(() => {
      this.layoutFrame = null;
      const top = this.scroll.getBoundingClientRect().top;
      let pageNumber = this.currentPageNumber;
      let distance = Number.POSITIVE_INFINITY;
      for (const page of this.pagesByNumber.values()) {
        const delta = Math.abs(page.shell.getBoundingClientRect().top - top);
        if (delta < distance) { distance = delta; pageNumber = page.pageNumber; }
      }
      if (pageNumber !== this.currentPageNumber) {
        this.currentPageNumber = pageNumber;
        this.updatePageIndicator();
        this.emitViewState("scroll");
      }
      for (const nearby of this.nearbyPages()) this.queuePageRender(nearby);
    }) ?? null;
  }

  private updatePageIndicator(): void {
    this.pageNumberInput.value = String(this.currentPageNumber);
    this.pageCountLabel.textContent = String(this.pdfDocument.numPages);
    this.pageIndicator.setAttribute("aria-label", `Page ${this.currentPageNumber} of ${this.pdfDocument.numPages}`);
  }

  private updateZoomControl(): void {
    const selected = this.currentScaleMode === "auto" ? "auto" : String(this.scale);
    const option = [...this.zoomSelect.options].find((candidate) => candidate.value === selected);
    this.zoomSelect.value = option ? selected : "auto";
  }

  private isAlive(generation = this.lifecycleGeneration): boolean {
    return !this.destroyed && generation === this.lifecycleGeneration;
  }

  private invalidatePage(page: OwnedPage): void {
    page.generation += 1;
    page.renderedAtScale = undefined;
    page.renderedAtRotation = undefined;
    page.renderTask?.cancel?.();
    page.renderTask = undefined;
    page.textLayer.replaceChildren();
    page.annotationLayer.replaceChildren();
  }

  private evictOffscreenPages(): void {
    const keep = new Set([...this.visiblePages, ...this.nearbyPages()]);
    for (const page of this.pagesByNumber.values()) {
      if (keep.has(page.pageNumber) || page.renderedAtScale === undefined) continue;
      page.renderedAtScale = undefined;
      page.renderedAtRotation = undefined;
      page.generation += 1;
      page.renderTask?.cancel?.();
      page.renderTask = undefined;
      page.textLayer.replaceChildren();
      page.annotationLayer.replaceChildren();
      page.canvas.width = 1;
      page.canvas.height = 1;
    }
  }

  private queuePageRender(pageNumber: number): void {
    void this.loadPage(pageNumber).catch((error: unknown) => {
      if (this.destroyed || (error instanceof Error && /cancel/i.test(error.message))) return;
      this.callbacks.onDebugLog?.("warn", "pdfjs-page-render-failed", {
        pageNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async loadPage(pageNumber: number): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    if (!this.isAlive(lifecycleGeneration)) return;
    const page = this.pagesByNumber.get(pageNumber);
    if (!page || page.renderQueued || (page.renderedAtScale === this.scale && page.renderedAtRotation === this.rotation)) return;
    const pending = this.pendingRenders.get(pageNumber);
    if (pending) return pending;
    page.renderQueued = true;
    let task: PdfJsRenderTask | undefined;
    let work!: Promise<void>;
    work = (async () => {
      const generation = page.generation;
      try {
        if (!this.isAlive(lifecycleGeneration)) return;
        if (!page.page) page.page = await this.pdfDocument.getPage(pageNumber);
        if (!this.isAlive(lifecycleGeneration) || generation !== page.generation) return;
        const canonicalViewport = page.page.getViewport({ scale: 1, rotation: 0 });
        const viewport = page.page.getViewport({ scale: this.scale, rotation: this.rotation });
        page.viewport = viewport;
        page.naturalWidth = Math.max(1, canonicalViewport.width);
        page.naturalHeight = Math.max(1, canonicalViewport.height);
        setPixelSize(page.shell, viewport.width, viewport.height);
        const dpr = Math.max(1, Math.min(3, this.root.ownerDocument.defaultView?.devicePixelRatio ?? 1));
        page.canvas.width = Math.max(1, Math.ceil(viewport.width * dpr));
        page.canvas.height = Math.max(1, Math.ceil(viewport.height * dpr));
        setElementCssProps(page.canvas, { width: `${viewport.width}px`, height: `${viewport.height}px` });
        const context = page.canvas.getContext("2d");
        if (!context) throw new Error(`PDF.js canvas context unavailable for page ${pageNumber}`);
        if (!this.isAlive(lifecycleGeneration) || generation !== page.generation) return;
        task = dpr === 1
          ? page.page.render({ canvasContext: context, viewport })
          : page.page.render({ canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
        page.renderTask = task;
        await task.promise;
        if (!this.isAlive(lifecycleGeneration) || generation !== page.generation || page.viewport !== viewport) return;
        await this.renderTextLayer(page, viewport, generation);
        await this.renderAnnotationLayer(page, viewport, generation);
        if (!this.isAlive(lifecycleGeneration) || generation !== page.generation) return;
        page.renderedAtScale = this.scale;
        page.renderedAtRotation = this.rotation;
        this.callbacks.onPageLifecycleChange?.({
          kind: "render", viewerGeneration: this.viewerGeneration, pageNumbers: [pageNumber],
          mountGenerations: { [String(pageNumber)]: page.mountGeneration }, signalAt: Date.now()
        });
        this.evictOffscreenPages();
      } finally {
        const current = this.pendingRenders.get(pageNumber) === work;
        if (page.renderTask === task) page.renderTask = undefined;
        if (current) {
          page.renderQueued = false;
          this.pendingRenders.delete(pageNumber);
          if (this.isAlive(lifecycleGeneration)
            && (page.renderedAtScale !== this.scale || page.renderedAtRotation !== this.rotation)) {
            this.queuePageRender(pageNumber);
          }
        }
      }
    })();
    this.pendingRenders.set(pageNumber, work);
    return work;
  }

  private async renderTextLayer(page: OwnedPage, viewport: PdfJsViewport, generation: number): Promise<void> {
    page.textLayer.replaceChildren();
    const content = await this.getTextContent(page.pageNumber);
    if (this.destroyed || generation !== page.generation || !content.items) return;
    for (const item of content.items.slice(0, MAX_TEXT_ITEMS)) {
      const text = item.str?.trim();
      const transform = transformForText(item);
      if (!text || !transform) continue;
      const [x, y] = viewportPoint(viewport, transform[4] ?? 0, transform[5] ?? 0);
      const fontHeight = Math.max(1, Math.hypot(transform[2] ?? 0, transform[3] ?? 0) * this.scale);
      const span = createElement(page.textLayer.ownerDocument, "span");
      span.textContent = text;
      setElementCssProps(span, {
        left: `${x}px`, top: `${y - fontHeight}px`, fontSize: `${fontHeight}px`,
        fontFamily: "sans-serif", lineHeight: "1"
      });
      span.dataset.hnTextItem = "true";
      page.textLayer.append(span);
    }
    if (this.findInput.value.trim()) this.applyFindHighlights(this.findInput.value, page.pageNumber);
  }

  private async renderAnnotationLayer(page: OwnedPage, viewport: PdfJsViewport, generation: number): Promise<void> {
    page.annotationLayer.replaceChildren();
    const annotations = await page.page?.getAnnotations?.({ intent: "display" });
    if (this.destroyed || generation !== page.generation || !annotations) return;
    for (const annotation of annotations.slice(0, MAX_ANNOTATIONS)) {
      if (!annotation.rect || annotation.rect.length < 4) continue;
      const rect = viewportRect(viewport, annotation.rect);
      const left = Math.min(rect[0], rect[2]);
      const top = Math.min(rect[1], rect[3]);
      const width = Math.max(1, Math.abs(rect[2] - rect[0]));
      const height = Math.max(1, Math.abs(rect[3] - rect[1]));
      const url = safeUrl(
        annotation.url ?? annotation.unsafeUrl,
        page.annotationLayer.ownerDocument.defaultView?.location.href ?? "about:blank"
      );
      const element = url ? createElement(page.annotationLayer.ownerDocument, "a") : createElement(page.annotationLayer.ownerDocument, "div");
      if (url && element instanceof HTMLAnchorElement) {
        element.href = url; element.target = "_blank"; element.rel = "noopener noreferrer";
      }
      element.className = "hn-owned-pdf-annotation";
      setElementCssProps(element, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      element.setAttribute("aria-label", annotation.title || annotation.contents || annotation.fieldName || "PDF annotation");
      page.annotationLayer.append(element);
    }
  }

  private toggleSidebar(mode: "outline" | "thumbnails"): void {
    const panel = mode === "outline" ? this.outlinePanel : this.thumbnailPanel;
    const other = mode === "outline" ? this.thumbnailPanel : this.outlinePanel;
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    other.hidden = true;
    panel.hidden = false;
    if (mode === "thumbnails" && panel.childElementCount === 0) this.loadThumbnails();
  }

  private loadThumbnails(): void {
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    this.thumbnailQueued.clear();
    this.thumbnailRendered.clear();
    const ownerDocument = this.thumbnailPanel.ownerDocument;
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
          const canvas = entry.target.querySelector("canvas");
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (canvas instanceof HTMLCanvasElement && Number.isInteger(pageNumber)) this.queueThumbnailRender(pageNumber, canvas);
        }
      }, { root: this.thumbnailPanel, rootMargin: "400px 0px" })
      : null;
    this.thumbnailObserver = observer;
    for (let pageNumber = 1; pageNumber <= this.pdfDocument.numPages; pageNumber += 1) {
      const button = createElement(ownerDocument, "button", "hn-owned-pdf-thumbnail");
      button.type = "button";
      button.dataset.pageNumber = String(pageNumber);
      button.setAttribute("aria-label", `Go to page ${pageNumber}`);
      const canvas = createElement(ownerDocument, "canvas");
      const label = createElement(ownerDocument, "span");
      label.textContent = String(pageNumber);
      button.append(canvas, label);
      button.addEventListener("click", () => this.focusPage(pageNumber));
      this.thumbnailPanel.append(button);
      if (observer) observer.observe(button);
      else if (pageNumber <= THUMBNAIL_FALLBACK_PRELOAD) this.queueThumbnailRender(pageNumber, canvas);
    }
  }

  private queueThumbnailRender(pageNumber: number, canvas: HTMLCanvasElement): void {
    const lifecycleGeneration = this.lifecycleGeneration;
    const thumbnailGeneration = this.thumbnailGeneration;
    if (this.thumbnailQueued.has(pageNumber) || this.thumbnailRendered.has(pageNumber)) return;
    this.thumbnailQueued.add(pageNumber);
    void (async () => {
      let rendered = false;
      try {
        const page = this.pagesByNumber.get(pageNumber);
        if (!page || !this.isAlive(lifecycleGeneration) || thumbnailGeneration !== this.thumbnailGeneration) return;
        if (!page.page) page.page = await this.pdfDocument.getPage(pageNumber);
        if (!this.isAlive(lifecycleGeneration) || thumbnailGeneration !== this.thumbnailGeneration) return;
        const viewport = page.page.getViewport({ scale: 0.16, rotation: this.rotation });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        setElementCssProps(canvas, { width: `${viewport.width}px`, height: `${viewport.height}px` });
        const context = canvas.getContext("2d");
        if (!context || !this.isAlive(lifecycleGeneration) || thumbnailGeneration !== this.thumbnailGeneration) return;
        const task = page.page.render({ canvasContext: context, viewport });
        this.thumbnailTasks.add(task);
        try {
          await task.promise;
          rendered = true;
        } finally {
          this.thumbnailTasks.delete(task);
        }
      } finally {
        if (thumbnailGeneration === this.thumbnailGeneration) {
          this.thumbnailQueued.delete(pageNumber);
          if (rendered) this.thumbnailRendered.add(pageNumber);
        }
      }
    })().catch((error: unknown) => {
      if (!this.destroyed && !(error instanceof Error && /cancel/i.test(error.message))) {
        this.callbacks.onDebugLog?.("warn", "pdfjs-thumbnail-failed", { pageNumber, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private async loadOutline(): Promise<void> {
    let outline: readonly unknown[] | null = null;
    try { outline = this.pdfDocument.getOutline ? await this.pdfDocument.getOutline() : null; } catch { outline = null; }
    if (!outline?.length) return;
    const list = createElement(this.outlinePanel.ownerDocument, "ol");
    for (const entry of outline.slice(0, 500)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { title?: unknown; dest?: unknown };
      const button = createElement(this.outlinePanel.ownerDocument, "button");
      button.type = "button";
      button.textContent = typeof item.title === "string" ? item.title : "Untitled";
      button.addEventListener("click", () => {
        const page = Array.isArray(item.dest) && typeof item.dest[0] === "number" ? item.dest[0] + 1 : undefined;
        if (page) this.focusPage(page);
      });
      const listItem = createElement(this.outlinePanel.ownerDocument, "li");
      listItem.append(button); list.append(listItem);
    }
    this.outlinePanel.replaceChildren(list);
  }

  private nearbyPages(): number[] {
    const result = new Set<number>([this.currentPageNumber]);
    for (let offset = 1; offset <= RENDER_NEIGHBOR_RADIUS; offset += 1) {
      if (this.currentPageNumber - offset >= 1) result.add(this.currentPageNumber - offset);
      if (this.currentPageNumber + offset <= this.pdfDocument.numPages) result.add(this.currentPageNumber + offset);
    }
    return [...result];
  }

  private setScale(next: number, mode: string | number = "manual"): void {
    const previous = this.scale;
    this.scale = clampScale(next);
    this.currentScaleMode = mode;
    if (Math.abs(previous - this.scale) < 0.001) {
      this.updateZoomControl();
      return;
    }
    const centerX = this.scroll.scrollLeft + this.scroll.clientWidth / 2;
    const centerY = this.scroll.scrollTop + this.scroll.clientHeight / 2;
    const ratio = this.scale / previous;
    this.scroll.scrollLeft = centerX * ratio - this.scroll.clientWidth / 2;
    this.scroll.scrollTop = centerY * ratio - this.scroll.clientHeight / 2;
    for (const page of this.pagesByNumber.values()) {
      this.invalidatePage(page);
      setPixelSize(page.shell, this.displayWidth(page) * this.scale, this.displayHeight(page) * this.scale);
    }
    this.updateZoomControl();
    this.callbacks.onZoomChange?.({ phase: "begin", scale: this.scale, source: "geometry", viewerGeneration: this.viewerGeneration });
    for (const page of this.nearbyPages()) this.queuePageRender(page);
    if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      this.zoomTimer = null;
      if (!this.destroyed) this.callbacks.onZoomChange?.({ phase: "settled", scale: this.scale, source: "geometry", viewerGeneration: this.viewerGeneration });
    }, 120);
    this.emitViewState("scalechanging");
  }

  private fitWidth(): void {
    const page = this.pagesByNumber.get(this.currentPageNumber);
    if (!page || page.naturalWidth <= 0) return;
    this.setScale((this.scroll.clientWidth - 32) / this.displayWidth(page), "auto");
  }

  private displayWidth(page: OwnedPage): number {
    return this.rotation % 180 === 0 ? page.naturalWidth : page.naturalHeight;
  }

  private displayHeight(page: OwnedPage): number {
    return this.rotation % 180 === 0 ? page.naturalHeight : page.naturalWidth;
  }

  private setRotation(nextRotation: number): void {
    const next = normalizeRotation(nextRotation);
    if (next === this.rotation) return;
    this.rotation = next;
    for (const page of this.pagesByNumber.values()) {
      this.invalidatePage(page);
      setPixelSize(page.shell, this.displayWidth(page) * this.scale, this.displayHeight(page) * this.scale);
    }
    this.thumbnailGeneration += 1;
    for (const task of this.thumbnailTasks) task.cancel?.();
    this.thumbnailTasks.clear();
    if (!this.thumbnailPanel.hidden) {
      this.thumbnailPanel.replaceChildren();
      this.loadThumbnails();
    }
    this.callbacks.onPagesChanged?.("rotationchanging");
    this.emitViewState("rotationchanging");
    for (const pageNumber of this.nearbyPages()) this.queuePageRender(pageNumber);
  }

  private toggleFindBar(force?: boolean): void {
    this.findBar.hidden = force === undefined ? !this.findBar.hidden : !force;
    if (!this.findBar.hidden) {
      this.findInput.focus();
      this.findInput.select();
    } else {
      this.clearFindHighlights();
    }
  }

  private trimTextContentCache(): void {
    const protectedPages = new Set([...this.visiblePages, this.currentPageNumber]);
    for (const [pageNumber] of this.textContentByPage) {
      if (this.textContentByPage.size <= MAX_TEXT_CONTENT_CACHE_PAGES) break;
      if (protectedPages.has(pageNumber)) continue;
      this.textContentByPage.delete(pageNumber);
    }
  }

  private async getTextContent(pageNumber: number): Promise<{ items?: readonly PdfJsTextItem[] }> {
    const cached = this.textContentByPage.get(pageNumber);
    if (cached) return cached;
    const pending = (async () => {
      const page = this.pagesByNumber.get(pageNumber);
      if (!page) return {};
      if (!page.page) page.page = await this.pdfDocument.getPage(pageNumber);
      return await page.page.getTextContent?.() ?? {};
    })();
    this.textContentByPage.set(pageNumber, pending);
    void pending.then(
      () => this.trimTextContentCache(),
      () => { if (this.textContentByPage.get(pageNumber) === pending) this.textContentByPage.delete(pageNumber); }
    );
    return pending;
  }

  private applyFindHighlights(query: string, pageNumber?: number): void {
    const pages = pageNumber === undefined
      ? this.pagesByNumber.values()
      : [this.pagesByNumber.get(pageNumber)].filter((page): page is OwnedPage => Boolean(page));
    const normalized = normalizeFindText(query);
    for (const page of pages) {
      const spans = [...page.textLayer.querySelectorAll("span")];
      if (!normalized) {
        for (const span of spans) span.classList.remove("is-find-match");
        continue;
      }
      let text = "";
      const ranges: Array<{ span: HTMLSpanElement; start: number; end: number }> = [];
      for (const span of spans) {
        const spanText = normalizeFindText(span.textContent ?? "");
        if (!spanText) continue;
        if (text) text += " ";
        const start = text.length;
        text += spanText;
        ranges.push({ span, start, end: text.length });
      }
      const searchable = text;
      const matchRanges: Array<{ start: number; end: number }> = [];
      let offset = searchable.indexOf(normalized);
      while (offset >= 0) {
        matchRanges.push({ start: offset, end: offset + normalized.length });
        offset = searchable.indexOf(normalized, offset + normalized.length);
      }
      for (const range of ranges) {
        const matches = matchRanges.some((match) => match.start < range.end && match.end > range.start);
        range.span.classList.toggle("is-find-match", matches);
      }
    }
  }

  private clearFindHighlights(): void {
    this.findGeneration += 1;
    this.findMatches = [];
    this.findIndex = -1;
    this.applyFindHighlights("");
    this.findStatus.textContent = "";
  }

  private async findDocument(query: string): Promise<void> {
    const normalized = normalizeFindText(query);
    const generation = ++this.findGeneration;
    const lifecycleGeneration = this.lifecycleGeneration;
    if (!normalized) {
      this.clearFindHighlights();
      return;
    }
    this.findStatus.textContent = "Searching…";
    const matches: Array<{ pageNumber: number; offset: number }> = [];
    try {
      for (let pageNumber = 1; pageNumber <= this.pdfDocument.numPages; pageNumber += 1) {
        const content = await this.getTextContent(pageNumber);
        if (!this.isAlive(lifecycleGeneration) || generation !== this.findGeneration) return;
        const text = (content.items ?? [])
          .slice(0, MAX_TEXT_ITEMS)
          .map((item) => normalizeFindText(item.str ?? ""))
          .filter(Boolean)
          .join(" ");
        let offset = text.indexOf(normalized);
        while (offset >= 0) {
          matches.push({ pageNumber, offset });
          offset = text.indexOf(normalized, offset + normalized.length);
        }
      }
    } catch (error) {
      if (this.isAlive(lifecycleGeneration) && generation === this.findGeneration) {
        this.findStatus.textContent = "Search unavailable";
        this.callbacks.onDebugLog?.("warn", "pdfjs-find-failed", { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (!this.isAlive(lifecycleGeneration) || generation !== this.findGeneration) return;
    this.findMatches = matches;
    this.findIndex = matches.length > 0 ? 0 : -1;
    this.applyFindHighlights(query);
    this.findStatus.textContent = matches.length === 0 ? "No matches" : `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    if (this.findIndex >= 0) this.focusPage(matches[this.findIndex]!.pageNumber);
  }

  private moveFind(direction: -1 | 1): void {
    if (this.findMatches.length === 0) return;
    this.findIndex = (this.findIndex + direction + this.findMatches.length) % this.findMatches.length;
    const match = this.findMatches[this.findIndex];
    if (match) this.focusPage(match.pageNumber);
  }

  private installHandToolInteraction(): void {
    const onPointerDown = (event: PointerEvent): void => {
      if (!this.handToolActive || event.button !== 0 || event.isPrimary === false) return;
      this.handPointerId = event.pointerId;
      this.handStartX = event.clientX;
      this.handStartY = event.clientY;
      this.handScrollLeft = this.scroll.scrollLeft;
      this.handScrollTop = this.scroll.scrollTop;
      this.scroll.setPointerCapture?.(event.pointerId);
      setElementCssProps(this.scroll, { cursor: "grabbing" });
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.handToolActive || this.handPointerId !== event.pointerId) return;
      this.scroll.scrollLeft = this.handScrollLeft - (event.clientX - this.handStartX);
      this.scroll.scrollTop = this.handScrollTop - (event.clientY - this.handStartY);
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (this.handPointerId !== event.pointerId) return;
      this.handPointerId = null;
      this.scroll.releasePointerCapture?.(event.pointerId);
      setElementCssProps(this.scroll, { cursor: this.handToolActive ? "grab" : "auto" });
    };
    this.scroll.addEventListener("pointerdown", onPointerDown, true);
    this.scroll.addEventListener("pointermove", onPointerMove, true);
    this.scroll.addEventListener("pointerup", onPointerUp, true);
    this.scroll.addEventListener("pointercancel", onPointerUp, true);
    this.cleanups.push(
      () => this.scroll.removeEventListener("pointerdown", onPointerDown, true),
      () => this.scroll.removeEventListener("pointermove", onPointerMove, true),
      () => this.scroll.removeEventListener("pointerup", onPointerUp, true),
      () => this.scroll.removeEventListener("pointercancel", onPointerUp, true)
    );
  }

  private toggleHandTool(): void {
    this.handToolActive = !this.handToolActive;
    this.root.classList.toggle("is-hand-tool", this.handToolActive);
    setElementCssProps(this.scroll, { cursor: this.handToolActive ? "grab" : "auto" });
  }

  private togglePresentationMode(): void {
    const ownerDocument = this.root.ownerDocument;
    if (ownerDocument.fullscreenElement) {
      void ownerDocument.exitFullscreen?.();
      return;
    }
    const request = this.root.requestFullscreen?.();
    if (request !== undefined) void request.catch((error: unknown) => {
      this.callbacks.onDebugLog?.("warn", "pdfjs-presentation-failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private downloadPdf(): void {
    const ownerDocument = this.root.ownerDocument;
    const urlApi = ownerDocument.defaultView?.URL;
    if (!urlApi?.createObjectURL) {
      this.callbacks.onDebugLog?.("warn", "pdfjs-download-unavailable", { reason: "object-url-api-missing" });
      return;
    }
    const url = urlApi.createObjectURL(new Blob([this.sourceData], { type: "application/pdf" }));
    const link = createElement(ownerDocument, "a");
    link.href = url;
    link.download = this.fileName || "document.pdf";
    ownerDocument.body?.append(link);
    link.click();
    link.remove();
    urlApi.revokeObjectURL(url);
  }

  private printPdf(): void {
    const ownerDocument = this.root.ownerDocument;
    const view = ownerDocument.defaultView;
    const urlApi = view?.URL;
    if (!view || !urlApi?.createObjectURL) {
      this.callbacks.onDebugLog?.("warn", "pdfjs-print-unavailable", { reason: "object-url-api-missing" });
      return;
    }
    const frame = createElement(ownerDocument, "iframe");
    const url = urlApi.createObjectURL(new Blob([this.sourceData], { type: "application/pdf" }));
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      frame.remove();
      urlApi.revokeObjectURL(url);
    };
    const cleanupTimer = view.setTimeout(cleanup, 10_000);
    frame.title = "PDF print preview";
    setElementCssProps(frame, { position: "fixed", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    frame.src = url;
    frame.addEventListener("load", () => {
      view.clearTimeout(cleanupTimer);
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      view.setTimeout(cleanup, 1_000);
    }, { once: true });
    frame.addEventListener("error", cleanup, { once: true });
    ownerDocument.body?.append(frame);
  }

  private emitViewState(source: "scroll" | "scalechanging" | "rotationchanging" | "pages-dom"): void {
    this.callbacks.onViewStateChange?.(this.getViewState(), source);
  }

  pages(): PdfPageInfo[] { return [...this.pagesByNumber.values()].map((page) => this.pageInfo(page)); }
  page(pageNumber: number): PdfPageInfo | undefined {
    const page = this.pagesByNumber.get(pageNumber);
    return page ? this.pageInfo(page) : undefined;
  }
  pageMountGeneration(pageNumber: number): number { return this.pagesByNumber.get(pageNumber)?.mountGeneration ?? 0; }

  private pageInfo(page: OwnedPage): PdfPageInfo {
    return {
      pageNumber: page.pageNumber,
      width: Math.max(1, page.naturalWidth),
      height: Math.max(1, page.naturalHeight),
      scale: this.scale,
      rotation: this.rotation,
      coordinateOrigin: "bottom-left",
      element: page.shell,
      mountGeneration: page.mountGeneration,
      geometryConfidence: page.viewport ? "authoritative" : "derived",
      geometrySafe: page.shell.isConnected && Boolean(page.viewport),
      identityConfidence: "authoritative",
      identitySafe: true,
      candidateCount: 1
    };
  }

  getViewState(): AnnotationViewState {
    const maxScroll = Math.max(1, this.scroll.scrollHeight - this.scroll.clientHeight);
    return {
      pageNumber: this.currentPageNumber,
      scrollFraction: Math.max(0, Math.min(1, this.scroll.scrollTop / maxScroll)),
      scale: this.scale,
      rotation: this.rotation,
      scaleMode: this.currentScaleMode
    };
  }

  restoreViewState(state: AnnotationViewState): void {
    const rotation = normalizeRotation(state.rotation);
    if (rotation !== this.rotation) this.setRotation(rotation);
    const mode = state.scaleMode ?? "auto";
    if (Number.isFinite(state.scale) && state.scale > 0) this.setScale(state.scale, mode);
    else { this.currentScaleMode = mode; this.updateZoomControl(); }
    this.currentPageNumber = Math.max(1, Math.min(this.pdfDocument.numPages, Math.round(state.pageNumber || 1)));
    const maxScroll = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
    this.scroll.scrollTop = maxScroll * Math.max(0, Math.min(1, state.scrollFraction));
    this.updatePageIndicator();
    this.queuePageRender(this.currentPageNumber);
  }

  focusPage(pageNumber: number): boolean {
    const page = this.pagesByNumber.get(pageNumber);
    if (!page) return false;
    this.currentPageNumber = pageNumber;
    page.shell.scrollIntoView?.({ block: "start" });
    this.updatePageIndicator();
    this.queuePageRender(pageNumber);
    this.emitViewState("scroll");
    return true;
  }

  onResize(): void {
    if (this.destroyed) return;
    if (this.currentScaleMode === "auto") this.fitWidth();
    else this.scheduleLayoutUpdate();
  }

  scrollElement(): HTMLElement { return this.scroll; }

  mountOverlay(pageNumber: number): HTMLElement {
    const page = this.pagesByNumber.get(pageNumber);
    if (!page) throw new Error(`Cannot mount annotation overlay: PDF page ${pageNumber} is unavailable`);
    setElementCssProps(page.shell, { position: "relative" });
    const overlay = createElement(page.shell.ownerDocument, "div", "native-pdf-handwriting-page-overlay");
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.dataset.focusOverlayInternal = "true";
    setElementCssProps(overlay, { position: "absolute", inset: "0", pointerEvents: "none" });
    page.shell.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  mountToolbar(toolbar: HTMLElement, placement: ToolbarPlacement = "main"): void {
    for (const node of this.root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-rail")) node.remove();
    toolbar.classList.add("native-pdf-handwriting-toolbar");
    toolbar.classList.toggle("is-sidebar-left", placement === "left");
    toolbar.classList.toggle("is-sidebar-right", placement === "right");
    if (placement === "main") this.toolbarHost.append(toolbar);
    else {
      const rail = createElement(this.root.ownerDocument, "div", `hn-owned-pdf-ink-rail is-${placement}`);
      rail.append(toolbar); this.root.append(rail);
    }
    this.mounted.add(toolbar);
  }

  nativeTextLayer(pageNumber: number): HTMLElement | null { return this.pagesByNumber.get(pageNumber)?.textLayer ?? null; }

  compatibilityReport(): { errors: string[]; warnings: string[]; profile?: PdfIntegrationProfile } {
    return {
      errors: [], warnings: [], profile: {
        schemaVersion: 1, adapter: "direct", status: "supported", viewerGeneration: this.viewerGeneration,
        strategies: {
          viewerRoot: "plugin-owned", pages: "pdfjs-document", scrollRoot: "plugin-owned",
          scale: "pdfjs-viewport", zoomEvents: "plugin-owned", pageLifecycle: "generation-guarded", sidebar: "plugin-outline"
        },
        capabilities: { viewerRoot: true, pageIdentity: true, geometry: true, scrollRoot: true, privateViewer: false, eventBus: false, readableScale: true, pageLifecycle: true, viewerReplacement: true, sidebar: true, embedded: false },
        counters: { rebinds: 0, viewerReplacements: 0, pageReplacements: 0, fallbackUses: 0, attachRetries: 0 },
        failedProbes: [], warnings: []
      }
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.lifecycleGeneration += 1;
    this.findGeneration += 1;
    this.thumbnailGeneration += 1;
    this.destroyed = true;
    const view = this.root.ownerDocument.defaultView;
    if (this.zoomTimer !== null) (view?.clearTimeout ?? window.clearTimeout)(this.zoomTimer);
    if (this.layoutFrame !== null) view?.cancelAnimationFrame(this.layoutFrame);
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    this.thumbnailQueued.clear();
    this.thumbnailRendered.clear();
    for (const task of this.thumbnailTasks) task.cancel?.();
    this.thumbnailTasks.clear();
    for (const page of this.pagesByNumber.values()) { page.renderTask?.cancel?.(); page.page?.cleanup?.(); }
    this.pendingRenders.clear();
    this.textContentByPage.clear();
    this.visiblePages.clear();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    void this.pdfDocument.cleanup?.();
    void this.pdfDocument.destroy?.();
    void this.loadingTask.destroy?.();
    this.mounted.clear();
    this.root.remove();
  }
}

