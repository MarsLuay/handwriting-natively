export interface MobilePdfCssZoomPage {
  pageNumber: number;
  element: HTMLElement;
  overlay?: HTMLElement;
  visible: boolean;
}

export interface MobilePdfCssZoomPoint {
  x: number;
  y: number;
}

export interface MobilePdfCssZoomBeginOptions {
  root: HTMLElement;
  scrollRoot: HTMLElement;
  pages: readonly MobilePdfCssZoomPage[];
  initialScale: number;
  focalPoint: MobilePdfCssZoomPoint;
  maxVisiblePages?: number;
}

export interface MobilePdfCssZoomSample {
  previewScale: number;
  focalPoint: MobilePdfCssZoomPoint;
}

export interface MobilePdfCssZoomFrame {
  previewScale: number;
  focalPoint: MobilePdfCssZoomPoint;
  pageNumbers: readonly number[];
  timestampMs: number;
  zoomDurationMs: number;
}

type RectSnapshot = Pick<DOMRect, "left" | "top" | "width" | "height">;

const OVERFLOW_ANCHOR_OFF_CLASS = "native-pdf-handwriting-pinch-overflow-anchor-off";

function finitePoint(point: MobilePdfCssZoomPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function rectSnapshot(element: HTMLElement): RectSnapshot | null {
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width <= 1 || rect.height <= 1) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function readZoom(element: HTMLElement): number {
  const inline = Number.parseFloat(element.style.getPropertyValue("zoom"));
  if (Number.isFinite(inline) && inline > 0) return inline;
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue("zoom");
  const parsed = Number.parseFloat(computed ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Mobile PDF preview owned by the content container rather than PDF.js scale.
 *
 * This deliberately uses the browser's container `zoom` property. PDF.js keeps
 * its canonical scale and rendered pages, while the page and any handwriting
 * overlays remain in one visual coordinate system. The final CSS zoom is kept
 * after `settle()`; only `cancel()` rolls it back.
 */
export class MobilePdfCssZoom {
  private active = false;
  private initialScale = 1;
  private initialZoom = 1;
  private previousInlineZoom = "";
  private previousInlineTransform = "";
  private previousInlineTransformOrigin = "";
  private previousInlineTransition = "";
  private initialFocalPoint: MobilePdfCssZoomPoint = { x: 0, y: 0 };
  private initialRootRect: RectSnapshot | null = null;
  private initialScrollRect: RectSnapshot | null = null;
  private initialScroll = { left: 0, top: 0 };
  private hadOverflowAnchorClass = false;
  private root: HTMLElement | null = null;
  private scrollRoot: HTMLElement | null = null;
  private readonly pages = new Map<number, MobilePdfCssZoomPage>();
  private pendingSample: MobilePdfCssZoomSample | null = null;
  private lastAppliedSample: MobilePdfCssZoomSample | null = null;
  private animationFrame: number | null = null;
  private springTimer: number | null = null;
  private view: Window | null = null;
  private onFrame: ((frame: MobilePdfCssZoomFrame) => void) | undefined;

  begin(
    options: MobilePdfCssZoomBeginOptions,
    onFrame?: (frame: MobilePdfCssZoomFrame) => void
  ): boolean {
    this.cancel();
    if (!options.root.isConnected || !options.scrollRoot.isConnected) return false;
    if (options.root === options.scrollRoot || !options.scrollRoot.contains(options.root)) return false;
    if (!Number.isFinite(options.initialScale) || options.initialScale <= 0 || !finitePoint(options.focalPoint)) return false;

    const maxVisiblePages = Math.max(1, Math.min(8, Math.floor(options.maxVisiblePages ?? 4)));
    const candidates = options.pages
      .filter((page) => page.visible)
      .slice(0, maxVisiblePages);
    if (candidates.length === 0) return false;

    const rootRect = rectSnapshot(options.root);
    const scrollRect = rectSnapshot(options.scrollRoot);
    if (!rootRect || !scrollRect) return false;

    for (const page of candidates) {
      if (!page.element.isConnected
        || !options.root.contains(page.element)
        || page.element === options.scrollRoot
        || page.element.contains(options.scrollRoot)
        || (page.overlay !== undefined && !page.element.contains(page.overlay))) {
        this.pages.clear();
        return false;
      }
      this.pages.set(page.pageNumber, page);
    }

    this.root = options.root;
    this.scrollRoot = options.scrollRoot;
    this.initialScale = options.initialScale;
    this.previousInlineZoom = options.root.style.getPropertyValue("zoom");
    this.previousInlineTransform = options.root.style.getPropertyValue("transform");
    this.previousInlineTransformOrigin = options.root.style.getPropertyValue("transform-origin");
    this.previousInlineTransition = options.root.style.getPropertyValue("transition");
    this.initialZoom = readZoom(options.root);
    this.initialFocalPoint = { ...options.focalPoint };
    this.initialRootRect = rootRect;
    this.initialScrollRect = scrollRect;
    this.initialScroll = {
      left: options.scrollRoot.scrollLeft,
      top: options.scrollRoot.scrollTop
    };
    this.hadOverflowAnchorClass = options.scrollRoot.classList.contains(OVERFLOW_ANCHOR_OFF_CLASS);
    options.scrollRoot.classList.add(OVERFLOW_ANCHOR_OFF_CLASS);
    options.root.classList.add("native-pdf-handwriting-pinch-active");
    this.view = options.root.ownerDocument.defaultView;
    this.onFrame = onFrame;
    this.active = true;
    this.submit({ previewScale: options.initialScale, focalPoint: options.focalPoint });
    return true;
  }

  submit(sample: MobilePdfCssZoomSample): boolean {
    if (!this.active || !Number.isFinite(sample.previewScale) || sample.previewScale <= 0 || !finitePoint(sample.focalPoint)) {
      return false;
    }
    this.pendingSample = {
      previewScale: sample.previewScale,
      focalPoint: { ...sample.focalPoint }
    };
    if (this.animationFrame !== null) return true;

    const flush = (): void => {
      this.animationFrame = null;
      this.flushPendingSample();
    };
    if (this.view?.requestAnimationFrame) {
      this.animationFrame = this.view.requestAnimationFrame(flush);
    } else {
      this.animationFrame = (this.view?.setTimeout ?? window.setTimeout)(flush, 16);
    }
    return true;
  }

  flush(): void {
    if (!this.active) return;
    if (this.animationFrame !== null) {
      if (this.view?.cancelAnimationFrame) this.view.cancelAnimationFrame(this.animationFrame);
      else (this.view?.clearTimeout ?? window.clearTimeout)(this.animationFrame);
      this.animationFrame = null;
    }
    this.flushPendingSample();
  }

  /** Keep the final CSS zoom and release only the temporary transaction state. */
  settle(): void {
    this.clear(true);
  }

  /** Restore the zoom and scroll that existed before this gesture. */
  cancel(): void {
    this.clear(false);
  }

  isActive(): boolean {
    return this.active;
  }

  activePageNumbers(): number[] {
    return [...this.pages.keys()];
  }

  private flushPendingSample(): void {
    const pending = this.pendingSample;
    this.pendingSample = null;
    if (!this.active || !pending) return;
    this.apply(pending);
  }

  private apply(sample: MobilePdfCssZoomSample): void {
    const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    const ratio = sample.previewScale / this.initialScale;
    const root = this.root;
    const scrollRoot = this.scrollRoot;
    const rootRect = this.initialRootRect;
    const scrollRect = this.initialScrollRect;
    if (!root || !scrollRoot || !rootRect || !scrollRect || !Number.isFinite(ratio) || ratio <= 0) {
      this.cancel();
      return;
    }

    this.lastAppliedSample = {
      previewScale: sample.previewScale,
      focalPoint: { ...sample.focalPoint }
    };

    const currentZoom = this.initialZoom * ratio;
    root.style.setProperty("zoom", String(currentZoom));

    // The root is a child of the scroll host. Solve scroll coordinates from
    // the original root/focal geometry instead of reading layout after every
    // zoom write; this keeps the input path to one style write plus two scroll
    // writes per display frame.
    const rootContentLeft = rootRect.left - scrollRect.left + this.initialScroll.left;
    const rootContentTop = rootRect.top - scrollRect.top + this.initialScroll.top;
    const localFocalX = this.initialFocalPoint.x - rootRect.left;
    const localFocalY = this.initialFocalPoint.y - rootRect.top;
    const desiredScrollLeft = rootContentLeft + localFocalX * ratio - (sample.focalPoint.x - scrollRect.left);
    const desiredScrollTop = rootContentTop + localFocalY * ratio - (sample.focalPoint.y - scrollRect.top);

    scrollRoot.scrollLeft = desiredScrollLeft;
    scrollRoot.scrollTop = desiredScrollTop;

    // Mobile WebKit clamps scrollLeft/scrollTop to [0, maxScroll]. When zooming
    // or panning side-to-side, any clamped offset (e.g. negative scrollLeft or
    // centered margin-auto layout) cannot be fulfilled by native scrolling.
    // Compensate with a direct GPU translation on the root so 2D panning tracks 1:1.
    const unfulfilledX = desiredScrollLeft - scrollRoot.scrollLeft;
    const unfulfilledY = desiredScrollTop - scrollRoot.scrollTop;

    if (Math.abs(unfulfilledX) > 0.01 || Math.abs(unfulfilledY) > 0.01) {
      const tx = -unfulfilledX / currentZoom;
      const ty = -unfulfilledY / currentZoom;
      root.style.setProperty("transform", `translate3d(${tx}px, ${ty}px, 0)`);
      root.style.setProperty("transform-origin", "0 0");
    } else {
      root.style.removeProperty("transform");
      root.style.removeProperty("transform-origin");
    }

    const timestampMs = typeof performance === "undefined" ? Date.now() : performance.now();
    this.onFrame?.({
      previewScale: sample.previewScale,
      focalPoint: { ...sample.focalPoint },
      pageNumbers: this.activePageNumbers(),
      timestampMs,
      zoomDurationMs: Math.max(0, timestampMs - startedAt)
    });
  }

  private clear(preserveZoom: boolean): void {
    if (this.animationFrame !== null) {
      if (this.view?.cancelAnimationFrame) this.view.cancelAnimationFrame(this.animationFrame);
      else (this.view?.clearTimeout ?? window.clearTimeout)(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.springTimer !== null) {
      (this.view?.clearTimeout ?? window.clearTimeout)(this.springTimer);
      this.springTimer = null;
    }
    const root = this.root;
    const scrollRoot = this.scrollRoot;
    if (root) {
      root.classList.remove("native-pdf-handwriting-pinch-active");
    }

    if (!preserveZoom && root) {
      if (this.previousInlineZoom) root.style.setProperty("zoom", this.previousInlineZoom);
      else root.style.removeProperty("zoom");
      if (this.previousInlineTransform) root.style.setProperty("transform", this.previousInlineTransform);
      else root.style.removeProperty("transform");
      if (this.previousInlineTransformOrigin) root.style.setProperty("transform-origin", this.previousInlineTransformOrigin);
      else root.style.removeProperty("transform-origin");
      if (this.previousInlineTransition) root.style.setProperty("transition", this.previousInlineTransition);
      else root.style.removeProperty("transition");
    }

    if (!preserveZoom && scrollRoot) {
      scrollRoot.scrollLeft = this.initialScroll.left;
      scrollRoot.scrollTop = this.initialScroll.top;
    }

    if (preserveZoom && root && scrollRoot) {
      // Re-sync final scroll position once layout has settled
      if (this.lastAppliedSample && this.initialRootRect && this.initialScrollRect) {
        const ratio = this.lastAppliedSample.previewScale / this.initialScale;
        const rootRect = this.initialRootRect;
        const scrollRect = this.initialScrollRect;
        const rootContentLeft = rootRect.left - scrollRect.left + this.initialScroll.left;
        const rootContentTop = rootRect.top - scrollRect.top + this.initialScroll.top;
        const localFocalX = this.initialFocalPoint.x - rootRect.left;
        const localFocalY = this.initialFocalPoint.y - rootRect.top;
        const desiredScrollLeft = rootContentLeft + localFocalX * ratio - (this.lastAppliedSample.focalPoint.x - scrollRect.left);
        const desiredScrollTop = rootContentTop + localFocalY * ratio - (this.lastAppliedSample.focalPoint.y - scrollRect.top);
        scrollRoot.scrollLeft = desiredScrollLeft;
        scrollRoot.scrollTop = desiredScrollTop;

        const remainingUnfulfilledX = desiredScrollLeft - scrollRoot.scrollLeft;
        const remainingUnfulfilledY = desiredScrollTop - scrollRoot.scrollTop;

        // If there was an active transform (e.g. overscroll / off-center drag),
        // animate it smoothly back to rest (rubber-band spring).
        const currentTransform = root.style.getPropertyValue("transform");
        if (currentTransform && currentTransform !== "none" && currentTransform !== "translate3d(0px, 0px, 0)") {
          if (Math.abs(remainingUnfulfilledX) > 0.5 || Math.abs(remainingUnfulfilledY) > 0.5) {
            root.style.setProperty("transition", "transform 200ms cubic-bezier(0.25, 1, 0.5, 1)");
            root.style.setProperty("transform", "translate3d(0px, 0px, 0)");
            const view = this.view;
            this.springTimer = (view?.setTimeout ?? window.setTimeout)(() => {
              this.springTimer = null;
              if (root.isConnected) {
                root.style.removeProperty("transform");
                root.style.removeProperty("transform-origin");
                root.style.removeProperty("transition");
              }
            }, 210);
          } else {
            root.style.removeProperty("transform");
            root.style.removeProperty("transform-origin");
            root.style.removeProperty("transition");
          }
        }
      }
    }

    if (scrollRoot && !this.hadOverflowAnchorClass) scrollRoot.classList.remove(OVERFLOW_ANCHOR_OFF_CLASS);
    this.pages.clear();
    this.pendingSample = null;
    this.lastAppliedSample = null;
    this.active = false;
    this.initialScale = 1;
    this.initialZoom = 1;
    this.previousInlineZoom = "";
    this.previousInlineTransform = "";
    this.previousInlineTransformOrigin = "";
    this.previousInlineTransition = "";
    this.initialFocalPoint = { x: 0, y: 0 };
    this.initialRootRect = null;
    this.initialScrollRect = null;
    this.initialScroll = { left: 0, top: 0 };
    this.hadOverflowAnchorClass = false;
    this.root = null;
    this.scrollRoot = null;
    this.view = null;
    this.onFrame = undefined;
  }
}
