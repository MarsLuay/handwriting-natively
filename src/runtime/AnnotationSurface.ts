import type { VaultLogLevel } from "../logging/VaultLogSink";
import type { ViewStateSource } from "../logging/SessionLogger";
import type { ToolbarPlacement } from "../model";

/** A logical page exposed by any annotation surface (PDF, image, or test host). */
export interface AnnotationPageInfo {
  /** Stable logical page number within the current document. */
  pageNumber: number;
  /** Canonical page-local coordinate width, not viewport CSS width. */
  width: number;
  /** Canonical page-local coordinate height, not viewport CSS height. */
  height: number;
  /** Current display scale used to map page-local coordinates to CSS. */
  scale: number;
  /** Display rotation in right-angle degrees; persisted geometry stays unrotated. */
  rotation: number;
  /** Coordinate origin for page-local geometry. PDF defaults to bottom-left. */
  coordinateOrigin?: "top-left" | "bottom-left";
  /** Live host element for this page. */
  element: HTMLElement;
}

export interface AnnotationViewState {
  pageNumber: number;
  scrollFraction: number;
  scale: number;
  rotation: number;
}

export interface AnnotationSurfaceCallbacks {
  onViewStateChange?(state: AnnotationViewState, source: ViewStateSource): void;
  onPagesChanged?(reason: string): void;
  onPageContentMutation?(recordCount: number): void;
  onCompatibilityWarning?(message: string): void;
  onDebugLog?(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): void;
}

/**
 * Minimal host contract required by the shared annotation runtime.
 *
 * PDF.js/private-Obsidian capabilities are deliberately optional. A non-PDF
 * surface only implements page geometry, lifecycle, overlay/UI mounting, and
 * teardown; it never has to impersonate a PDF viewer.
 */
export interface AnnotationSurface {
  readonly kind: "direct" | "embedded";
  readonly host: HTMLElement;
  readonly root: HTMLElement;

  pages(): AnnotationPageInfo[];
  page(pageNumber: number): AnnotationPageInfo | undefined;
  getViewState(): AnnotationViewState;
  restoreViewState(state: AnnotationViewState): void;
  focusPage(pageNumber: number): boolean;
  scrollElement(): HTMLElement;
  mountOverlay(pageNumber: number): HTMLElement;
  mountToolbar(toolbar: HTMLElement, placement?: ToolbarPlacement): void;
  compatibilityReport(): { errors: string[]; warnings: string[] };
  destroy(): void;
}
