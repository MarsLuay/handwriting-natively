import type { AnnotationSurface, AnnotationSurfaceCallbacks, AnnotationViewState, ViewerState } from "../runtime/AnnotationSurface";
import type { InkStroke, ToolbarPlacement } from "../model";
import type { PageLifecycleCoordinator } from "../runtime/PageLifecycleCoordinator";
import type { PdfFindControllerLike, PdfIntegrationProfile, PdfJsEventBus } from "./PdfViewerCompatibility";
import type { PlatformCapabilityReport } from "./PlatformCapabilities";
import type { PdfPageInfo } from "./PdfPageLocator";
import type { MobilePdfZoomHandoff } from "./MobilePdfZoomHandoff";

export type {
  PageLifecycleCoordinator,
  ManagedPageRecord,
  PageLifecycleStage,
  PageVisibility,
  PagePriority,
  PageLayerStatus,
  InkOverlayStatus,
  PageLifecycleChangeEvent,
  PageLifecycleListener,
  PageVisibilityChangeEvent,
  PageVisibilityListener
} from "../runtime/PageLifecycleCoordinator";
import type { RenderScheduler } from "../runtime/RenderScheduler";

export type {
  RenderScheduler,
  RenderPriority,
  RenderPhase,
  RenderJob,
  RenderAbortSignal,
  RenderMemoryBudget,
  RenderedPageRecord,
  RenderSchedulerOptions
} from "../runtime/RenderScheduler";

/** Compatibility aliases for PDF-only adapters and integrations. */
export type PdfViewState = AnnotationViewState;
export type PdfAdapterCallbacks = AnnotationSurfaceCallbacks;

/** Bounded, read-only ink data used only for low-resolution PDF sidebar previews. */
export interface PdfInkPreview {
  revision: number;
  strokes: readonly InkStroke[];
}

export type PdfInkPreviewProvider = (pageNumber: number) => PdfInkPreview;

/** Command bridge for PDF-owned controls; implementations remain session-owned. */
export interface PdfViewerCommandBridge {
  zoomIn(): boolean;
  zoomOut(): boolean;
  setZoom(scale: number): boolean;
  fitWidth(): boolean;
  nextPage(): boolean;
  previousPage(): boolean;
  goToPage(pageNumber: number): boolean;
  rotateClockwise(): boolean;
  rotateCounterclockwise(): boolean;
  toggleHandMode(): boolean;
  isHandMode(): boolean;
  toggleSearch(force?: boolean): boolean;
  closeSearch(): boolean;
  handleKeyDown(event: KeyboardEvent, isTextEditing?: boolean): boolean;
}

export type PdfToolbarAction =
  | "fit-height"
  | "fit-page"
  | "show-thumbnails"
  | "show-outline"
  | "presentation"
  | "print"
  | "download";

/** Optional PDF-only capabilities; generic annotation surfaces do not implement this contract. */
export interface PdfSurfaceExtensions {
  readonly supportsPdfExport?: true;
  readonly lifecycleCoordinator?: PageLifecycleCoordinator;
  readonly renderScheduler?: RenderScheduler;
  /** DOM layer containing pages only, for temporary viewport transforms. */
  viewportContentElement?(): HTMLElement | null;
  /** Bind the shared session command controller to adapter-owned controls. */
  setViewerCommandBridge?(commands: PdfViewerCommandBridge | null): void;
  /** Apply shared zoom commands around the PDF viewer's viewport center. */
  setScaleAtViewportCenter?(scale: number): void;
  /** Run PDF-only actions from the shared annotation toolbar's More menu. */
  performToolbarAction?(action: PdfToolbarAction): boolean;
  /** Keep adapter-owned Hand control chrome in sync with the session tool. */
  setHandToolActive?(active: boolean): void;
  nativeTextLayer?(pageNumber: number): HTMLElement | null;
  findController?(): PdfFindControllerLike | null;
  eventBus?(): PdfJsEventBus | null;
  onPdfEvent?(name: string, handler: (event: unknown) => void): () => void;
  setInkZoomBurstActive?(next: boolean): void;
  nativeScaleCommitAvailable?(): boolean;
  compatibilityReport?(): {
    errors: string[];
    warnings: string[];
    profile?: PdfIntegrationProfile;
    platform?: PlatformCapabilityReport;
  };
  /** Adapter-owned native handoff; private viewer objects stay behind this boundary. */
  createMobilePdfZoomHandoff?(): MobilePdfZoomHandoff;
  consumeSidebarFollowZoomMetrics?(): {
    sidebarFollowActiveDuringZoom: boolean;
    sidebarFollowFramesDuringBurst: number;
    maxSidebarOffsetJump: number;
    sidebarFollowSuppressedTriggers: number;
  } | null;
  /** Supplies sidecar ink to plugin-owned low-resolution sidebar previews. */
  setInkPreviewProvider?(provider: PdfInkPreviewProvider | null): void;
  /** Invalidates only the changed pages; rendering is coalesced by the adapter. */
  refreshInkPreviews?(pageNumbers?: readonly number[]): void;
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
  restoreViewState(state: PdfViewState | ViewerState): void;
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
