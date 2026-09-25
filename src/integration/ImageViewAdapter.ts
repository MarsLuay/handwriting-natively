import { createDetachedDiv } from "../vendor/createDetached";
import type { ToolbarPlacement } from "../model";
import type { AnnotationPageInfo, AnnotationSurface, AnnotationSurfaceCallbacks, AnnotationViewState } from "../runtime/AnnotationSurface";

/**
 * Adapter for Obsidian's native image view. Images are represented as one
 * page so the existing page-space ink, sidecar, and pointer machinery can be
 * reused without teaching the PDF integration about image DOM internals.
 */
export class ImageViewAdapter implements AnnotationSurface {
  readonly kind = "direct" as const;
  readonly supportsImageExport = true as const;
  readonly host: HTMLElement;
  readonly root: HTMLElement;

  private readonly image: HTMLImageElement;
  private readonly pageElement: HTMLElement;
  private readonly callbacks: AnnotationSurfaceCallbacks;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private readonly wrappedImage: boolean;
  private destroyed = false;

  private constructor(host: HTMLElement, image: HTMLImageElement, callbacks: AnnotationSurfaceCallbacks) {
    this.host = host;
    this.image = image;
    this.callbacks = callbacks;
    const originalParent = image.parentElement;
    this.pageElement = this.wrapImage(image);
    this.root = this.pageElement;
    this.wrappedImage = this.pageElement !== originalParent;
    this.installObservers();
  }

  static attach(host: HTMLElement, callbacks: AnnotationSurfaceCallbacks = {}): ImageViewAdapter {
    const image = host.matches("img")
      ? host as HTMLImageElement
      : host.querySelector<HTMLImageElement>("img");
    if (!image) throw new Error("Image view element missing");
    return new ImageViewAdapter(host, image, callbacks);
  }

  pages(): AnnotationPageInfo[] {
    return [this.pageInfo()];
  }

  page(pageNumber: number): AnnotationPageInfo | undefined {
    return pageNumber === 1 ? this.pageInfo() : undefined;
  }

  getViewState(): AnnotationViewState {
    const page = this.pageInfo();
    const scrollRoot = this.scrollElement();
    const denominator = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    return {
      pageNumber: 1,
      scrollFraction: Math.max(0, Math.min(1, scrollRoot.scrollTop / denominator)),
      scale: page.scale,
      rotation: 0
    };
  }

  restoreViewState(state: AnnotationViewState): void {
    if (state.pageNumber !== 1) return;
    this.pageElement.scrollIntoView?.({ block: "start" });
    const scrollRoot = this.scrollElement();
    const denominator = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTop = denominator * Math.max(0, Math.min(1, state.scrollFraction));
  }

  focusPage(pageNumber: number): boolean {
    if (pageNumber !== 1) return false;
    this.pageElement.scrollIntoView?.({ block: "start" });
    return true;
  }

  scrollElement(): HTMLElement {
    let current: HTMLElement | null = this.host;
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
    if (pageNumber !== 1) throw new Error(`Cannot mount annotation overlay: image page ${pageNumber} is unavailable`);
    const overlay = createDetachedDiv(this.pageElement.ownerDocument);
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = "1";
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

  nativeTextLayer(): HTMLElement | null {
    return null;
  }

  imageElement(): HTMLImageElement | null {
    return this.image.isConnected ? this.image : null;
  }

  findController(): null {
    return null;
  }

  eventBus(): null {
    return null;
  }

  onPdfEvent(): () => void {
    return () => undefined;
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return { errors: [], warnings: [] };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const mounted of this.mounted) mounted.remove();
    this.mounted.clear();
    if (this.wrappedImage && this.pageElement.parentElement) {
      this.pageElement.parentElement.insertBefore(this.image, this.pageElement);
      this.pageElement.remove();
    }
  }

  private pageInfo(): AnnotationPageInfo {
    const rect = this.image.getBoundingClientRect();
    const width = this.image.naturalWidth > 0 ? this.image.naturalWidth : Math.max(1, rect.width);
    const height = this.image.naturalHeight > 0 ? this.image.naturalHeight : Math.max(1, rect.height);
    const scaleX = rect.width > 0 ? rect.width / width : 1;
    const scaleY = rect.height > 0 ? rect.height / height : 1;
    return {
      pageNumber: 1,
      width,
      height,
      scale: Math.min(scaleX, scaleY) > 0 ? Math.min(scaleX, scaleY) : 1,
      rotation: 0,
      coordinateOrigin: "top-left",
      element: this.pageElement
    };
  }

  private wrapImage(image: HTMLImageElement): HTMLElement {
    const existing = image.parentElement;
    if (!existing) throw new Error("Image view element is detached");
    const wrapper = createDetachedDiv(image.ownerDocument);
    wrapper.className = "native-pdf-handwriting-image-page";
    wrapper.dataset.pageNumber = "1";
    existing.insertBefore(wrapper, image);
    wrapper.append(image);
    return wrapper;
  }

  private ensureRelative(element: HTMLElement): void {
    if (element.ownerDocument.defaultView?.getComputedStyle(element).position === "static") {
      element.classList.add("native-pdf-handwriting-relative");
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
    const onLoad = (): void => this.callbacks.onPagesChanged?.("image-load");
    this.image.addEventListener("load", onLoad);
    this.cleanup.push(() => this.image.removeEventListener("load", onLoad));

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.callbacks.onPagesChanged?.("image-resize"));
      observer.observe(this.image);
      this.cleanup.push(() => observer.disconnect());
    }
  }
}
