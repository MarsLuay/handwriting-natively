import { SinglePageSurfaceAdapter } from "./SinglePageSurfaceAdapter";
import type {
  AnnotationPageInfo,
  AnnotationSurfaceCallbacks
} from "../runtime/AnnotationSurface";

export type MarkdownViewMode = "preview" | "source";

/** DOM options for a rendered Markdown surface. */
export interface MarkdownViewAdapterOptions {
  /** Current MarkdownView mode reported by Obsidian. */
  mode?: MarkdownViewMode;
  /** Explicit root for callers that already resolved Obsidian's shell. */
  surfaceRoot?: HTMLElement;
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
export class MarkdownViewAdapter extends SinglePageSurfaceAdapter {
  readonly surfaceType = "markdown" as const;
  readonly mode: MarkdownViewMode;

  private ownsMarkdownSurfaceClass = false;

  private constructor(
    host: HTMLElement,
    surfaceRoot: HTMLElement,
    mode: MarkdownViewMode,
    callbacks: AnnotationSurfaceCallbacks
  ) {
    super(host, surfaceRoot, callbacks, surfaceRoot);
    this.mode = mode;
    if (!surfaceRoot.classList.contains("native-pdf-handwriting-markdown-surface")) {
      surfaceRoot.classList.add("native-pdf-handwriting-markdown-surface");
      this.ownsMarkdownSurfaceClass = true;
    }
    this.installMarkdownObservers();
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

  protected override canRestoreScroll(): boolean {
    return this.mode !== "source";
  }

  protected override shouldScrollIntoViewOnFocus(): boolean {
    return this.mode === "preview";
  }

  isHostOwnedInputTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const embeddedPdf = target.closest(
      ".pdf-embed, .internal-embed[data-type='pdf'], .internal-embed[src$='.pdf']"
    );
    if (embeddedPdf && this.root.contains(embeddedPdf)) return true;

    const internalEmbed = target.closest(".internal-embed");
    const source = internalEmbed?.getAttribute("src")?.split(/[?#]/, 1)[0] ?? "";
    return Boolean(internalEmbed && this.root.contains(internalEmbed) && /\.pdf$/i.test(source));
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    const errors = this.pageElement.isConnected ? [] : ["Markdown surface root detached"];
    return { errors, warnings: [] };
  }

  protected pageInfo(): AnnotationPageInfo {
    const rect = this.pageElement.getBoundingClientRect();
    const layoutWidth = Math.max(this.pageElement.scrollWidth, this.pageElement.clientWidth);
    const layoutHeight = Math.max(this.pageElement.scrollHeight, this.pageElement.clientHeight);
    const width = Math.max(1, layoutWidth || rect.width);
    const height = Math.max(1, layoutHeight || rect.height);
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

  override destroy(): void {
    if (this.destroyed) return;
    super.destroy();
    if (this.ownsMarkdownSurfaceClass) {
      this.pageElement.classList.remove("native-pdf-handwriting-markdown-surface");
    }
  }

  private installMarkdownObservers(): void {
    const view = this.pageElement.ownerDocument.defaultView;
    const ResizeObserverClass = view?.ResizeObserver
      ?? (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    let contentResizeObserver: ResizeObserver | null = null;
    if (ResizeObserverClass) {
      const observer = new ResizeObserverClass(() => this.scheduleGeometryRefresh("markdown-resize"));
      contentResizeObserver = observer;
      observer.observe(this.pageElement);
      // The scroll root often keeps a fixed viewport box while its scroll
      // extent comes from an auto-sized child (the preview sizer or cm-content).
      // Watch those flow roots so image loads, widgets, and CSS reflow refresh
      // note geometry even when no DOM mutation occurs.
      for (const child of Array.from(this.pageElement.children)) {
        if (!this.isManagedNode(child)) observer.observe(child);
      }
      this.cleanup.push(() => observer.disconnect());
    }
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type !== "childList" || record.target !== this.pageElement) continue;
          for (const node of Array.from(record.removedNodes)) {
            if (node.nodeType === 1) contentResizeObserver?.unobserve(node as Element);
          }
          for (const node of Array.from(record.addedNodes)) {
            if (node.nodeType !== 1) continue;
            const element = node as Element;
            if (!this.isManagedNode(element)) contentResizeObserver?.observe(element);
          }
        }
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
}
