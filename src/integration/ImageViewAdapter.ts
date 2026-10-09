import { createDetachedDiv } from "../vendor/createDetached";
import { SinglePageSurfaceAdapter } from "./SinglePageSurfaceAdapter";
import type { AnnotationPageInfo, AnnotationSurfaceCallbacks } from "../runtime/AnnotationSurface";

/**
 * Adapter for Obsidian's native image view. Images are represented as one
 * page so the existing page-space ink, sidecar, and pointer machinery can be
 * reused without teaching the PDF integration about image DOM internals.
 */
export class ImageViewAdapter extends SinglePageSurfaceAdapter {
  readonly surfaceType = "image" as const;
  readonly supportsImageExport = true as const;

  private readonly image: HTMLImageElement;
  private readonly wrappedImage: boolean;
  private readonly addedScrollPolicyClass: boolean;

  private constructor(host: HTMLElement, image: HTMLImageElement, callbacks: AnnotationSurfaceCallbacks) {
    const originalParent = image.parentElement;
    const pageElement = ImageViewAdapter.wrapImage(image);
    super(host, pageElement, callbacks, pageElement);
    this.image = image;
    this.wrappedImage = pageElement !== originalParent;
    const scrollRoot = this.scrollElement();
    this.addedScrollPolicyClass = !scrollRoot.classList.contains("native-pdf-handwriting-stable-scroll-root");
    scrollRoot.classList.add("native-pdf-handwriting-stable-scroll-root");
    this.installObservers();
  }

  static attach(host: HTMLElement, callbacks: AnnotationSurfaceCallbacks = {}): ImageViewAdapter {
    const image = host.matches("img")
      ? host as HTMLImageElement
      : host.querySelector<HTMLImageElement>("img");
    if (!image) throw new Error("Image view element missing");
    return new ImageViewAdapter(host, image, callbacks);
  }

  protected override shouldApplyZeroViewportOffset(): boolean {
    return true;
  }

  protected pageInfo(): AnnotationPageInfo {
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

  imageElement(): HTMLImageElement | null {
    return this.image.isConnected ? this.image : null;
  }

  nativeTextLayer(): HTMLElement | null {
    return null;
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

  override destroy(): void {
    if (this.destroyed) return;
    super.destroy();
    if (this.addedScrollPolicyClass) {
      this.scrollElement().classList.remove("native-pdf-handwriting-stable-scroll-root");
    }
    if (this.wrappedImage && this.pageElement.parentElement) {
      this.pageElement.parentElement.insertBefore(this.image, this.pageElement);
      this.pageElement.remove();
    }
  }

  private static wrapImage(image: HTMLImageElement): HTMLElement {
    const existing = image.parentElement;
    if (!existing) throw new Error("Image view element is detached");
    const wrapper = createDetachedDiv(image.ownerDocument);
    wrapper.className = "native-pdf-handwriting-image-page";
    wrapper.dataset.pageNumber = "1";
    existing.insertBefore(wrapper, image);
    wrapper.append(image);
    return wrapper;
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
