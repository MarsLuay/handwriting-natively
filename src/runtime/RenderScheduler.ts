import type { PageLifecycleCoordinator } from "./PageLifecycleCoordinator";

export type RenderPriority = "immediate" | "high" | "medium" | "low";
export type RenderPhase = "movement" | "settled" | "idle";

export interface RenderJob {
  readonly id: string;
  readonly pageNumber: number;
  readonly priority: RenderPriority;
  readonly scale: number;
  readonly rotation: number;
  readonly dpr: number;
  readonly isQualityUpgrade: boolean;
  readonly requestedAt: number;
  resolve?: (() => void) | undefined;
  reject?: ((error: unknown) => void) | undefined;
  promise?: Promise<void> | undefined;
}

export interface RenderAbortSignal {
  readonly aborted: boolean;
  onAbort(callback: () => void): void;
}

export interface RenderMemoryBudget {
  maxRenderedPages?: number;
  maxTotalPixels?: number;
}

export interface RenderedPageRecord {
  pageNumber: number;
  scale: number;
  rotation: number;
  dpr: number;
  width: number;
  height: number;
  pixelCount: number;
  renderedAt: number;
}

export interface RenderSchedulerOptions {
  coordinator?: PageLifecycleCoordinator | undefined;
  maxRenderedPages?: number | undefined;
  maxTotalPixels?: number | undefined;
  settleTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  getDevicePixelRatio?: (() => number) | undefined;
  executeRender: (job: RenderJob, signal: RenderAbortSignal) => Promise<void>;
  onEvict?: ((pageNumber: number) => void) | undefined;
  onPhaseChange?: ((phase: RenderPhase) => void) | undefined;
}

interface ActiveJobController {
  readonly job: RenderJob;
  aborted: boolean;
  readonly callbacks: Array<() => void>;
  abort(): void;
}

export class RenderScheduler {
  private readonly coordinator: PageLifecycleCoordinator | undefined;
  private readonly maxRenderedPages: number;
  private readonly maxTotalPixels: number;
  private readonly settleTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly getDevicePixelRatio: () => number;
  private readonly executeRender: (job: RenderJob, signal: RenderAbortSignal) => Promise<void>;
  private readonly onEvict: ((pageNumber: number) => void) | undefined;
  private readonly onPhaseChange: ((phase: RenderPhase) => void) | undefined;

  private phase: RenderPhase = "settled";
  private currentScale = 1;
  private currentRotation = 0;
  private currentPageNumber = 1;
  private totalPages = 1;
  private lastScrollTop = 0;
  private lastScrollLeft = 0;
  private scrollDirection: "forward" | "backward" | "none" = "none";

  private readonly immediateQueue = new Map<number, RenderJob>();
  private readonly highQueue = new Map<number, RenderJob>();
  private readonly mediumQueue = new Map<number, RenderJob>();
  private readonly lowQueue = new Map<number, RenderJob>();

  private activeController: ActiveJobController | null = null;
  private readonly renderedPages = new Map<number, RenderedPageRecord>();

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isDraining = false;
  private destroyed = false;

  constructor(options: RenderSchedulerOptions) {
    this.coordinator = options.coordinator;
    this.maxRenderedPages = Math.max(2, options.maxRenderedPages ?? 8);
    this.maxTotalPixels = Math.max(1_000_000, options.maxTotalPixels ?? 80_000_000);
    this.settleTimeoutMs = Math.max(30, options.settleTimeoutMs ?? 120);
    this.idleTimeoutMs = Math.max(10, options.idleTimeoutMs ?? 40);
    this.getDevicePixelRatio = options.getDevicePixelRatio ?? (() => {
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
      return Math.max(1, Math.min(3, dpr || 1));
    });
    this.executeRender = options.executeRender;
    this.onEvict = options.onEvict;
    this.onPhaseChange = options.onPhaseChange;
  }

  getPhase(): RenderPhase {
    return this.phase;
  }

  getTargetDpr(): number {
    return this.getDevicePixelRatio();
  }

  getRenderedPage(pageNumber: number): Readonly<RenderedPageRecord> | undefined {
    return this.renderedPages.get(pageNumber);
  }

  getAllRenderedPages(): Readonly<RenderedPageRecord>[] {
    return [...this.renderedPages.values()];
  }

  isRenderQueued(pageNumber: number): boolean {
    return this.immediateQueue.has(pageNumber)
      || this.highQueue.has(pageNumber)
      || this.mediumQueue.has(pageNumber)
      || this.lowQueue.has(pageNumber);
  }

  getActiveJob(): RenderJob | null {
    return this.activeController?.job ?? null;
  }

  setDocumentGeometry(totalPages: number, scale: number, rotation: number, activePage: number): void {
    this.totalPages = Math.max(1, totalPages);
    this.currentPageNumber = Math.max(1, activePage);
    const geometryChanged = this.currentScale !== scale || this.currentRotation !== rotation;
    this.currentScale = scale;
    this.currentRotation = rotation;
    if (geometryChanged) {
      this.cancelObsoleteRenders();
    }
  }

  notifyMovement(_reason = "movement"): void {
    if (this.destroyed) return;
    if (this.phase !== "movement") {
      this.phase = "movement";
      this.onPhaseChange?.("movement");
      // Cancel active background work during movement so CPU/GPU stays clear for smooth scroll
      if (this.activeController && (this.activeController.job.priority === "low" || this.activeController.job.priority === "medium")) {
        this.activeController.abort();
      }
    }
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.notifySettled();
    }, this.settleTimeoutMs);
  }

  notifyScrollPosition(scrollTop: number, scrollLeft: number): void {
    if (this.destroyed) return;
    const deltaY = scrollTop - this.lastScrollTop;
    if (Math.abs(deltaY) > 4) {
      this.scrollDirection = deltaY > 0 ? "forward" : "backward";
    }
    this.lastScrollTop = scrollTop;
    this.lastScrollLeft = scrollLeft;
    this.notifyMovement("scroll");
    this.updatePredictedNextPage();
  }

  notifySettled(): void {
    if (this.destroyed) return;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.phase !== "settled") {
      this.phase = "settled";
      this.onPhaseChange?.("settled");
    }
    this.upgradeVisiblePagesToTargetResolution();
    this.updatePredictedNextPage();
    this.drainQueue();
  }

  notifyIdle(): void {
    if (this.destroyed || this.phase === "movement") return;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.phase !== "idle") {
      this.phase = "idle";
      this.onPhaseChange?.("idle");
    }
    this.scheduleQualityUpgrades();
    this.drainQueue();
  }

  notifyScale(scale: number, rotation: number): void {
    const geometryChanged = this.currentScale !== scale || this.currentRotation !== rotation;
    this.currentScale = scale;
    this.currentRotation = rotation;
    if (geometryChanged) {
      this.cancelObsoleteRenders();
      this.notifyMovement("scale");
    }
  }

  private priorityRank(priority: RenderPriority): number {
    switch (priority) {
      case "immediate": return 4;
      case "high": return 3;
      case "medium": return 2;
      case "low": return 1;
    }
  }

  requestPage(pageNumber: number, requestedPriority?: RenderPriority, forceDpr?: number): Promise<void> {
    if (this.destroyed || !Number.isFinite(pageNumber) || pageNumber < 1) return Promise.resolve();
    const priority = requestedPriority ?? this.derivePriorityForPage(pageNumber);
    const targetDpr = forceDpr ?? (this.phase === "movement" ? 1.0 : this.getTargetDpr());
    const isQualityUpgrade = priority === "low";

    const rendered = this.renderedPages.get(pageNumber);
    if (
      rendered
      && rendered.scale === this.currentScale
      && rendered.rotation === this.currentRotation
      && rendered.dpr >= targetDpr
      && !isQualityUpgrade
    ) {
      return Promise.resolve();
    }

    const existing = this.immediateQueue.get(pageNumber)
      ?? this.highQueue.get(pageNumber)
      ?? this.mediumQueue.get(pageNumber)
      ?? this.lowQueue.get(pageNumber);
    if (existing && existing.scale === this.currentScale && existing.rotation === this.currentRotation) {
      if (this.priorityRank(priority) > this.priorityRank(existing.priority)) {
        this.enqueueJob({ ...existing, priority, dpr: Math.max(existing.dpr, targetDpr) });
      }
      return existing.promise ?? Promise.resolve();
    }

    if (this.activeController && this.activeController.job.pageNumber === pageNumber) {
      if (this.activeController.job.scale === this.currentScale && this.activeController.job.rotation === this.currentRotation) {
        return this.activeController.job.promise ?? Promise.resolve();
      }
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const job: RenderJob = {
      id: `${pageNumber}:${this.currentScale}:${this.currentRotation}:${targetDpr}:${Date.now()}`,
      pageNumber,
      priority,
      scale: this.currentScale,
      rotation: this.currentRotation,
      dpr: targetDpr,
      isQualityUpgrade,
      requestedAt: Date.now(),
      resolve,
      reject,
      promise
    };

    this.enqueueJob(job);
    this.scheduleDrain();
    return promise;
  }

  private scheduleDrain(): void {
    if (this.destroyed) return;
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        void this.drainQueue();
      });
    } else {
      void Promise.resolve().then(() => this.drainQueue());
    }
  }

  requestPages(pageNumbers: readonly number[], priority?: RenderPriority): void {
    for (const pageNumber of pageNumbers) {
      void this.requestPage(pageNumber, priority);
    }
  }

  private derivePriorityForPage(pageNumber: number): RenderPriority {
    if (this.coordinator) {
      const rec = this.coordinator.getRecord(pageNumber);
      if (rec) {
        if (rec.visibility === "active" || rec.visibility === "visible") return "immediate";
        if (rec.visibility === "nearby") return "high";
      }
    }
    if (pageNumber === this.currentPageNumber) return "immediate";
    if (Math.abs(pageNumber - this.currentPageNumber) <= 2) return "high";
    return "medium";
  }

  private enqueueJob(job: RenderJob): void {
    // Remove from lower queues to ensure promotion
    this.immediateQueue.delete(job.pageNumber);
    this.highQueue.delete(job.pageNumber);
    this.mediumQueue.delete(job.pageNumber);
    this.lowQueue.delete(job.pageNumber);

    switch (job.priority) {
      case "immediate":
        this.immediateQueue.set(job.pageNumber, job);
        // Preempt active background job immediately
        if (this.activeController) {
          const activePriority = this.activeController.job.priority;
          if (activePriority === "low" || activePriority === "medium") {
            this.activeController.abort();
          }
        }
        break;
      case "high":
        this.highQueue.set(job.pageNumber, job);
        break;
      case "medium":
        this.mediumQueue.set(job.pageNumber, job);
        break;
      case "low":
        this.lowQueue.set(job.pageNumber, job);
        break;
    }

    this.coordinator?.setRenderQueued(job.pageNumber, true);
  }

  private updatePredictedNextPage(): void {
    if (this.scrollDirection === "none" || this.phase === "movement") return;
    const predicted = this.scrollDirection === "forward"
      ? Math.min(this.totalPages, this.currentPageNumber + 1)
      : Math.max(1, this.currentPageNumber - 1);

    if (predicted === this.currentPageNumber) return;
    const rendered = this.renderedPages.get(predicted);
    if (!rendered || rendered.scale !== this.currentScale || rendered.rotation !== this.currentRotation) {
      if (!this.immediateQueue.has(predicted) && !this.highQueue.has(predicted)) {
        this.requestPage(predicted, "medium");
      }
    }
  }

  private scheduleQualityUpgrades(): void {
    const targetDpr = this.getTargetDpr();
    for (const [pageNumber, record] of this.renderedPages) {
      if (
        record.scale === this.currentScale
        && record.rotation === this.currentRotation
        && record.dpr < targetDpr
      ) {
        if (!this.isRenderQueued(pageNumber)) {
          this.requestPage(pageNumber, "low", targetDpr);
        }
      }
    }
  }

  private upgradeVisiblePagesToTargetResolution(): void {
    const targetDpr = this.getTargetDpr();
    const visiblePages = this.coordinator?.getVisiblePages() ?? [this.currentPageNumber];
    for (const pageNumber of visiblePages) {
      const rendered = this.renderedPages.get(pageNumber);
      if (
        !rendered
        || rendered.scale !== this.currentScale
        || rendered.rotation !== this.currentRotation
        || rendered.dpr < targetDpr
      ) {
        void this.requestPage(pageNumber, "immediate", targetDpr);
      }
    }
  }

  cancelObsoleteRenders(): void {
    if (this.activeController) {
      const active = this.activeController.job;
      if (active.scale !== this.currentScale || active.rotation !== this.currentRotation) {
        this.activeController.abort();
      }
    }

    const filterQueue = (queue: Map<number, RenderJob>): void => {
      for (const [pageNumber, job] of queue) {
        if (job.scale !== this.currentScale || job.rotation !== this.currentRotation) {
          queue.delete(pageNumber);
          this.coordinator?.setRenderQueued(pageNumber, false);
          job.resolve?.();
        }
      }
    };

    filterQueue(this.immediateQueue);
    filterQueue(this.highQueue);
    filterQueue(this.mediumQueue);
    filterQueue(this.lowQueue);
  }

  private pickNextJob(): RenderJob | null {
    // 1. Immediate priority jobs (active/visible) always run first
    if (this.immediateQueue.size > 0) {
      const [firstKey, firstJob] = this.immediateQueue.entries().next().value as [number, RenderJob];
      this.immediateQueue.delete(firstKey);
      return firstJob;
    }

    // 2. High priority jobs run when not moving (or settled/idle)
    if (this.highQueue.size > 0 && this.phase !== "movement") {
      const [firstKey, firstJob] = this.highQueue.entries().next().value as [number, RenderJob];
      this.highQueue.delete(firstKey);
      return firstJob;
    }

    // 3. Medium & low priority run only in idle phase
    if (this.phase === "idle") {
      if (this.mediumQueue.size > 0) {
        const [firstKey, firstJob] = this.mediumQueue.entries().next().value as [number, RenderJob];
        this.mediumQueue.delete(firstKey);
        return firstJob;
      }
      if (this.lowQueue.size > 0) {
        const [firstKey, firstJob] = this.lowQueue.entries().next().value as [number, RenderJob];
        this.lowQueue.delete(firstKey);
        return firstJob;
      }
    }

    return null;
  }

  private async drainQueue(): Promise<void> {
    if (this.destroyed || this.isDraining) return;
    this.isDraining = true;

    try {
      while (!this.destroyed) {
        // Preemption check: if active job is background and an immediate job arrived, abort active job!
        if (this.activeController && this.immediateQueue.size > 0) {
          const activePriority = this.activeController.job.priority;
          if (activePriority === "low" || activePriority === "medium") {
            this.activeController.abort();
          }
        }

        if (this.activeController) {
          break; // Wait for active render to finish
        }

        const job = this.pickNextJob();
        if (!job) {
          // If all immediate and high jobs finished and settled, schedule transition to idle
          if (this.immediateQueue.size === 0 && this.highQueue.size === 0 && this.phase === "settled") {
            this.scheduleIdleTransition();
          }
          break;
        }

        await this.runJob(job);
      }
    } finally {
      this.isDraining = false;
    }
  }

  private scheduleIdleTransition(): void {
    if (this.destroyed || this.phase !== "settled") return;
    if (this.immediateQueue.size > 0 || this.highQueue.size > 0) return;
    if (this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.destroyed && this.phase === "settled") {
        this.notifyIdle();
      }
    }, this.idleTimeoutMs);
  }

  private async runJob(job: RenderJob): Promise<void> {
    const controller = this.createAbortController(job);
    this.activeController = controller;

    try {
      const signal: RenderAbortSignal = {
        get aborted() {
          return controller.aborted;
        },
        onAbort: (fn) => {
          if (controller.aborted) fn();
          else controller.callbacks.push(fn);
        }
      };

      await this.executeRender(job, signal);

      if (!controller.aborted) {
        this.coordinator?.setRenderQueued(job.pageNumber, false);
        this.recordRenderSuccess(job);
        this.enforceMemoryBudget();
      }
      job.resolve?.();
    } catch (error) {
      job.reject?.(error);
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private createAbortController(job: RenderJob): ActiveJobController {
    const callbacks: Array<() => void> = [];
    const controller: ActiveJobController = {
      job,
      aborted: false,
      callbacks,
      abort: () => {
        if (controller.aborted) return;
        controller.aborted = true;
        for (const cb of callbacks) {
          try {
            cb();
          } catch {
            // Abort callbacks must not throw
          }
        }
      }
    };
    return controller;
  }

  private recordRenderSuccess(job: RenderJob): void {
    const rec = this.coordinator?.getRecord(job.pageNumber);
    const naturalWidth = rec?.naturalWidth ?? 600;
    const naturalHeight = rec?.naturalHeight ?? 800;
    const pixelWidth = Math.ceil(naturalWidth * job.scale * job.dpr);
    const pixelHeight = Math.ceil(naturalHeight * job.scale * job.dpr);
    const pixelCount = pixelWidth * pixelHeight;

    this.renderedPages.set(job.pageNumber, {
      pageNumber: job.pageNumber,
      scale: job.scale,
      rotation: job.rotation,
      dpr: job.dpr,
      width: pixelWidth,
      height: pixelHeight,
      pixelCount,
      renderedAt: Date.now()
    });
  }

  enforceMemoryBudget(): void {
    let totalPixels = 0;
    for (const r of this.renderedPages.values()) totalPixels += r.pixelCount;
    if (this.renderedPages.size <= this.maxRenderedPages && totalPixels <= this.maxTotalPixels) return;

    // Determine eviction priority:
    // 1. Never evict active or visible pages
    // 2. Cold pages first, ordered by distance from active page (farthest first)
    // 3. LRU tie-breaker (oldest renderedAt first)
    const candidates = [...this.renderedPages.values()].filter((record) => {
      if (this.coordinator) {
        const pageRec = this.coordinator.getRecord(record.pageNumber);
        if (pageRec && (pageRec.visibility === "active" || pageRec.visibility === "visible")) {
          return false;
        }
      }
      return record.pageNumber !== this.currentPageNumber;
    });

    candidates.sort((a, b) => {
      const aIsCold = this.coordinator?.isPageCold(a.pageNumber) ?? true;
      const bIsCold = this.coordinator?.isPageCold(b.pageNumber) ?? true;
      if (aIsCold !== bIsCold) return aIsCold ? -1 : 1;

      const distA = Math.abs(a.pageNumber - this.currentPageNumber);
      const distB = Math.abs(b.pageNumber - this.currentPageNumber);
      if (distA !== distB) return distB - distA; // Farthest first

      return a.renderedAt - b.renderedAt; // LRU
    });

    for (const candidate of candidates) {
      if (this.renderedPages.size <= this.maxRenderedPages && totalPixels <= this.maxTotalPixels) {
        break;
      }
      this.renderedPages.delete(candidate.pageNumber);
      totalPixels -= candidate.pixelCount;
      this.onEvict?.(candidate.pageNumber);
    }
  }

  evictPage(pageNumber: number, notify = true): boolean {
    const record = this.renderedPages.get(pageNumber);
    if (!record) return false;
    this.renderedPages.delete(pageNumber);
    if (notify) {
      this.onEvict?.(pageNumber);
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    for (const job of this.immediateQueue.values()) job.resolve?.();
    for (const job of this.highQueue.values()) job.resolve?.();
    for (const job of this.mediumQueue.values()) job.resolve?.();
    for (const job of this.lowQueue.values()) job.resolve?.();
    this.immediateQueue.clear();
    this.highQueue.clear();
    this.mediumQueue.clear();
    this.lowQueue.clear();
    this.renderedPages.clear();
  }
}
