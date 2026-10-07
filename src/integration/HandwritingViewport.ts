/**
 * Persistent Handwriting Viewport State and Controller.
 *
 * Owns the visual interaction viewport (scale, x, y) as the single source
 * of truth for all pinch-zoom, two-finger pan, one-finger pan, rubber banding,
 * bounds calculation, coordinate conversion, and spring settling.
 * PDF.js renders underneath it.
 */

import type { ViewerViewportState } from "../runtime/ViewerState";

export type HandwritingViewportState = ViewerViewportState;
export type { ViewerViewportState };

export interface HandwritingViewportBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface HandwritingViewportOptions {
  getContainerRect: () => { width: number; height: number; left: number; top: number } | null;
  getContentSize: () => { width: number; height: number } | null;
  minScale?: number;
  maxScale?: number;
  initialState?: Partial<HandwritingViewportState>;
  onStateChange?: (state: HandwritingViewportState) => void;
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
}

export class HandwritingViewport {
  private readonly state: HandwritingViewportState;
  private rawX: number;
  private rawY: number;
  private pinchAnchor: { x: number; y: number } | null = null;
  private targetElement: HTMLElement | null = null;
  private animationId: number | null = null;
  private readonly options: HandwritingViewportOptions;

  private readonly requestFrame: (callback: (timestamp: number) => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly now: () => number;

  constructor(options: HandwritingViewportOptions) {
    this.options = options;
    const initial = options.initialState;
    this.state = {
      scale: initial?.scale ?? 1,
      x: initial?.x ?? 0,
      y: initial?.y ?? 0
    };
    this.rawX = this.state.x;
    this.rawY = this.state.y;

    this.requestFrame = options.requestFrame ?? (
      typeof window !== "undefined" && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number
    );
    this.cancelFrame = options.cancelFrame ?? (
      typeof window !== "undefined" && window.cancelAnimationFrame
        ? window.cancelAnimationFrame.bind(window)
        : (id) => clearTimeout(id)
    );
    this.now = options.now ?? (
      typeof performance !== "undefined" ? performance.now.bind(performance) : Date.now
    );
  }

  getState(): HandwritingViewportState {
    return { ...this.state };
  }

  setTarget(element: HTMLElement | null): void {
    if (this.targetElement === element) return;
    if (this.targetElement) {
      this.targetElement.style.removeProperty("transform");
      this.targetElement.style.removeProperty("transform-origin");
      this.targetElement.style.removeProperty("transition");
      this.targetElement.classList.remove("native-pdf-handwriting-pinch-active");
    }
    this.targetElement = element;
    if (this.targetElement) {
      this.apply();
    }
  }

  getTarget(): HTMLElement | null {
    return this.targetElement;
  }

  setState(next: Partial<HandwritingViewportState>, applyNow = true): void {
    this.cancelAnimation();
    if (typeof next.scale === "number" && Number.isFinite(next.scale) && next.scale > 0) {
      this.state.scale = next.scale;
    }
    if (typeof next.x === "number" && Number.isFinite(next.x)) {
      this.state.x = next.x;
      this.rawX = next.x;
    }
    if (typeof next.y === "number" && Number.isFinite(next.y)) {
      this.state.y = next.y;
      this.rawY = next.y;
    }
    if (applyNow) {
      this.apply();
    }
  }

  /**
   * Calculates valid resting bounds [minX, maxX] and [minY, maxY] based
   * on container viewport size and scaled document content size.
   */
  getBounds(scale = this.state.scale): HandwritingViewportBounds {
    const container = this.options.getContainerRect();
    const content = this.options.getContentSize();
    if (!container || !content || container.width <= 0 || container.height <= 0 || content.width <= 0 || content.height <= 0) {
      return { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    }

    const scaledW = content.width * scale;
    const scaledH = content.height * scale;

    let minX: number;
    let maxX: number;
    if (scaledW > container.width) {
      minX = container.width - scaledW;
      maxX = 0;
    } else {
      // Centered horizontally when document fits within container width
      minX = (container.width - scaledW) / 2;
      maxX = minX;
    }

    let minY: number;
    let maxY: number;
    if (scaledH > container.height) {
      minY = container.height - scaledH;
      maxY = 0;
    } else {
      minY = Math.max(0, (container.height - scaledH) / 2);
      maxY = minY;
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * GoodNotes/Apple-style rubber band elastic resistance when dragging outside bounds.
   */
  static rubberBand(delta: number, dimension: number, coefficient = 0.55): number {
    if (dimension <= 0 || delta === 0) return delta;
    const abs = Math.abs(delta);
    const damped = (abs * coefficient * dimension) / (abs + coefficient * dimension);
    return Math.sign(delta) * damped;
  }

  constrainWithRubberBand(x: number, y: number, bounds = this.getBounds()): { x: number; y: number } {
    const container = this.options.getContainerRect();
    const dimW = container?.width ?? 600;
    const dimH = container?.height ?? 800;

    let visualX = x;
    if (x < bounds.minX) {
      visualX = bounds.minX + HandwritingViewport.rubberBand(x - bounds.minX, dimW);
    } else if (x > bounds.maxX) {
      visualX = bounds.maxX + HandwritingViewport.rubberBand(x - bounds.maxX, dimW);
    }

    let visualY = y;
    if (y < bounds.minY) {
      visualY = bounds.minY + HandwritingViewport.rubberBand(y - bounds.minY, dimH);
    } else if (y > bounds.maxY) {
      visualY = bounds.maxY + HandwritingViewport.rubberBand(y - bounds.maxY, dimH);
    }

    return { x: visualX, y: visualY };
  }

  /**
   * Begins a pinch-zoom/pan gesture anchored at focalPoint.
   */
  startPinch(focalPoint: { x: number; y: number }): void {
    this.cancelAnimation();
    if (this.state.scale > 0) {
      this.pinchAnchor = {
        x: (focalPoint.x - this.rawX) / this.state.scale,
        y: (focalPoint.y - this.rawY) / this.state.scale
      };
    }
  }

  /**
   * Pinch zoom around a focal point on screen.
   * Keeps the document content point currently under focalPoint pinned under focalPoint.
   * Also simultaneously tracks two-finger panning as focalPoint moves.
   */
  pinch(nextScale: number, focalPoint: { x: number; y: number }): void {
    this.cancelAnimation();
    const minScale = this.options.minScale ?? 0.1;
    const maxScale = this.options.maxScale ?? 10;

    // Apply elastic resistance if pinched outside scale limits
    let effectiveScale = nextScale;
    if (nextScale < minScale) {
      effectiveScale = minScale - HandwritingViewport.rubberBand(minScale - nextScale, minScale * 0.5);
    } else if (nextScale > maxScale) {
      effectiveScale = maxScale + HandwritingViewport.rubberBand(nextScale - maxScale, maxScale * 0.5);
    }

    if (!this.pinchAnchor) {
      this.startPinch(focalPoint);
    }

    if (this.pinchAnchor) {
      const newX = focalPoint.x - this.pinchAnchor.x * effectiveScale;
      const newY = focalPoint.y - this.pinchAnchor.y * effectiveScale;

      this.rawX = newX;
      this.rawY = newY;
      this.state.scale = effectiveScale;

      const constrained = this.constrainWithRubberBand(newX, newY, this.getBounds(effectiveScale));
      this.state.x = constrained.x;
      this.state.y = constrained.y;

      this.apply();
    }
  }

  /**
   * Ends a pinch gesture and settles overscroll/scale back to bounds.
   */
  endPinch(): void {
    this.pinchAnchor = null;
    this.settle();
  }

  /**
   * Pan the viewport by deltaX and deltaY (in screen pixels).
   * Applicable for two-finger pan, one-finger pan, drag tool, or trackpad pan.
   */
  pan(deltaX: number, deltaY: number): void {
    this.cancelAnimation();
    this.rawX += deltaX;
    this.rawY += deltaY;

    const constrained = this.constrainWithRubberBand(this.rawX, this.rawY);
    this.state.x = constrained.x;
    this.state.y = constrained.y;

    this.apply();
  }

  /**
   * Settles any overscroll / rubber-band back to resting bounds with a smooth spring animation.
   */
  settle(onSettled?: () => void): void {
    this.cancelAnimation();
    this.pinchAnchor = null;

    const minScale = this.options.minScale ?? 0.1;
    const maxScale = this.options.maxScale ?? 10;
    const targetScale = Math.max(minScale, Math.min(maxScale, this.state.scale));

    const bounds = this.getBounds(targetScale);
    const targetX = Math.max(bounds.minX, Math.min(bounds.maxX, this.rawX));
    const targetY = Math.max(bounds.minY, Math.min(bounds.maxY, this.rawY));

    this.rawX = targetX;
    this.rawY = targetY;

    const startX = this.state.x;
    const startY = this.state.y;
    const startScale = this.state.scale;

    const diffX = targetX - startX;
    const diffY = targetY - startY;
    const diffScale = targetScale - startScale;

    if (Math.abs(diffX) < 0.5 && Math.abs(diffY) < 0.5 && Math.abs(diffScale) < 0.001) {
      this.state.x = targetX;
      this.state.y = targetY;
      this.state.scale = targetScale;
      this.apply();
      onSettled?.();
      return;
    }

    const startTime = this.now();
    const duration = 200;

    const step = () => {
      const elapsed = this.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Apple-standard cubic-bezier(0.25, 1, 0.5, 1) ease-out curve
      const eased = 1 - Math.pow(1 - progress, 3);

      this.state.x = startX + diffX * eased;
      this.state.y = startY + diffY * eased;
      this.state.scale = startScale + diffScale * eased;
      this.apply();

      if (progress < 1) {
        this.animationId = this.requestFrame(step);
      } else {
        this.animationId = null;
        this.state.x = targetX;
        this.state.y = targetY;
        this.state.scale = targetScale;
        this.apply();
        onSettled?.();
      }
    };

    this.animationId = this.requestFrame(step);
  }

  reset(): void {
    this.cancelAnimation();
    this.pinchAnchor = null;
    this.state.scale = 1;
    this.state.x = 0;
    this.state.y = 0;
    this.rawX = 0;
    this.rawY = 0;
    this.apply();
  }

  /**
   * Convert screen coordinates (clientX, clientY) to document viewport coordinates.
   */
  screenToViewport(screenPoint: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (screenPoint.x - this.state.x) / this.state.scale,
      y: (screenPoint.y - this.state.y) / this.state.scale
    };
  }

  /**
   * Convert document viewport coordinates to screen coordinates.
   */
  viewportToScreen(docPoint: { x: number; y: number }): { x: number; y: number } {
    return {
      x: this.state.x + docPoint.x * this.state.scale,
      y: this.state.y + docPoint.y * this.state.scale
    };
  }

  /**
   * Convert screen coordinates directly to unscaled page-local coordinates.
   */
  screenToPageLocal(
    pageElement: HTMLElement,
    screenPoint: { x: number; y: number }
  ): { x: number; y: number } {
    const doc = this.screenToViewport(screenPoint);
    return {
      x: doc.x - pageElement.offsetLeft,
      y: doc.y - pageElement.offsetTop
    };
  }

  apply(): void {
    if (this.targetElement && this.targetElement.isConnected) {
      if (Math.abs(this.state.scale - 1) < 0.0001 && Math.abs(this.state.x) < 0.01 && Math.abs(this.state.y) < 0.01) {
        this.targetElement.style.removeProperty("transform");
        this.targetElement.style.removeProperty("transform-origin");
        this.targetElement.classList.remove("native-pdf-handwriting-pinch-active");
      } else {
        this.targetElement.style.setProperty("transform-origin", "0 0");
        this.targetElement.style.setProperty(
          "transform",
          `translate3d(${this.state.x}px, ${this.state.y}px, 0) scale(${this.state.scale})`
        );
        this.targetElement.classList.add("native-pdf-handwriting-pinch-active");
      }
    }
    this.options.onStateChange?.({ ...this.state });
  }

  private cancelAnimation(): void {
    if (this.animationId !== null) {
      this.cancelFrame(this.animationId);
      this.animationId = null;
    }
  }

  destroy(): void {
    this.cancelAnimation();
    this.pinchAnchor = null;
    if (this.targetElement) {
      this.targetElement.style.removeProperty("transform");
      this.targetElement.style.removeProperty("transform-origin");
      this.targetElement.style.removeProperty("transition");
      this.targetElement.classList.remove("native-pdf-handwriting-pinch-active");
      this.targetElement = null;
    }
  }
}
