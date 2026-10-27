import { describe, expect, it, vi } from "vitest";
import { SinglePageSurfaceAdapter } from "../src/integration/SinglePageSurfaceAdapter";
import type { AnnotationPageInfo } from "../src/runtime/AnnotationSurface";

class TestSinglePageAdapter extends SinglePageSurfaceAdapter {
  readonly surfaceType = "markdown" as const;
  private readonly scaleValue: number;

  constructor(
    host: HTMLElement,
    pageElement: HTMLElement,
    callbacks = {},
    scale = 1
  ) {
    super(host, pageElement, callbacks, pageElement);
    this.scaleValue = scale;
  }

  protected pageInfo(): AnnotationPageInfo {
    return {
      pageNumber: 1,
      width: 800,
      height: 1200,
      scale: this.scaleValue,
      rotation: 0,
      coordinateOrigin: "top-left",
      element: this.pageElement
    };
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return { errors: [], warnings: [] };
  }

  public testScheduleGeometryRefresh(reason: string): void {
    this.scheduleGeometryRefresh(reason);
  }
}

describe("SinglePageSurfaceAdapter", () => {
  it("discovers nearest scroll container and calculates viewport state", () => {
    const host = document.createElement("div");
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const page = document.createElement("div");
    scroller.append(page);
    host.append(scroller);

    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
    scroller.scrollTop = 300;
    scroller.scrollLeft = 50;

    const adapter = new TestSinglePageAdapter(host, page, {}, 1.5);
    expect(adapter.scrollElement()).toBe(scroller);

    const viewState = adapter.getViewState();
    expect(viewState.pageNumber).toBe(1);
    expect(viewState.scale).toBe(1.5);
    expect(viewState.viewport?.x).toBe(50);
    expect(viewState.viewport?.y).toBe(300);
    expect(viewState.scrollFraction).toBeCloseTo(300 / 1200);

    expect(adapter.pages()).toHaveLength(1);
    expect(adapter.page(1)?.pageNumber).toBe(1);
    expect(adapter.page(2)).toBeUndefined();
  });

  it("restores scroll position and manages overlay mount lifecycle", () => {
    const host = document.createElement("div");
    const page = document.createElement("div");
    host.style.overflow = "scroll";
    host.append(page);
    Object.defineProperty(host, "scrollHeight", { value: 1600, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });

    const adapter = new TestSinglePageAdapter(host, page);
    adapter.restoreViewState({
      pageNumber: 1,
      viewport: { scale: 1, x: 20, y: 150 },
      scale: 1,
      rotation: 0,
      scaleMode: "custom"
    });
    expect(host.scrollLeft).toBe(20);
    expect(host.scrollTop).toBe(150);

    const overlay = adapter.mountOverlay(1);
    expect(overlay.parentElement).toBe(page);
    expect(overlay.classList.contains("native-pdf-handwriting-page-overlay")).toBe(true);
    expect(overlay.dataset.pageNumber).toBe("1");
    expect(overlay.dataset.surfaceType).toBe("markdown");
    expect(() => adapter.mountOverlay(2)).toThrow(/page 2 is unavailable/);

    const toolbar = document.createElement("div");
    adapter.mountToolbar(toolbar);
    expect(toolbar.parentElement).toBe(host);
    expect(toolbar.classList.contains("is-main")).toBe(true);

    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
  });

  it("schedules geometry refreshes when layout changes", async () => {
    const host = document.createElement("div");
    const page = document.createElement("div");
    host.append(page);
    const onPagesChanged = vi.fn();
    const adapter = new TestSinglePageAdapter(host, page, { onPagesChanged });

    // Mock getBoundingClientRect on page to simulate resize
    let width = 400;
    let height = 600;
    page.getBoundingClientRect = () => ({
      width,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    width = 500;
    height = 700;
    adapter.testScheduleGeometryRefresh("test-resize");

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(onPagesChanged).toHaveBeenCalledWith("test-resize");

    adapter.destroy();
  });
});
