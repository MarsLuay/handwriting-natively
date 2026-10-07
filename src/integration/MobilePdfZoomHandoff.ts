import { annotationPageSafetyReason, type AnnotationPageInfo, type AnnotationViewState } from "../runtime/AnnotationSurface";
import {
  ElementRectViewportTransform,
  PageCoordinateMapper,
  PageCoordinateSpace,
  type ViewportPoint
} from "../runtime/PageCoordinateMapper";

export type MobilePdfZoomHandoffPhase = "idle" | "preview" | "committing" | "settled" | "cancelled";

export type MobilePdfZoomHandoffCancelReason =
  | "viewer-replaced"
  | "page-identity-changed"
  | "page-geometry-unsafe"
  | "native-scale-commit-unavailable"
  | "stable-geometry-unavailable"
  | "capability-lost";

export type MobilePdfZoomHandoffSignal =
  | "scale-changing"
  | "scale-settled"
  | "render"
  | "mutation"
  | "resize"
  | "geometry";

export interface MobilePdfZoomHandoffHost {
  viewerGeneration(): number;
  getViewState(): AnnotationViewState;
  page(pageNumber: number): AnnotationPageInfo | undefined;
  scrollElement(): HTMLElement;
  commitScale(scale: number, focalPoint?: ViewportPoint): boolean;
}

export interface MobilePdfZoomHandoffBeginOptions {
  pageNumber: number;
  focalPoint: ViewportPoint;
  compositor?: { cancel(): void };
}

export interface MobilePdfZoomHandoffCommitResult {
  phase: MobilePdfZoomHandoffPhase;
  accepted: boolean;
  reason?: MobilePdfZoomHandoffCancelReason;
}

export interface MobilePdfZoomHandoffReleaseResult {
  phase: MobilePdfZoomHandoffPhase;
  released: boolean;
  reason?: MobilePdfZoomHandoffCancelReason;
  scrollDelta: { left: number; top: number };
}

interface Anchor {
  pageNumber: number;
  pageElement: HTMLElement;
  mountGeneration: number | undefined;
  pagePoint: ViewportPoint;
  focalPoint: ViewportPoint;
  initialScroll: { left: number; top: number };
  scrollElement: HTMLElement;
  hadOverflowAnchorClass: boolean;
}

const SCALE_EPSILON = 0.02;
const PINCH_OVERFLOW_ANCHOR_OFF_CLASS = "native-pdf-handwriting-pinch-overflow-anchor-off";
const STRUCTURAL_SIGNALS = new Set<MobilePdfZoomHandoffSignal>(["render", "mutation", "resize", "geometry"]);

function finitePoint(point: ViewportPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

const rectViewportTransform = new ElementRectViewportTransform();

function pageMapper(page: AnnotationPageInfo, rect: DOMRect): PageCoordinateMapper {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const renderedWidth = Math.max(1, rotated ? page.height : page.width);
  const renderedHeight = Math.max(1, rotated ? page.width : page.height);
  return new PageCoordinateMapper({
    width: page.width,
    height: page.height,
    scale: page.scale > 0 && Number.isFinite(page.scale) ? page.scale : 1,
    scaleX: rect.width / renderedWidth,
    scaleY: rect.height / renderedHeight,
    rotation: page.rotation === 90 || page.rotation === 180 || page.rotation === 270 ? page.rotation : 0,
    origin: page.coordinateOrigin ?? "bottom-left"
  });
}

function pageCoordinateSpace(page: AnnotationPageInfo, rect: DOMRect): PageCoordinateSpace {
  return new PageCoordinateSpace(rectViewportTransform, page.element, pageMapper(page, rect));
}

function samePageMount(page: AnnotationPageInfo, anchor: Anchor): boolean {
  return page.element === anchor.pageElement
    && (page.mountGeneration === undefined
      || anchor.mountGeneration === undefined
      || page.mountGeneration === anchor.mountGeneration);
}

/**
 * Coordinates the temporary compositor with the canonical PDF.js scale.
 *
 * This object owns no PDF.js/private objects. The adapter supplies bounded page,
 * generation, scale, and commit operations; stale callbacks are rejected before
 * either rebase or release can touch the current scroll root.
 */
export class MobilePdfZoomHandoff {
  private phase: MobilePdfZoomHandoffPhase = "idle";
  private cancelReason: MobilePdfZoomHandoffCancelReason | undefined;
  private anchor: Anchor | null = null;
  private expectedViewerGeneration: number | null = null;
  private finalScale: number | null = null;
  private readonly signals = new Set<MobilePdfZoomHandoffSignal>();
  private compositor: { cancel(): void } | undefined;

  constructor(private readonly host: MobilePdfZoomHandoffHost) {}

  begin(options: MobilePdfZoomHandoffBeginOptions): boolean {
    this.cancel();
    const page = this.host.page(options.pageNumber);
    if (!page || annotationPageSafetyReason(page) !== null || !finitePoint(options.focalPoint)) return false;
    const rect = page.element.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 1 || rect.height <= 1) return false;
    const pagePoint = pageCoordinateSpace(page, rect).clientToPage(options.focalPoint, rect);
    if (!finitePoint(pagePoint)) return false;
    const scroll = this.host.scrollElement();
    const hadOverflowAnchorClass = scroll.classList.contains(PINCH_OVERFLOW_ANCHOR_OFF_CLASS);
    // PDF.js changes page geometry during the native commit. Disable the
    // browser's independent scroll anchoring for this bounded handoff so the
    // focal-point rebase below is the only post-pinch scroll adjustment.
    scroll.classList.add(PINCH_OVERFLOW_ANCHOR_OFF_CLASS);
    this.anchor = {
      pageNumber: options.pageNumber,
      pageElement: page.element,
      mountGeneration: page.mountGeneration,
      pagePoint,
      focalPoint: { ...options.focalPoint },
      initialScroll: { left: scroll.scrollLeft, top: scroll.scrollTop },
      scrollElement: scroll,
      hadOverflowAnchorClass
    };
    this.expectedViewerGeneration = this.host.viewerGeneration();
    this.finalScale = null;
    this.cancelReason = undefined;
    this.signals.clear();
    this.compositor = options.compositor;
    this.phase = "preview";
    return true;
  }

  commit(finalScale: number): MobilePdfZoomHandoffCommitResult {
    if (this.phase !== "preview" || !Number.isFinite(finalScale) || finalScale <= 0) {
      const result: MobilePdfZoomHandoffCommitResult = { phase: this.phase, accepted: false };
      if (this.cancelReason) result.reason = this.cancelReason;
      return result;
    }
    const reason = this.validateGenerationAndPage();
    if (reason) return this.cancelWith(reason);
    if (!this.host.commitScale(finalScale, this.anchor?.focalPoint)) {
      return this.cancelWith("native-scale-commit-unavailable");
    }
    this.finalScale = finalScale;
    this.signals.clear();
    this.signals.add("scale-changing");
    this.phase = "committing";
    return { phase: this.phase, accepted: true };
  }

  /** Update the final page-space anchor as the two-finger midpoint moves. */
  updateFocalPoint(focalPoint: ViewportPoint): boolean {
    if ((this.phase !== "preview" && this.phase !== "committing") || !finitePoint(focalPoint) || !this.anchor) {
      return false;
    }
    // Generation/page validation remains at commit and release boundaries;
    // midpoint updates stay on the input-critical path and do not query DOM.
    this.anchor.focalPoint = { ...focalPoint };
    return true;
  }

  observe(signal: MobilePdfZoomHandoffSignal): MobilePdfZoomHandoffPhase {
    // Page-structure notifications can arrive while the fingers are still
    // down, before the native scale commit. Validate the anchor in preview too
    // so an unrelated virtualized-page addition does not cancel the gesture,
    // while an actual anchor replacement still fails closed.
    if (this.phase !== "preview" && this.phase !== "committing") return this.phase;
    const reason = this.validateGenerationAndPage();
    if (reason) {
      this.cancelWith(reason);
      return this.phase;
    }
    if (this.phase === "committing") this.signals.add(signal);
    return this.phase;
  }

  /**
   * Call once from the adapter's stable display-frame callback, after the
   * scale-settled signal and one render/DOM-geometry signal have arrived.
   */
  release(): MobilePdfZoomHandoffReleaseResult {
    const empty = { left: 0, top: 0 };
    if (this.phase !== "committing") {
      const result: MobilePdfZoomHandoffReleaseResult = { phase: this.phase, released: false, scrollDelta: empty };
      if (this.cancelReason) result.reason = this.cancelReason;
      return result;
    }
    const reason = this.validateGenerationAndPage();
    if (reason) {
      this.cancelWith(reason);
      return { phase: this.phase, released: false, reason, scrollDelta: empty };
    }
    if (!this.signals.has("scale-settled") || ![...STRUCTURAL_SIGNALS].some((signal) => this.signals.has(signal))) {
      return { phase: this.phase, released: false, scrollDelta: empty };
    }
    if (this.finalScale === null || !nativeScaleMatches(this.host.getViewState(), this.finalScale)) {
      return { phase: this.phase, released: false, scrollDelta: empty };
    }
    const anchor = this.anchor;
    const page = anchor ? this.host.page(anchor.pageNumber) : undefined;
    const scroll = this.host.scrollElement();
    if (!anchor || !page || annotationPageSafetyReason(page) !== null || !samePageMount(page, anchor)) {
      this.cancelWith("stable-geometry-unavailable");
      return { phase: this.phase, released: false, reason: "stable-geometry-unavailable", scrollDelta: empty };
    }
    // The canonical page geometry must be measured without the temporary
    // compositor transform. Keep native scale/scroll ownership held until the
    // rebase below has completed, then release the visual transform exactly once.
    this.compositor?.cancel();
    this.compositor = undefined;
    const rect = page.element.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 1 || rect.height <= 1) {
      this.cancelWith("stable-geometry-unavailable");
      return { phase: this.phase, released: false, reason: "stable-geometry-unavailable", scrollDelta: empty };
    }
    const nextScreenPoint = pageCoordinateSpace(page, rect).pageToClient(anchor.pagePoint, rect);
    if (!finitePoint(nextScreenPoint)) {
      this.cancelWith("stable-geometry-unavailable");
      return { phase: this.phase, released: false, reason: "stable-geometry-unavailable", scrollDelta: empty };
    }
    const delta = {
      left: nextScreenPoint.x - anchor.focalPoint.x,
      top: nextScreenPoint.y - anchor.focalPoint.y
    };
    if (!Number.isFinite(delta.left) || !Number.isFinite(delta.top)) {
      this.cancelWith("stable-geometry-unavailable");
      return { phase: this.phase, released: false, reason: "stable-geometry-unavailable", scrollDelta: empty };
    }
    scroll.scrollLeft += delta.left;
    scroll.scrollTop += delta.top;
    this.restoreOverflowAnchor(anchor);
    this.phase = "settled";
    this.anchor = null;
    this.expectedViewerGeneration = null;
    this.finalScale = null;
    this.signals.clear();
    this.compositor = undefined;
    return { phase: this.phase, released: true, scrollDelta: delta };
  }

  cancel(reason: MobilePdfZoomHandoffCancelReason = "capability-lost"): void {
    if (this.phase === "idle" || this.phase === "settled" || this.phase === "cancelled") {
      if (this.phase === "idle") this.cancelReason = undefined;
      return;
    }
    this.compositor?.cancel();
    this.compositor = undefined;
    if (this.anchor) this.restoreOverflowAnchor(this.anchor);
    this.anchor = null;
    this.expectedViewerGeneration = null;
    this.finalScale = null;
    this.signals.clear();
    this.cancelReason = reason;
    this.phase = "cancelled";
  }

  currentPhase(): MobilePdfZoomHandoffPhase {
    return this.phase;
  }

  currentCancelReason(): MobilePdfZoomHandoffCancelReason | undefined {
    return this.cancelReason;
  }

  private restoreOverflowAnchor(anchor: Anchor): void {
    if (anchor.hadOverflowAnchorClass) return;
    anchor.scrollElement.classList.remove(PINCH_OVERFLOW_ANCHOR_OFF_CLASS);
  }

  private validateGenerationAndPage(): MobilePdfZoomHandoffCancelReason | undefined {
    if (this.expectedViewerGeneration === null || this.host.viewerGeneration() !== this.expectedViewerGeneration) {
      return "viewer-replaced";
    }
    if (!this.anchor) return "stable-geometry-unavailable";
    const page = this.host.page(this.anchor.pageNumber);
    if (!page || !samePageMount(page, this.anchor) || page.identitySafe === false) return "page-identity-changed";
    if (annotationPageSafetyReason(page) !== null) return "page-geometry-unsafe";
    return undefined;
  }

  private cancelWith(reason: MobilePdfZoomHandoffCancelReason): MobilePdfZoomHandoffCommitResult {
    this.cancel(reason);
    return { phase: this.phase, accepted: false, reason };
  }
}

/** Scale settled evidence must be close enough to the requested canonical scale. */
export function nativeScaleMatches(view: AnnotationViewState, expectedScale: number): boolean {
  return Number.isFinite(view.scale)
    && Number.isFinite(expectedScale)
    && expectedScale > 0
    && Math.abs(view.scale - expectedScale) <= Math.max(SCALE_EPSILON, expectedScale * SCALE_EPSILON);
}
