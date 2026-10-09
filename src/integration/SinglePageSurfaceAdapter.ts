import { createDetachedDiv } from "../vendor/createDetached";
import { isHTMLElement } from "../dom/typeGuards";
import type {
  AnnotationPageInfo,
  AnnotationSurface,
  AnnotationSurfaceCallbacks,
  AnnotationViewState,
  ViewerState
} from "../runtime/AnnotationSurface";

export interface SinglePageGeometry {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Shared base class for single-page annotation surfaces (images and Markdown notes).
 *
 * Encapsulates single-page scroll container discovery, resize/geometry observation,
 * client-to-surface bounding rect calculations, viewport state management, and
 * overlay/toolbar mount lifecycles.
 */
export abstract class SinglePageSurfaceAdapter implements AnnotationSurface {
  readonly kind = "direct" as const;
  abstract readonly surfaceType: "image" | "markdown";
  readonly host: HTMLElement;
  readonly root: HTMLElement;

  protected readonly pageElement: HTMLElement;
  protected readonly callbacks: AnnotationSurfaceCallbacks;
  protected readonly cleanup: Array<() => void> = [];
  protected readonly mounted = new Set<HTMLElement>();
  protected ownsRelativeClass = false;
  protected destroyed = false;

  private scrollRootElement: HTMLElement | null = null;
  private lastGeometry: SinglePageGeometry | null = null;
  private pendingRefreshFrame: number | null = null;
  private pendingRefreshTimer: number | null = null;
  private pendingRefreshReason: string | null = null;

  constructor(
    host: HTMLElement,
    pageElement: HTMLElement,
    callbacks: AnnotationSurfaceCallbacks = {},
    rootElement: HTMLElement = pageElement
  ) {
    this.host = host;
    this.pageElement = pageElement;
    this.root = rootElement;
    this.callbacks = callbacks;
    this.lastGeometry = this.measureGeometry();
  }

  abstract compatibilityReport(): { errors: string[]; warnings: string[] };

  pages(): AnnotationPageInfo[] {
    return [this.pageInfo()];
  }

  page(pageNumber: number): AnnotationPageInfo | undefined {
    return pageNumber === 1 ? this.pageInfo() : undefined;
  }

  protected abstract pageInfo(): AnnotationPageInfo;

  getViewState(): AnnotationViewState {
    const page = this.pageInfo();
    const scrollRoot = this.scrollElement();
    const denominator = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    return {
      viewport: {
        scale: page.scale,
        x: scrollRoot.scrollLeft,
        y: scrollRoot.scrollTop
      },
      pageNumber: 1,
      scrollFraction: Math.max(0, Math.min(1, scrollRoot.scrollTop / denominator)),
      scale: page.scale,
      rotation: 0,
      scaleMode: "custom"
    };
  }

  restoreViewState(state: AnnotationViewState | ViewerState): void {
    if (state.pageNumber !== 1 || !this.canRestoreScroll()) return;
    this.pageElement.scrollIntoView?.({ block: "start" });
    const scrollRoot = this.scrollElement();
    const hasCoordinates = state.viewport
      && Number.isFinite(state.viewport.x)
      && Number.isFinite(state.viewport.y)
      && (this.shouldApplyZeroViewportOffset() || state.viewport.x > 0 || state.viewport.y > 0);

    if (hasCoordinates && state.viewport) {
      scrollRoot.scrollTop = state.viewport.y;
      scrollRoot.scrollLeft = state.viewport.x;
    } else if (typeof state.scrollFraction === "number" && Number.isFinite(state.scrollFraction)) {
      const denominator = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      scrollRoot.scrollTop = denominator * Math.max(0, Math.min(1, state.scrollFraction));
    }
  }

  focusPage(pageNumber: number): boolean {
    if (pageNumber !== 1) return false;
    if (this.shouldScrollIntoViewOnFocus()) this.pageElement.scrollIntoView?.({ block: "start" });
    return true;
  }

  protected canRestoreScroll(): boolean {
    return true;
  }

  protected shouldScrollIntoViewOnFocus(): boolean {
    return true;
  }

  protected shouldApplyZeroViewportOffset(): boolean {
    return false;
  }

  scrollElement(): HTMLElement {
    if (this.scrollRootElement) return this.scrollRootElement;
    let current: HTMLElement | null = this.pageElement;
    while (current) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (style && /(auto|scroll|overlay)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`)) {
        this.scrollRootElement = current;
        return current;
      }
      current = current.parentElement;
    }
    this.scrollRootElement = this.host;
    return this.host;
  }

  mountOverlay(pageNumber: number): HTMLElement {
    if (pageNumber !== 1) {
      throw new Error(`Cannot mount annotation overlay: ${this.surfaceType} page ${pageNumber} is unavailable`);
    }
    const overlay = createDetachedDiv(this.pageElement.ownerDocument);
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = "1";
    if (this.surfaceType === "markdown") {
      overlay.dataset.surfaceType = "markdown";
    }
    overlay.dataset.focusOverlayInternal = "true";
    this.ensureRelative(this.pageElement);
    this.pageElement.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  mountToolbar(toolbar: HTMLElement): void {
    this.clearToolbarMounts(toolbar);
    toolbar.classList.remove("is-sidebar-left", "is-sidebar-right");
    toolbar.classList.add("is-main");
    this.host.insertBefore(toolbar, this.host.firstChild);
    this.mounted.add(toolbar);
  }

  protected clearToolbarMounts(toolbar: HTMLElement): void {
    for (const existing of this.host.querySelectorAll(".native-pdf-handwriting-toolbar")) {
      if (existing !== toolbar) existing.remove();
    }
    toolbar.remove();
    this.mounted.delete(toolbar);
  }

  protected ensureRelative(element: HTMLElement): void {
    if (element.ownerDocument.defaultView?.getComputedStyle(element).position === "static") {
      element.classList.add("native-pdf-handwriting-relative");
      this.ownsRelativeClass = true;
    }
  }

  protected isManagedNode(node: Node): boolean {
    let current: HTMLElement | null = isHTMLElement(node) ? node : node.parentElement;
    while (current) {
      if ([...this.mounted].some((mounted) => mounted === current || mounted.contains(current))) return true;
      current = current.parentElement;
    }
    return false;
  }

  protected measureGeometry(): SinglePageGeometry {
    const rect = this.pageElement.getBoundingClientRect();
    const layoutWidth = Math.max(this.pageElement.scrollWidth, this.pageElement.clientWidth);
    const layoutHeight = Math.max(this.pageElement.scrollHeight, this.pageElement.clientHeight);
    return {
      // getBoundingClientRect includes temporary CSS zoom transforms. Layout
      // metrics remain in the adapter's document coordinate space.
      width: Math.max(1, layoutWidth || rect.width),
      height: Math.max(1, layoutHeight || rect.height),
      viewportWidth: this.pageElement.clientWidth || rect.width,
      viewportHeight: this.pageElement.clientHeight || rect.height
    };
  }

  protected geometryChanged(previous: SinglePageGeometry, next: SinglePageGeometry): boolean {
    return Math.abs(previous.width - next.width) > 0.5
      || Math.abs(previous.height - next.height) > 0.5
      || Math.abs(previous.viewportWidth - next.viewportWidth) > 0.5
      || Math.abs(previous.viewportHeight - next.viewportHeight) > 0.5;
  }

  protected scheduleGeometryRefresh(reason: string): void {
    if (this.destroyed || this.pendingRefreshFrame !== null || this.pendingRefreshTimer !== null) return;
    this.pendingRefreshReason = reason;
    const view = this.pageElement.ownerDocument.defaultView;
    const refresh = (): void => {
      this.pendingRefreshFrame = null;
      this.pendingRefreshTimer = null;
      const previous = this.lastGeometry ?? this.measureGeometry();
      const next = this.measureGeometry();
      this.lastGeometry = next;
      const pendingReason = this.pendingRefreshReason;
      this.pendingRefreshReason = null;
      if (this.destroyed || !this.geometryChanged(previous, next)) return;
      this.callbacks.onPagesChanged?.(pendingReason ?? "geometry-change");
    };
    if (view?.requestAnimationFrame) {
      this.pendingRefreshFrame = view.requestAnimationFrame(refresh);
    } else if (view) {
      this.pendingRefreshTimer = view.setTimeout(refresh, 16);
    } else {
      queueMicrotask(refresh);
    }
  }

  protected cancelScheduledRefresh(): void {
    const view = this.pageElement.ownerDocument.defaultView;
    if (this.pendingRefreshFrame !== null) view?.cancelAnimationFrame(this.pendingRefreshFrame);
    if (this.pendingRefreshTimer !== null) view?.clearTimeout(this.pendingRefreshTimer);
    this.pendingRefreshFrame = null;
    this.pendingRefreshTimer = null;
    this.pendingRefreshReason = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelScheduledRefresh();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const mounted of this.mounted) mounted.remove();
    this.mounted.clear();
    if (this.ownsRelativeClass) this.pageElement.classList.remove("native-pdf-handwriting-relative");
  }
}
