import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RenderScheduler,
  type RenderJob,
  type RenderAbortSignal
} from "../src/runtime/RenderScheduler";
import { PageLifecycleCoordinator } from "../src/runtime/PageLifecycleCoordinator";

describe("RenderScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes priority queues in order: immediate -> high -> medium -> low", async () => {
    const executedPages: number[] = [];
    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      settleTimeoutMs: 50,
      idleTimeoutMs: 40,
      getDevicePixelRatio: () => 2,
      executeRender: async (job: RenderJob) => {
        executedPages.push(job.pageNumber);
      }
    });

    scheduler.setDocumentGeometry(10, 1, 0, 1);

    // Queue in reverse priority order
    void scheduler.requestPage(4, "low");
    void scheduler.requestPage(3, "medium");
    void scheduler.requestPage(2, "high");
    void scheduler.requestPage(1, "immediate");

    // Allow immediate and high to run
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executedPages.slice(0, 2)).toEqual([1, 2]);

    // Transition to idle by waiting for idle timeout
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(executedPages).toEqual([1, 2, 3, 4]);
    scheduler.destroy();
  });

  it("preempts active low/medium background jobs when an immediate job arrives", async () => {
    let cancelCalled = false;
    let resolveLowJob!: () => void;
    const executedPages: number[] = [];

    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 2,
      executeRender: async (job: RenderJob, signal: RenderAbortSignal) => {
        executedPages.push(job.pageNumber);
        if (job.priority === "low") {
          signal.onAbort(() => {
            cancelCalled = true;
          });
          await new Promise<void>((res) => {
            resolveLowJob = res;
          });
        }
      }
    });

    scheduler.setDocumentGeometry(10, 1, 0, 1);
    scheduler.notifyIdle();

    // Start a low priority job
    void scheduler.requestPage(5, "low");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executedPages).toEqual([5]);
    expect(cancelCalled).toBe(false);

    // Now an immediate job arrives
    void scheduler.requestPage(1, "immediate");
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Low job should have received abort signal immediately
    expect(cancelCalled).toBe(true);

    // Once the low job wraps up its aborted state
    resolveLowJob();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Immediate job runs immediately
    expect(executedPages).toEqual([5, 1]);
    scheduler.destroy();
  });

  it("renders at 1.0 DPR during movement phase and upgrades visible pages to target DPR upon settle", async () => {
    const renders: Array<{ page: number; dpr: number; priority: string }> = [];

    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      settleTimeoutMs: 40,
      idleTimeoutMs: 120,
      getDevicePixelRatio: () => 2,
      executeRender: async (job: RenderJob) => {
        renders.push({ page: job.pageNumber, dpr: job.dpr, priority: job.priority });
      }
    });

    scheduler.setDocumentGeometry(5, 1, 0, 1);

    // Notify scroll movement
    scheduler.notifyMovement("scroll");
    expect(scheduler.getPhase()).toBe("movement");

    // Request visible page during movement
    void scheduler.requestPage(1, "immediate");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(renders).toHaveLength(1);
    expect(renders[0]?.page).toBe(1);
    expect(renders[0]?.dpr).toBe(1.0); // Cheap preview during movement

    // Viewport settles after 40ms
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scheduler.getPhase()).toBe("settled");

    // Settling should have re-requested visible page 1 at target resolution (2.0 DPR)
    expect(renders).toHaveLength(2);
    expect(renders[1]?.page).toBe(1);
    expect(renders[1]?.dpr).toBe(2);

    scheduler.destroy();
  });

  it("cancels obsolete queued and in-flight renders on zoom/rotation change", async () => {
    let cancelCalled = false;
    let resolveActiveJob!: () => void;
    const executedScales: number[] = [];

    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 2,
      executeRender: async (job: RenderJob, signal: RenderAbortSignal) => {
        executedScales.push(job.scale);
        if (job.scale === 1.0) {
          signal.onAbort(() => {
            cancelCalled = true;
          });
          await new Promise<void>((res) => {
            resolveActiveJob = res;
          });
        }
      }
    });

    scheduler.setDocumentGeometry(10, 1.0, 0, 1);
    void scheduler.requestPage(1, "immediate");
    void scheduler.requestPage(2, "high");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executedScales).toEqual([1.0]);

    // Zoom occurs to scale 1.5
    scheduler.notifyScale(1.5, 0);

    // In-flight job at scale 1.0 should be aborted
    expect(cancelCalled).toBe(true);

    // Old high job for page 2 at scale 1.0 should have been cancelled from queue
    expect(scheduler.isRenderQueued(2)).toBe(false);

    // Queue page 1 at new scale 1.5
    void scheduler.requestPage(1, "immediate");
    resolveActiveJob();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executedScales).toEqual([1.0, 1.5]);
    scheduler.destroy();
  });

  it("enforces memory budget by evicting cold pages farthest from active page first", async () => {
    const evictedPages: number[] = [];
    const scheduler = new RenderScheduler({
      maxRenderedPages: 3,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 1,
      executeRender: async () => {},
      onEvict: (pageNumber) => {
        evictedPages.push(pageNumber);
      }
    });

    // 10 pages total, active page is page 1
    scheduler.setDocumentGeometry(10, 1, 0, 1);

    // Render pages 1, 2, 3 (budget of 3 rendered pages is reached)
    await scheduler.requestPage(1, "immediate");
    await scheduler.requestPage(2, "high");
    await scheduler.requestPage(3, "high");
    expect(evictedPages).toHaveLength(0);

    // User navigates forward: active page is now page 10
    scheduler.setDocumentGeometry(10, 1, 0, 10);
    // Render page 10 (immediate) -> budget exceeded (4 pages).
    // Candidates to evict: pages 1, 2, 3.
    // Distance from active page 10: page 1 (dist 9), page 2 (dist 8), page 3 (dist 7).
    // Farthest candidate from 10 is page 1!
    await scheduler.requestPage(10, "immediate");
    expect(evictedPages).toEqual([1]);

    // Render page 9 (high) -> budget exceeded again.
    // Farthest candidate from 10 among remaining (2, 3) is page 2!
    await scheduler.requestPage(9, "high");
    expect(evictedPages).toEqual([1, 2]);

    // Rendered set still retains page 10 (dist 0), 9 (dist 1), 3 (dist 7)
    expect(scheduler.getRenderedPage(10)).toBeDefined();
    expect(scheduler.getRenderedPage(9)).toBeDefined();
    expect(scheduler.getRenderedPage(3)).toBeDefined();
    expect(scheduler.getRenderedPage(1)).toBeUndefined();
    expect(scheduler.getRenderedPage(2)).toBeUndefined();

    scheduler.destroy();
  });

  it("enforces pixel count budget and evicts when total pixels exceed maxTotalPixels", async () => {
    const evictedPages: number[] = [];
    // Each page 600x800 = 480,000 pixels.
    // Budget 1,000,000 pixels holds at most 2 pages.
    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      maxTotalPixels: 1_000_000,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 1,
      executeRender: async () => {},
      onEvict: (pageNumber) => {
        evictedPages.push(pageNumber);
      }
    });

    scheduler.setDocumentGeometry(10, 1, 0, 1);

    await scheduler.requestPage(1, "immediate");
    await scheduler.requestPage(2, "high");
    expect(evictedPages).toHaveLength(0);

    // 3rd page exceeds 1,000,000 pixels (3 * 480,000 = 1,440,000)
    await scheduler.requestPage(3, "high");
    expect(evictedPages).toHaveLength(1);
    expect(evictedPages[0]).toBe(3); // Farthest from active page 1

    scheduler.destroy();
  });

  it("coordinates with PageLifecycleCoordinator for visibility priorities and tracking", async () => {
    const coordinator = new PageLifecycleCoordinator({
      neighborRadius: 1,
      totalPages: 5,
      initialActivePage: 1
    });

    // Register pages
    const shell1 = document.createElement("div");
    const shell2 = document.createElement("div");
    const shell3 = document.createElement("div");
    coordinator.registerPage({ pageNumber: 1, shell: shell1, naturalWidth: 600, naturalHeight: 800 });
    coordinator.registerPage({ pageNumber: 2, shell: shell2, naturalWidth: 600, naturalHeight: 800 });
    coordinator.registerPage({ pageNumber: 3, shell: shell3, naturalWidth: 600, naturalHeight: 800 });

    const queueFlags: Array<{ page: number; queued: boolean }> = [];
    const scheduler = new RenderScheduler({
      coordinator,
      maxRenderedPages: 10,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 1,
      executeRender: async (job: RenderJob) => {
        queueFlags.push({ page: job.pageNumber, queued: coordinator.isRenderQueued(job.pageNumber) });
      }
    });

    scheduler.setDocumentGeometry(5, 1, 0, 1);

    // Requesting page 1 (active) -> derived priority is immediate
    await scheduler.requestPage(1);
    expect(queueFlags).toHaveLength(1);
    expect(queueFlags[0]).toEqual({ page: 1, queued: true });
    // After render completes, coordinator queue flag is reset
    expect(coordinator.isRenderQueued(1)).toBe(false);

    scheduler.destroy();
  });

  it("schedules quality upgrades for lower DPR rendered pages during idle phase", async () => {
    const renders: Array<{ page: number; dpr: number }> = [];

    const scheduler = new RenderScheduler({
      maxRenderedPages: 10,
      settleTimeoutMs: 50,
      getDevicePixelRatio: () => 2,
      executeRender: async (job: RenderJob) => {
        renders.push({ page: job.pageNumber, dpr: job.dpr });
      }
    });

    scheduler.setDocumentGeometry(5, 1, 0, 1);

    // Force DPR 1.0 preview render for page 2
    await scheduler.requestPage(2, "high", 1.0);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toEqual({ page: 2, dpr: 1.0 });

    // Transition to idle
    scheduler.notifyIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Page 2 should have been upgraded to DPR 2.0
    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual({ page: 2, dpr: 2.0 });

    scheduler.destroy();
  });
});
