import type { AnnotationSurface, AnnotationSurfaceCallbacks, AnnotationViewState } from "../runtime/AnnotationSurface";
import type { ToolbarPlacement } from "../model";
import type { PdfFindControllerLike, PdfIntegrationProfile, PdfJsEventBus } from "./PdfViewerCompatibility";
import type { PlatformCapabilityReport } from "./PlatformCapabilities";
import type { PdfPageInfo } from "./PdfPageLocator";

/** Compatibility aliases for PDF-only adapters and integrations. */
export type PdfViewState = AnnotationViewState;
export type PdfAdapterCallbacks = AnnotationSurfaceCallbacks;

/** Optional PDF-only capabilities; generic annotation surfaces do not implement this contract. */
export interface PdfSurfaceExtensions {
  readonly supportsPdfExport?: true;
  setBoostedZoom?(enabled: boolean): void;
  nativeTextLayer?(pageNumber: number): HTMLElement | null;
  findController?(): PdfFindControllerLike | null;
  eventBus?(): PdfJsEventBus | null;
  onPdfEvent?(name: string, handler: (event: unknown) => void): () => void;
  setInkZoomBurstActive?(next: boolean): void;
  consumeSidebarFollowZoomMetrics?(): {
    sidebarFollowActiveDuringZoom: boolean;
    sidebarFollowFramesDuringBurst: number;
    maxSidebarOffsetJump: number;
    sidebarFollowSuppressedTriggers: number;
  } | null;
}

export function pdfSurfaceExtensions(surface: AnnotationSurface): PdfSurfaceExtensions | null {
  const candidate = surface as AnnotationSurface & Partial<PdfSurfaceExtensions>;
  return candidate.supportsPdfExport === true ? candidate : null;
}

/** Optional image-only capability kept outside the generic annotation contract. */
export interface ImageSurfaceExtensions {
  readonly supportsImageExport?: true;
  imageElement?(): HTMLImageElement | null;
}

export function imageSurfaceExtensions(surface: AnnotationSurface): ImageSurfaceExtensions | null {
  const candidate = surface as AnnotationSurface & Partial<ImageSurfaceExtensions>;
  return candidate.supportsImageExport === true ? candidate : null;
}

export interface ObsidianPdfAdapter extends AnnotationSurface, PdfSurfaceExtensions {
  readonly kind: "direct" | "embedded";
  /** Monotonic per-adapter viewer generation; native and embedded leaves are independent. */
  readonly viewerGeneration: number;
  /** Current ephemeral DOM-shell generation for a logical page. */
  pageMountGeneration(pageNumber: number): number;
  /** PDF adapters expose PDF export and viewer capabilities through the optional extension. */
  readonly supportsPdfExport?: true;
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  pages(): PdfPageInfo[];
  /** O(1) page lookup — prefer over `pages()` when only a few mounts are needed. */
  page(pageNumber: number): PdfPageInfo | undefined;
  getViewState(): PdfViewState;
  restoreViewState(state: PdfViewState): void;
  /** Brings one native PDF.js page into view without restoring an old scroll offset. */
  focusPage(pageNumber: number): boolean;
  scrollElement(): HTMLElement;
  mountOverlay(pageNumber: number): HTMLElement;
  mountToolbar(toolbar: HTMLElement, placement?: ToolbarPlacement): void;
  compatibilityReport(): {
    errors: string[];
    warnings: string[];
    profile?: PdfIntegrationProfile;
    platform?: PlatformCapabilityReport;
  };
  destroy(): void;
}

export class PdfAdapterCompatibilityError extends Error {
  constructor(kind: "direct" | "embedded", reasons: string[]) {
    super(`${kind} PDF adapter incompatible: ${reasons.join("; ")}`);
    this.name = "PdfAdapterCompatibilityError";
  }
}
