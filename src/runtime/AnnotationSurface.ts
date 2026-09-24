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
  /** Live host element for this page; the DOM node is an ephemeral mount. */
  element: HTMLElement;
  /** Changes when the logical page is backed by a different DOM shell. */
  mountGeneration?: number;
  /** Evidence quality for the geometry used by annotation mapping. */
  geometryConfidence?: "authoritative" | "derived" | "heuristic";
  /** False means the surface must not accept annotation for this mount. */
  geometrySafe?: boolean;
  /** Evidence quality for logical page identity when shells are duplicated. */
  identityConfidence?: "authoritative" | "derived" | "heuristic" | "ambiguous";
  /** False means duplicate/stale shells were not safely disambiguated. */
  identitySafe?: boolean;
  /** Number of candidate DOM shells observed for this logical page. */
  candidateCount?: number;
}

export interface AnnotationViewState {
  pageNumber: number;
  scrollFraction: number;
  scale: number;
  rotation: number;
}

/** Semantic lifecycle evidence emitted by PDF adapters; no DOM/private types escape. */
export interface AnnotationPageLifecycleChange {
  kind: "mount" | "unmount" | "replace" | "render" | "reload" | "viewer-replaced";
  viewerGeneration: number;
  pageNumbers?: number[];
  mountGenerations?: Record<string, number>;
}

export interface AnnotationZoomChange {
  phase: "begin" | "change" | "settled";
  scale: number | null;
  source: "viewer-event" | "geometry" | "mutation-fallback" | "unknown";
  viewerGeneration: number;
}

export interface AnnotationSurfaceCallbacks {
  onViewStateChange?(state: AnnotationViewState, source: ViewStateSource): void;
  onPagesChanged?(reason: string): void;
  onPageLifecycleChange?(change: AnnotationPageLifecycleChange): void;
  onZoomChange?(change: AnnotationZoomChange): void;
  onPageContentMutation?(recordCount: number): void;
  onCompatibilityWarning?(message: string): void;
  onDebugLog?(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): void;
}

/**
 * Minimal host contract required by the shared annotation runtime.
 *
 * PDF.js/private-Obsidian capabilities are deliberately kept outside this
 * contract. A non-PDF surface only implements page geometry, lifecycle,
 * overlay/UI mounting, and teardown; it never has to impersonate a PDF viewer.
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
