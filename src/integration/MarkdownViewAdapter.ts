import { createDetachedDiv } from "../vendor/createDetached";
import { isHTMLElement } from "../dom/typeGuards";
import type {
  AnnotationPageInfo,
  AnnotationSurface,
  AnnotationSurfaceCallbacks,
  AnnotationViewState,
  ViewerState
} from "../runtime/AnnotationSurface";

export type MarkdownViewMode = "preview" | "source";

/** DOM options for a rendered Markdown surface. */
export interface MarkdownViewAdapterOptions {
  /** Current MarkdownView mode reported by Obsidian. */
  mode?: MarkdownViewMode;
  /** Explicit root for callers that already resolved Obsidian's shell. */
  surfaceRoot?: HTMLElement;
}

interface MarkdownGeometry {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Resolve Obsidian's rendered Reading-view root. */
export function findMarkdownPreviewRoot(host: HTMLElement): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  if (host.matches(".markdown-preview-view")) candidates.push(host);
  candidates.push(...host.querySelectorAll<HTMLElement>(".markdown-preview-view"));
  return candidates.find((candidate) => !candidate.closest(".cm-editor")) ?? null;
}

/** Resolve the scroll container that owns CodeMirror's editing content. */
export function findMarkdownEditorRoot(host: HTMLElement): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  if (host.matches(".cm-scroller")) candidates.push(host);
  candidates.push(...host.querySelectorAll<HTMLElement>(".markdown-source-view .cm-scroller, .cm-editor .cm-scroller"));
  return candidates.find((candidate) => !candidate.closest(".markdown-preview-view")
    && candidate.querySelector(".cm-content[contenteditable='true']")) ?? null;
}

/** Resolve the active Reading or editing surface from MarkdownView.getMode(). */
export function findMarkdownSurfaceRoot(host: HTMLElement, mode: MarkdownViewMode): HTMLElement | null {
  return mode === "preview" ? findMarkdownPreviewRoot(host) : findMarkdownEditorRoot(host);
}

/**
 * One-page Reading or CodeMirror editing surface for Markdown handwriting.
 *
 * Markdown content is treated as a top-left-coordinate page covering the full
 * scrollable note. Editing overlays are siblings of CodeMirror's contenteditable
 * element so the plugin never changes the editor's document tree.
 */
export class MarkdownViewAdapter implements AnnotationSurface {
  readonly kind = "direct" as const;
  readonly surfaceType = "markdown" as const;
  readonly mode: MarkdownViewMode;
  readonly host: HTMLElement;
  readonly root: HTMLElement;

  private readonly pageElement: HTMLElement;
  private readonly callbacks: AnnotationSurfaceCallbacks;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private lastGeometry: MarkdownGeometry;
  private pendingRefreshFrame: number | null = null;
  private pendingRefreshTimer: number | null = null;
  private pendingRefreshReason: string | null = null;
  private ownsRelativeClass = false;
  private ownsMarkdownSurfaceClass = false;
  private destroyed = false;

  private constructor(
    host: HTMLElement,
    surfaceRoot: HTMLElement,
    mode: MarkdownViewMode,
    callbacks: AnnotationSurfaceCallbacks
  ) {
    this.host = host;
    this.root = surfaceRoot;
    this.pageElement = surfaceRoot;
    this.mode = mode;
    this.callbacks = callbacks;
    if (!surfaceRoot.classList.contains("native-pdf-handwriting-markdown-surface")) {
      surfaceRoot.classList.add("native-pdf-handwriting-markdown-surface");
      this.ownsMarkdownSurfaceClass = true;
    }
    this.lastGeometry = this.measureGeometry();
    this.installObservers();
  }

  /**
   * Create an adapter. The explicit root escape hatch lets the caller resolve
   * Obsidian-specific selectors without changing the generic surface contract.
   */
  static attach(
    host: HTMLElement,
    callbacks: AnnotationSurfaceCallbacks = {},
    options: MarkdownViewAdapterOptions = {}
  ): MarkdownViewAdapter {
    const mode = options.mode ?? "preview";
    const surfaceRoot = options.surfaceRoot ?? findMarkdownSurfaceRoot(host, mode);
    if (!surfaceRoot) throw new Error(`Markdown ${mode} surface root missing`);
    if (surfaceRoot !== host && !host.contains(surfaceRoot)) {
      throw new Error("Markdown surface root is outside its host");
    }
    if (mode === "preview" && !surfaceRoot.matches(".markdown-preview-view")) {
      throw new Error("Markdown Reading surface root is invalid");
    }
    if (mode === "source" && (!surfaceRoot.matches(".cm-scroller")
      || !surfaceRoot.querySelector(".cm-content[contenteditable='true']"))) {
      throw new Error("Markdown editor surface root must be .cm-scroller");
    }
    return new MarkdownViewAdapter(host, surfaceRoot, mode, callbacks);
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
    // Obsidian owns the editing cursor and scroll restoration in Source and
    // Live Preview. Do not replace its current scroll with sidecar view state.
    if (this.mode === "source") return;
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
    if (this.mode === "preview") this.pageElement.scrollIntoView?.({ block: "start" });
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

  mountToolbar(toolbar: HTMLElement): void {
    this.clearToolbarMounts(toolbar);
    toolbar.classList.remove("is-sidebar-left", "is-sidebar-right");
    toolbar.classList.add("is-main");
    this.host.insertBefore(toolbar, this.host.firstChild);
    this.mounted.add(toolbar);
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    const errors = this.pageElement.isConnected ? [] : ["Markdown surface root detached"];
    return { errors, warnings: [] };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelScheduledRefresh();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const mounted of this.mounted) mounted.remove();
    this.mounted.clear();
    if (this.ownsRelativeClass) this.pageElement.classList.remove("native-pdf-handwriting-relative");
    if (this.ownsMarkdownSurfaceClass) this.pageElement.classList.remove("native-pdf-handwriting-markdown-surface");
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
      scrollContentGeometry: true,
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
      const observer = new ResizeObserver(() => this.scheduleGeometryRefresh("markdown-resize"));
      observer.observe(this.pageElement);
      this.cleanup.push(() => observer.disconnect());
    }
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver((records) => {
        const contentChanged = records.some((record) => {
          if (record.type === "characterData") return !this.isManagedNode(record.target);
          if (record.type !== "childList") return false;
          return [
            ...Array.from(record.addedNodes),
            ...Array.from(record.removedNodes)
          ].some((node) => !this.isManagedNode(node));
        });
        if (contentChanged) this.scheduleGeometryRefresh("markdown-render");
      });
      observer.observe(this.pageElement, { childList: true, subtree: true, characterData: true });
      this.cleanup.push(() => observer.disconnect());
    }
  }

  private measureGeometry(): MarkdownGeometry {
    const rect = this.pageElement.getBoundingClientRect();
    return {
      width: Math.max(1, this.pageElement.scrollWidth, this.pageElement.clientWidth, rect.width),
      height: Math.max(1, this.pageElement.scrollHeight, this.pageElement.clientHeight, rect.height),
      viewportWidth: Math.max(0, rect.width),
      viewportHeight: Math.max(0, rect.height)
    };
  }

  private scheduleGeometryRefresh(reason: string): void {
    if (this.destroyed || this.pendingRefreshFrame !== null || this.pendingRefreshTimer !== null) return;
    this.pendingRefreshReason = reason;
    const view = this.pageElement.ownerDocument.defaultView;
    const refresh = (): void => {
      this.pendingRefreshFrame = null;
      this.pendingRefreshTimer = null;
      const previous = this.lastGeometry;
      const next = this.measureGeometry();
      this.lastGeometry = next;
      const pendingReason = this.pendingRefreshReason;
      this.pendingRefreshReason = null;
      if (this.destroyed || !this.geometryChanged(previous, next)) return;
      this.callbacks.onPagesChanged?.(pendingReason ?? "markdown-layout");
    };
    if (view?.requestAnimationFrame) {
      this.pendingRefreshFrame = view.requestAnimationFrame(refresh);
    } else if (view) {
      this.pendingRefreshTimer = view.setTimeout(refresh, 16);
    } else {
      queueMicrotask(refresh);
    }
  }

  private geometryChanged(previous: MarkdownGeometry, next: MarkdownGeometry): boolean {
    return Math.abs(previous.width - next.width) > 0.5
      || Math.abs(previous.height - next.height) > 0.5
      || Math.abs(previous.viewportWidth - next.viewportWidth) > 0.5
      || Math.abs(previous.viewportHeight - next.viewportHeight) > 0.5;
  }

  private cancelScheduledRefresh(): void {
    const view = this.pageElement.ownerDocument.defaultView;
    if (this.pendingRefreshFrame !== null) view?.cancelAnimationFrame(this.pendingRefreshFrame);
    if (this.pendingRefreshTimer !== null) view?.clearTimeout(this.pendingRefreshTimer);
    this.pendingRefreshFrame = null;
    this.pendingRefreshTimer = null;
    this.pendingRefreshReason = null;
  }

  private isManagedNode(node: Node): boolean {
    let current: HTMLElement | null = isHTMLElement(node) ? node : node.parentElement;
    while (current) {
      if ([...this.mounted].some((mounted) => mounted === current || mounted.contains(current))) return true;
      current = current.parentElement;
    }
    return false;
  }
}
