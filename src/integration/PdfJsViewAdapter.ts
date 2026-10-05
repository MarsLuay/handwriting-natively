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

function clampScale(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, value)) : DEFAULT_SCALE;
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

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, window.location.href);
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
  private readonly pdfDocument: PdfJsDocumentProxy;
  private readonly loadingTask: { destroy?(): Promise<void> | void };
  private readonly pagesByNumber = new Map<number, OwnedPage>();
  private readonly mounted = new Set<HTMLElement>();
  private readonly cleanups: Array<() => void> = [];
  private readonly pendingRenders = new Map<number, Promise<void>>();
  private intersectionObserver: IntersectionObserver | null = null;
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
  private readonly outlinePanel: HTMLElement;

  private constructor(
    options: PdfJsViewAdapterOptions,
    loadingTask: { destroy?(): Promise<void> | void },
    pdfDocument: PdfJsDocumentProxy
  ) {
    this.host = options.host;
    this.callbacks = options.callbacks ?? {};
    this.loadingTask = loadingTask;
    this.pdfDocument = pdfDocument;
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
    this.pageIndicator = createElement(ownerDocument, "span", "hn-owned-pdf-page-indicator");
    this.scroll.append(this.pageContainer);
    this.root.append(this.toolbarHost, this.outlinePanel, this.scroll);
    options.host.replaceChildren(this.root);
    this.installControls(ownerDocument);
    this.installScrollTracking();
    this.installKeyboardNavigation();
    this.installIntersectionObserver();
  }

  static async create(options: PdfJsViewAdapterOptions): Promise<PdfJsViewAdapter> {
    const runtime = await loadPdfJsRuntime(options.app, options.pluginDir, options.runtime);
    const data = new Uint8Array(await options.app.vault.readBinary(options.file));
    const loadingTask = runtime.module.getDocument(pdfJsDocumentOptions(runtime.assets, data));
    const pdfDocument = await loadingTask.promise;
    const adapter = new PdfJsViewAdapter(options, loadingTask, pdfDocument);
    await adapter.initialize();
    return adapter;
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
    await this.loadPage(1);
    for (const pageNumber of [2, 3].filter((value) => value <= this.pdfDocument.numPages)) this.queuePageRender(pageNumber);
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
    controls.append(
      this.navigationButton(ownerDocument, "Previous page", "‹", () => this.focusPage(this.currentPageNumber - 1)),
      this.navigationButton(ownerDocument, "Next page", "›", () => this.focusPage(this.currentPageNumber + 1)),
      this.pageIndicator,
      this.navigationButton(ownerDocument, "Zoom out", "−", () => this.setScale(this.scale / SCALE_STEP)),
      this.navigationButton(ownerDocument, "Zoom in", "+", () => this.setScale(this.scale * SCALE_STEP)),
      this.navigationButton(ownerDocument, "Fit page width", "Fit", () => this.fitWidth()),
      this.navigationButton(ownerDocument, "Toggle outline", "Outline", () => { this.outlinePanel.hidden = !this.outlinePanel.hidden; })
    );
    this.toolbarHost.append(controls);
    this.updatePageIndicator();
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
        if (entry.isIntersecting || entry.intersectionRatio > 0) this.queuePageRender(pageNumber);
      }
    }, { root: this.scroll, rootMargin: "800px 0px" });
    this.cleanups.push(() => this.intersectionObserver?.disconnect());
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
    this.pageIndicator.textContent = `${this.currentPageNumber} / ${this.pdfDocument.numPages}`;
    this.pageIndicator.setAttribute("aria-label", `Page ${this.currentPageNumber} of ${this.pdfDocument.numPages}`);
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
    if (this.destroyed) return;
    const page = this.pagesByNumber.get(pageNumber);
    if (!page || page.renderQueued || page.renderedAtScale === this.scale) return;
    const pending = this.pendingRenders.get(pageNumber);
    if (pending) return pending;
    page.renderQueued = true;
    const work = (async () => {
      try {
        if (!page.page) page.page = await this.pdfDocument.getPage(pageNumber);
        const viewport = page.page.getViewport({ scale: this.scale, rotation: this.rotation });
        page.viewport = viewport;
        page.naturalWidth = Math.max(1, viewport.width / this.scale);
        page.naturalHeight = Math.max(1, viewport.height / this.scale);
        setPixelSize(page.shell, viewport.width, viewport.height);
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        page.canvas.width = Math.max(1, Math.ceil(viewport.width * dpr));
        page.canvas.height = Math.max(1, Math.ceil(viewport.height * dpr));
        setElementCssProps(page.canvas, { width: `${viewport.width}px`, height: `${viewport.height}px` });
        const context = page.canvas.getContext("2d");
        if (!context) throw new Error(`PDF.js canvas context unavailable for page ${pageNumber}`);
        page.renderTask?.cancel?.();
        const generation = page.generation;
        const task = page.page.render({ canvasContext: context, viewport });
        page.renderTask = task;
        await task.promise;
        if (this.destroyed || generation !== page.generation || page.viewport !== viewport) return;
        await this.renderTextLayer(page, viewport, generation);
        await this.renderAnnotationLayer(page, viewport, generation);
        page.renderedAtScale = this.scale;
        this.callbacks.onPageLifecycleChange?.({
          kind: "render", viewerGeneration: this.viewerGeneration, pageNumbers: [pageNumber],
          mountGenerations: { [String(pageNumber)]: page.mountGeneration }, signalAt: Date.now()
        });
      } finally {
        page.renderTask = undefined;
        page.renderQueued = false;
        this.pendingRenders.delete(pageNumber);
      }
    })();
    this.pendingRenders.set(pageNumber, work);
    return work;
  }

  private async renderTextLayer(page: OwnedPage, viewport: PdfJsViewport, generation: number): Promise<void> {
    page.textLayer.replaceChildren();
    const content = await page.page?.getTextContent?.();
    if (this.destroyed || generation !== page.generation || !content?.items) return;
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
      page.textLayer.append(span);
    }
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
      const url = safeUrl(annotation.url ?? annotation.unsafeUrl);
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

  private setScale(next: number): void {
    const previous = this.scale;
    this.scale = clampScale(next);
    if (Math.abs(previous - this.scale) < 0.001) return;
    const center = this.scroll.scrollTop + this.scroll.clientHeight / 2;
    const ratio = this.scale / previous;
    this.scroll.scrollTop = center * ratio - this.scroll.clientHeight / 2;
    for (const page of this.pagesByNumber.values()) {
      page.generation += 1;
      page.renderedAtScale = undefined;
      page.renderTask?.cancel?.();
      page.renderTask = undefined;
      page.textLayer.replaceChildren();
      page.annotationLayer.replaceChildren();
      setPixelSize(page.shell, page.naturalWidth * this.scale, page.naturalHeight * this.scale);
    }
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
    this.setScale(Math.max(1, this.scroll.clientWidth - 32) / page.naturalWidth);
  }

  private emitViewState(source: "scroll" | "scalechanging" | "pages-dom"): void {
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
    if (Number.isFinite(state.scale) && state.scale > 0) this.setScale(state.scale);
    this.rotation = normalizeRotation(state.rotation);
    this.currentPageNumber = Math.max(1, Math.min(this.pdfDocument.numPages, Math.round(state.pageNumber || 1)));
    this.currentScaleMode = state.scaleMode ?? "auto";
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
    this.destroyed = true;
    if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
    if (this.layoutFrame !== null) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.layoutFrame);
    this.intersectionObserver?.disconnect();
    for (const page of this.pagesByNumber.values()) { page.renderTask?.cancel?.(); page.page?.cleanup?.(); }
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    void this.pdfDocument.cleanup?.();
    void this.pdfDocument.destroy?.();
    void this.loadingTask.destroy?.();
    this.mounted.clear();
    this.root.remove();
  }
}

