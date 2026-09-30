import type { MobileCustomPdfZoomMode } from "./MobileCustomPdfZoom";

export interface MobilePdfCompositorPage {
  pageNumber: number;
  element: HTMLElement;
  overlay?: HTMLElement;
  visible: boolean;
}

export interface MobilePdfCompositorPoint {
  x: number;
  y: number;
}

export interface MobilePdfCompositorBeginOptions {
  mode: MobileCustomPdfZoomMode;
  enabled: boolean;
  root: HTMLElement;
  scrollRoot: HTMLElement;
  pages: readonly MobilePdfCompositorPage[];
  initialScale: number;
  focalPoint: MobilePdfCompositorPoint;
  maxVisiblePages?: number;
}

export interface MobilePdfCompositorSample {
  previewScale: number;
  focalPoint: MobilePdfCompositorPoint;
}

export interface MobilePdfCompositorFrame {
  previewScale: number;
  focalPoint: MobilePdfCompositorPoint;
  pageNumbers: readonly number[];
  /** Bounded timing for the page-local transform batch, not a raw frame log. */
  timestampMs: number;
  transformDurationMs: number;
}

type RectSnapshot = Pick<DOMRect, "left" | "top" | "width" | "height">;
type SavedStyle = Pick<CSSStyleDeclaration, "transform" | "transformOrigin" | "willChange">;

function finitePoint(point: MobilePdfCompositorPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function rectSnapshot(element: HTMLElement): RectSnapshot | null {
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width <= 1 || rect.height <= 1) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * A bounded, page-local visual transform for the opt-in mobile pinch path.
 *
 * The class deliberately transforms page elements, not the PDF scroll root or
 * Obsidian chrome. A mounted handwriting overlay remains a child of its page,
 * so PDF pixels and ink move together without a second overlay transform.
 */
export class MobilePdfCompositor {
  private active = false;
  private initialScale = 1;
  private initialFocalPoint: MobilePdfCompositorPoint = { x: 0, y: 0 };
  private readonly pages = new Map<number, { page: MobilePdfCompositorPage; rect: RectSnapshot; style: SavedStyle }>();
  private pendingSample: MobilePdfCompositorSample | null = null;
  private animationFrame: number | null = null;
  private view: Window | null = null;
  private onFrame: ((frame: MobilePdfCompositorFrame) => void) | undefined;

  begin(options: MobilePdfCompositorBeginOptions, onFrame?: (frame: MobilePdfCompositorFrame) => void): boolean {
    this.cancel();
    if (!options.enabled || options.mode !== "custom-mobile") return false;
    if (!options.root.isConnected || !options.scrollRoot.isConnected) return false;
    if (!Number.isFinite(options.initialScale) || options.initialScale <= 0 || !finitePoint(options.focalPoint)) return false;

    const maxVisiblePages = Math.max(1, Math.min(8, Math.floor(options.maxVisiblePages ?? 4)));
    const candidates = options.pages
      .filter((page) => page.visible)
      .slice(0, maxVisiblePages);
    if (candidates.length === 0) return false;

    for (const page of candidates) {
      if (!page.element.isConnected
        || !options.root.contains(page.element)
        || page.element === options.scrollRoot
        || page.element.contains(options.scrollRoot)
        || (page.overlay !== undefined && !page.element.contains(page.overlay))) {
        this.pages.clear();
        return false;
      }
      const rect = rectSnapshot(page.element);
      if (!rect || page.element.style.transform !== "") {
        this.pages.clear();
        return false;
      }
      this.pages.set(page.pageNumber, {
        page,
        rect,
        style: {
          transform: page.element.style.transform,
          transformOrigin: page.element.style.transformOrigin,
          willChange: page.element.style.willChange
        }
      });
    }
    // These properties are invariant for the burst. Set them once rather than
    // rewriting style declarations on every compositor frame.
    for (const { page } of this.pages.values()) {
      page.element.style.transformOrigin = "0 0";
      page.element.style.willChange = "transform";
    }

    this.initialScale = options.initialScale;
    this.initialFocalPoint = { ...options.focalPoint };
    this.view = options.root.ownerDocument.defaultView;
    this.onFrame = onFrame;
    this.active = true;
    this.submit({ previewScale: options.initialScale, focalPoint: options.focalPoint });
    return true;
  }

  submit(sample: MobilePdfCompositorSample): boolean {
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

  /** Apply the last preview before the native scale commit owns the frame. */
  flush(): void {
    if (!this.active) return;
    if (this.animationFrame !== null) {
      if (this.view?.cancelAnimationFrame) this.view.cancelAnimationFrame(this.animationFrame);
      else (this.view?.clearTimeout ?? window.clearTimeout)(this.animationFrame);
      this.animationFrame = null;
    }
    this.flushPendingSample();
  }

  settle(): void {
    this.clear();
  }

  cancel(): void {
    this.clear();
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

  private apply(sample: MobilePdfCompositorSample): void {
    const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    const ratio = sample.previewScale / this.initialScale;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      this.cancel();
      return;
    }
    const { x: focalX, y: focalY } = sample.focalPoint;
    const { x: initialFocalX, y: initialFocalY } = this.initialFocalPoint;
    for (const { page, rect } of this.pages.values()) {
      // Scale around the original content anchor, then translate by the
      // midpoint movement. Using the latest midpoint as the scale origin
      // alone makes a held two-finger left/right drag visually stationary.
      const offsetX = focalX - initialFocalX * ratio + (ratio - 1) * rect.left;
      const offsetY = focalY - initialFocalY * ratio + (ratio - 1) * rect.top;
      page.element.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${ratio})`;
    }
    const timestampMs = typeof performance === "undefined" ? Date.now() : performance.now();
    this.onFrame?.({
      previewScale: sample.previewScale,
      focalPoint: { ...sample.focalPoint },
      pageNumbers: this.activePageNumbers(),
      timestampMs,
      transformDurationMs: Math.max(0, timestampMs - startedAt)
    });
  }

  private clear(): void {
    if (this.animationFrame !== null) {
      if (this.view?.cancelAnimationFrame) this.view.cancelAnimationFrame(this.animationFrame);
      else (this.view?.clearTimeout ?? window.clearTimeout)(this.animationFrame);
      this.animationFrame = null;
    }
    for (const { page, style } of this.pages.values()) {
      page.element.style.transform = style.transform;
      page.element.style.transformOrigin = style.transformOrigin;
      page.element.style.willChange = style.willChange;
    }
    this.pages.clear();
    this.pendingSample = null;
    this.active = false;
    this.initialScale = 1;
    this.initialFocalPoint = { x: 0, y: 0 };
    this.view = null;
    this.onFrame = undefined;
  }
}
