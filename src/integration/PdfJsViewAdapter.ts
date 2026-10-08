import type { App, TFile } from "obsidian";
import type { InkStroke, ToolbarPlacement } from "../model";
import type {
  AnnotationSurfaceCallbacks,
  AnnotationViewState,
  ViewerState,
  ViewerScaleMode
} from "../runtime/AnnotationSurface";
import { normalizeScaleMode, VIEWER_ZOOM_STEP } from "../runtime/ViewerState";
import {
  PageLifecycleCoordinator,
  type ManagedPageRecord
} from "../runtime/PageLifecycleCoordinator";
import {
  RenderScheduler,
  type RenderPriority,
  type RenderJob,
  type RenderAbortSignal
} from "../runtime/RenderScheduler";
import { setElementCssProps } from "../dom/typeGuards";
import type { PdfIntegrationProfile } from "./PdfViewerCompatibility";
import type { PdfPageInfo } from "./PdfPageLocator";
import type {
  PdfInkPreview,
  PdfInkPreviewProvider,
  PdfViewerCommandBridge,
  PdfSurfaceExtensions,
  PdfToolbarAction
} from "./ObsidianPdfAdapter";
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

const MAX_PREVIEW_POINTS_PER_STROKE = 96;
const MAX_PREVIEW_PAGES_PER_FRAME = 24;

function previewPoint(
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number,
  rotation: number,
  previewWidth: number,
  previewHeight: number
): [number, number] {
  const safeWidth = Math.max(1, pageWidth);
  const safeHeight = Math.max(1, pageHeight);
  const normalizedRotation = normalizeRotation(rotation);
  switch (normalizedRotation) {
    case 90:
      return [y / safeHeight * previewWidth, x / safeWidth * previewHeight];
    case 180:
      return [(safeWidth - x) / safeWidth * previewWidth, y / safeHeight * previewHeight];
    case 270:
      return [(safeHeight - y) / safeHeight * previewWidth, (safeWidth - x) / safeWidth * previewHeight];
    default:
      return [x / safeWidth * previewWidth, (safeHeight - y) / safeHeight * previewHeight];
  }
}

/** Draws a deliberately low-resolution copy of sidecar ink without touching the PDF raster. */
function drawInkPreview(
  canvas: HTMLCanvasElement,
  pageWidth: number,
  pageHeight: number,
  rotation: number,
  strokes: readonly InkStroke[]
): boolean {
  const context = canvas.getContext("2d");
  if (!context || typeof context.clearRect !== "function" || typeof context.beginPath !== "function") return false;
  const previewWidth = Math.max(1, canvas.width);
  const previewHeight = Math.max(1, canvas.height);
  context.clearRect(0, 0, previewWidth, previewHeight);
  if (!strokes.length) return true;
  const rotated = normalizeRotation(rotation) % 180 !== 0;
  const contentWidth = rotated ? pageHeight : pageWidth;
  const contentHeight = rotated ? pageWidth : pageHeight;
  const scale = Math.min(previewWidth / Math.max(1, contentWidth), previewHeight / Math.max(1, contentHeight));
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const points = stroke.points;
    const sampled: typeof points = [];
    if (points.length <= MAX_PREVIEW_POINTS_PER_STROKE) {
      sampled.push(...points);
    } else {
      sampled.push(points[0]!);
      const step = (points.length - 1) / (MAX_PREVIEW_POINTS_PER_STROKE - 1);
      for (let index = 1; index < MAX_PREVIEW_POINTS_PER_STROKE - 1; index += 1) {
        sampled.push(points[Math.round(index * step)]!);
      }
      sampled.push(points.at(-1)!);
    }
    if (sampled.length === 0) continue;
    const first = sampled[0];
    if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.y)) continue;
    const start = previewPoint(first.x, first.y, pageWidth, pageHeight, rotation, previewWidth, previewHeight);
    context.beginPath();
    context.moveTo(start[0], start[1]);
    for (const point of sampled.slice(1)) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const next = previewPoint(point.x, point.y, pageWidth, pageHeight, rotation, previewWidth, previewHeight);
      context.lineTo(next[0], next[1]);
    }
    context.strokeStyle = stroke.color;
    context.globalAlpha = Math.max(0.08, Math.min(1, stroke.opacity * (stroke.tool === "highlighter" ? 0.45 : 1)));
    context.lineWidth = Math.max(0.5, stroke.width * scale);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  }
  context.globalAlpha = 1;
  return true;
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
  readonly lifecycleCoordinator: PageLifecycleCoordinator;
  readonly renderScheduler: RenderScheduler;
  private readonly pagesByNumber = new Map<number, OwnedPage>();
  private readonly mounted = new Set<HTMLElement>();
  private readonly cleanups: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private lifecycleGeneration = 0;
  private thumbnailGeneration = 0;
  private destroyed = false;
  private scale = DEFAULT_SCALE;
  private rotation = 0;
  private currentPageNumber = 1;
  private currentScaleMode: ViewerScaleMode = "custom";
  // Resolve the default fit once; later layout changes must preserve the user's viewport.
  private initialScaleResolved = false;
  private zoomTimer: number | null = null;
  private layoutFrame: number | null = null;
  private readonly toolbarHost: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly pageContainer: HTMLElement;
  private readonly findBar: HTMLElement;
  private readonly findInput: HTMLInputElement;
  private readonly findStatus: HTMLElement;
  private readonly outlinePanel: HTMLElement;
  private readonly thumbnailPanel: HTMLElement;
  private readonly thumbnailTasks = new Set<PdfJsRenderTask>();
  private readonly thumbnailQueued = new Set<number>();
  private readonly thumbnailRendered = new Set<number>();
  private thumbnailObserver: IntersectionObserver | null = null;
  private inkPreviewProvider: PdfInkPreviewProvider | null = null;
  private readonly thumbnailInkCanvases = new Map<number, HTMLCanvasElement>();
  private readonly outlineInkCanvases = new Map<number, Set<HTMLCanvasElement>>();
  private readonly inkPreviewQueued = new Set<number>();
  private inkPreviewFrame: number | null = null;
  private inkPreviewTimer: number | null = null;
  private readonly textContentByPage = new Map<number, Promise<{ items?: readonly PdfJsTextItem[] }>>();
  private findGeneration = 0;
  private findMatches: Array<{ pageNumber: number; offset: number }> = [];
  private findIndex = -1;
  private handToolActive = false;
  private viewerCommands: PdfViewerCommandBridge | null = null;

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
    this.lifecycleCoordinator = new PageLifecycleCoordinator({
      neighborRadius: RENDER_NEIGHBOR_RADIUS,
      totalPages: this.pdfDocument.numPages,
      initialActivePage: 1,
      onRenderRequested: (pageNumber) => this.queuePageRender(pageNumber),
      onEvictPage: (record) => this.performPageEviction(record)
    });
    this.renderScheduler = new RenderScheduler({
      coordinator: this.lifecycleCoordinator,
      timerWindow: ownerDocument.defaultView ?? window,
      executeRender: (job, signal) => this.executePageRender(job, signal),
      onEvict: (pageNumber) => this.performPageEvictionByNumber(pageNumber),
      getDevicePixelRatio: () => Math.max(1, Math.min(3, this.root.ownerDocument.defaultView?.devicePixelRatio ?? 1))
    });
    this.toolbarHost = createElement(ownerDocument, "div", "hn-owned-pdf-toolbar-host");
    this.toolbarHost.setAttribute("aria-label", "Handwriting toolbar");
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
    this.root.append(this.toolbarHost, this.findBar, this.outlinePanel, this.thumbnailPanel, this.scroll);
    options.host.replaceChildren(this.root);
    this.installControls(ownerDocument, options);
    this.installScrollTracking();
    this.installKeyboardNavigation();
    this.installZoomGestures();
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
    this.renderScheduler.setDocumentGeometry(this.pdfDocument.numPages, this.scale, this.rotation, 1);
    await this.renderScheduler.requestPage(1, "immediate");
    const preloadPages = typeof IntersectionObserver === "function"
      ? [2, 3].filter((value) => value <= this.pdfDocument.numPages)
      : Array.from({ length: Math.min(8, this.pdfDocument.numPages) }, (_, index) => index + 1);
    for (const pageNumber of preloadPages) this.queuePageRender(pageNumber, "high");
    await this.loadOutline();
    if (!this.initialScaleResolved) this.fitWidth();
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
    const record = this.lifecycleCoordinator.registerPage({
      pageNumber,
      shell,
      naturalWidth,
      naturalHeight
    });
    const page: OwnedPage = {
      pageNumber,
      shell,
      canvas,
      textLayer,
      annotationLayer,
      naturalWidth,
      naturalHeight,
      renderTask: undefined,
      generation: record.generation,
      mountGeneration: record.mountGeneration,
      renderedAtScale: undefined,
      renderedAtRotation: undefined,
      renderQueued: false
    };
    this.pagesByNumber.set(pageNumber, page);
    this.pageContainer.append(shell);
    setPixelSize(shell, naturalWidth * this.scale, naturalHeight * this.scale);
    if (pageNumber < this.pdfDocument.numPages) {
      const gap = createElement(ownerDocument, "div", "hn-owned-pdf-page-gap");
      gap.setAttribute("aria-hidden", "true");
      setElementCssProps(gap, { height: `${PAGE_GAP}px` });
      this.pageContainer.append(gap);
    }
    return page;
  }

  private sidebarView(): 0 | 1 | 2 {
    if (!this.thumbnailPanel.hidden) return 1;
    if (!this.outlinePanel.hidden) return 2;
    return 0;
  }

  private setSidebarView(view: number): void {
    this.thumbnailPanel.hidden = view !== 1;
    this.outlinePanel.hidden = view !== 2;
    if (view === 1 && this.thumbnailPanel.childElementCount === 0) this.loadThumbnails();
    this.refreshInkPreviews();
  }

  private revealCurrentOutlineItem(): void {
    this.setSidebarView(2);
    this.outlinePanel
      .querySelector<HTMLButtonElement>(`button[data-page-number="${this.currentPageNumber}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }

  private adaptToTheme(app: App): void {
    const themed = app.loadLocalStorage("pdfjs-is-themed") === "true";
    this.root.classList.toggle("hn-owned-pdf-themed", themed);
    const view = this.root.ownerDocument.defaultView;
    const background = themed
      ? view?.getComputedStyle(this.root).getPropertyValue("--pdf-page-background").trim() ?? ""
      : "";
    if (background) this.root.style.setProperty("--hn-owned-pdf-page-background", background);
    else this.root.style.removeProperty("--hn-owned-pdf-page-background");
  }

  private installControls(ownerDocument: Document, options: PdfJsViewAdapterOptions): void {
    this.findBar.append(
      this.navigationButton(ownerDocument, "Previous match", "↑", () => this.moveFind(-1)),
      this.navigationButton(ownerDocument, "Next match", "↓", () => this.moveFind(1)),
      this.navigationButton(ownerDocument, "Close find bar", "×", () => this.toggleFindBar(false))
    );
    this.adaptToTheme(options.app);
    const onFindInput = (): void => { void this.findDocument(this.findInput.value); };
    this.findInput.addEventListener("input", onFindInput);
    this.cleanups.push(() => this.findInput.removeEventListener("input", onFindInput));
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
    const onScroll = (): void => {
      this.initialScaleResolved = true;
      // Persist the chosen zoom once a scroll position exists instead of restoring a fit preset.
      this.currentScaleMode = "custom";
      this.renderScheduler.notifyScrollPosition(this.scroll.scrollTop, this.scroll.scrollLeft);
      this.scheduleLayoutUpdate();
      this.emitViewState("scroll");
    };
    this.scroll.addEventListener("scroll", onScroll, { passive: true });
    this.cleanups.push(() => this.scroll.removeEventListener("scroll", onScroll));
  }

  private installKeyboardNavigation(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      const view = this.root.ownerDocument.defaultView;
      const ElementConstructor = view?.Element;
      const target = ElementConstructor && event.target instanceof ElementConstructor
        ? event.target
        : null;
      const isTextEditing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (this.viewerCommands?.handleKeyDown(event, isTextEditing)) return;
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.toggleSearch(true);
        else this.toggleFindBar(true);
        return;
      }
      if (event.key === "Escape" && !this.findBar.hidden) {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.closeSearch();
        else this.toggleFindBar(false);
        return;
      }
      if (isTextEditing) return;
      if (event.key === "PageDown" || event.key === "ArrowDown") {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.nextPage();
        else this.focusPage(Math.min(this.pdfDocument.numPages, this.currentPageNumber + 1));
      } else if (event.key === "PageUp" || event.key === "ArrowUp") {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.previousPage();
        else this.focusPage(Math.max(1, this.currentPageNumber - 1));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.zoomIn();
        else this.setScale(this.scale * VIEWER_ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        if (this.viewerCommands) this.viewerCommands.zoomOut();
        else this.setScale(this.scale / VIEWER_ZOOM_STEP);
      }
    };
    this.root.addEventListener("keydown", onKeyDown);
    this.cleanups.push(() => this.root.removeEventListener("keydown", onKeyDown));
  }

  private installZoomGestures(): void {
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.01);
      const nextScale = clampScale(this.scale * factor);
      this.setScaleAtFocalPoint(nextScale, event.clientX, event.clientY);
    };
    this.scroll.addEventListener("wheel", onWheel, { passive: false });
    this.cleanups.push(() => this.scroll.removeEventListener("wheel", onWheel));

    let activePinch: { startDist: number; startScale: number; focalX: number; focalY: number } | null = null;
    const touchDistance = (t1: Touch, t2: Touch): number => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length === 2) {
        const t1 = event.touches[0]!;
        const t2 = event.touches[1]!;
        activePinch = {
          startDist: touchDistance(t1, t2),
          startScale: this.scale,
          focalX: (t1.clientX + t2.clientX) / 2,
          focalY: (t1.clientY + t2.clientY) / 2
        };
      } else {
        activePinch = null;
      }
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (!activePinch || event.touches.length !== 2) return;
      event.preventDefault();
      const t1 = event.touches[0]!;
      const t2 = event.touches[1]!;
      const currentDist = touchDistance(t1, t2);
      if (activePinch.startDist > 0) {
        const ratio = currentDist / activePinch.startDist;
        const nextScale = clampScale(activePinch.startScale * ratio);
        const focalX = (t1.clientX + t2.clientX) / 2;
        const focalY = (t1.clientY + t2.clientY) / 2;
        this.setScaleAtFocalPoint(nextScale, focalX, focalY);
      }
    };

    const onTouchEnd = (event: TouchEvent): void => {
      if (activePinch && event.touches.length < 2) {
        activePinch = null;
      }
    };

    this.scroll.addEventListener("touchstart", onTouchStart, { passive: true });
    this.scroll.addEventListener("touchmove", onTouchMove, { passive: false });
    this.scroll.addEventListener("touchend", onTouchEnd, { passive: true });
    this.scroll.addEventListener("touchcancel", onTouchEnd, { passive: true });
    this.cleanups.push(
      () => this.scroll.removeEventListener("touchstart", onTouchStart),
      () => this.scroll.removeEventListener("touchmove", onTouchMove),
      () => this.scroll.removeEventListener("touchend", onTouchEnd),
      () => this.scroll.removeEventListener("touchcancel", onTouchEnd)
    );
  }

  private installIntersectionObserver(): void {
    if (typeof IntersectionObserver !== "function") return;
    this.lifecycleCoordinator.installIntersectionObserver(this.scroll, { rootMargin: "800px 0px" });
    this.cleanups.push(() => {
      this.lifecycleCoordinator.disconnectObserver();
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
        this.lifecycleCoordinator.setActivePage(pageNumber);
        this.renderScheduler.setDocumentGeometry(this.pdfDocument.numPages, this.scale, this.rotation, pageNumber);
        this.emitViewState("scroll");
      }
      for (const nearby of this.nearbyPages()) this.queuePageRender(nearby);
    }) ?? null;
  }

  private isAlive(generation = this.lifecycleGeneration): boolean {
    return !this.destroyed && generation === this.lifecycleGeneration;
  }

  private invalidatePage(page: OwnedPage): void {
    page.generation = this.lifecycleCoordinator.bumpGeneration(page.pageNumber);
    page.renderedAtScale = undefined;
    page.renderedAtRotation = undefined;
    page.renderTask?.cancel?.();
    page.renderTask = undefined;
    page.textLayer.replaceChildren();
    page.annotationLayer.replaceChildren();
  }

  private evictOffscreenPages(): void {
    this.lifecycleCoordinator.evictOffscreenPages((record) => this.performPageEviction(record));
  }

  private performPageEvictionByNumber(pageNumber: number): void {
    const page = this.pagesByNumber.get(pageNumber);
    if (!page) return;
    page.renderedAtScale = undefined;
    page.renderedAtRotation = undefined;
    page.generation = this.lifecycleCoordinator.bumpGeneration(pageNumber);
    page.renderTask?.cancel?.();
    page.renderTask = undefined;
    page.textLayer.replaceChildren();
    page.annotationLayer.replaceChildren();
    page.canvas.width = 1;
    page.canvas.height = 1;
    this.lifecycleCoordinator.markEvicted(pageNumber);
  }

  private performPageEviction(record: ManagedPageRecord): void {
    const page = this.pagesByNumber.get(record.pageNumber);
    if (!page) return;
    this.renderScheduler.evictPage(record.pageNumber, false);
    page.renderedAtScale = undefined;
    page.renderedAtRotation = undefined;
    page.generation = record.generation;
    page.renderTask?.cancel?.();
    page.renderTask = undefined;
    page.textLayer.replaceChildren();
    page.annotationLayer.replaceChildren();
    page.canvas.width = 1;
    page.canvas.height = 1;
  }

  private queuePageRender(pageNumber: number, priority?: RenderPriority): void {
    void this.renderScheduler.requestPage(pageNumber, priority).catch((error: unknown) => {
      if (this.destroyed || (error instanceof Error && /cancel/i.test(error.message))) return;
      this.callbacks.onDebugLog?.("warn", "pdfjs-page-render-failed", {
        pageNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async executePageRender(job: RenderJob, signal: RenderAbortSignal): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    if (!this.isAlive(lifecycleGeneration) || signal.aborted) return;
    const page = this.pagesByNumber.get(job.pageNumber);
    if (!page) return;

    let task: PdfJsRenderTask | undefined;
    const generation = page.generation;
    try {
      if (!this.isAlive(lifecycleGeneration) || signal.aborted) return;
      if (!page.page) page.page = await this.pdfDocument.getPage(job.pageNumber);
      if (!this.isAlive(lifecycleGeneration) || signal.aborted || generation !== page.generation) return;

      const canonicalViewport = page.page.getViewport({ scale: 1, rotation: 0 });
      const viewport = page.page.getViewport({ scale: job.scale, rotation: job.rotation });
      page.viewport = viewport;
      page.naturalWidth = Math.max(1, canonicalViewport.width);
      page.naturalHeight = Math.max(1, canonicalViewport.height);
      setPixelSize(page.shell, viewport.width, viewport.height);

      const dpr = job.dpr;
      page.canvas.width = Math.max(1, Math.ceil(viewport.width * dpr));
      page.canvas.height = Math.max(1, Math.ceil(viewport.height * dpr));
      setElementCssProps(page.canvas, { width: `${viewport.width}px`, height: `${viewport.height}px` });
      const context = page.canvas.getContext("2d");
      if (!context) throw new Error(`PDF.js canvas context unavailable for page ${job.pageNumber}`);
      if (!this.isAlive(lifecycleGeneration) || signal.aborted || generation !== page.generation) return;

      this.lifecycleCoordinator.beginPdfRaster(job.pageNumber);
      task = dpr === 1
        ? page.page.render({ canvasContext: context, viewport })
        : page.page.render({ canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
      let taskCancelled = false;
      const cancelTask = (): void => {
        if (taskCancelled) return;
        taskCancelled = true;
        task?.cancel?.();
      };
      page.renderTask = {
        promise: task.promise,
        cancel: cancelTask
      };

      signal.onAbort(cancelTask);
      if (signal.aborted) {
        cancelTask();
      }

      await task.promise;
      if (!this.isAlive(lifecycleGeneration) || signal.aborted || generation !== page.generation || page.viewport !== viewport) {
        this.lifecycleCoordinator.finishPdfRaster(job.pageNumber, false);
        return;
      }
      this.lifecycleCoordinator.finishPdfRaster(job.pageNumber, true);
      this.lifecycleCoordinator.beginTextLayer(job.pageNumber);
      await this.renderTextLayer(page, viewport, generation);
      this.lifecycleCoordinator.finishTextLayer(job.pageNumber, true);
      this.lifecycleCoordinator.beginAnnotationLayer(job.pageNumber);
      await this.renderAnnotationLayer(page, viewport, generation);
      this.lifecycleCoordinator.finishAnnotationLayer(job.pageNumber, true);

      if (!this.isAlive(lifecycleGeneration) || signal.aborted || generation !== page.generation) return;
      page.renderedAtScale = job.scale;
      page.renderedAtRotation = job.rotation;
      this.lifecycleCoordinator.setRenderedGeometry(job.pageNumber, job.scale, job.rotation);
      this.callbacks.onPageLifecycleChange?.({
        kind: "render", viewerGeneration: this.viewerGeneration, pageNumbers: [job.pageNumber],
        mountGenerations: { [String(job.pageNumber)]: page.mountGeneration }, signalAt: Date.now()
      });
      this.evictOffscreenPages();
    } catch (error) {
      this.lifecycleCoordinator.finishPdfRaster(job.pageNumber, false);
      if (signal.aborted || (error instanceof Error && /cancel/i.test(error.message))) {
        return;
      }
      throw error;
    } finally {
      if (page.renderTask?.promise === task?.promise) {
        page.renderTask = undefined;
      }
    }
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

  private scheduleInkPreviewFlush(): void {
    if (this.destroyed || this.inkPreviewFrame !== null || this.inkPreviewTimer !== null) return;
    const view = this.root.ownerDocument.defaultView;
    if (view?.requestAnimationFrame) {
      this.inkPreviewFrame = view.requestAnimationFrame(() => {
        this.inkPreviewFrame = null;
        this.flushInkPreviewQueue();
      });
      return;
    }
    const timerWindow = view ?? window;
    this.inkPreviewTimer = timerWindow.setTimeout(() => {
      this.inkPreviewTimer = null;
      this.flushInkPreviewQueue();
    }, 0);
  }

  private flushInkPreviewQueue(): void {
    if (this.destroyed) return;
    const pages = [...this.inkPreviewQueued].slice(0, MAX_PREVIEW_PAGES_PER_FRAME);
    for (const pageNumber of pages) {
      this.inkPreviewQueued.delete(pageNumber);
      this.renderInkPreviewPage(pageNumber);
    }
    if (this.inkPreviewQueued.size > 0) this.scheduleInkPreviewFlush();
  }

  private queueInkPreviewRender(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pdfDocument.numPages) return;
    this.inkPreviewQueued.add(pageNumber);
    this.scheduleInkPreviewFlush();
  }

  private renderInkPreviewPage(pageNumber: number): void {
    const page = this.pagesByNumber.get(pageNumber);
    if (!page) return;
    let preview: PdfInkPreview = { revision: 0, strokes: [] };
    try {
      preview = this.inkPreviewProvider?.(pageNumber) ?? preview;
    } catch {
      // Preview rendering is optional; sidebar navigation must remain usable.
    }
    const canvases = this.outlineInkCanvases.get(pageNumber) ?? [];
    for (const canvas of canvases) {
      const rotated = this.rotation % 180 !== 0;
      const width = 42;
      const height = Math.max(18, Math.round(width * (rotated ? page.naturalWidth / page.naturalHeight : page.naturalHeight / page.naturalWidth)));
      canvas.width = width;
      canvas.height = height;
      setPixelSize(canvas, width, height);
      const drawn = drawInkPreview(canvas, page.naturalWidth, page.naturalHeight, this.rotation, preview.strokes);
      canvas.hidden = !drawn || preview.strokes.length === 0;
    }
    const thumbnailCanvas = this.thumbnailInkCanvases.get(pageNumber);
    if (thumbnailCanvas) {
      const drawn = drawInkPreview(thumbnailCanvas, page.naturalWidth, page.naturalHeight, this.rotation, preview.strokes);
      thumbnailCanvas.hidden = !drawn || preview.strokes.length === 0;
    }
  }

  setInkPreviewProvider(provider: PdfInkPreviewProvider | null): void {
    if (this.destroyed) return;
    this.inkPreviewProvider = provider;
    this.refreshInkPreviews();
  }

  refreshInkPreviews(pageNumbers?: readonly number[]): void {
    if (this.destroyed) return;
    const pages = pageNumbers
      ? pageNumbers
      : [...new Set([
        ...(this.outlinePanel.hidden ? [] : this.outlineInkCanvases.keys()),
        ...(this.thumbnailPanel.hidden ? [] : [...this.thumbnailInkCanvases.keys()].filter((page) => this.thumbnailRendered.has(page)))
      ])];
    for (const pageNumber of pages) {
      const outlineReady = !this.outlinePanel.hidden && this.outlineInkCanvases.has(pageNumber);
      const thumbnailReady = !this.thumbnailPanel.hidden && this.thumbnailRendered.has(pageNumber);
      if (outlineReady || thumbnailReady) this.queueInkPreviewRender(pageNumber);
    }
  }

  private loadThumbnails(): void {
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    this.thumbnailQueued.clear();
    this.thumbnailRendered.clear();
    this.thumbnailInkCanvases.clear();
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
      const inkCanvas = createElement(ownerDocument, "canvas", "hn-owned-pdf-thumbnail-ink");
      inkCanvas.hidden = true;
      setElementCssProps(inkCanvas, { inset: "0", pointerEvents: "none", position: "absolute", zIndex: "1" });
      const canvasHost = createElement(ownerDocument, "div", "hn-owned-pdf-thumbnail-canvas");
      setElementCssProps(canvasHost, { position: "relative" });
      canvasHost.append(canvas, inkCanvas);
      this.thumbnailInkCanvases.set(pageNumber, inkCanvas);
      const label = createElement(ownerDocument, "span");
      label.textContent = String(pageNumber);
      button.append(canvasHost, label);
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
        const inkCanvas = this.thumbnailInkCanvases.get(pageNumber);
        if (inkCanvas) {
          inkCanvas.width = canvas.width;
          inkCanvas.height = canvas.height;
          setElementCssProps(inkCanvas, { width: `${viewport.width}px`, height: `${viewport.height}px` });
        }
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
          if (rendered) {
            this.thumbnailRendered.add(pageNumber);
            this.queueInkPreviewRender(pageNumber);
          }
        }
      }
    })().catch((error: unknown) => {
      if (!this.destroyed && !(error instanceof Error && /cancel/i.test(error.message))) {
        this.callbacks.onDebugLog?.("warn", "pdfjs-thumbnail-failed", { pageNumber, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private async outlineDestinationPage(destination: unknown): Promise<number | undefined> {
    let resolved = destination;
    if (typeof resolved === "string") {
      if (!this.pdfDocument.getDestination) return undefined;
      try { resolved = await this.pdfDocument.getDestination(resolved); } catch { return undefined; }
    }
    if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
    const pageReference: unknown = resolved[0];
    let pageIndex: number | undefined;
    if (typeof pageReference === "number") {
      pageIndex = pageReference;
    } else if (this.pdfDocument.getPageIndex) {
      try { pageIndex = await this.pdfDocument.getPageIndex(pageReference); } catch { return undefined; }
    }
    if (typeof pageIndex !== "number" || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pdfDocument.numPages) return undefined;
    return pageIndex + 1;
  }

  private async loadOutline(): Promise<void> {
    let outline: readonly unknown[] | null = null;
    try { outline = this.pdfDocument.getOutline ? await this.pdfDocument.getOutline() : null; } catch { outline = null; }
    if (!outline?.length) return;
    this.outlineInkCanvases.clear();
    const list = createElement(this.outlinePanel.ownerDocument, "ol");
    for (const entry of outline.slice(0, 500)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { title?: unknown; dest?: unknown };
      // PDF.js normally returns a RefProxy here, not the numeric page index used by
      // the small test adapter. Resolve both forms so outline previews are mapped
      // to the same page as outline navigation.
      const page = await this.outlineDestinationPage(item.dest);
      const button = createElement(this.outlinePanel.ownerDocument, "button");
      button.type = "button";
      if (page) button.dataset.pageNumber = String(page);
      const title = createElement(this.outlinePanel.ownerDocument, "span");
      title.textContent = typeof item.title === "string" ? item.title : "Untitled";
      const preview = createElement(this.outlinePanel.ownerDocument, "canvas", "hn-owned-pdf-outline-ink");
      preview.hidden = true;
      preview.setAttribute("aria-hidden", "true");
      button.append(preview, title);
      button.addEventListener("click", () => { if (page) this.focusPage(page); });
      if (page && this.pagesByNumber.has(page)) {
        const canvases = this.outlineInkCanvases.get(page) ?? new Set<HTMLCanvasElement>();
        canvases.add(preview);
        this.outlineInkCanvases.set(page, canvases);
      }
      const listItem = createElement(this.outlinePanel.ownerDocument, "li");
      listItem.append(button); list.append(listItem);
    }
    this.outlinePanel.replaceChildren(list);
  }

  private nearbyPages(): number[] {
    return this.lifecycleCoordinator.getWorkingSet();
  }

  private setScale(next: number, mode: ViewerScaleMode | number = "custom"): void {
    this.setScaleAtFocalPoint(next, undefined, undefined, mode);
  }

  private setScaleAtFocalPoint(
    next: number,
    focalClientX?: number,
    focalClientY?: number,
    mode: ViewerScaleMode | number = "custom"
  ): void {
    const previous = this.scale;
    this.scale = clampScale(next);
    this.currentScaleMode = normalizeScaleMode(mode);
    this.initialScaleResolved = true;
    if (Math.abs(previous - this.scale) < 0.001) return;
    const ratio = this.scale / previous;
    if (focalClientX !== undefined && focalClientY !== undefined) {
      const rect = this.scroll.getBoundingClientRect();
      const offsetX = focalClientX - rect.left;
      const offsetY = focalClientY - rect.top;
      this.scroll.scrollLeft = (this.scroll.scrollLeft + offsetX) * ratio - offsetX;
      this.scroll.scrollTop = (this.scroll.scrollTop + offsetY) * ratio - offsetY;
    } else {
      const centerX = this.scroll.scrollLeft + this.scroll.clientWidth / 2;
      const centerY = this.scroll.scrollTop + this.scroll.clientHeight / 2;
      this.scroll.scrollLeft = centerX * ratio - this.scroll.clientWidth / 2;
      this.scroll.scrollTop = centerY * ratio - this.scroll.clientHeight / 2;
    }
    this.renderScheduler.notifyScale(this.scale, this.rotation);
    for (const page of this.pagesByNumber.values()) {
      this.invalidatePage(page);
      setPixelSize(page.shell, this.displayWidth(page) * this.scale, this.displayHeight(page) * this.scale);
      setElementCssProps(page.canvas, { width: `${this.displayWidth(page) * this.scale}px`, height: `${this.displayHeight(page) * this.scale}px` });
    }
    this.callbacks.onZoomChange?.({ phase: "begin", scale: this.scale, source: "geometry", viewerGeneration: this.viewerGeneration });
    for (const page of this.nearbyPages()) this.queuePageRender(page);
    if (this.zoomTimer !== null) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      this.zoomTimer = null;
      if (!this.destroyed) {
        this.callbacks.onZoomChange?.({ phase: "settled", scale: this.scale, source: "geometry", viewerGeneration: this.viewerGeneration });
        this.renderScheduler.notifySettled();
      }
    }, 120);
    this.emitViewState("scalechanging");
  }

  private fitWidth(): void {
    const page = this.pagesByNumber.get(this.currentPageNumber);
    const availableWidth = this.scroll.clientWidth - 32;
    if (!page || page.naturalWidth <= 0 || availableWidth <= 0) return;
    this.setScale(availableWidth / this.displayWidth(page), "custom");
  }

  private fitHeight(): void {
    const page = this.pagesByNumber.get(this.currentPageNumber);
    if (!page || page.naturalHeight <= 0) return;
    const availableHeight = this.scroll.clientHeight - 32;
    if (availableHeight <= 0) return;
    this.setScale(availableHeight / this.displayHeight(page), "fit-height");
  }

  private fitPage(): void {
    const page = this.pagesByNumber.get(this.currentPageNumber);
    if (!page || page.naturalWidth <= 0) return;
    const availableWidth = this.scroll.clientWidth - 32;
    const availableHeight = this.scroll.clientHeight - 32;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const scale = Math.min(
      availableWidth / this.displayWidth(page),
      availableHeight / this.displayHeight(page)
    );
    this.setScale(scale, "fit-page");
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
    this.renderScheduler.notifyScale(this.scale, this.rotation);
    for (const page of this.pagesByNumber.values()) {
      this.invalidatePage(page);
      setPixelSize(page.shell, this.displayWidth(page) * this.scale, this.displayHeight(page) * this.scale);
      setElementCssProps(page.canvas, { width: `${this.displayWidth(page) * this.scale}px`, height: `${this.displayHeight(page) * this.scale}px` });
    }
    this.thumbnailGeneration += 1;
    for (const task of this.thumbnailTasks) task.cancel?.();
    this.thumbnailTasks.clear();
    if (!this.thumbnailPanel.hidden) {
      this.thumbnailPanel.replaceChildren();
      this.loadThumbnails();
    }
    this.refreshInkPreviews();
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
    const protectedPages = new Set(this.lifecycleCoordinator.getWorkingSet());
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

  

  setViewerCommandBridge(commands: PdfViewerCommandBridge | null): void {
    this.viewerCommands = commands;
    this.setHandToolActive(commands?.isHandMode() ?? false);
  }

  setHandToolActive(active: boolean): void {
    this.handToolActive = active;
    this.root.classList.toggle("is-hand-tool", this.handToolActive);
    setElementCssProps(this.scroll, { cursor: this.handToolActive ? "grab" : "auto" });
  }

  performToolbarAction(action: PdfToolbarAction): boolean {
    switch (action) {
      case "fit-height": this.fitHeight(); break;
      case "fit-page": this.fitPage(); break;
      case "show-thumbnails": this.setSidebarView(this.sidebarView() === 1 ? 0 : 1); break;
      case "show-outline":
        if (this.sidebarView() === 2) this.setSidebarView(0);
        else this.revealCurrentOutlineItem();
        break;
      case "presentation": this.togglePresentationMode(); break;
      case "print": this.printPdf(); break;
      case "download": this.downloadPdf(); break;
    }
    return true;
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
  pageMountGeneration(pageNumber: number): number {
    return this.lifecycleCoordinator.getRecord(pageNumber)?.mountGeneration
      ?? this.pagesByNumber.get(pageNumber)?.mountGeneration
      ?? 0;
  }

  viewportContentElement(): HTMLElement {
    return this.pageContainer;
  }

  private pageInfo(page: OwnedPage): PdfPageInfo {
    const record = this.lifecycleCoordinator.getRecord(page.pageNumber);
    return {
      pageNumber: page.pageNumber,
      width: Math.max(1, page.naturalWidth),
      height: Math.max(1, page.naturalHeight),
      scale: this.scale,
      rotation: this.rotation,
      coordinateOrigin: "bottom-left",
      element: page.shell,
      mountGeneration: record?.mountGeneration ?? page.mountGeneration,
      geometryConfidence: page.viewport ? "authoritative" : "derived",
      geometrySafe: page.shell.isConnected && Boolean(page.viewport),
      identityConfidence: "authoritative",
      identitySafe: true,
      candidateCount: 1
    };
  }

  getViewState(): ViewerState & AnnotationViewState {
    const maxScroll = Math.max(1, this.scroll.scrollHeight - this.scroll.clientHeight);
    const scrollFraction = Math.max(0, Math.min(1, this.scroll.scrollTop / maxScroll));
    return {
      viewport: {
        scale: this.scale,
        x: this.scroll.scrollLeft,
        y: this.scroll.scrollTop
      },
      pageNumber: this.currentPageNumber,
      rotation: this.rotation,
      scaleMode: this.currentScaleMode,
      scrollFraction,
      scale: this.scale
    };
  }

  restoreViewState(state: ViewerState | AnnotationViewState): void {
    const rotation = normalizeRotation(state.rotation);
    if (rotation !== this.rotation) this.setRotation(rotation);
    const scale = state.viewport?.scale ?? state.scale;
    if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) {
      // Fit commands resolve to a numeric scale at invocation. Replaying a
      // fit preset during restore would refit to the current pane and move
      // the viewport after the user had selected a position and zoom.
      this.setScale(scale, "custom");
    } else {
      this.currentScaleMode = "custom";
      this.initialScaleResolved = true;
    }
    this.currentPageNumber = Math.max(1, Math.min(this.pdfDocument.numPages, Math.round(state.pageNumber || 1)));
    this.lifecycleCoordinator.setActivePage(this.currentPageNumber);
    this.renderScheduler.setDocumentGeometry(this.pdfDocument.numPages, this.scale, this.rotation, this.currentPageNumber);
    const maxScroll = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
    if (state.viewport && Number.isFinite(state.viewport.x) && Number.isFinite(state.viewport.y)) {
      this.scroll.scrollTop = state.viewport.y;
      this.scroll.scrollLeft = state.viewport.x;
    } else if (typeof state.scrollFraction === "number" && Number.isFinite(state.scrollFraction)) {
      this.scroll.scrollTop = maxScroll * Math.max(0, Math.min(1, state.scrollFraction));
    }
    this.queuePageRender(this.currentPageNumber, "immediate");
  }

  focusPage(pageNumber: number): boolean {
    const page = this.pagesByNumber.get(pageNumber);
    if (!page) return false;
    this.currentPageNumber = pageNumber;
    this.lifecycleCoordinator.setActivePage(pageNumber);
    this.renderScheduler.setDocumentGeometry(this.pdfDocument.numPages, this.scale, this.rotation, pageNumber);
    page.shell.scrollIntoView?.({ block: "start" });
    this.queuePageRender(pageNumber, "immediate");
    this.emitViewState("scroll");
    return true;
  }

  onResize(): void {
    if (this.destroyed) return;
    // Obsidian also calls this for pane/sidebar layout changes, not just initial sizing.
    if (!this.initialScaleResolved) this.fitWidth();
    this.scheduleLayoutUpdate();
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
    this.lifecycleCoordinator.setInkOverlayStatus(pageNumber, "mounting");
    return overlay;
  }

  mountToolbar(toolbar: HTMLElement, _placement: ToolbarPlacement = "main"): void {
    for (const node of this.root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-rail")) node.remove();
    toolbar.classList.add("native-pdf-handwriting-toolbar");
    toolbar.classList.remove("is-sidebar-left", "is-sidebar-right");
    toolbar.classList.add("is-main");
    this.toolbarHost.append(toolbar);
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
    this.lifecycleCoordinator.destroy();
    this.renderScheduler.destroy();
    this.resizeObserver?.disconnect();
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    this.thumbnailQueued.clear();
    this.thumbnailRendered.clear();
    this.thumbnailInkCanvases.clear();
    this.outlineInkCanvases.clear();
    this.inkPreviewQueued.clear();
    if (this.inkPreviewFrame !== null) view?.cancelAnimationFrame(this.inkPreviewFrame);
    if (this.inkPreviewTimer !== null) (view?.clearTimeout ?? window.clearTimeout)(this.inkPreviewTimer);
    this.inkPreviewFrame = null;
    this.inkPreviewTimer = null;
    this.inkPreviewProvider = null;
    for (const task of this.thumbnailTasks) task.cancel?.();
    this.thumbnailTasks.clear();
    for (const page of this.pagesByNumber.values()) { page.renderTask?.cancel?.(); page.page?.cleanup?.(); }
    this.textContentByPage.clear();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    void this.pdfDocument.cleanup?.();
    void this.pdfDocument.destroy?.();
    void this.loadingTask.destroy?.();
    this.mounted.clear();
    this.root.remove();
  }
}
