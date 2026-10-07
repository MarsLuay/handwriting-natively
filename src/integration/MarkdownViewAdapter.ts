import { createDetachedDiv } from "../vendor/createDetached";
import { isHTMLElement } from "../dom/typeGuards";
import type { ToolbarPlacement } from "../model";
import type {
  AnnotationPageInfo,
  AnnotationSurface,
  AnnotationSurfaceCallbacks,
  AnnotationViewState,
  ViewerState
} from "../runtime/AnnotationSurface";

/** Options kept deliberately DOM-only until Markdown view attachment is enabled. */
export interface MarkdownViewAdapterOptions {
  /** Explicit Reading-view root for callers that already resolved Obsidian's shell. */
  previewRoot?: HTMLElement;
}

/**
 * Resolve a rendered Markdown Reading-view root without touching source mode.
 *
 * This is intentionally not called by the plugin entrypoint yet. It gives the
 * future Markdown integration one safe discovery boundary and makes Live
 * Preview/source editors ineligible until their editing and input semantics are
 * designed separately.
 */
export function findMarkdownPreviewRoot(host: HTMLElement): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  if (host.matches(".markdown-preview-view")) candidates.push(host);
  candidates.push(...host.querySelectorAll<HTMLElement>(".markdown-preview-view"));
  return candidates.find((candidate) => !candidate.closest(".cm-editor")) ?? null;
}

/**
 * One-page Reading-view scaffold for future Markdown handwriting.
 *
 * Markdown content is treated as a top-left-coordinate page whose height is
 * the rendered content height. The adapter is not registered by main.ts, so
 * constructing it is the only way it can currently affect a view; no toolbar,
 * overlay, listener, or setting is user-visible in the shipped runtime.
 */
export class MarkdownViewAdapter implements AnnotationSurface {
  readonly kind = "direct" as const;
  readonly surfaceType = "markdown" as const;
  readonly host: HTMLElement;
  readonly root: HTMLElement;

  private readonly pageElement: HTMLElement;
  private readonly callbacks: AnnotationSurfaceCallbacks;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private ownsRelativeClass = false;
  private destroyed = false;

  private constructor(host: HTMLElement, previewRoot: HTMLElement, callbacks: AnnotationSurfaceCallbacks) {
    this.host = host;
    this.root = previewRoot;
    this.pageElement = previewRoot;
    this.callbacks = callbacks;
    this.installObservers();
  }

  /**
   * Create a future-only adapter. The explicit root escape hatch lets a later
   * Obsidian compatibility layer own selector knowledge without changing this
   * generic surface contract.
   */
  static attach(
    host: HTMLElement,
    callbacks: AnnotationSurfaceCallbacks = {},
    options: MarkdownViewAdapterOptions = {}
  ): MarkdownViewAdapter {
    const previewRoot = options.previewRoot ?? findMarkdownPreviewRoot(host);
    if (!previewRoot) throw new Error("Markdown preview root missing");
    if (previewRoot !== host && !host.contains(previewRoot)) {
      throw new Error("Markdown preview root is outside its host");
    }
    return new MarkdownViewAdapter(host, previewRoot, callbacks);
  }

  pages(): AnnotationPageInfo[] {
    return [this.pageInfo()];
  }

  page(pageNumber: number): AnnotationPageInfo | undefined {
    return pageNumber === 1 ? this.pageInfo() : undefined;
  }

  getViewState(): AnnotationViewState {
    const scrollRoot = this.scrollElement();
    const denominator = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    return {
      viewport: {
        scale: 1,
        x: scrollRoot.scrollLeft,
        y: scrollRoot.scrollTop
      },
      pageNumber: 1,
      scrollFraction: Math.max(0, Math.min(1, scrollRoot.scrollTop / denominator)),
      scale: 1,
      rotation: 0,
      scaleMode: "custom"
    };
  }

  restoreViewState(state: AnnotationViewState | ViewerState): void {
    if (state.pageNumber !== 1) return;
    this.pageElement.scrollIntoView?.({ block: "start" });
    const scrollRoot = this.scrollElement();
    if (state.viewport && (Number.isFinite(state.viewport.y) && state.viewport.y > 0 || Number.isFinite(state.viewport.x) && state.viewport.x > 0)) {
      scrollRoot.scrollTop = state.viewport.y;
      scrollRoot.scrollLeft = state.viewport.x;
    } else if (typeof state.scrollFraction === "number" && Number.isFinite(state.scrollFraction)) {
      const denominator = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      scrollRoot.scrollTop = denominator * Math.max(0, Math.min(1, state.scrollFraction));
    }
  }

  focusPage(pageNumber: number): boolean {
    if (pageNumber !== 1) return false;
    this.pageElement.scrollIntoView?.({ block: "start" });
    return true;
  }

  scrollElement(): HTMLElement {
    let current: HTMLElement | null = this.pageElement;
    while (current) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (style && /(auto|scroll|overlay)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`)) {
        return current;
      }
      current = current.parentElement;
    }
    return this.host;
  }

  mountOverlay(pageNumber: number): HTMLElement {
    if (pageNumber !== 1) throw new Error(`Cannot mount annotation overlay: Markdown page ${pageNumber} is unavailable`);
    const overlay = createDetachedDiv(this.pageElement.ownerDocument);
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = "1";
    overlay.dataset.surfaceType = "markdown";
    overlay.dataset.focusOverlayInternal = "true";
    this.ensureRelative(this.pageElement);
    this.pageElement.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  mountToolbar(toolbar: HTMLElement, _placement: ToolbarPlacement = "main"): void {
    this.clearToolbarMounts(toolbar);
    toolbar.classList.remove("is-sidebar-left", "is-sidebar-right");
    toolbar.classList.add("is-main");
    this.host.insertBefore(toolbar, this.host.firstChild);
    this.mounted.add(toolbar);
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    const errors = this.pageElement.isConnected ? [] : ["Markdown preview root detached"];
    return { errors, warnings: [] };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const mounted of this.mounted) mounted.remove();
    this.mounted.clear();
    if (this.ownsRelativeClass) this.pageElement.classList.remove("native-pdf-handwriting-relative");
  }

  private pageInfo(): AnnotationPageInfo {
    const rect = this.pageElement.getBoundingClientRect();
    const width = Math.max(1, this.pageElement.scrollWidth, this.pageElement.clientWidth, rect.width);
    const height = Math.max(1, this.pageElement.scrollHeight, this.pageElement.clientHeight, rect.height);
    return {
      pageNumber: 1,
      width,
      height,
      scale: 1,
      rotation: 0,
      coordinateOrigin: "top-left",
      element: this.pageElement,
      geometryConfidence: "derived",
      geometrySafe: width > 1 && height > 1,
      identityConfidence: "authoritative",
      identitySafe: true,
      candidateCount: 1
    };
  }

  private ensureRelative(element: HTMLElement): void {
    if (element.ownerDocument.defaultView?.getComputedStyle(element).position === "static") {
      element.classList.add("native-pdf-handwriting-relative");
      this.ownsRelativeClass = true;
    }
  }

  private clearToolbarMounts(toolbar: HTMLElement): void {
    for (const existing of this.host.querySelectorAll(".native-pdf-handwriting-toolbar")) {
      if (existing !== toolbar) existing.remove();
    }
    toolbar.remove();
    this.mounted.delete(toolbar);
  }

  private installObservers(): void {
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.callbacks.onPagesChanged?.("markdown-resize"));
      observer.observe(this.pageElement);
      this.cleanup.push(() => observer.disconnect());
    }
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver((records) => {
        const contentChanged = records.some((record) => [
          ...Array.from(record.addedNodes),
          ...Array.from(record.removedNodes)
        ].some((node) => !this.isManagedNode(node)));
        if (contentChanged) this.callbacks.onPagesChanged?.("markdown-render");
      });
      observer.observe(this.pageElement, { childList: true, subtree: true });
      this.cleanup.push(() => observer.disconnect());
    }
  }

  private isManagedNode(node: Node): boolean {
    return isHTMLElement(node)
      && [...this.mounted].some((mounted) => mounted === node || mounted.contains(node));
  }
}
