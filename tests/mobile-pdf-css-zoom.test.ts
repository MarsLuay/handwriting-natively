import { describe, expect, it, vi } from "vitest";
import { MobilePdfCssZoom } from "../src/integration/MobilePdfCssZoom";
import { MobilePdfCssZoomTransaction } from "../src/integration/MobilePdfCssZoomTransaction";
import type { MobilePdfCssZoomPage } from "../src/integration/MobilePdfCssZoom";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function fixture() {
  const scrollRoot = document.createElement("div");
  const root = document.createElement("div");
  const page = document.createElement("div");
  const overlay = document.createElement("div");
  page.append(overlay);
  root.append(page);
  scrollRoot.append(root);
  document.body.append(scrollRoot);
  Object.defineProperty(scrollRoot, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, 0, 600, 800)
  });
  Object.defineProperty(root, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, 0, 600, 800)
  });
  Object.defineProperty(page, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, 0, 600, 800)
  });
  const pageInfo: MobilePdfCssZoomPage = { pageNumber: 1, element: page, overlay, visible: true };
  return { scrollRoot, root, pages: [pageInfo] };
}

describe("mobile PDF CSS zoom", () => {
  it("keeps the final container zoom instead of committing a PDF.js scale", () => {
    vi.useFakeTimers();
    const { scrollRoot, root, pages } = fixture();
    const frames: number[] = [];
    const compositor = new MobilePdfCssZoom();

    expect(compositor.begin({
      root,
      scrollRoot,
      pages,
      initialScale: 1,
      focalPoint: { x: 300, y: 300 }
    }, (frame) => frames.push(frame.previewScale))).toBe(true);
    compositor.submit({ previewScale: 2, focalPoint: { x: 300, y: 300 } });
    compositor.flush();

    expect(root.style.getPropertyValue("zoom")).toBe("2");
    expect(scrollRoot.scrollLeft).toBe(300);
    expect(scrollRoot.scrollTop).toBe(300);
    expect(frames).toEqual([2]);

    compositor.settle();
    expect(root.style.getPropertyValue("zoom")).toBe("2");
    expect(compositor.isActive()).toBe(false);
    expect(scrollRoot.classList.contains("native-pdf-handwriting-pinch-overflow-anchor-off")).toBe(false);
  });

  it("restores the previous CSS zoom and scroll when cancelled", () => {
    vi.useFakeTimers();
    const { scrollRoot, root, pages } = fixture();
    root.style.setProperty("zoom", "1.5");
    scrollRoot.scrollLeft = 40;
    scrollRoot.scrollTop = 60;
    const compositor = new MobilePdfCssZoom();

    expect(compositor.begin({
      root,
      scrollRoot,
      pages,
      initialScale: 2,
      focalPoint: { x: 300, y: 300 }
    })).toBe(true);
    compositor.submit({ previewScale: 3, focalPoint: { x: 300, y: 300 } });
    compositor.flush();
    expect(root.style.getPropertyValue("zoom")).toBe("2.25");

    compositor.cancel();
    expect(root.style.getPropertyValue("zoom")).toBe("1.5");
    expect(scrollRoot.scrollLeft).toBe(40);
    expect(scrollRoot.scrollTop).toBe(60);
  });

  it("cancels when a competing native scale signal arrives", () => {
    const calls: string[] = [];
    const compositor = {
      submit: vi.fn(() => true),
      flush: vi.fn(() => calls.push("flush")),
      settle: vi.fn(() => calls.push("settle")),
      cancel: vi.fn(() => calls.push("cancel"))
    } as unknown as MobilePdfCssZoom;
    const completions: unknown[] = [];
    const transaction = new MobilePdfCssZoomTransaction({
      compositor,
      initialScale: 1,
      onComplete: (completion) => completions.push(completion)
    });

    expect(transaction.preview(1.25, { x: 10, y: 10 })).toBe(true);
    transaction.observe("scale-changing");
    expect(transaction.currentPhase()).toBe("cancelled");
    expect(calls).toEqual(["cancel"]);
    expect(completions).toEqual([{ phase: "cancelled", reason: "native-scale-observed" }]);
  });
});
