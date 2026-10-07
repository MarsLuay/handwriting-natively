import { describe, expect, it, vi } from "vitest";
import {
  PageLifecycleCoordinator,
  derivePagePriority,
  derivePageStage,
  type PageLifecycleChangeEvent
} from "../src/runtime/PageLifecycleCoordinator";

describe("PageLifecycleCoordinator", () => {
  it("derives correct priorities and stages for all visibility and layer states", () => {
    expect(derivePagePriority("active")).toBe("immediate");
    expect(derivePagePriority("visible")).toBe("immediate");
    expect(derivePagePriority("nearby")).toBe("normal");
    expect(derivePagePriority("cold")).toBe("idle");

    expect(derivePageStage("active", "idle")).toBe("active");
    expect(derivePageStage("visible", "idle")).toBe("visible");
    expect(derivePageStage("nearby", "idle")).toBe("nearby");
    expect(derivePageStage("cold", "idle")).toBe("cold");

    expect(derivePageStage("active", "rendering")).toBe("rendering");
    expect(derivePageStage("visible", "rendering")).toBe("rendering");
    expect(derivePageStage("nearby", "rendering")).toBe("rendering");
    expect(derivePageStage("cold", "rendering")).toBe("rendering");

    expect(derivePageStage("active", "ready")).toBe("ready");
    expect(derivePageStage("visible", "ready")).toBe("ready");
    expect(derivePageStage("nearby", "ready")).toBe("ready");
    expect(derivePageStage("cold", "ready")).toBe("ready");

    expect(derivePageStage("cold", "evicted")).toBe("evicted");
    expect(derivePageStage("nearby", "evicted")).toBe("evicted");
  });

  it("manages registered page records with correct initial state hierarchy", () => {
    const coordinator = new PageLifecycleCoordinator({
      neighborRadius: 2,
      totalPages: 5,
      initialActivePage: 1
    });

    const shell1 = document.createElement("section");
    shell1.dataset.pageNumber = "1";
    const shell2 = document.createElement("section");
    shell2.dataset.pageNumber = "2";
    const shell5 = document.createElement("section");
    shell5.dataset.pageNumber = "5";

    const rec1 = coordinator.registerPage({ pageNumber: 1, shell: shell1, naturalWidth: 600, naturalHeight: 800 });
    const rec2 = coordinator.registerPage({ pageNumber: 2, shell: shell2, naturalWidth: 600, naturalHeight: 800 });
    const rec5 = coordinator.registerPage({ pageNumber: 5, shell: shell5, naturalWidth: 600, naturalHeight: 800 });

    expect(rec1.visibility).toBe("active");
    expect(rec1.priority).toBe("immediate");
    expect(rec1.stage).toBe("active");
    expect(rec1.pdfRaster).toBe("idle");
    expect(rec1.textLayer).toBe("idle");
    expect(rec1.annotationLayer).toBe("idle");
    expect(rec1.inkOverlay).toBe("unmounted");
    expect(rec1.generation).toBe(1);
    expect(rec1.mountGeneration).toBe(1);

    expect(rec2.visibility).toBe("nearby");
    expect(rec2.priority).toBe("normal");
    expect(rec2.stage).toBe("nearby");

    expect(rec5.visibility).toBe("cold");
    expect(rec5.priority).toBe("idle");
    expect(rec5.stage).toBe("cold");

    expect(coordinator.getActivePage()).toBe(1);
    expect(coordinator.getVisiblePages()).toEqual([1]);
    expect(coordinator.getNearbyPages()).toEqual([2]);
    expect(coordinator.getWorkingSet()).toEqual([1, 2]);
    expect(coordinator.isPageActive(1)).toBe(true);
    expect(coordinator.isPageNearby(2)).toBe(true);
    expect(coordinator.isPageCold(5)).toBe(true);
  });

  it("transitions active page and notifies stage change listeners", () => {
    const coordinator = new PageLifecycleCoordinator({
      neighborRadius: 1,
      totalPages: 4,
      initialActivePage: 1
    });

    const events: PageLifecycleChangeEvent[] = [];
    coordinator.onStageChange((event) => {
      events.push(event);
    });

    const shells = [1, 2, 3, 4].map((pageNumber) => {
      const shell = document.createElement("section");
      shell.dataset.pageNumber = String(pageNumber);
      return coordinator.registerPage({ pageNumber, shell, naturalWidth: 600, naturalHeight: 800 });
    });

    coordinator.setActivePage(3);
    expect(coordinator.getActivePage()).toBe(3);
    expect(coordinator.getVisibility(1)).toBe("cold");
    expect(coordinator.getVisibility(2)).toBe("nearby");
    expect(coordinator.getVisibility(3)).toBe("active");
    expect(coordinator.getVisibility(4)).toBe("nearby");

    expect(coordinator.getPriority(3)).toBe("immediate");
    expect(coordinator.getPriority(2)).toBe("normal");
    expect(coordinator.getPriority(1)).toBe("idle");

    expect(events.length).toBeGreaterThan(0);
  });

  it("coordinates rendering lifecycle, layer readiness, and ink overlay mounting", () => {
    const coordinator = new PageLifecycleCoordinator({ totalPages: 3 });
    const shell = document.createElement("section");
    shell.dataset.pageNumber = "1";
    coordinator.registerPage({ pageNumber: 1, shell, naturalWidth: 600, naturalHeight: 800 });

    expect(coordinator.getStage(1)).toBe("active");

    coordinator.beginPdfRaster(1);
    expect(coordinator.isRendering(1)).toBe(true);
    expect(coordinator.getStage(1)).toBe("rendering");

    coordinator.finishPdfRaster(1, true);
    expect(coordinator.isReady(1)).toBe(true);
    expect(coordinator.getStage(1)).toBe("ready");

    coordinator.beginTextLayer(1);
    expect(coordinator.getRecord(1)?.textLayer).toBe("rendering");
    coordinator.finishTextLayer(1, true);
    expect(coordinator.getRecord(1)?.textLayer).toBe("ready");

    coordinator.beginAnnotationLayer(1);
    expect(coordinator.getRecord(1)?.annotationLayer).toBe("rendering");
    coordinator.finishAnnotationLayer(1, true);
    expect(coordinator.getRecord(1)?.annotationLayer).toBe("ready");

    coordinator.setInkOverlayStatus(1, "mounting");
    expect(coordinator.getInkOverlayStatus(1)).toBe("mounting");
    coordinator.setInkOverlayStatus(1, "mounted");
    expect(coordinator.getInkOverlayStatus(1)).toBe("mounted");

    coordinator.setRenderedGeometry(1, 1.5, 0);
    expect(coordinator.getRecord(1)?.renderedAtScale).toBe(1.5);
    expect(coordinator.getRecord(1)?.renderedAtRotation).toBe(0);
  });

  it("handles generations and invalidations cleanly", () => {
    const coordinator = new PageLifecycleCoordinator({ totalPages: 2 });
    const shell = document.createElement("section");
    coordinator.registerPage({ pageNumber: 1, shell, naturalWidth: 600, naturalHeight: 800 });

    coordinator.beginPdfRaster(1);
    coordinator.finishPdfRaster(1, true);
    coordinator.setRenderedGeometry(1, 1, 0);
    expect(coordinator.isReady(1)).toBe(true);

    const nextGen = coordinator.bumpGeneration(1);
    expect(nextGen).toBe(2);
    expect(coordinator.getRecord(1)?.generation).toBe(2);
    expect(coordinator.getRecord(1)?.renderedAtScale).toBeUndefined();
    expect(coordinator.getRecord(1)?.pdfRaster).toBe("idle");
    expect(coordinator.getStage(1)).toBe("active");

    const nextMount = coordinator.bumpMountGeneration(1);
    expect(nextMount).toBe(2);
    expect(coordinator.getRecord(1)?.mountGeneration).toBe(2);
  });

  it("correctly identifies eviction candidates and evicts offscreen pages", () => {
    const coordinator = new PageLifecycleCoordinator({
      neighborRadius: 1,
      totalPages: 10,
      initialActivePage: 1
    });

    for (let p = 1; p <= 10; p += 1) {
      const shell = document.createElement("section");
      shell.dataset.pageNumber = String(p);
      coordinator.registerPage({ pageNumber: p, shell, naturalWidth: 600, naturalHeight: 800 });
    }

    // Render pages 1 and 6
    coordinator.beginPdfRaster(1);
    coordinator.finishPdfRaster(1, true);
    coordinator.setRenderedGeometry(1, 1, 0);

    coordinator.beginPdfRaster(6);
    coordinator.finishPdfRaster(6, true);
    coordinator.setRenderedGeometry(6, 1, 0);

    // Active page is 1. Page 6 is cold (outside neighbor radius 1).
    expect(coordinator.getVisibility(6)).toBe("cold");
    const candidates = coordinator.getEvictionCandidates();
    expect(candidates.map((c) => c.pageNumber)).toEqual([6]);

    const evictedRecords: number[] = [];
    const evictedNumbers = coordinator.evictOffscreenPages((rec) => {
      evictedRecords.push(rec.pageNumber);
    });

    expect(evictedNumbers).toEqual([6]);
    expect(evictedRecords).toEqual([6]);
    expect(coordinator.isEvicted(6)).toBe(true);
    expect(coordinator.getStage(6)).toBe("evicted");
    expect(coordinator.getRecord(6)?.renderedAtScale).toBeUndefined();
  });

  it("supports intersection observer simulation with visibility updates and render requests", () => {
    let observerCallback: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    class MockIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        observerCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const requestedRenders: number[] = [];
    const coordinator = new PageLifecycleCoordinator({
      neighborRadius: 1,
      totalPages: 5,
      initialActivePage: 1,
      onRenderRequested: (pageNumber) => {
        requestedRenders.push(pageNumber);
      }
    });

    const scrollRoot = document.createElement("div");
    coordinator.installIntersectionObserver(scrollRoot);

    const shell1 = document.createElement("section");
    shell1.dataset.pageNumber = "1";
    const shell3 = document.createElement("section");
    shell3.dataset.pageNumber = "3";
    coordinator.registerPage({ pageNumber: 1, shell: shell1, naturalWidth: 600, naturalHeight: 800 });
    coordinator.registerPage({ pageNumber: 3, shell: shell3, naturalWidth: 600, naturalHeight: 800 });

    expect(observerCallback).toBeDefined();

    // Simulate page 3 scrolling into viewport
    observerCallback!([
      { target: shell3, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry
    ]);

    expect(coordinator.isPageVisible(3)).toBe(true);
    expect(coordinator.getPriority(3)).toBe("immediate");
    expect(requestedRenders).toContain(3);

    // Simulate page 3 leaving viewport
    observerCallback!([
      { target: shell3, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry
    ]);

    expect(coordinator.isPageVisible(3)).toBe(false);
    expect(coordinator.getVisibility(3)).toBe("cold");

    coordinator.destroy();
    vi.unstubAllGlobals();
  });
});
