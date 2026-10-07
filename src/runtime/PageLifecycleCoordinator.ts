/**
 * Canonical page-state machine unifying PDF.js view adapters and ink sessions.
 *
 * Authoritatively determines visibility, priority, raster/text/annotation layer readiness,
 * ink overlay mounting, generation counting, and eviction candidates across the document.
 */

export type PageVisibility = "cold" | "nearby" | "visible" | "active";
export type PagePriority = "immediate" | "normal" | "idle";
export type PageLayerStatus = "idle" | "rendering" | "ready" | "evicted" | "failed";
export type InkOverlayStatus = "unmounted" | "mounting" | "mounted";
export type PageLifecycleStage = "cold" | "nearby" | "visible" | "active" | "rendering" | "ready" | "evicted";

export interface ManagedPageRecord {
  readonly pageNumber: number;
  shell: HTMLElement;
  visibility: PageVisibility;
  priority: PagePriority;
  pdfRaster: PageLayerStatus;
  textLayer: PageLayerStatus;
  annotationLayer: PageLayerStatus;
  inkOverlay: InkOverlayStatus;
  generation: number;
  mountGeneration: number;
  stage: PageLifecycleStage;
  naturalWidth: number;
  naturalHeight: number;
  renderedAtScale?: number | undefined;
  renderedAtRotation?: number | undefined;
}

export interface PageRegistrationOptions {
  pageNumber: number;
  shell: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
}

export interface PageLifecycleChangeEvent {
  pageNumber: number;
  previousStage: PageLifecycleStage;
  currentStage: PageLifecycleStage;
  record: Readonly<ManagedPageRecord>;
}

export type PageLifecycleListener = (event: PageLifecycleChangeEvent) => void;

export interface PageLifecycleCoordinatorOptions {
  neighborRadius?: number;
  totalPages?: number;
  initialActivePage?: number;
  onRenderRequested?: ((pageNumber: number, priority: PagePriority) => void) | undefined;
  onEvictPage?: ((record: ManagedPageRecord) => void) | undefined;
  onStageChange?: ((event: PageLifecycleChangeEvent) => void) | undefined;
}

export function derivePagePriority(visibility: PageVisibility): PagePriority {
  switch (visibility) {
    case "active":
    case "visible":
      return "immediate";
    case "nearby":
      return "normal";
    case "cold":
    default:
      return "idle";
  }
}

export function derivePageStage(
  visibility: PageVisibility,
  pdfRaster: PageLayerStatus
): PageLifecycleStage {
  if (pdfRaster === "evicted") return "evicted";
  if (pdfRaster === "rendering") return "rendering";
  if (pdfRaster === "ready") return "ready";
  return visibility;
}

export class PageLifecycleCoordinator {
  private readonly neighborRadius: number;
  private totalPages: number;
  private activePageNumber: number;
  private readonly records = new Map<number, ManagedPageRecord>();
  private readonly visiblePages = new Set<number>();
  private readonly renderQueuedPages = new Set<number>();
  private readonly listeners = new Set<PageLifecycleListener>();
  private intersectionObserver: IntersectionObserver | null = null;
  private readonly onRenderRequested?: ((pageNumber: number, priority: PagePriority) => void) | undefined;
  private readonly onEvictPage?: ((record: ManagedPageRecord) => void) | undefined;
  private destroyed = false;

  constructor(options?: PageLifecycleCoordinatorOptions) {
    this.neighborRadius = Math.max(1, options?.neighborRadius ?? 2);
    this.totalPages = Math.max(0, options?.totalPages ?? 0);
    this.activePageNumber = Math.max(1, options?.initialActivePage ?? 1);
    this.onRenderRequested = options?.onRenderRequested;
    this.onEvictPage = options?.onEvictPage;
    if (options?.onStageChange) {
      this.listeners.add(options.onStageChange);
    }
  }

  setTotalPages(count: number): void {
    this.totalPages = Math.max(0, count);
  }

  getTotalPages(): number {
    return this.totalPages;
  }

  getActivePage(): number {
    return this.activePageNumber;
  }

  registerPage(options: PageRegistrationOptions): ManagedPageRecord {
    const { pageNumber, shell, naturalWidth, naturalHeight } = options;
    const existing = this.records.get(pageNumber);
    if (existing) {
      existing.shell = shell;
      existing.naturalWidth = naturalWidth;
      existing.naturalHeight = naturalHeight;
      this.intersectionObserver?.observe(shell);
      return existing;
    }

    const visibility = this.computeVisibility(pageNumber);
    const priority = derivePagePriority(visibility);
    const pdfRaster: PageLayerStatus = "idle";
    const stage = derivePageStage(visibility, pdfRaster);

    const record: ManagedPageRecord = {
      pageNumber,
      shell,
      visibility,
      priority,
      pdfRaster,
      textLayer: "idle",
      annotationLayer: "idle",
      inkOverlay: "unmounted",
      generation: 1,
      mountGeneration: 1,
      stage,
      naturalWidth,
      naturalHeight,
      renderedAtScale: undefined,
      renderedAtRotation: undefined
    };

    this.records.set(pageNumber, record);
    this.intersectionObserver?.observe(shell);
    return record;
  }

  unregisterPage(pageNumber: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    this.intersectionObserver?.unobserve(record.shell);
    this.records.delete(pageNumber);
    this.visiblePages.delete(pageNumber);
    this.renderQueuedPages.delete(pageNumber);
  }

  getRecord(pageNumber: number): ManagedPageRecord | undefined {
    return this.records.get(pageNumber);
  }

  getAllRecords(): ManagedPageRecord[] {
    return [...this.records.values()];
  }

  getPageNumbers(): number[] {
    return [...this.records.keys()].sort((a, b) => a - b);
  }

  hasPage(pageNumber: number): boolean {
    return this.records.has(pageNumber);
  }

  setActivePage(pageNumber: number): void {
    if (this.destroyed || !Number.isFinite(pageNumber)) return;
    const target = Math.max(1, Math.round(pageNumber));
    if (this.activePageNumber === target && this.records.has(target)) return;
    this.activePageNumber = target;
    this.recomputeAllVisibilities();
  }

  installIntersectionObserver(scrollRoot: HTMLElement, options?: { rootMargin?: string }): void {
    if (this.destroyed || typeof IntersectionObserver !== "function") return;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (!Number.isFinite(pageNumber)) continue;
        const isVisible = entry.isIntersecting || entry.intersectionRatio > 0;
        if (isVisible) {
          if (!this.visiblePages.has(pageNumber)) {
            this.visiblePages.add(pageNumber);
            changed = true;
          }
          this.requestRender(pageNumber);
        } else {
          if (this.visiblePages.has(pageNumber)) {
            this.visiblePages.delete(pageNumber);
            changed = true;
          }
        }
      }
      if (changed) {
        this.recomputeAllVisibilities();
      }
      this.evictOffscreenPages();
    }, { root: scrollRoot, rootMargin: options?.rootMargin ?? "800px 0px" });

    for (const record of this.records.values()) {
      this.intersectionObserver.observe(record.shell);
    }
  }

  disconnectObserver(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.visiblePages.clear();
  }

  getVisiblePages(): number[] {
    return [...this.records.values()]
      .filter((rec) => rec.visibility === "visible" || rec.visibility === "active")
      .map((rec) => rec.pageNumber)
      .sort((a, b) => a - b);
  }

  getNearbyPages(): number[] {
    return [...this.records.values()]
      .filter((rec) => rec.visibility === "nearby")
      .map((rec) => rec.pageNumber)
      .sort((a, b) => a - b);
  }

  getWorkingSet(): number[] {
    return [...this.records.values()]
      .filter((rec) => rec.visibility !== "cold")
      .map((rec) => rec.pageNumber)
      .sort((a, b) => a - b);
  }

  isPageVisible(pageNumber: number): boolean {
    const rec = this.records.get(pageNumber);
    return rec ? rec.visibility === "visible" || rec.visibility === "active" : false;
  }

  isPageActive(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.visibility === "active";
  }

  isPageNearby(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.visibility === "nearby";
  }

  isPageCold(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.visibility === "cold";
  }

  getStage(pageNumber: number): PageLifecycleStage | undefined {
    return this.records.get(pageNumber)?.stage;
  }

  getVisibility(pageNumber: number): PageVisibility | undefined {
    return this.records.get(pageNumber)?.visibility;
  }

  getPriority(pageNumber: number): PagePriority | undefined {
    return this.records.get(pageNumber)?.priority;
  }

  isReady(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.pdfRaster === "ready";
  }

  isRendering(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.pdfRaster === "rendering";
  }

  isEvicted(pageNumber: number): boolean {
    return this.records.get(pageNumber)?.pdfRaster === "evicted";
  }

  beginPdfRaster(pageNumber: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    this.updateRecordStage(record, { pdfRaster: "rendering" });
  }

  finishPdfRaster(pageNumber: number, success: boolean): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    this.updateRecordStage(record, { pdfRaster: success ? "ready" : "failed" });
  }

  beginTextLayer(pageNumber: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.textLayer = "rendering";
  }

  finishTextLayer(pageNumber: number, success: boolean): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.textLayer = success ? "ready" : "failed";
  }

  beginAnnotationLayer(pageNumber: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.annotationLayer = "rendering";
  }

  finishAnnotationLayer(pageNumber: number, success: boolean): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.annotationLayer = success ? "ready" : "failed";
  }

  setInkOverlayStatus(pageNumber: number, status: InkOverlayStatus): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.inkOverlay = status;
  }

  getInkOverlayStatus(pageNumber: number): InkOverlayStatus | undefined {
    return this.records.get(pageNumber)?.inkOverlay;
  }

  setRenderedGeometry(pageNumber: number, scale: number, rotation: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.renderedAtScale = scale;
    record.renderedAtRotation = rotation;
  }

  bumpGeneration(pageNumber: number): number {
    const record = this.records.get(pageNumber);
    if (!record) return 0;
    record.generation += 1;
    record.renderedAtScale = undefined;
    record.renderedAtRotation = undefined;
    this.updateRecordStage(record, {
      pdfRaster: "idle",
      textLayer: "idle",
      annotationLayer: "idle"
    });
    return record.generation;
  }

  bumpMountGeneration(pageNumber: number): number {
    const record = this.records.get(pageNumber);
    if (!record) return 0;
    record.mountGeneration += 1;
    return record.mountGeneration;
  }

  invalidatePage(pageNumber: number): void {
    this.bumpGeneration(pageNumber);
  }

  invalidateAllPages(): void {
    for (const pageNumber of this.records.keys()) {
      this.bumpGeneration(pageNumber);
    }
  }

  getEvictionCandidates(): ManagedPageRecord[] {
    const candidates: ManagedPageRecord[] = [];
    for (const record of this.records.values()) {
      if (record.visibility === "cold" && (record.renderedAtScale !== undefined || record.pdfRaster === "ready")) {
        candidates.push(record);
      }
    }
    return candidates;
  }

  markEvicted(pageNumber: number): void {
    const record = this.records.get(pageNumber);
    if (!record) return;
    record.renderedAtScale = undefined;
    record.renderedAtRotation = undefined;
    record.generation += 1;
    this.updateRecordStage(record, {
      pdfRaster: "evicted",
      textLayer: "evicted",
      annotationLayer: "evicted"
    });
  }

  evictOffscreenPages(customEvict?: (record: ManagedPageRecord) => void): number[] {
    const candidates = this.getEvictionCandidates();
    const evicted: number[] = [];
    const evictCallback = customEvict ?? this.onEvictPage;
    for (const record of candidates) {
      evictCallback?.(record);
      this.markEvicted(record.pageNumber);
      evicted.push(record.pageNumber);
    }
    return evicted;
  }

  isRenderQueued(pageNumber: number): boolean {
    return this.renderQueuedPages.has(pageNumber);
  }

  setRenderQueued(pageNumber: number, queued: boolean): void {
    if (queued) {
      this.renderQueuedPages.add(pageNumber);
    } else {
      this.renderQueuedPages.delete(pageNumber);
    }
  }

  requestRender(pageNumber: number): void {
    if (this.destroyed) return;
    const record = this.records.get(pageNumber);
    if (!record) return;
    this.onRenderRequested?.(pageNumber, record.priority);
  }

  onStageChange(listener: PageLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectObserver();
    this.records.clear();
    this.visiblePages.clear();
    this.renderQueuedPages.clear();
    this.listeners.clear();
  }

  private computeVisibility(pageNumber: number): PageVisibility {
    if (pageNumber === this.activePageNumber) {
      return "active";
    }
    if (this.visiblePages.has(pageNumber)) {
      return "visible";
    }
    if (Math.abs(pageNumber - this.activePageNumber) <= this.neighborRadius) {
      return "nearby";
    }
    return "cold";
  }

  private recomputeAllVisibilities(): void {
    for (const record of this.records.values()) {
      const visibility = this.computeVisibility(record.pageNumber);
      const priority = derivePagePriority(visibility);
      const previousStage = record.stage;
      record.visibility = visibility;
      record.priority = priority;
      record.stage = derivePageStage(visibility, record.pdfRaster);
      if (record.stage !== previousStage) {
        this.notifyStageChange(record, previousStage);
      }
    }
  }

  private updateRecordStage(
    record: ManagedPageRecord,
    changes: {
      pdfRaster?: PageLayerStatus;
      textLayer?: PageLayerStatus;
      annotationLayer?: PageLayerStatus;
    }
  ): void {
    const previousStage = record.stage;
    if (changes.pdfRaster !== undefined) record.pdfRaster = changes.pdfRaster;
    if (changes.textLayer !== undefined) record.textLayer = changes.textLayer;
    if (changes.annotationLayer !== undefined) record.annotationLayer = changes.annotationLayer;
    record.stage = derivePageStage(record.visibility, record.pdfRaster);
    if (record.stage !== previousStage) {
      this.notifyStageChange(record, previousStage);
    }
  }

  private notifyStageChange(record: ManagedPageRecord, previousStage: PageLifecycleStage): void {
    const event: PageLifecycleChangeEvent = {
      pageNumber: record.pageNumber,
      previousStage,
      currentStage: record.stage,
      record
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not break coordinator loop
      }
    }
  }
}
