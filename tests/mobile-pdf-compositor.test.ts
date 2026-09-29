import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePdfCompositor } from "../src/integration/MobilePdfCompositor";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function page(number: number, visible: boolean, left = 0): { element: HTMLElement; overlay: HTMLElement; pageNumber: number; visible: boolean } {
  const element = document.createElement("div");
  const overlay = document.createElement("div");
  element.append(overlay);
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(left, number * 100, 600, 800)
  });
  return { element, overlay, pageNumber: number, visible };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("mobile PDF compositor", () => {
  it("transforms only visible page content and cleans up PDF/ink presentation", async () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const viewer = document.createElement("div");
    const sidebar = document.createElement("aside");
    sidebar.style.transform = "translateX(4px)";
    const first = page(1, true);
    const second = page(2, false);
    scrollRoot.append(sidebar, viewer);
    viewer.append(first.element, second.element);
    document.body.append(scrollRoot);
    const compositor = new MobilePdfCompositor();

    expect(compositor.begin({
      mode: "custom-mobile",
      enabled: true,
      root: viewer,
      scrollRoot,
      pages: [first, second],
      initialScale: 1,
      focalPoint: { x: 300, y: 300 }
    })).toBe(true);
    compositor.submit({ previewScale: 2, focalPoint: { x: 300, y: 300 } });
    await vi.advanceTimersByTimeAsync(16);

    expect(first.element.style.transform).toContain("scale(2)");
    expect(first.overlay.style.transform).toBe("");
    expect(second.element.style.transform).toBe("");
    expect(scrollRoot.style.transform).toBe("");
    expect(sidebar.style.transform).toBe("translateX(4px)");

    compositor.settle();
    expect(first.element.style.transform).toBe("");
    expect(first.element.style.transformOrigin).toBe("");
    expect(first.element.style.willChange).toBe("");
    expect(compositor.isActive()).toBe(false);
  });

  it("coalesces sustained samples to the latest display-frame sample", async () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const viewer = document.createElement("div");
    const first = page(1, true);
    scrollRoot.append(viewer);
    viewer.append(first.element);
    document.body.append(scrollRoot);
    const frames: Array<{ previewScale: number; pageNumbers: readonly number[] }> = [];
    const compositor = new MobilePdfCompositor();
    compositor.begin({
      mode: "custom-mobile",
      enabled: true,
      root: viewer,
      scrollRoot,
      pages: [first],
      initialScale: 1,
      focalPoint: { x: 300, y: 300 }
    }, (frame) => frames.push(frame));
    compositor.submit({ previewScale: 1.2, focalPoint: { x: 300, y: 300 } });
    compositor.submit({ previewScale: 1.4, focalPoint: { x: 300, y: 300 } });
    compositor.submit({ previewScale: 1.8, focalPoint: { x: 300, y: 300 } });
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.previewScale).toBe(1.8);
    expect(frames[0]?.pageNumbers).toEqual([1]);
  });

  it("bounds a large document to visible pages without per-sample full-document work", async () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const viewer = document.createElement("div");
    const pages = Array.from({ length: 50 }, (_, index) => page(index + 1, index < 2));
    pages.forEach(({ element }) => viewer.append(element));
    scrollRoot.append(viewer);
    document.body.append(scrollRoot);
    const framePageCounts: number[] = [];
    const compositor = new MobilePdfCompositor();
    compositor.begin({
      mode: "custom-mobile",
      enabled: true,
      root: viewer,
      scrollRoot,
      pages,
      initialScale: 1,
      focalPoint: { x: 300, y: 300 },
      maxVisiblePages: 2
    }, (frame) => framePageCounts.push(frame.pageNumbers.length));
    compositor.submit({ previewScale: 1.5, focalPoint: { x: 300, y: 300 } });
    await vi.advanceTimersByTimeAsync(16);

    expect(compositor.activePageNumbers()).toEqual([1, 2]);
    expect(framePageCounts.at(-1)).toBe(2);
    expect(pages.slice(2).every(({ element }) => element.style.transform === "")).toBe(true);
  });

  it.each([
    ["disabled", { mode: "custom-mobile" as const, enabled: false }],
    ["native mode", { mode: "native-fallback" as const, enabled: true }]
  ])("does not transform on %s", (_label, gate) => {
    const scrollRoot = document.createElement("div");
    const viewer = document.createElement("div");
    const first = page(1, true);
    scrollRoot.append(viewer);
    viewer.append(first.element);
    document.body.append(scrollRoot);
    const compositor = new MobilePdfCompositor();

    expect(compositor.begin({
      ...gate,
      root: viewer,
      scrollRoot,
      pages: [first],
      initialScale: 1,
      focalPoint: { x: 10, y: 10 }
    })).toBe(false);
    expect(first.element.style.transform).toBe("");
  });

  it("fails closed for an unsafe viewer/page boundary and cancellation restores prior styles", () => {
    const scrollRoot = document.createElement("div");
    const viewer = document.createElement("div");
    const first = page(1, true);
    first.element.style.transform = "translateZ(0)";
    scrollRoot.append(viewer);
    viewer.append(first.element);
    document.body.append(scrollRoot);
    const compositor = new MobilePdfCompositor();

    expect(compositor.begin({
      mode: "custom-mobile",
      enabled: true,
      root: viewer,
      scrollRoot,
      pages: [first],
      initialScale: 1,
      focalPoint: { x: 10, y: 10 }
    })).toBe(false);
    first.element.style.transform = "";
    expect(compositor.begin({
      mode: "custom-mobile",
      enabled: true,
      root: viewer,
      scrollRoot,
      pages: [first],
      initialScale: 1,
      focalPoint: { x: 10, y: 10 }
    })).toBe(true);
    compositor.cancel();
    expect(first.element.style.transform).toBe("");
  });
});
