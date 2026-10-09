import { setElementCssProps } from "../dom/typeGuards";

/**
 * Persistent Handwriting Viewport State and Controller.
 *
 * Owns the visual interaction viewport (scale, x, y) as the single source
 * of truth for pinch-zoom, two-finger pan, one-finger pan, hard pan bounds,
 * coordinate conversion, and renderer/scroll projection. Content smaller than
 * the viewport stays anchored at its current origin instead of being centered.
 * PDF.js renders underneath it.
 */

/**
 * Live viewport translation state. x/y are visual content translations in
 * viewport CSS pixels, not DOM scroll offsets. Native scroll is only a
 * projection of this state.
 */
export interface HandwritingViewportState {
  scale: number;
  x: number;
  y: number;
}

export interface HandwritingViewportBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface HandwritingViewportOptions {
  getContainerRect: () => { width: number; height: number; left: number; top: number } | null;
  getContentSize: () => { width: number; height: number } | null;
  /** Native scroll host used only as a projection/compatibility surface. */
  getScrollElement?: () => HTMLElement | null;
  minScale?: number;
  maxScale?: number;
  initialState?: Partial<HandwritingViewportState>;
  /** Scale already applied to page geometry by PDF.js or the host viewer. */
  initialRenderedScale?: number;
  onStateChange?: (state: HandwritingViewportState) => void;
}

export class HandwritingViewport {
  private readonly state: HandwritingViewportState;
  private renderedScale: number;
  private pinchAnchor: { x: number; y: number } | null = null;
  private targetElement: HTMLElement | null = null;
  private lastProjectedScrollLeft = 0;
  private lastProjectedScrollTop = 0;
  private hasScrollProjection = false;
  private readonly options: HandwritingViewportOptions;

  constructor(options: HandwritingViewportOptions) {
    this.options = options;
    const initial = options.initialState;
    this.state = {
      scale: initial?.scale ?? 1,
      x: initial?.x ?? 0,
      y: initial?.y ?? 0
    };
    this.renderedScale = Number.isFinite(options.initialRenderedScale) && (options.initialRenderedScale ?? 0) > 0
      ? options.initialRenderedScale!
      : 1;
  }

  getState(): HandwritingViewportState {
    return { ...this.state };
  }

  getRenderedScale(): number {
    return this.renderedScale;
  }

  /** Rebase the temporary CSS projection after the renderer changes scale. */
  syncRenderedState(scale: number, scrollLeft: number, scrollTop: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.pinchAnchor = null;
    this.renderedScale = scale;
    this.state.scale = scale;
    this.state.x = -Math.max(0, Number.isFinite(scrollLeft) ? scrollLeft : 0);
    this.state.y = -Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
    this.apply();
  }

  /**
   * Reconcile an externally-originated native scroll (scrollbar, browser wheel,
   * scrollIntoView, etc.) back into canonical viewport translation.
   *
   * Scroll events caused by this viewport's own projection are ignored.
   */
  syncFromScroll(scrollLeft?: number, scrollTop?: number, force = false): boolean {
    const scroll = this.options.getScrollElement?.() ?? null;
    const left = typeof scrollLeft === "number" && Number.isFinite(scrollLeft)
      ? scrollLeft
      : (scroll?.scrollLeft ?? 0);
    const top = typeof scrollTop === "number" && Number.isFinite(scrollTop)
      ? scrollTop
      : (scroll?.scrollTop ?? 0);

    if (!force && this.hasScrollProjection
      && Math.abs(left - this.lastProjectedScrollLeft) < 0.5
      && Math.abs(top - this.lastProjectedScrollTop) < 0.5) {
      return false;
    }

    this.pinchAnchor = null;
    this.state.x = -left;
    this.state.y = -top;
    this.apply();
    return true;
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
    if (typeof next.scale === "number" && Number.isFinite(next.scale) && next.scale > 0) {
      this.state.scale = next.scale;
    }
    if (typeof next.x === "number" && Number.isFinite(next.x)) {
      this.state.x = next.x;
    }
    if (typeof next.y === "number" && Number.isFinite(next.y)) {
      this.state.y = next.y;
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

    const projectionScale = scale / this.renderedScale;
    const scaledW = content.width * projectionScale;
    const scaledH = content.height * projectionScale;

    let minX: number;
    let maxX: number;
    if (scaledW > container.width) {
      minX = container.width - scaledW;
      maxX = 0;
    } else {
      minX = 0;
      maxX = 0;
    }

    let minY: number;
    let maxY: number;
    if (scaledH > container.height) {
      minY = container.height - scaledH;
      maxY = 0;
    } else {
      minY = 0;
      maxY = 0;
    }

    return { minX, maxX, minY, maxY };
  }

  private constrainToBounds(x: number, y: number, bounds = this.getBounds()): { x: number; y: number } {
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, y))
    };
  }

  /**
   * Begins a pinch-zoom/pan gesture anchored at focalPoint.
   */
  startPinch(focalPoint: { x: number; y: number }): void {
    if (this.state.scale > 0) {
      const focal = this.screenToContainer(focalPoint);
      this.pinchAnchor = {
        x: (focal.x - this.state.x) / this.state.scale,
        y: (focal.y - this.state.y) / this.state.scale
      };
    }
  }

  /**
   * Pinch zoom around a focal point on screen.
   * Keeps the document content point currently under focalPoint pinned under focalPoint.
   * Also simultaneously tracks two-finger panning as focalPoint moves.
   */
  pinch(nextScale: number, focalPoint: { x: number; y: number }): void {
    const minScale = this.options.minScale ?? 0.1;
    const maxScale = this.options.maxScale ?? 10;
    const requestedScale = Number.isFinite(nextScale) ? nextScale : this.state.scale;
    const effectiveScale = Math.max(minScale, Math.min(maxScale, requestedScale));

    if (!this.pinchAnchor) {
      this.startPinch(focalPoint);
    }

    if (this.pinchAnchor) {
      const focal = this.screenToContainer(focalPoint);
      const newX = focal.x - this.pinchAnchor.x * effectiveScale;
      const newY = focal.y - this.pinchAnchor.y * effectiveScale;
      this.state.scale = effectiveScale;
      const constrained = this.constrainToBounds(newX, newY, this.getBounds(effectiveScale));
      this.state.x = constrained.x;
      this.state.y = constrained.y;

      this.apply();
    }
  }

  /** End a pinch without changing the viewport the user selected. */
  endPinch(): void {
    this.pinchAnchor = null;
  }

  /**
   * Pan the viewport by deltaX and deltaY (in screen pixels).
   * Applicable for two-finger pan, one-finger pan, drag tool, or trackpad pan.
   */
  pan(deltaX: number, deltaY: number): void {
    const constrained = this.constrainToBounds(this.state.x + deltaX, this.state.y + deltaY);
    this.state.x = constrained.x;
    this.state.y = constrained.y;

    this.apply();
  }

  reset(): void {
    this.pinchAnchor = null;
    this.state.scale = 1;
    this.state.x = 0;
    this.state.y = 0;
    this.apply();
  }

  private screenToContainer(screenPoint: { x: number; y: number }): { x: number; y: number } {
    const container = this.options.getContainerRect();
    return {
      x: screenPoint.x - (container?.left ?? 0),
      y: screenPoint.y - (container?.top ?? 0)
    };
  }

  /**
   * Convert client/screen coordinates to the canonical unscaled viewer viewport.
   * The container's client-space origin is part of the transform; x/y remain
   * visual content translations relative to that container.
   */
  screenToViewport(screenPoint: { x: number; y: number }): { x: number; y: number } {
    const point = this.screenToContainer(screenPoint);
    return {
      x: (point.x - this.state.x) / this.state.scale,
      y: (point.y - this.state.y) / this.state.scale
    };
  }

  /**
   * Convert canonical unscaled viewer viewport coordinates back to client space.
   */
  viewportToScreen(docPoint: { x: number; y: number }): { x: number; y: number } {
    const container = this.options.getContainerRect();
    const originX = container?.left ?? 0;
    const originY = container?.top ?? 0;
    return {
      x: originX + this.state.x + docPoint.x * this.state.scale,
      y: originY + this.state.y + docPoint.y * this.state.scale
    };
  }

  /**
   * Convert client coordinates to an element's unscaled local viewport.
   * Both points pass through the authoritative viewport transform so callers
   * never independently divide client deltas by zoom.
   */
  screenToElementLocal(
    element: HTMLElement,
    screenPoint: { x: number; y: number },
    rect = element.getBoundingClientRect()
  ): { x: number; y: number } {
    // Element-local coordinates are still in the renderer's CSS pixel space.
    // Remove only the temporary compositor ratio here; PageCoordinateMapper
    // separately accounts for the renderer's scale when mapping to PDF units.
    const projectionScale = this.viewportProjectionScale();
    return {
      x: (screenPoint.x - rect.left) / projectionScale,
      y: (screenPoint.y - rect.top) / projectionScale
    };
  }

  /**
   * Convert an element-local unscaled viewport point back to client space.
   */
  elementLocalToScreen(
    element: HTMLElement,
    localPoint: { x: number; y: number },
    rect = element.getBoundingClientRect()
  ): { x: number; y: number } {
    const projectionScale = this.viewportProjectionScale();
    return {
      x: rect.left + localPoint.x * projectionScale,
      y: rect.top + localPoint.y * projectionScale
    };
  }

  private viewportProjectionScale(): number {
    return Math.max(0.1, this.state.scale) / Math.max(0.1, this.renderedScale);
  }

  /**
   * @deprecated Prefer PageCoordinateSpace for page/PDF conversions.
   */
  screenToPageLocal(
    pageElement: HTMLElement,
    screenPoint: { x: number; y: number }
  ): { x: number; y: number } {
    return this.screenToElementLocal(pageElement, screenPoint);
  }

  apply(): void {
    let translateX = this.state.x;
    let translateY = this.state.y;
    const scroll = this.options.getScrollElement?.() ?? null;

    if (scroll?.isConnected) {
      const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const desiredScrollLeft = Math.max(0, Math.min(maxScrollLeft, -this.state.x));
      const desiredScrollTop = Math.max(0, Math.min(maxScrollTop, -this.state.y));

      if (Math.abs(scroll.scrollLeft - desiredScrollLeft) > 0.01) {
        scroll.scrollLeft = desiredScrollLeft;
      }
      if (Math.abs(scroll.scrollTop - desiredScrollTop) > 0.01) {
        scroll.scrollTop = desiredScrollTop;
      }

      const actualScrollLeft = Number.isFinite(scroll.scrollLeft) ? scroll.scrollLeft : desiredScrollLeft;
      const actualScrollTop = Number.isFinite(scroll.scrollTop) ? scroll.scrollTop : desiredScrollTop;
      this.lastProjectedScrollLeft = actualScrollLeft;
      this.lastProjectedScrollTop = actualScrollTop;
      this.hasScrollProjection = true;

      // Native scroll represents the in-bounds portion. Any scroll clamping
      // difference is projected as a residual GPU transform.
      translateX = this.state.x + actualScrollLeft;
      translateY = this.state.y + actualScrollTop;
    } else {
      this.hasScrollProjection = false;
    }

    if (this.targetElement && this.targetElement.isConnected) {
      const projectionScale = this.state.scale / this.renderedScale;
      if (Math.abs(projectionScale - 1) < 0.0001
        && Math.abs(translateX) < 0.01
        && Math.abs(translateY) < 0.01) {
        this.targetElement.style.removeProperty("transform");
        this.targetElement.style.removeProperty("transform-origin");
        this.targetElement.classList.remove("native-pdf-handwriting-pinch-active");
      } else {
        setElementCssProps(this.targetElement, {
          transformOrigin: "0 0",
          transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${projectionScale})`
        });
        this.targetElement.classList.add("native-pdf-handwriting-pinch-active");
      }
    }
    this.options.onStateChange?.({ ...this.state });
  }

  destroy(): void {
    this.pinchAnchor = null;
    this.hasScrollProjection = false;
    if (this.targetElement) {
      this.targetElement.style.removeProperty("transform");
      this.targetElement.style.removeProperty("transform-origin");
      this.targetElement.style.removeProperty("transition");
      this.targetElement.classList.remove("native-pdf-handwriting-pinch-active");
      this.targetElement = null;
    }
  }
}
