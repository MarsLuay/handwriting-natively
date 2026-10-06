import type { DrawingTool, InkStroke, PagePoint, TextAnnotation, TextRun, PluginSettings, PressureCalibration, PressureProfile, TextStyle, ToolId, ToolbarPlacement, ToolPreferences } from "../model";
import { isDrawingTool, isInkDrawTool, resolveDrawingTool } from "../model";
import {
  annotationPageMountMatches,
  annotationPageSafetyReason,
  type AnnotationPageContentMutation,
  type AnnotationPageLifecycleChange,
  type AnnotationSurface,
  type AnnotationPageInfo,
  type AnnotationZoomChange
} from "./AnnotationSurface";
import { imageSurfaceExtensions, pdfSurfaceExtensions } from "../integration/ObsidianPdfAdapter";
import { describeTarget } from "../dom/describeElement";
import { PointerTypeOriginLog, pointerTypeOrigin, type PointerTypeListenerPhase } from "../input/PointerTypeOrigin";
import { AnnotationFindBridge, type AnnotationFindPageLayout } from "../integration/AnnotationFindBridge";
import { loadPdfThumbnailRuntime } from "../integration/PdfThumbnailRuntime";
import type { PdfThumbnailSidebarActions } from "../integration/PdfThumbnailDeleteMenu";
import { captureNativePdfMutationScreenshot } from "../integration/NativePdfMutationScreenshot";
import { resolveToolbarPlacement } from "./resolveToolbarPlacement";
import { documentMountPolicy, mountWorkSuperseded, workingSetPageNumbers } from "./documentBudgetPolicy";
type PdfThumbnailRuntimeModule = Awaited<ReturnType<typeof loadPdfThumbnailRuntime>>;
let pdfThumbnailRuntime: PdfThumbnailRuntimeModule | undefined;

async function ensurePdfThumbnailRuntime(): Promise<PdfThumbnailRuntimeModule> {
  pdfThumbnailRuntime ??= await loadPdfThumbnailRuntime();
  return pdfThumbnailRuntime;
}

function requirePdfThumbnailRuntime(): PdfThumbnailRuntimeModule {
  if (!pdfThumbnailRuntime) throw new Error("PDF thumbnail runtime has not been loaded");
  return pdfThumbnailRuntime;
}

import {
  PINCH_CLEANUP_MAX_WAIT_MS,
  ZOOM_BURST_STUCK_MS,
  decideZoomBurstWatchdog,
  type PostZoomContactObservation,
  type StylusIdentity
} from "./PostZoomInputTrace";
import { loadPostZoomInputRuntime } from "./PostZoomInputRuntime";
import type { PostZoomInputRuntimeModule } from "./PostZoomInputRuntime";

let postZoomInputRuntime: PostZoomInputRuntimeModule | undefined;

async function ensurePostZoomInputRuntime(): Promise<PostZoomInputRuntimeModule> {
  postZoomInputRuntime ??= await loadPostZoomInputRuntime();
  return postZoomInputRuntime;
}

function requirePostZoomInputRuntime(): PostZoomInputRuntimeModule {
  if (!postZoomInputRuntime) throw new Error("post-zoom input runtime has not been loaded");
  return postZoomInputRuntime;
}

function mountedToolbarRail(toolbar: HTMLElement): HTMLElement | null {
  return toolbar.closest<HTMLElement>(".native-pdf-handwriting-rail, .hn-owned-pdf-ink-rail");
}

import { PostZoomDurabilityTrace } from "./PostZoomDurabilityTrace";
import { SLOW_SPAN_SYNC_MS, SlowSpanTrace, type InkLatencyBreakdown } from "./SlowSpanTrace";
import {
  inkVisibilityCause,
  inkVisibilityFlash,
  probeInkCanvas,
  replacementInkReadyForActivePages,
  type InkVisibilityPhase,
  type InkVisibilitySnapshot
} from "./InkVisibility";
import {
  deferredRenderDisposition,
  DENSE_ZOOM_RASTER_FALLBACK_STROKES,
  shouldUseDenseZoomRasterFallback
} from "./renderCachePolicy";
import { isAnnotationChromeTarget, PointerRouter, type PointerRoute, type PointerRouterHandoff } from "../input/PointerRouter";
import { classifyInputTarget } from "../input/InputTargetClassification";
import { detectPointerInputCapabilities } from "../input/PointerInputCapabilities";
import { GestureOwnership } from "../input/GestureOwnership";
import { PostUiInputProbe, POST_UI_INPUT_PHASE_THRESHOLD_MS, type PostUiProbeArmContext, type PostUiProbeOutcome, type PostUiProbeStage, type PostUiProbeResult } from "../input/PostUiInputProbe";
import { acquireDocumentInputOwnership, documentInputOwnershipSnapshot, type DocumentInputOwnershipHandle } from "../input/DocumentInputOwnership";
import { PhysicalContactTracker, type RawPointerContactSample, type RawTouchContactEvent, type RawTouchPoint, type PhysicalContactRecord } from "../input/PhysicalContactTracker";
import {
  acquirePhysicalContactCollector,
  physicalContactHotPathStats,
  rawPointerContactSample,
  rawTouchContactEvent,
  type PhysicalContactCollectorEvent,
  type PhysicalContactCollectorLease,
  type PhysicalContactDuplicateObserver
} from "../input/PhysicalContactCollector";
import {
  canAnnotatePointer,
  describeInputPolicies
} from "../input/annotationInputPolicy";
import { AddPageControl } from "../ui/AddPageControl";
import { AddPageTiming } from "../ui/AddPageTiming";
import { shouldIgnoreSelectionShortcut, parseSelectionShortcut, parseHistoryShortcut, inkHotkeyCommand, type InkHotkeyCommand, type SelectionShortcutAction } from "../input/SelectionShortcuts";
import type { PointerSample } from "../input/PointerCapabilities";
import type { CustomPinchFrame } from "../input/PointerRouter";
import { MobilePinchZoomController, type MobilePinchZoomFocalPoint, type MobilePinchZoomFrame } from "../input/MobilePinchZoomController";
import { MobilePdfCssZoom, type MobilePdfCssZoomPage } from "../integration/MobilePdfCssZoom";
import { MobilePdfCssZoomTransaction } from "../integration/MobilePdfCssZoomTransaction";
import type {
  MobilePdfZoomHandoffCancelReason,
  MobilePdfZoomHandoffSignal
} from "../integration/MobilePdfZoomHandoff";
import {
  planMobileCustomPdfZoom,
  type MobileCustomPdfZoomFallbackReason,
  type MobileCustomPdfZoomMode
} from "../integration/MobileCustomPdfZoom";
import { OpenInkStrokeGeometry, type InkStrokeGeometryRecord } from "../input/InkStrokeGeometry";
import { consumeTouchDoubleTap, type TouchDoubleTapPoint, type TouchDoubleTapState } from "../input/TouchDoubleTap";
import { PressureConditioner, pressureConditionerOptionsForCalibration } from "../input/PressureProfile";
import { InkSession, type InkLifecycleEvent } from "../ink/InkSession";
import { DamageLedger } from "../ink/DamageLedger";
import { strokeBounds, type Bounds } from "../ink/StrokeHitTesting";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeClipboard } from "../ink/StrokeClipboard";
import { simplifyPoints } from "../ink/StrokeStabilizer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PageCoordinateMapper, type PageRotation } from "./PageCoordinateMapper";
import { normalizeRotation, pdfRenderCanvas, resolvePageCoordinateLayout, type PageCoordinateLayout } from "../pdf/PageCoordinateLayout";
import { createDetachedDiv, createDetachedEl } from "../vendor/createDetached";
import { getDebugNodeId } from "../dom/debugNodeId";
import { isElement, isElementInDocument, isHTMLElement, setElementCssProps } from "../dom/typeGuards";
import { contactBlockedByOverlay, decidePostZoomPageContact, ensurePdfPageNumbers, isHandwritingPageChrome, isPluginInputChromeTarget, isPostZoomPageTarget } from "../integration/pdfPageSelectors";
import { PdfExportService, annotatedFilename, editableAnnotatedFilename } from "../pdf/PdfExportService";
import type { ImportedPdfPages } from "../pdf/PdfNoteService";
import { exportInkStrokesToSvg } from "../pdf/SvgInkExportService";
import { AddStrokeCommand, ReplaceAnnotationSelectionCommand, ReplacePageStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command, type HistoryChangeAction } from "../history/CommandHistory";
import { eraseStrokes, eraseWholeStrokes } from "../tools/EraserTool";
import { recognizeHeldShape, resizeShapePoints, shapeResizeAnchor, shapeResizeHandle, SHAPE_RECOGNITION_HOLD_MS, type ShapeRecognition } from "../tools/ShapeRecognizer";
import { boundingShapeFromSelection, filterSelectableStrokes, selectStrokes, selectionShapeArea, shapeBounds, shapeContainsPoint, translateShape, visibleStrokeSegments, type SelectionShape } from "../tools/LassoTool";
import { drawHighlighterStroke, drawHighlighterStrokeWithMasks } from "../tools/HighlighterTool";
import {
  drawLaserStroke,
  laserTrailStillVisible,
  mapLaserPoints
} from "../tools/LaserTool";
import { drawGraphiteStroke, seedFromId } from "../tools/PencilTool";
import { drawPenStroke } from "../tools/PenTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity, hashDocumentContent, type DocumentIdentityInput } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import { insertPageIntoSidecar, insertPagesIntoSidecar, removePageFromSidecar, reorderPageInSidecar, reorderPageNumber } from "../storage/SidecarPageRemoval";
import { pickNewerSidecar, serializeSidecar, countSidecarStrokes, countSidecarTexts, type SidecarSchemaV1 } from "../storage/SidecarSchema";
import type { VaultSyncWriter } from "../storage/VaultFs";
import { AnnotationToolbar, type MoreAction } from "../ui/AnnotationToolbar";
import { inkBackingBudget, inkBackingSize } from "./inkBackingSize";
import type { DebugState } from "../ui/DebugPanel";
import { SelectionToolbar, type ViewportPoint } from "../ui/SelectionToolbar";
import { DropdownController } from "../ui/DropdownController";
import { SessionLogger, type DrawPositionLog, type ViewStateSource } from "../logging/SessionLogger";
import { BoundedTiming, EffectiveFrameBudget, type RuntimeFrameProfile, buildScaleDeltaHistogram, roundMetric } from "../logging/PerformanceMetrics";
import { ZoomFrameDiagnostics, type FrameAttributionSummary } from "./ZoomFrameDiagnostics";
import { ZoomPipelineTrace, type ZoomPipelineSummary } from "./ZoomPipelineTrace";
import { MobilePdfZoomDiagnosticsTrace, type MobilePdfZoomTraceSummary } from "./MobilePdfZoomDiagnostics";
import {
  ZoomNativeHandoffTrace,
  type NativeHandoffPhase,
  type ZoomNativeHandoffSummary
} from "./ZoomNativeHandoffTrace";
import type { VaultLogSink } from "../logging/VaultLogSink";
import type { AnnotationViewState } from "./AnnotationSurface";
import { describeScrollElement, scrollPdfByDetailed } from "../integration/PdfScrollRoot";
import { TextAnnotationSession } from "../text/TextAnnotationSession";
import { AddTextAnnotationCommand, DeleteTextAnnotationsCommand, ReplaceTextAnnotationCommand } from "../text/TextAnnotationCommands";
import { textMenu, type TextStyleChange } from "../ui/TextDropdown";
import { insertStyledText, readTextRuns, renderTextRuns, rescaleTextRuns, restoreSelection, selectionOffsets, type TextSelectionOffsets } from "../text/RichTextDom";
import { normalizeTextRuns, patchTextRunRange, plainTextFromRuns, plainTextToRuns, styleAtTextOffset } from "../text/RichTextRuns";
import {
  emitHnDevProbeDiagnostic,
  isHnDevProbeActive,
  type HnDevProbeDiagnostic,
  type HnDevProbeMetric
} from "./DevProbeDiagnostics";
import type { ScanDocumentPage } from "../scanning/ScanDocument";
import { ImageRasterExportService, type ImageRasterFormat, type ImageRasterRenderTarget } from "../image/ImageRasterExportService";
import { IpadPointerTouchTrace } from "../input/IpadPointerTouchTrace";

const INPUT_OWNER_REGISTRY_KEY = "__nativePdfHandwritingInputOwners";
const TEXT_TOUCH_HOLD_MS = 500;
const TEXT_TOUCH_MOVE_THRESHOLD_PX = 10;
const detachedInputOwners = new WeakMap<HTMLElement, ViewerInkSession>();
const wheelPanReplayDepth = new WeakMap<Document, number>();

interface PointerHitTest {
  targetPage: HTMLElement | null;
  geometricPage: AnnotationPageInfo | null;
  safeRecoveryPage: AnnotationPageInfo | null;
  firstInteractiveHit: Element | null;
  firstInteractiveHitBelongsToPage: boolean;
  pageOccludedByUi: boolean;
  details: Record<string, unknown>;
}

function emptyPointerHitTest(targetPage: HTMLElement | null): PointerHitTest {
  return {
    targetPage,
    geometricPage: null,
    safeRecoveryPage: null,
    firstInteractiveHit: null,
    firstInteractiveHitBelongsToPage: false,
    pageOccludedByUi: false,
    details: {}
  };
}

function rectDetails(element: Element | null): Record<string, number> | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function hitElementDetails(element: Element | null): Record<string, unknown> | null {
  if (!element) return null;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const page = element.closest(".page, .pdf-page-view");
  const overlay = element.closest(".native-pdf-handwriting-page-overlay");
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: [...element.classList].slice(0, 6),
    debugNodeId: getDebugNodeId(element),
    pointerEvents: style?.pointerEvents ?? null,
    display: style?.display ?? null,
    visibility: style?.visibility ?? null,
    opacity: style?.opacity ?? null,
    position: style?.position ?? null,
    zIndex: style?.zIndex ?? null,
    transform: style?.transform && style.transform !== "none" ? style.transform : null,
    hidden: isHTMLElement(element) ? element.hidden : false,
    ariaHidden: element.getAttribute("aria-hidden"),
    inert: element.hasAttribute("inert"),
    rect: rectDetails(element),
    connected: element.isConnected,
    pageAncestor: page ? {
      debugNodeId: getDebugNodeId(page),
      pageNumber: isHTMLElement(page) ? page.dataset.pageNumber ?? null : null
    } : null,
    overlayAncestor: overlay ? { debugNodeId: getDebugNodeId(overlay) } : null
  };
}

function containsClientPoint(element: Element, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    && clientX >= rect.left && clientX <= rect.right
    && clientY >= rect.top && clientY <= rect.bottom;
}

function isNonInteractiveHit(element: Element | null): boolean {
  if (!element) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return isHTMLElement(element) && element.hidden
    || element.getAttribute("aria-hidden") === "true"
    || element.hasAttribute("inert")
    || style?.pointerEvents === "none"
    || style?.display === "none"
    || style?.visibility === "hidden"
    || style?.opacity === "0";
}

/** Foreground Obsidian shells that can legitimately own pen hits over a PDF. */
const OBSIDIAN_UI_SHELL_SELECTOR = [
  ".workspace-drawer",
  ".workspace-drawer-backdrop",
  ".modal-container",
  ".modal-bg",
  ".modal",
  ".menu",
  ".popover",
  ".suggestion-container",
].join(", ");

type ObsidianUiShellKind =
  | "drawer"
  | "drawer-backdrop"
  | "modal"
  | "menu"
  | "unknown";

interface ObsidianUiShellRef {
  kind: ObsidianUiShellKind;
  shell: Element;
}

interface ObsidianUiShellSnapshot {
  kind: ObsidianUiShellKind;
  active: boolean;
  details: Record<string, unknown>;
  surfaceInstanceId?: string | null;
  initiatorPointerType?: string | null;
  initiatorAt?: number | null;
  lastInputPointerType?: string | null;
  nestedShellCount?: number;
  nestedShellIds?: Array<string | number | null>;
  openedAt?: number | null;
  openedByPointerType?: string | null;
  routerGenerations?: Array<number | null>;
}

interface NativePenContact {
  startedAt: number;
  scrollBefore: { left: number; top: number };
  maxScrollDeltaPx: number;
  panObserved: boolean;
}

function classifyObsidianUiShell(shell: Element): ObsidianUiShellKind {
  if (shell.classList.contains("workspace-drawer-backdrop")) return "drawer-backdrop";
  if (shell.classList.contains("workspace-drawer")) return "drawer";
  if (
    shell.classList.contains("modal-container")
    || shell.classList.contains("modal-bg")
    || shell.classList.contains("modal")
  ) {
    return "modal";
  }
  if (
    shell.classList.contains("menu")
    || shell.classList.contains("popover")
    || shell.classList.contains("suggestion-container")
  ) {
    return "menu";
  }
  return "unknown";
}

function canonicalObsidianUiShell(shell: Element): Element {
  const kind = classifyObsidianUiShell(shell);
  let canonical = shell;
  let ancestor = shell.parentElement;
  while (ancestor) {
    if (classifyObsidianUiShell(ancestor) === kind) canonical = ancestor;
    ancestor = ancestor.parentElement;
  }
  return canonical;
}

function findObsidianUiShell(element: Element): ObsidianUiShellRef | null {
  const shell = element.closest(OBSIDIAN_UI_SHELL_SELECTOR);
  if (!shell) return null;
  const canonical = canonicalObsidianUiShell(shell);
  return { kind: classifyObsidianUiShell(canonical), shell: canonical };
}

/**
 * Closed mobile drawers stay in the DOM with pointer-events:auto and can still
 * appear in elementsFromPoint() after Settings/drawer close. Only treat an open
 * / pinned / visibly active shell as a real occluder.
 */
function isActiveObsidianUiShell(shell: Element, kind: ObsidianUiShellKind): boolean {
  if (!shell.isConnected || isNonInteractiveHit(shell)) return false;
  if (kind === "drawer") {
    return shell.classList.contains("is-shown")
      || shell.classList.contains("is-pinned")
      || shell.getAttribute("aria-hidden") === "false";
  }
  if (kind === "drawer-backdrop") {
    return shell.classList.contains("is-shown");
  }
  // Modals/menus typically unmount when closed; residual nodes still need the
  // non-interactive / inert checks above.
  return true;
}

function describeObsidianUiShell(
  element: Element | null,
  clientX?: number,
  clientY?: number
): Record<string, unknown> | null {
  if (!element) return null;
  const ref = findObsidianUiShell(element);
  if (!ref) return null;
  const hitInsideShellBounds = typeof clientX === "number" && typeof clientY === "number"
    ? containsClientPoint(ref.shell, clientX, clientY)
    : null;
  return {
    kind: ref.kind,
    ...hitElementDetails(ref.shell),
    active: isActiveObsidianUiShell(ref.shell, ref.kind),
    hitInsideShellBounds
  };
}

/**
 * True only for active Obsidian foreground UI over the PDF. Bare layout chrome
 * (`.vertical-tab-content`, `.setting-item`, titles) is not enough — those nodes
 * linger in mobile hit stacks after Settings/drawers close.
 */
function isObsidianUiOccluder(
  element: Element | null,
  viewerHost: Element,
  clientX?: number,
  clientY?: number
): boolean {
  if (!element || viewerHost.contains(element) || isNonInteractiveHit(element)) return false;
  const ref = findObsidianUiShell(element);
  if (!ref) return false;
  if (!isActiveObsidianUiShell(ref.shell, ref.kind)) return false;
  if (typeof clientX === "number" && typeof clientY === "number") {
    const rect = ref.shell.getBoundingClientRect();
    // Skip bounds rejection when the shell has no layout box yet (jsdom / mid-transition).
    if (rect.width > 0 && rect.height > 0 && !containsClientPoint(ref.shell, clientX, clientY)) {
      return false;
    }
  }
  return true;
}

/** Stale Settings/drawer/layout hits that must not block geometric pen recovery. */
const STALE_LAYOUT_HIT_SELECTOR = [
  ".vertical-tab-content",
  ".vertical-tabs-container",
  ".vertical-tab-nav-item",
  ".vertical-tab-nav-item-title",
  ".setting-item",
  ".setting-item-description",
  ".workspace-drawer-header",
  ".workspace-tab-header-container",
].join(", ");

function isIgnorableStaleOutsideHit(
  element: Element | null,
  viewerHost: Element,
  clientX: number,
  clientY: number
): boolean {
  if (!element || viewerHost.contains(element)) return false;
  const ref = findObsidianUiShell(element);
  // An open/pinned shell owns the hit even when layout boxes are empty in tests.
  if (ref && isActiveObsidianUiShell(ref.shell, ref.kind)) return false;
  if (isObsidianUiOccluder(element, viewerHost, clientX, clientY)) return false;
  if (isNonInteractiveHit(element)) return true;
  if (ref) return true;
  return Boolean(element.closest(STALE_LAYOUT_HIT_SELECTOR));
}

function settleResetBucket(reason: string | null): string {
  if (!reason) return "other";
  if (reason.includes("live-ink")) return "live-ink";
  if (reason.includes("page-render")) return "pages-page-render";
  if (reason.includes("scale")) return "scale-change";
  if (reason.includes("pinch")) return "pinch-cleanup";
  if (reason.includes("remount")) return "viewer-remount";
  if (reason.includes("mutation")) return "mutation";
  if (reason.includes("timer-reset")) return "timer-reset";
  if (reason.includes("scroll")) return "view-scroll";
  return "other";
}

function isInputChromeTarget(target: EventTarget | null): boolean {
  return isPluginInputChromeTarget(target);
}

function inputOwners(pageElement: HTMLElement): WeakMap<HTMLElement, ViewerInkSession> {
  // Page elements belong to a specific Obsidian window. Keep ownership there
  // so a pop-out PDF gets the same duplicate-router protection as the main UI.
  const root = pageElement.ownerDocument.defaultView as (Window & {
    [INPUT_OWNER_REGISTRY_KEY]?: WeakMap<HTMLElement, ViewerInkSession>;
  }) | null;
  if (!root) return detachedInputOwners;
  if (!root[INPUT_OWNER_REGISTRY_KEY]) root[INPUT_OWNER_REGISTRY_KEY] = new WeakMap<HTMLElement, ViewerInkSession>();
  return root[INPUT_OWNER_REGISTRY_KEY];
}

function isReplayingWheelPan(ownerDocument: Document): boolean {
  return (wheelPanReplayDepth.get(ownerDocument) ?? 0) > 0;
}

function replayWheelPan<T>(ownerDocument: Document, work: () => T): T {
  const depth = wheelPanReplayDepth.get(ownerDocument) ?? 0;
  wheelPanReplayDepth.set(ownerDocument, depth + 1);
  try {
    return work();
  } finally {
    if (depth === 0) wheelPanReplayDepth.delete(ownerDocument);
    else wheelPanReplayDepth.set(ownerDocument, depth);
  }
}

export interface MobilePdfZoomDiagnostics {
  settingEnabled: boolean;
  mode: MobileCustomPdfZoomMode;
  fallbackReasons: readonly MobileCustomPdfZoomFallbackReason[];
  active: boolean;
  activePhase: string | null;
  trace: MobilePdfZoomTraceSummary;
}

export interface SessionDiagnostics {
  documentPath: string;
  compatibility: ReturnType<AnnotationSurface["compatibilityReport"]>;
  mobilePdfZoom: MobilePdfZoomDiagnostics;
  debug: DebugState;
}

export interface AddPageMutationRestoreState {
  operationId: string;
  startedAt: number;
  capturedAt: number;
  viewState: AnnotationViewState;
  pageCountBefore: number;
  currentPageBefore: number;
  mountedPageNumbers: number[];
  pageMountGenerationsBefore: Array<number | null>;
  routerGenerationsBefore: number[];
  viewerGenerationBefore: number | null;
  viewerElementDebugIdBefore?: number | null;
  pageDomIds: Array<number | null>;
  canvasIds: Array<number | null>;
  overlayIds: Array<number | null>;
  pageRectsBefore: Array<Record<string, number> | null>;
  viewportBefore: Record<string, number> | null;
  scrollBefore: { left: number; top: number; width: number; height: number };
  /** Runtime-only references used to detect stale connected generations. */
  beforePageElements?: readonly HTMLElement[];
  beforeOverlayElements?: readonly HTMLElement[];
}

export interface ViewerInkSessionOptions {
  adapter: AnnotationSurface;
  documentPath: string;
  /** Content-derived identity captured once while the source PDF is opened. */
  contentHash?: string;
  /** Version stamped onto bounded copied diagnostics profiles. */
  pluginVersion?: string;
  settings: PluginSettings;
  sidecars: SidecarRepository;
  recovery: RecoveryRepository;
  saveSettings(preferences: ToolPreferences): Promise<void>;
  savePluginSettings?(patch: Partial<PluginSettings>): Promise<void>;
  /** Reads source bytes for content identity; works for PDF and image documents. */
  readDocument?(this: void): Promise<Uint8Array>;
  /** Compatibility callback for PDF integrations that have not migrated yet. */
  readSourcePdf?(this: void): Promise<Uint8Array>;
  /** Writes the current source PDF bytes after a validated page import. */
  writeSourcePdf?(bytes: Uint8Array): Promise<void>;
  /** Optional document export supplied by a surface-specific integration. */
  writeExport?(name: string, bytes: Uint8Array): Promise<string | void>;
  /** Writes a separate selected-ink SVG beside the source PDF. */
  writeSvgExport?(this: void, name: string, svg: string): Promise<string | void>;
  /** Inserts a blank page at the requested one-indexed PDF position. */
  onInsertPage?(requestedPageNumber: number, report?: (stage: string) => void): Promise<number>;
  /** Persists the pre-mutation view state across a native PDF reload. */
  onAddPageMutationStart?(state: AddPageMutationRestoreState): void;
  /** Clears a pending restore when the current viewer survived the mutation. */
  onAddPageMutationResolved?(state: AddPageMutationRestoreState): void;
  /** Restore captured Add Page state when a source-PDF rewrite recreated the viewer. */
  restoredAddPageMutation?: AddPageMutationRestoreState;
  /** Opens the source picker and prepares an imported-page PDF without writing it. */
  onImportPages?(afterPage: number): Promise<ImportedPdfPages | null>;
  /** Opens the action-time camera/document review flow. */
  openScanDocument?(): Promise<readonly ScanDocumentPage[] | null>;
  /** Inserts confirmed scanned pages at the requested one-indexed position. */
  onInsertScannedPages?(requestedPageNumber: number, pages: readonly ScanDocumentPage[]): Promise<number>;
  /** Removes one source-PDF page and remaps its persisted annotations. */
  onDeletePage?(pageNumber: number): Promise<void>;
  /** Removes multiple source-PDF pages and remaps persisted annotations once. */
  onDeletePages?(pageNumbers: readonly number[]): Promise<void>;
  /** Moves one source-PDF page and remaps its persisted annotations. */
  onReorderPage?(fromPage: number, toPage: number): Promise<void>;
  notice(message: string): void;
  decideUnsaved?(): Promise<CloseChoice>;
  /** Reads whether left-button mouse input is enabled for annotation. */
  mouseInkingEnabled?(): boolean;
  /** Reads the live explicit touch-only/ambiguous-device fallback. */
  touchDrawFallbackEnabled?(): boolean;
  /** Reads whether a finger double-tap should switch to the eraser. */
  touchDoubleTapEraserEnabled?(): boolean;
  /** Reads the current pressure profile; it is captured when a new stroke starts. */
  pressureProfile?(): PressureProfile;
  /** Reads the current calibration; it is captured when a new stroke starts. */
  pressureCalibration?(): PressureCalibration;
  simplifyStrokesEnabled?(): boolean;
  toolbarPlacement?: () => ToolbarPlacement;
  vaultLog?: VaultLogSink;
  /** Enables diagnostics that would otherwise add avoidable input-path work. */
  debugEnabled?: () => boolean;
  /** PDF++/viewer reload detached our DOM — plugin should drop session and rescan. */
  onDetached?: () => void;
  /** Sync filesystem writer for unload/detach — flush must not race async vault I/O. */
  writeSync?: VaultSyncWriter | null;
  /** Monotonic epoch per document so a replaced session cannot overwrite a newer one. */
  claimPersistEpoch?: (documentId: string) => number;
  livePersistEpoch?: (documentId: string) => number;
  /** Host runtime flags — avoid importing `obsidian` here so unit tests stay portable. */
  runtimePlatform?: () => { mobile: boolean; phone: boolean; ipad?: boolean };
}

interface LaserTrail {
  id: string;
  page: number;
  points: PagePoint[];
  color: string;
  width: number;
  opacity: number;
  holdMs: number;
  fadeMs: number;
}

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ZoomGeometrySnapshot {
  contentRect: RectSnapshot | null;
  overlayRect: RectSnapshot;
}

interface StrokeRenderLifecycleState {
  strokeId: string;
  page: number;
  firstRendered: boolean;
  lastPaintGeneration: number | null;
  lastCanvasGeneration: number | null;
  lastRenderedAt: number | null;
  lastAcknowledgedPaintGeneration: number | null;
  lastOmittedPaintGeneration: number | null;
  lastZoomSettlePaintGeneration: number | null;
}

interface StrokePersistenceLifecycleState {
  strokeId: string;
  lastSerializationRevision: string | null;
  lastSerializationOmissionRevision: string | null;
  lastPersistedRevision: string | null;
}

interface PixelEvidenceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PixelEvidenceSample {
  available: boolean;
  pixelCount: number;
  nonTransparentPixels: number;
  alphaSum: number;
  reason?: string;
}

interface StrokePixelEvidenceState {
  strokeId: string;
  paintGeneration: number | null;
  canvasGeneration: number | null;
  region: PixelEvidenceRegion | null;
  before: PixelEvidenceSample | null;
  lastDelayedPaintGeneration: number | null;
}

interface StrokePerformanceState {
  startedAt: number;
  pointerDownAt: number;
  pointerId: number | null;
  physicalContactId: string | null;
  strokeId: string | null;
  firstCanvasCommitAt: number | null;
  firstInputAt: number | null;
  modelStartedAt: number | null;
  pointerUpAt: number | null;
  page: number;
  tool: string;
  pointerType: string;
  pointerEvents: number;
  renderUpdates: number;
  inputToRender: BoundedTiming;
  routing: BoundedTiming;
  geometry: BoundedTiming;
  model: BoundedTiming;
  scheduling: BoundedTiming;
  canvasCommit: BoundedTiming;
  paintAcknowledgement: BoundedTiming;
  frameIntervals: BoundedTiming;
  renderTotalMs: number;
  maxPluginCallbackMs: number;
  lastRenderAt: number | null;
  longTaskMaxMs: number;
  routerRebinds: number;
  canvasResizes: number;
  vectorRepaints: number;
  mutationRefreshes: number;
  hqUpgrades: number;
}

interface ZoomOverlayLayoutTiming {
  totalMs: number;
  geometryReads: number;
  geometryReadAfterWrite: number;
  phaseDurations: {
    "page-snapshot": number;
    "surface-reconcile": number;
    "layout-read": number;
    "geometry-read": number;
    "overlay-write": number;
    "text-layout": number;
    "layout-diagnostic": number;
    "cursor-refresh": number;
  };
}

interface ZoomProfileState {
  startedAt: number;
  gestureEndedAt: number | null;
  scaleStart: number | null;
  scaleEnd: number | null;
  minScale: number | null;
  maxScale: number | null;
  scaleChangingEvents: number;
  scaleIntervals: BoundedTiming;
  scaleDeltas: BoundedTiming;
  lastScaleAt: number | null;
  lastScale: number | null;
  frameIntervals: BoundedTiming;
  frameCount: number;
  lastFrameAt: number | null;
  worstFrameOffsetMs: number | null;
  longTaskMaxMs: number;
  lastPdfGeometry: RectSnapshot | null;
  lastInkGeometry: RectSnapshot | null;
  geometryReadCount: number;
  geometryReadAfterWriteCount: number;
  maxPdfGeometryDeltaPx: number;
  maxInkGeometryDeltaPx: number;
  maxPdfInkMismatchPx: number;
  worstMismatchOffsetMs: number | null;
  initialScrollLeft: number | null;
  initialScrollTop: number | null;
  scrollEvents: number;
  pageChangingEvents: number;
  mobileRefreshSignals: number;
  mobileRefreshDeferred: number;
  mobileRefreshFramesScheduled: number;
  mobileRefreshExecutions: number;
  refreshRequests: number;
  refreshExecutions: number;
  layoutFramesScheduled: number;
  layoutFramesExecuted: number;
  coalescedVisualUpdates: number;
  layoutSyncs: number;
  compositorTicks: number;
  bitmapBlits: number;
  inkLayerCaptures: number;
  inkLayerBlits: number;
  vectorRepaints: number;
  canvasResizes: number;
  hqUpgrades: number;
  routerRebinds: number;
  routerDestroys: number;
  taskCount: number;
  totalTaskMs: number;
  longestTaskMs: number;
  layoutTaskCount: number;
  layoutTaskTotalMs: number;
  layoutTaskMaxMs: number;
  refreshTaskCount: number;
  refreshTaskTotalMs: number;
  refreshTaskMaxMs: number;
  compositorTaskCount: number;
  compositorTaskTotalMs: number;
  compositorTaskMaxMs: number;
  settleTimerResets: number;
  lastScrollLeft: number | null;
  lastScrollTop: number | null;
  maxScrollDeltaPx: number;
  worstScrollOffsetMs: number | null;
  sidebarFollowActiveDuringZoom: boolean;
  sidebarFollowFramesDuringBurst: number;
  maxSidebarOffsetJump: number;
  sidebarFollowSuppressedTriggers: number;
}

interface PenScrollEvidence {
  correlationId: string;
  beforeLeft: number;
  beforeTop: number;
  maxDeltaPx: number;
  terminalLeft: number | null;
  terminalTop: number | null;
  observedAt: number;
}

interface ToolChangeMarker {
  id: string;
  at: number;
  previousTool: ToolId;
  nextTool: ToolId;
  source: string;
  pointerType: string;
  viewerGeneration: number;
  pageGenerations: Array<{
    page: number;
    mountGeneration: number | null;
    routerGeneration: number | null;
  }>;
}

interface PageSurface {
  page: AnnotationPageInfo;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Generation increments whenever canvas dimensions clear the committed pixels. */
  canvasGeneration: number;
  /** Most recent paint generation acknowledged for this page. */
  paintGeneration: number;
  /** Ephemeral active-stroke layer. The committed ink canvas stays untouched while drawing. */
  draftCanvas: HTMLCanvasElement;
  /** Predicted pen samples stay separate so releasing never has to erase them from the final draft. */
  predictionCanvas: HTMLCanvasElement;
  /** Selection/lasso chrome is isolated from committed ink so pointer moves do not blit the page. */
  selectionCanvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  context: CanvasRenderingContext2D;
  draftContext: CanvasRenderingContext2D;
  predictionContext: CanvasRenderingContext2D;
  selectionContext: CanvasRenderingContext2D;
  /** Committed-stroke cache — blit for live draw + zoom settle before HQ rebuild. */
  inkLayer: HTMLCanvasElement | null;
  inkLayerContext: CanvasRenderingContext2D | null;
  inkLayerValid: boolean;
  /** BackingScale used when inkLayer was last filled by vector paint (not burst bitmap capture). */
  inkLayerBackingScale: number | null;
  /** True if inkLayer was warmed by zoom-burst canvas capture (raster, not canonical). */
  inkLayerBurstCapture: boolean;
  /** Exact InkSession page revision represented by inkLayer, or null when unknown. */
  inkLayerRevision: number | null;
  /** True when a stale committed raster is visible while dense zoom HQ paint is deferred. */
  rasterFallbackReady: boolean;
  /** Off-viewport page skipped a canonical paint and must redraw before display. */
  viewportCullPending: boolean;
  /** Neighbor zoom settle used blit-stretch / lower backing; needs idle HQ upgrade. */
  settleUpgradePending: boolean;
  /** Chunked HQ repaint kept off the release frame for very dense pages. */
  deferredCanonicalPaint: {
    strokes: readonly InkStroke[];
    nextIndex: number;
    pageRevision: number;
    backingScale: number;
    pixelWidth: number;
    pixelHeight: number;
    width: number;
    height: number;
    startedAt: number;
  } | null;
  deferredCanonicalPaintFrame: number | null;
  router: PointerRouter | null;
  mobileCustomPinch: MobilePdfCssZoomTransaction | null;
  pendingRouterHandoff: PointerRouterHandoff | null;
  livePaintFrame: number | null;
  /** One short watchdog lets visible ink paint if the browser misses the next rAF. */
  livePaintFallbackTimer: number | null;
  pendingLivePaint: { kind: "draw" | "edit"; syncText: boolean; sampleCount: number; event?: PointerEvent } | null;
  pendingLivePaintAt: number | null;
  /** Earliest browser input timestamp represented by the pending frame. */
  pendingLiveInputAt: number | null;
  /** One post-commit rAF acknowledgement at a time; never one log per sample. */
  paintAcknowledgementFrame: number | null;
  paintAcknowledgementCancel: (() => void) | null;
  strokePerformance: StrokePerformanceState | null;
  /** Prefix of editPath already represented by the transient live eraser preview. */
  liveEraserPaintedPoints: number;
  /** True while a transient eraser preview owns the page pixels. */
  wetPreviewActive: boolean;
  /** True when the preview erases the visible committed canvas in place. */
  wetPreviewUsesCommittedCanvas: boolean;
  /** Damage accumulated by the transient eraser preview until the command settles. */
  wetDamage: DamageLedger;
  /** Prefix of live stroke preview already stamped on draftCanvas (incremental paint). */
  liveDrawPaintedPoints: number;
  /** Page-space point bounds accumulated while the active stroke is sampled. */
  liveDrawPageBounds: Bounds | null;
  /** Stroke whose final-quality pixels currently occupy draftCanvas. */
  liveDrawPreviewStrokeId: string | null;
  /** Browser-predicted pen points rendered only on the disposable prediction layer. */
  predictedPreview: PagePoint[];
  predictedPreviewPainted: boolean;
  builder: StrokeBuilder | undefined;
  /** Stroke-local input conditioning; never changes already-captured ink. */
  pressureConditioner: PressureConditioner | undefined;
  /** Previous canonical point used for distance-aware pressure conditioning. */
  pressureLastPagePoint: Pick<PagePoint, "x" | "y"> | undefined;
  /** Mouse fallback captured with the drawing style at pointer-down. */
  simulateMousePressure: boolean;
  /** True while the live StrokeBuilder is a non-persisted laser draft. */
  laserDraft: boolean;
  /** Samples dropped from the current ephemeral laser draft. */
  laserDiscardedPoints: number;
  shapeHoldTimer: number | null;
  shapePreview: PagePoint[] | null;
  shapeResize: ShapeResize | null;
  editPath: PagePoint[];
  editTool: "eraser" | "lasso" | undefined;
  eraserSize: number | undefined;
  eraserWholeStrokes: boolean | undefined;
  textIntent: {
    start: PagePoint;
    hit: TextAnnotation | null;
    pointerType: string;
    pointerId: number;
    target: HTMLElement | null;
    longPressTimer: number | null;
    longPressTriggered: boolean;
  } | null;
  /** Last unsafe evidence reason reported for this page generation. */
  annotationSafetyBlocked: string | null;
}

/** A one-shot bitmap cover kept alive while Obsidian replaces a source PDF. */
interface PageMutationShield {
  element: HTMLElement;
  action: "delete" | "insert" | "reorder";
  pageNumber: number;
  capturedPages: number;
  timeout: number | null;
}

interface PendingNativeHandoffUpdate {
  viewerGeneration: number;
  mutation: AnnotationPageContentMutation | null;
  lifecycle: AnnotationPageLifecycleChange | null;
  resizeSignalAt: number | null;
}

interface NativeHandoffMutationResult {
  handled: boolean;
  reattached: boolean;
}

interface ZoomReleaseGate {
  inputTerminalsReady: boolean;
  inputTerminalTimedOut: boolean;
  nativeRenderSignalReady: boolean;
  nativeRenderSignalCount: number;
  nativeRenderSignalAt: number | null;
  nativeContentQuiet: boolean;
  replacementInkReady: boolean;
  stableRafReady: boolean;
  timeoutReached: boolean;
  ready: boolean;
}

interface ActiveTextEditor {
  surface: PageSurface;
  existing: TextAnnotation | null;
  draft: TextAnnotation;
  style: TextStyle;
  /** Canonical text formatting; DOM is synchronized after input but not re-rendered. */
  runs: TextRun[];
  /** Last root-relative selection, retained while a toolbar takes focus. */
  selection: TextSelectionOffsets | null;
  /** Formatting used for the next insertion after a collapsed style change. */
  insertionStyle: TextStyle;
  pendingInsertionStyle: boolean;
  /** Formatting requested during IME composition; applied after compositionend. */
  deferredStyleChange: TextStyleChange | null;
  element: HTMLElement;
  resizeObserver: ResizeObserver | null;
  abort: AbortController;
  /** IME candidate text is not committed annotation content yet. */
  composing: boolean;
}

interface TextMoveDrag {
  page: number;
  start: PagePoint;
  before: TextAnnotation;
  preview: TextAnnotation;
}

type TextBoxHandle = "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

/** A selection-frame drag; the committed text DOM does not reflow until release. */
interface TextBoxTransformDrag {
  surface: PageSurface;
  pointerId: number;
  start: Pick<PagePoint, "x" | "y">;
  before: TextAnnotation;
  preview: TextAnnotation;
  mode: "move" | "resize";
  handle: TextBoxHandle;
  /** Static box translated live for Move; resize keeps its text stationary. */
  box: HTMLElement;
  outline: HTMLElement;
  abort: AbortController;
}

interface ShapeResize {
  recognition: ShapeRecognition;
  anchor: PagePoint;
  handle: PagePoint;
}

export class ViewerInkSession {
  private static nextViewerGeneration = 1;
  private readonly viewerGeneration = ViewerInkSession.nextViewerGeneration++;
  private readonly ink = new InkSession();
  private readonly texts = new TextAnnotationSession();
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly pageSafetyDiagnostics = new Map<number, string>();
  private readonly ownedInputPages = new Set<HTMLElement>();
  private readonly exporter = new PdfExportService();
  private readonly imageExporter = new ImageRasterExportService();
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  /** Bounded generation for the shared toolbar's current mount ownership. */
  private toolbarUiGeneration = 0;
  private lastToolbarMountReason = "not-mounted";
  private lastToolbarUnmountReason: string | null = null;
  private lastHandwritingUiMissingKey = "";
  private uiIntegrityTimer: number | null = null;
  private readonly previousViewerElementDebugId: number | null;
  private lastAddPageOperationId: string | null;
  private readonly selectionToolbar: SelectionToolbar;
  private readonly textContextMenu: DropdownController;
  private textContextMenuTargetId: string | null = null;
  private textContextMenuSuppressTimer: number | null = null;
  private readonly history: CommandHistory;
  /** Pages dirtied by the next history.execute — avoids full multi-page refresh. */
  private readonly historyDirtyPages = new Set<number>();
  /** Pages already painted by the history callback in this turn. */
  private readonly historyPaintedPages = new Set<number>();
  private readonly wetRenderer = new WetInkRenderer();
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  /** One document-local lane for autosave, manual-save, and page-remap persistence. */
  private persistTail: Promise<void> = Promise.resolve();
  private selected: InkStroke[] = [];
  private selectedTexts: TextAnnotation[] = [];
  private selectionShape: SelectionShape | null = null;
  private selectionPage: number | null = null;
  private moveDrag: { page: number; start: PagePoint; before: InkStroke[]; beforeTexts: TextAnnotation[]; beforeShape: SelectionShape } | null = null;
  private movePreview: InkStroke[] | null = null;
  private moveTextPreview: TextAnnotation[] | null = null;
  private moveShapePreview: SelectionShape | null = null;
  private activeTextEditor: ActiveTextEditor | null = null;
  private textMoveDrag: TextMoveDrag | null = null;
  private textBoxTransformDrag: TextBoxTransformDrag | null = null;
  private textToolActive = false;
  private temporaryStylusEraserPointers = 0;
  private debugState: DebugState = {};
  private customMobilePdfPinchZoomEnabledOverride: boolean | null = null;
  /** Visual mobile PDF zoom is persistent CSS/container state, not PDF.js scale. */
  private mobileCssZoomScale = 1;
  private mobileCssZoomTarget: HTMLElement | null = null;
  private mobileCssZoomPreviousInlineValue: string | null = null;
  private destroyed = false;
  private detachNotified = false;
  /** Last Obsidian drawer/modal/menu class mutation — occlusion anomaly telemetry. */
  private lastUiShellMutationAt = 0;
  private uiShellMutationObserver: MutationObserver | null = null;
  private readonly uiShellSnapshots = new Map<Element, ObsidianUiShellSnapshot>();
  private readonly nativePenContacts = new Map<number, NativePenContact>();
  private lastPointerInitiator: { pointerType: string; pointerId: number; at: number; targetId: string | null } | null = null;
  private zoomTimelineSequence = 0;
  private activeZoomTimelineId: string | null = null;
  private readonly postUiInputProbe = new PostUiInputProbe();
  /** Stroke identity is diagnostic-only and bounded to recent model lifecycles. */
  private readonly strokePenContactIds = new Map<string, string | null>();
  private readonly strokeRenderStates = new Map<string, StrokeRenderLifecycleState>();
  private readonly strokePersistenceStates = new Map<string, StrokePersistenceLifecycleState>();
  private readonly strokePixelEvidenceStates = new Map<string, StrokePixelEvidenceState>();
  private readonly strokeRenderVerificationTimers = new Map<string, number>();
  private readonly strokePixelVerificationTimers = new Map<string, number>();
  private nextPaintGeneration = 0;
  private readonly penScrollEvidence = new Map<number, PenScrollEvidence>();
  private postUiProbeTimer: number | null = null;
  private lastUiInputPointerType = "programmatic";
  private touchDoubleTapState: TouchDoubleTapState | null = null;
  private touchDoubleTapPreviousTool: ToolId | null = null;
  private touchDoubleTapChangingTool = false;
  private lastUiSurfaceCloseAt: number | null = null;
  private lastZoomSettleAt: number | null = null;
  private lastTouchPanAt: number | null = null;
  private lastRouterBindAt: number | null = null;
  private lastPageReplacementAt: number | null = null;
  private lastToolChange: ToolChangeMarker | null = null;
  private postUiPendingPersistence: { correlationId: string; page: number | null } | null = null;
  /** Dedup key → last emit time for pen occlusion anomaly bursts. */
  private lastPenOcclusionAnomalyAt = 0;
  private lastPenOcclusionAnomalyKey = "";
  private persistEpoch = 0;
  private alreadyEmergencyPersisted = false;
  private writesAbandoned = false;
  private detachCheckTimer: number | null = null;
  private refreshDepth = 0;
  private resizeFrame: number | null = null;
  /** Coalesces PDF.js mutation, render, and root-resize handoff work. */
  private nativeHandoffUpdateFrame: number | null = null;
  private nativeHandoffUpdateToken = 0;
  private pendingNativeHandoffUpdate: PendingNativeHandoffUpdate | null = null;
  private viewportPaintFrame: number | null = null;
  /** Bumped when an ink layer cache entry is invalidated. Deferred HQ from an older epoch cancels. */
  private renderEpoch = 0;
  private pendingScheduledRefresh: { reason: string; repaintOnly: boolean } | null = null;
  /** One display-frame refresh for mobile scroll/pagechanging signals. */
  private mobileScrollRefreshFrame: number | null = null;
  /** Remount after zoom/handoff if scroll/pagechanging arrived while compositing. */
  private pendingMobileScrollRemount = false;
  private mountBurst = 0;
  private zoomSettleTimer: number | null = null;
  /** Live ink blocks HQ settle until the tip lifts. One pause, not a poll. */
  private zoomSettlePausedForLiveInk = false;
  private zoomSettlePausedAt: number | null = null;
  private zoomSettlePausedReason: "live-ink" | "live-ink-slice" | null = null;
  private zoomSettleResumeTimer: number | null = null;
  private zoomSettleTimerGeneration = 0;
  private zoomSettleTimerDueAt = 0;
  private settleTimerResetCount = 0;
  private runZoomSettlePaintCallCount = 0;
  private lastRunZoomSettlePaintAt = 0;
  private lastSettleDeferralReason: string | null = null;
  private lastZoomSignalReason = "";
  private lastZoomSignalScale: number | null = null;
  private zoomBurstWatchdog: number | null = null;
  /** Coalesces repeated native scale signals to one overlay/layout pass per frame. */
  private zoomLayoutFrame: number | null = null;
  /** Healthy router/cursor maintenance waits for the active contact to terminate. */
  private zoomMaintenanceDeferredForInput = false;
  /** One-frame geometry cache used to keep zoom reads ahead of DOM writes. */
  private zoomLayoutCache: Map<number, PageCoordinateLayout> | null = null;
  private zoomBurstStartedAt = 0;
  private zoomTickCount = 0;
  private zoomBurstScaleStart: number | null = null;
  private zoomBurstScaleEnd: number | null = null;
  /** Last observed PDF.js scale — burst baseline for single-tick delta coalesce. */
  private lastKnownViewScale: number | null = null;
  private zoomBurstReason = "view-scalechanging";
  private zoomCorrelationId: string | null = null;
  /** Last few finished pinches, for Copy Logs. One record per zoom, not per frame. */
  private readonly recentZoomGesturePerformance: Array<Record<string, unknown>> = [];
  private zoomSequence = 0;
  private readonly postZoomTrace = new (requirePostZoomInputRuntime().PostZoomInputTrace)();
  private readonly postZoomDurability = new PostZoomDurabilityTrace();
  private readonly slowSpans = new SlowSpanTrace();
  private readonly frameBudget: EffectiveFrameBudget;
  private readonly zoomFrameDiagnostics: ZoomFrameDiagnostics;
  private readonly zoomPipelineTrace: ZoomPipelineTrace;
  private readonly zoomNativeHandoffTrace: ZoomNativeHandoffTrace;
  private readonly mobilePdfZoomTrace = new MobilePdfZoomDiagnosticsTrace();
  private frameProfileRaf: number | null = null;
  private frameProfileTimer: number | null = null;
  private static readonly FRAME_PROFILE_IDLE_SAMPLE_COUNT = 24;
  private static readonly FRAME_PROFILE_IDLE_RESAMPLE_MS = 15_000;
  private lastZoomFrameAttributionSummary: FrameAttributionSummary | null = null;
  private lastZoomPipelineSummary: ZoomPipelineSummary | null = null;
  private lastZoomNativeHandoffSummary: ZoomNativeHandoffSummary | null = null;
  private readonly openInkStrokeGeometry = new Map<number, OpenInkStrokeGeometry>();
  private readonly recentInkStrokeGeometry: InkStrokeGeometryRecord[] = [];
  private settleWaitStartedAt = 0;
  private zoomGestureStartedAt = 0;
  private pinchTerminalAt = 0;
  private pinchSawContact = false;
  private lastScaleChangeAt = 0;
  private liveInkOverlapStartedAt = 0;
  private liveInkWaitAfterPinchTerminalMs = 0;
  private penLiftedForSettleAt = 0;
  private inGestureResetCount = 0;
  private settleResetReasons: Record<string, number> = {};
  private readonly pointerTypeOrigins = new PointerTypeOriginLog();
  private readonly pinchCleanup = new (requirePostZoomInputRuntime().PinchGestureCleanup)();
  private pinchCleanupFrame: number | null = null;
  private readonly postZoomStrokePointers = new Set<number>();
  private readonly postZoomRouterByPointer = new Map<number, {
    received: boolean;
    rejected: boolean;
    route: PointerRoute | null;
    routeReason: string | null;
    captureStale: boolean;
  }>();
  /** Bounded release gate timer/frame; native replacement keeps this held. */
  private zoomCompositeReleaseFrame: number | null = null;
  private readonly lastInkPixelByPage = new Map<number, boolean>();
  private readonly lastInkVisibilityByPage = new Map<number, InkVisibilitySnapshot>();
  private zoomCompositeReleaseTimer: number | null = null;
  private zoomCompositeSettledAt = 0;
  private lastZoomHandoffSettledAt = 0;
  private zoomNativeContentMutations = 0;
  private lastZoomNativeContentAt = 0;
  /** Native PDF.js can change page geometry after our first zoom settle. */
  private zoomHandoffNeedsFinalRebase = false;
  /** One durable coordinate breadcrumb per page for each text-bearing zoom burst. */
  private readonly zoomTextLayoutLoggedPages = new Set<number>();
  /** First and final ink-anchor snapshots expose zoom coordinate drift without stroke data. */
  private readonly zoomInkLayoutLoggedPhases = new Set<string>();
  private readonly zoomInkAnchorByPage = new Map<number, { normalizedX: number; normalizedY: number }>();
  private zoomProfile: ZoomProfileState | null = null;
  private zoomLongTaskObserver: PerformanceObserver | null = null;
  private interactionLongTaskObserver: PerformanceObserver | null = null;
  private effectiveDrawEnabledState = false;
  private lastObservedTool: ToolId = "pen";
  private lastDrawOwner = "idle";
  private lastActivePenIds: number[] = [];
  private laserTrails: LaserTrail[] = [];
  private laserFadeFrame: number | null = null;
  private lastLaserPaintAt = 0;
  /** Laser fade loop caps ~30fps — full page repaint every frame is too heavy. */
  private static readonly LASER_FADE_MIN_MS = 32;
  /** Bound CPU, allocations, and canvas commands for high-rate stylus input. */
  private static readonly MAX_LASER_DRAFT_POINTS = 1024;
  private lastZoomSignalAt = 0;
  private zoomCompositing = false;
  /** Number of pages admitted to the active pinch working set. */
  private zoomActivePageCount = 0;
  /** Page numbers touched by the most recent active-pinch layout pass. */
  private zoomWorkingPageNumbers = new Set<number>();
  /** Visible pages still needing settle paint (one page per rAF). */
  private zoomSettleQueue: Array<{ page: number; tier: "focus" | "neighbor" }> = [];
  private zoomSettleSliceFrame: number | null = null;
  private zoomSettleSliceStartedAt = 0;
  /** Count each page once in settle metrics even when focus-fast is upgraded. */
  private zoomSettlePaintedPages = new Set<number>();
  private zoomSettleBurst: {
    reason: string;
    burstTicks: number;
    burstDurationMs: number;
    scaleStart?: number;
    scaleEnd?: number;
  } | null = null;
  private zoomSettleStats = {
    pagesRepainted: 0,
    canvasesResized: 0,
    strokesRedrawn: 0,
    skippedDisconnected: 0,
    skippedCulled: 0,
    skippedBlitOnly: 0
  };
  /**
   * Quiet ms after last scale tick before HQ settle paint (resize + stroke redraw).
   * Live stepped trackpad/wheel left ~500ms gaps between micro-bursts; 120ms settled
   * mid-gesture and paid 300–800ms full paints repeatedly (canvasesResized×pages).
   */
  private static readonly ZOOM_SETTLE_MS = 560;
  /** Tiny pinch/nudge only — still above the old mid-gesture thrash floor. */
  private static readonly ZOOM_SETTLE_TINY_MS = 120;
  /**
   * Same-scale resize and finger-up settle. One effective frame budget, not the
   * 560ms trackpad window. Time inside this budget is not a slow span.
   */
  /** Absolute PDF.js scale delta treated as a micro-nudge (below ~one wheel notch). */
  private static readonly ZOOM_SETTLE_TINY_SCALE_DELTA = 0.02;
  /** Relative scale delta gate paired with {@link ZOOM_SETTLE_TINY_SCALE_DELTA}. */
  private static readonly ZOOM_SETTLE_TINY_RELATIVE = 0.015;
  /** Must cover ZOOM_SETTLE_MS so gesture-active / handoff guards hold through coalesce. */
  private static readonly ZOOM_ACTIVE_MS = 600;
  /** Fallback deadline when PDF.js gives no replacement/render signal. */
  private static readonly ZOOM_NATIVE_RENDER_GRACE_MS = 500;
  /** Do not release during the tail of a native page-content replacement burst. */
  private static readonly ZOOM_NATIVE_RENDER_QUIET_MS = 120;
  /** Recheck unresolved release-gate dependencies without a fixed release tail. */
  private static readonly ZOOM_RELEASE_GATE_RETRY_MS = 32;
  /** Detect back-to-back page paints during handoff (flash proxy). */
  private static readonly FLASH_DOUBLE_PAINT_MS = 50;
  /** Large pages use the captured layer for the release frame; HQ restamp follows off-frame. */
  private static readonly LARGE_ZOOM_RASTER_FALLBACK_STROKES = DENSE_ZOOM_RASTER_FALLBACK_STROKES;
  /** Chunk only pages large enough for the captured telemetry's ~1s vector walls. */
  private static readonly DEFERRED_CANONICAL_CHUNK_STROKES = 128;
  private static readonly PIXEL_EVIDENCE_MAX_EDGE = 192;
  private readonly lastPagePaintAt = new Map<number, { at: number; reason: string }>();
  private pasteGeneration = 0;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly logger: SessionLogger;
  private readonly ipadInputTrace: IpadPointerTouchTrace | null;
  private readonly mobilePinchZoom: MobilePinchZoomController;
  private activeMobilePinchSurface: PageSurface | null = null;
  private mobilePinchIndicator: HTMLElement | null = null;
  private mobilePinchIndicatorFadeTimer: number | null = null;
  /** Shared contact owner for document pan and every page router. */
  private readonly gestureOwnership = new GestureOwnership();
  private readonly addPageControl: AddPageControl | null;
  private readonly thumbnailSidebarActions: PdfThumbnailSidebarActions | null;
  private pageMutationInFlight = false;
  /** Add Page state remains pending until the rebuilt page set is observable. */
  private pendingAddPageMutation: AddPageMutationRestoreState | null = null;
  private activeAddPageTiming: AddPageTiming | null = null;
  private addPageMutationViewRestored = false;
  /** PDF find integration is an optional surface extension. */
  private readonly findBridge: AnnotationFindBridge | null;
  /** Last applied browser direct-manipulation policy for mounted PDF pages. */
  private touchDrawPolicyEnabled: boolean | null = null;
  /** Runtime promotion is session-scoped; it is never inferred from UA or persisted. */
  private stylusCapability: "unknown" | "confirmed" = "unknown";
  private readonly pointerProbeAbort = new AbortController();
  private readonly documentInputOwnerId = `session-${this.viewerGeneration}`;
  private readonly documentInputRegistrationSource = "ViewerInkSession.installPointerProbe";
  private documentInputOwnership: DocumentInputOwnershipHandle | null = null;
  private documentInputOwnershipRevoked = false;
  private physicalContactCollectorLease: PhysicalContactCollectorLease | null = null;
  private inputTeardownStarted = false;
  /** Bounded raw browser contact correlation; observation only, never routing ownership. */
  private readonly physicalContactTracker = new PhysicalContactTracker(`physical-contact-${this.documentInputOwnerId}`);
  /** A browser event object must never be processed twice by one collector. */
  private readonly seenPhysicalPointerEvents = new WeakSet<PointerEvent>();
  private readonly seenPhysicalTouchEvents = new WeakSet<TouchEvent>();
  /** Capture-phase collectors and the document probe inspect the same down. */
  private readonly pointerHitTestCache = new WeakMap<PointerEvent, PointerHitTest>();
  /** Links a live PointerEvent id to the bounded physical-contact trace. */
  private readonly physicalContactIdsByPointer = new Map<number, string>();
  /** Pointer-down timestamps let completed stroke profiles separate startup from user draw time. */
  private readonly pointerDownPerformanceAt = new Map<number, number>();
  /** Input/routing timestamps are diagnostic-only and bounded to active pointers. */
  private readonly pointerInputAt = new Map<number, number>();
  private readonly pointerRouteReceivedAt = new Map<number, number>();
  /** Dedup document fallback vs page-router handleDown by pointer and router generation. */
  private readonly handledDrawPointers = new Map<number, number>();
  private lastPointerPdf: { x: number; y: number } | undefined;
  /** Stable PDF point sizes from sidecar / first trusted live measurement — survives bad data-scale inference. */
  private readonly pageMetrics = new Map<number, { width: number; height: number }>();
  /** New pages must win over the native viewer's post-reload saved position. */
  private pendingInsertedPageFocus: { pageNumber: number; expectedPageCount: number } | null = null;
  /** Masks the unavoidable native PDF.js teardown while a source page is changed. */
  private pageMutationShield: PageMutationShield | null = null;
  private pageMutationShieldReleaseFrame: number | null = null;
  private pageMutationShieldReleaseFramesRemaining = 0;
  private pageMutationShieldSettledAt = 0;
  private pageMutationShieldNativeContentMutations = 0;
  private lastPageMutationShieldNativeContentAt = 0;
  private static readonly PAGE_MUTATION_SHIELD_TIMEOUT_MS = 4_000;
  /** Fail-safe only; normal release happens after two ready browser paints. */
  private static readonly PAGE_MUTATION_SHIELD_RENDER_TIMEOUT_MS = 500;
  private static readonly PAGE_MUTATION_SHIELD_READY_FRAMES = 2;
  /** Keep the old bitmap through the last native canvas/text-layer mutation. */
  private static readonly PAGE_MUTATION_SHIELD_RENDER_QUIET_MS = 120;

  private constructor(private readonly options: ViewerInkSessionOptions) {
    this.previousViewerElementDebugId = options.restoredAddPageMutation?.viewerElementDebugIdBefore ?? null;
    this.lastAddPageOperationId = options.restoredAddPageMutation?.operationId ?? null;
    const identityInput: DocumentIdentityInput = {
      vaultPath: options.documentPath,
      ...(options.contentHash ? { contentHash: options.contentHash } : {})
    };
    this.identity = createDocumentIdentity(identityInput);
    this.logger = new SessionLogger(options.documentPath, options.vaultLog, options.debugEnabled, options.pluginVersion);
    const runtimePlatform = options.runtimePlatform?.();
    this.ipadInputTrace = runtimePlatform?.ipad === true
      ? IpadPointerTouchTrace.acquire(options.adapter.host.ownerDocument)
      : null;
    this.ipadInputTrace?.start(options.debugEnabled?.() === true);
    this.frameBudget = new EffectiveFrameBudget(this.frameTimingEnvironment());
    this.zoomFrameDiagnostics = new ZoomFrameDiagnostics(undefined, this.frameBudget);
    this.zoomPipelineTrace = new ZoomPipelineTrace({ enabled: () => this.logger.isEnabled() });
    this.zoomNativeHandoffTrace = new ZoomNativeHandoffTrace();
    this.ink = new InkSession([], (event) => this.recordInkLifecycle(event));
    this.textToolActive = options.settings.toolPreferences.activeTool === "text";
    this.lastObservedTool = options.settings.toolPreferences.activeTool;
    this.logger.textTool("tool-initial", {
      active: this.textToolActive,
      ...describeInputPolicies(options.settings),
      activeTool: options.settings.toolPreferences.activeTool,
      fontSize: options.settings.toolPreferences.text.fontSize,
      fontFamily: options.settings.toolPreferences.text.fontFamily
    });
    this.syncEffectiveDrawState("session-create", "session");
    const pdfExtensions = pdfSurfaceExtensions(options.adapter);
    const imageExtensions = imageSurfaceExtensions(options.adapter);
    this.toolbar = new AnnotationToolbar({
      ownerDocument: options.adapter.host.ownerDocument,
      preferences: options.settings.toolPreferences,
      autosave: options.settings.autosave,
      supportedMoreActions: [
        ...(pdfExtensions && options.writeExport
          ? ["export", "export-editable"] as const
          : []),
        ...(imageExtensions?.imageElement && options.writeExport
          ? ["export-image"] as const
          : []),
        ...(options.onImportPages && options.writeSourcePdf ? ["import-page" as const] : []),
        ...(options.openScanDocument && options.onInsertScannedPages && (options.runtimePlatform?.().mobile ?? false)
          ? ["scan-document" as const]
          : []),
        // Keep the PDF-bar action available on mobile too. `main` is an
        // explicit placement now; hiding it here made the setting impossible
        // to select from the live PDF toolbar on mobile.
        ...(["toolbar-main", "toolbar-left", "toolbar-right"] as const)
      ],
      callbacks: {
        onPreferencesChange: (preferences, reason = "general") => {
          if (reason === "tool" && !this.touchDoubleTapChangingTool) {
            this.touchDoubleTapPreviousTool = null;
          }
          const previousTool = this.lastObservedTool;
          if (preferences.activeTool !== previousTool) {
            const at = Date.now();
            const pageGenerations = [...this.surfaces.values()].map((surface) => ({
              page: surface.page.pageNumber,
              mountGeneration: surface.page.mountGeneration ?? null,
              routerGeneration: surface.router?.generation ?? null
            }));
            this.lastToolChange = {
              id: `tool-${at}-${preferences.activeTool}`,
              at,
              previousTool,
              nextTool: preferences.activeTool,
              source: reason,
              pointerType: this.lastUiInputPointerType,
              viewerGeneration: this.viewerGeneration,
              pageGenerations
            };
            this.logger.toolChanged({
              toolChangeId: this.lastToolChange.id,
              at: this.lastToolChange.at,
              previousTool,
              nextTool: preferences.activeTool,
              source: reason,
              pointerType: this.lastUiInputPointerType,
              viewerGeneration: this.viewerGeneration,
              pageGenerations,
              routerGenerations: pageGenerations.map(({ routerGeneration }) => routerGeneration),
              activeStroke: this.hasAnyLiveInkInput()
            });
          }
          const wasTextToolActive = this.textToolActive;
          this.textToolActive = preferences.activeTool === "text";
          if (wasTextToolActive !== this.textToolActive) {
            this.logger.textTool(this.textToolActive ? "tool-activate" : "tool-deactivate", {
              activeTool: preferences.activeTool,
              ...this.inputPolicyLogFields(),
              textBoxesInteractable: this.textBoxesInteractable()
            });
            // A deactivated Text tool must not leave its contenteditable over
            // the page: it blocks normal static-text rendering until another
            // click happens to commit or discard it.
            if (!this.textToolActive) this.commitActiveTextEditor("tool-deactivate");
          }
          if (!this.textBoxesInteractable()) this.cancelTextBoxTransform("tool-change", false);
          const logTextPreferenceSave = wasTextToolActive || this.textToolActive;
          if (logTextPreferenceSave) {
            this.logger.textTool("preferences-save-start", {
              activeTool: preferences.activeTool,
              fontSize: preferences.text.fontSize,
              fontFamily: preferences.text.fontFamily
            });
          }
          void options.saveSettings(preferences).then(() => {
            if (logTextPreferenceSave) this.logger.textTool("preferences-save-complete", { activeTool: preferences.activeTool });
          }).catch((error) => {
            if (logTextPreferenceSave) {
              this.logger.textTool("preferences-save-error", {
                activeTool: preferences.activeTool,
                error: this.errorMessage(error)
              });
            }
          });
          this.syncEffectiveDrawState(reason === "tool" ? "tool-selected" : "settings-change", reason === "tool" ? "toolbar" : "settings");
          // Text-style changes synchronously update the focused editor, or
          // refresh just the selected text annotations. A full session refresh
          // here redraws every page a second time and makes font-size changes
          // visibly laggy.
          // Tool/style preference changes must not invalidate committed ink —
          // color/width/opacity only affect future strokes; rebuilding after a
          // zoom blit looks like strokes "snapping" to a new color.
          if (reason === "text-style") return;
          if (reason === "tool") {
            this.refreshToolChrome("tool-chrome");
            return;
          }
          this.refreshToolChrome("preferences");
        },
        onEraserSizePreview: () => {
          this.refreshSurfaceCursors();
        },
        onLassoCopyAll: () => {
          this.selectAllOnCurrentPage();
          this.copySelection();
        },
        onTextStyleChange: (change) => this.applyTextStyleToActiveEditor(change),
        onTextFormatPointerDown: () => this.captureActiveTextSelection("toolbar-pointerdown"),
        activeTextStyle: () => this.activeTextStyle(),
        onUndo: () => this.undo(),
        onRedo: () => this.redo(),
        onSave: () => this.manualSave(),
        onMore: (action) => void this.handleMore(action),
        toolbarPlacement: () => this.currentToolbarPlacement()
      }
    });
    this.selectionToolbar = new SelectionToolbar({
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onRecolor: (color) => this.recolorSelection(color),
      onClear: () => this.clearSelection()
    }, options.adapter.host.ownerDocument);
    this.selectionToolbar.bindViewport(options.adapter.root);
    this.textContextMenu = new DropdownController(options.adapter.host.ownerDocument);
    this.autosave = new AutosaveQueue<SidecarSchemaV1>({
      delayMs: options.settings.autosaveDelayMs,
      delayMsForSnapshot: (snapshot) => {
        // Captured telemetry shows 300-stroke documents spending 223–1,549ms
        // in sidecar writes. Give dense snapshots a quiet window so repeated
        // short releases do not each start another blocking vault transaction.
        const strokeCount = countSidecarStrokes(snapshot);
        return strokeCount >= 128
          ? Math.max(options.settings.autosaveDelayMs, 2_500)
          : options.settings.autosaveDelayMs;
      },
      retryFailed: options.settings.retryFailedAutosaves,
      write: async (_documentId, snapshot) => this.persist(snapshot, "autosave"),
      onStatus: (_documentId, status, error) => {
        this.toolbar.setSaveStatus(status, status === "saved" ? new Date() : undefined);
        if (status === "saved") this.saveCoordinator.markSaved();
        if (status === "failed") {
          this.logger.sidecarPersist({
            reason: "autosave",
            documentId: this.identity.id,
            strokeCount: this.ink.all().length,
            textCount: this.texts.all().length,
            dirty: this.isDirty(),
            updatedAt: new Date().toISOString(),
            error: this.errorMessage(error)
          });
        }
      },
      onSlowOperation: (operation) => this.logger.autosaveSlow({ ...operation })
    });
    this.saveCoordinator = new SaveCoordinator({
      autosave: options.settings.autosave,
      saveWhenClosing: options.settings.saveWhenClosing,
      save: () => this.persist(this.snapshot(), "manual"),
      scheduleAutosave: () => this.autosave.schedule(this.identity.id, this.snapshot())
    });
    this.history = new CommandHistory((command, action) => {
      this.saveCoordinator.completedCommand();
      this.toolbar.setSaveStatus("dirty");
      this.paintAfterHistory(command, action);
    });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        const callbackStartedAt = performance.now();
        try {
          this.zoomPipelineTrace.noteEvent("resize-observer");
          this.zoomPipelineTrace.noteStage("resize-observer", 0, 1, "resize-observer");
          this.zoomFrameDiagnostics.noteObserverSignal("resizeObserver");
          this.queueNativeHandoffUpdate({
            kind: "resize",
            signalAt: callbackStartedAt,
            viewerGeneration: this.currentAdapterViewerGeneration()
          });
        } finally {
          this.zoomNativeHandoffTrace.noteSignal({
            name: "resizeObserver",
            signalAt: callbackStartedAt,
            callbackAt: callbackStartedAt,
            callbackWorkMs: performance.now() - callbackStartedAt,
            pageNumbers: this.options.adapter.pages().map((page) => page.pageNumber).slice(0, 64),
            viewerGeneration: this.currentAdapterViewerGeneration(),
            phase: this.nativeHandoffPhase()
          });
        }
      });
    this.resizeObserver?.observe(options.adapter.root);
    const adapter = options.adapter;
    this.mobilePinchZoom = new MobilePinchZoomController({
      minScale: 0.1,
      maxScale: 10,
      getScale: () => {
        try {
          const surface = this.mobilePinchSurfaceAt(null, null);
          return surface && this.customMobilePdfPinchZoomEnabled(surface)
            ? this.mobileCssZoomScale
            : adapter.getViewState().scale;
        } catch {
          return 1;
        }
      },
      getViewportCenter: () => {
        const rect = adapter.root.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null;
      },
      onStart: (frame) => this.startActiveMobilePinch(frame),
      onPreview: (scale, focalPoint) => this.previewActiveMobilePinch(scale, focalPoint),
      onEnd: (scale, reason) => this.endActiveMobilePinch(scale, reason),
      onCancel: (reason) => this.cancelActiveMobilePinch(reason),
      onSettled: (scale) => this.persistMobilePinchScale(scale),
      onEligibility: (target) => this.mobilePinchWheelEligible(target, adapter),
      onIndicator: (scale, reset) => this.updateMobilePinchIndicator(scale, reset, adapter.host.ownerDocument)
    });
    this.addPageControl = options.onInsertPage
      ? new AddPageControl({
        enabled: () => !this.destroyed && typeof this.options.onInsertPage === "function",
        isBusy: () => this.pageMutationInFlight || Boolean(this.pageMutationShield) || this.pendingInsertedPageFocus !== null,
        isDrawing: () => this.hasActiveAnnotationGesture(),
        scrollRoot: () => adapter.scrollElement(),
        host: () => adapter.root,
        onCommit: () => this.addPageAt(Number.MAX_SAFE_INTEGER),
        onLifecycle: (phase, details) => this.logger.addPageUiLifecycle(phase, {
          viewerGeneration: this.addPageViewerGeneration(),
          ...details
        })
      }, adapter.host.ownerDocument)
      : null;
    this.thumbnailSidebarActions = options.onDeletePage && options.onInsertPage
      ? new (requirePdfThumbnailRuntime().PdfThumbnailSidebarActions)(adapter.host, {
        onAddPage: (pageNumber) => this.addPageAt(pageNumber),
        onDeletePage: (pageNumber) => this.deletePage(pageNumber),
        ...(options.onDeletePages
          ? { onDeletePages: (pageNumbers: readonly number[]) => this.deletePages(pageNumbers) }
          : {}),
        ...(options.onReorderPage
          ? { onReorderPage: (fromPage: number, toPage: number) => this.reorderPage(fromPage, toPage) }
          : {}),
        onMenuEvent: (phase, details) => this.logger.thumbnailMenu(phase, details),
        onUiLifecycle: (phase, details) => this.logger.addPageUiLifecycle(phase, {
          viewerGeneration: this.addPageViewerGeneration(),
          ...details
        })
      })
      : null;
    this.findBridge = pdfExtensions ? new AnnotationFindBridge({
      getFindController: () => pdfExtensions.findController?.() ?? null,
      getEventBus: () => pdfExtensions.eventBus?.() ?? null,
      getPageElement: (pageNumber) => adapter.page(pageNumber)?.element ?? null,
      getNativeTextLayer: (pageNumber) => pdfExtensions.nativeTextLayer?.(pageNumber) ?? null,
      textsForPage: (pageNumber) => this.texts.page(pageNumber),
      annotatedPageNumbers: () => {
        const pages = new Set<number>();
        for (const annotation of this.texts.all()) pages.add(annotation.page);
        return [...pages].sort((a, b) => a - b);
      },
      layoutForAnnotation: (pageNumber, annotation) => this.findLayoutForAnnotation(pageNumber, annotation),
      onWarning: (message) => {
        console.warn(`[Handwriting Natively] ${message}`);
        this.options.vaultLog?.write("warn", message);
      },
      onDebug: (phase, details) => {
        if (!(this.options.debugEnabled?.() ?? false)) return;
        this.options.vaultLog?.write("info", `find-bridge:${phase}`, details);
      }
    }) : null;
    this.installPointerProbe(adapter);
    this.startFrameProfileSampling();
  }

  private installPointerProbe(adapter: ViewerInkSessionOptions["adapter"]): void {
    const doc = adapter.host.ownerDocument;
    this.documentInputOwnership = acquireDocumentInputOwnership(doc, {
      ownerId: this.documentInputOwnerId,
      sessionGeneration: this.viewerGeneration,
      registrationSource: this.documentInputRegistrationSource,
      onReplaced: (reason) => this.revokeDocumentInputOwnership(reason)
    });
    const options = { capture: true, signal: this.pointerProbeAbort.signal };

    const within = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return adapter.host.contains(target) || adapter.root.contains(target);
    };

    this.physicalContactCollectorLease = acquirePhysicalContactCollector(doc, {
      ownerId: `viewer-session-${this.viewerGeneration}-${this.identity.id}`,
      sessionId: this.identity.id,
      viewerGeneration: this.viewerGeneration,
      isEnabled: () => this.options.debugEnabled?.() ?? false,
      withinTarget: within,
      onPhysicalContactEvent: (event) => {
        if (this.documentInputOwnershipRevoked || this.documentInputOwnership?.isOwner() !== true) return;
        this.handlePhysicalContactEvent(event);
      },
      onInputHotPathLongTask: (details) => {
        if (this.documentInputOwnershipRevoked || this.documentInputOwnership?.isOwner() !== true) return;
        this.logger.inputHotPathLongTask(details);
      },
      onPhysicalContactDuplicate: (details) => this.handlePhysicalContactDuplicate(details)
    });

    this.installPointerDownProbes(doc, options, within);
    this.installPointerUpCancelProbes(doc, options);
    doc.addEventListener("pointermove", (event: PointerEvent) => {
      this.continueOpenPenStroke(event);
    }, { capture: true, passive: false, signal: this.pointerProbeAbort.signal });
    adapter.scrollElement().addEventListener("scroll", () => this.updatePenScrollEvidence(), options);
    this.installWheelProbes(doc, options, within, adapter);
    this.installGestureProbes(doc, options, within);
    this.installUiShellMutationWatch(doc);
  }

  private revokeDocumentInputOwnership(reason: "replacement" | "released"): void {
    if (this.documentInputOwnershipRevoked) return;
    this.documentInputOwnershipRevoked = true;
    this.logger.inputLifecycleEvent("document-input-ownership-revoked", {
      ownerId: this.documentInputOwnerId,
      collectorId: this.documentInputOwnership?.collectorId ?? null,
      sessionGeneration: this.viewerGeneration,
      reason,
      registrationSource: this.documentInputRegistrationSource
    });
    this.pointerProbeAbort.abort();
    for (const surface of this.surfaces.values()) {
      surface.router?.destroy();
      surface.router = null;
      this.clearTouchDrawPolicy(surface.page.element);
      this.releaseInputOwner(surface.page.element);
    }
    this.gestureOwnership.replaceGeneration();
    this.ownedInputPages.clear();
    this.uiShellMutationObserver?.disconnect();
    this.uiShellMutationObserver = null;
    this.physicalContactIdsByPointer.clear();
    this.pointerDownPerformanceAt.clear();
    this.pointerInputAt.clear();
    this.pointerRouteReceivedAt.clear();
    this.clearPostUiProbeTimer();
  }

  private noteUiInput(event: PointerEvent): void {
    const pointerType = event.pointerType || "(empty)";
    this.lastUiInputPointerType = pointerType;
    if (!isElement(event.target)) return;
    const shell = findObsidianUiShell(event.target);
    if (!shell) return;
    const snapshot = this.uiShellSnapshots.get(shell.shell);
    if (snapshot) snapshot.lastInputPointerType = pointerType;
  }

  private installUiShellMutationWatch(doc: Document): void {
    this.uiShellMutationObserver?.disconnect();
    this.uiShellSnapshots.clear();
    this.captureUiShellSnapshots(doc);
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const target = mutation.target;
        if (isElement(target) && (
          target.matches?.(OBSIDIAN_UI_SHELL_SELECTOR)
          || target.closest?.(OBSIDIAN_UI_SHELL_SELECTOR)
        )) return true;
        return mutation.type === "childList";
      });
      if (!relevant) return;
      this.lastUiShellMutationAt = Date.now();
      const removedShells: Element[] = [];
      for (const mutation of mutations) {
        for (const removed of [...mutation.removedNodes]) {
          if (!isElement(removed)) continue;
          const shell = removed.matches(OBSIDIAN_UI_SHELL_SELECTOR)
            ? removed
            : removed.querySelector(OBSIDIAN_UI_SHELL_SELECTOR);
          if (shell) removedShells.push(canonicalObsidianUiShell(shell));
        }
      }
      this.captureUiShellSnapshots(doc, true, removedShells);
    });
    const root = doc.body ?? doc.documentElement;
    if (!root) return;
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-hidden", "inert", "hidden", "style"]
    });
    this.uiShellMutationObserver = observer;
  }

  private captureUiShellSnapshots(doc: Document, armOnTransition = false, removedShells: readonly Element[] = []): void {
    const next = new Map<Element, ObsidianUiShellSnapshot>();
    const transitions: Record<string, unknown>[] = [];
    const now = Date.now();
    const routerGenerations = this.currentRouterGenerations();
    const candidatesByShell = new Map<Element, Element[]>();
    for (const candidate of [...doc.querySelectorAll(OBSIDIAN_UI_SHELL_SELECTOR)]) {
      const shell = canonicalObsidianUiShell(candidate);
      const candidates = candidatesByShell.get(shell) ?? [];
      candidates.push(candidate);
      candidatesByShell.set(shell, candidates);
    }
    for (const [shell, candidates] of candidatesByShell) {
      const kind = classifyObsidianUiShell(shell);
      const active = isActiveObsidianUiShell(shell, kind);
      const previous = this.uiShellSnapshots.get(shell);
      const opened = active && !previous?.active;
      const nestedShellIds = candidates
        .filter((candidate) => candidate !== shell)
        .map((candidate) => getDebugNodeId(candidate))
        .slice(0, 8);
      const details = {
        ...(hitElementDetails(shell) ?? {}),
        canonicalSurfaceId: getDebugNodeId(shell),
        nestedShellCount: candidates.length,
        nestedShellIds
      };
      const snapshot: ObsidianUiShellSnapshot = {
        kind,
        active,
        details,
        nestedShellCount: candidates.length,
        nestedShellIds,
        openedAt: active ? (previous?.openedAt ?? (opened ? now : null)) : null,
        openedByPointerType: active ? (previous?.openedByPointerType ?? (opened ? this.lastUiInputPointerType : null)) : null,
        lastInputPointerType: active ? (previous?.lastInputPointerType ?? this.lastUiInputPointerType) : null,
        routerGenerations
      };
      next.set(shell, snapshot);
      if (armOnTransition && opened) {
        this.logger.uiSurface("open", {
          surfaceKind: kind,
          surfaceId: getDebugNodeId(shell),
          canonicalSurfaceId: getDebugNodeId(shell),
          nestedShellCount: snapshot.nestedShellCount,
          nestedShellIds: snapshot.nestedShellIds,
          openedAt: now,
          openedByPointerType: snapshot.openedByPointerType,
          lastInputPointerType: snapshot.lastInputPointerType,
          viewerActiveBefore: this.surfaces.size > 0,
          viewerActiveAfter: this.surfaces.size > 0,
          pageRouterGenerationsBefore: previous?.routerGenerations ?? routerGenerations,
          pageRouterGenerationsAfter: routerGenerations
        });
      }
      if (armOnTransition && previous?.active && !active) {
        const transition = {
          kind,
          reason: "active-to-closed",
          surfaceId: getDebugNodeId(shell),
          canonicalSurfaceId: getDebugNodeId(shell),
          nestedShellCount: previous.nestedShellCount,
          nestedShellIds: previous.nestedShellIds,
          openedAt: previous.openedAt ?? null,
          closedAt: now,
          durationMs: previous.openedAt == null ? null : Math.max(0, now - previous.openedAt),
          openedByPointerType: previous.openedByPointerType,
          closingPointerType: this.lastUiInputPointerType,
          lastInputPointerType: previous.lastInputPointerType,
          before: previous.details,
          after: snapshot.details,
          pageRouterGenerationsBefore: previous.routerGenerations,
          pageRouterGenerationsAfter: routerGenerations,
          viewerActiveBefore: this.surfaces.size > 0,
          viewerActiveAfter: this.surfaces.size > 0
        };
        transitions.push(transition);
        this.lastUiSurfaceCloseAt = now;
        this.logger.uiSurface("close", transition);
      }
    }
    if (armOnTransition) {
      for (const [shell, previous] of this.uiShellSnapshots) {
        if (!previous.active || next.has(shell)) continue;
        const transition = {
          kind: previous.kind,
          reason: "removed",
          surfaceId: getDebugNodeId(shell),
          canonicalSurfaceId: getDebugNodeId(shell),
          nestedShellCount: previous.nestedShellCount,
          nestedShellIds: previous.nestedShellIds,
          openedAt: previous.openedAt ?? null,
          closedAt: now,
          durationMs: previous.openedAt == null ? null : Math.max(0, now - previous.openedAt),
          openedByPointerType: previous.openedByPointerType,
          closingPointerType: this.lastUiInputPointerType,
          lastInputPointerType: previous.lastInputPointerType,
          before: previous.details,
          after: { connected: false },
          pageRouterGenerationsBefore: previous.routerGenerations,
          pageRouterGenerationsAfter: routerGenerations,
          viewerActiveBefore: this.surfaces.size > 0,
          viewerActiveAfter: this.surfaces.size > 0
        };
        transitions.push(transition);
        this.lastUiSurfaceCloseAt = now;
        this.logger.uiSurface("close", transition);
      }
      for (const shell of new Set(removedShells.map((candidate) => canonicalObsidianUiShell(candidate)))) {
        if (this.uiShellSnapshots.has(shell)) continue;
        const canonicalShell = canonicalObsidianUiShell(shell);
        const transition = {
          kind: classifyObsidianUiShell(canonicalShell),
          reason: "removed",
          surfaceId: getDebugNodeId(canonicalShell),
          canonicalSurfaceId: getDebugNodeId(canonicalShell),
          nestedShellCount: 1,
          nestedShellIds: [],
          openedAt: null,
          closedAt: now,
          durationMs: null,
          openedByPointerType: null,
          closingPointerType: this.lastUiInputPointerType,
          lastInputPointerType: null,
          before: hitElementDetails(shell) ?? {},
          after: { connected: false },
          pageRouterGenerationsBefore: routerGenerations,
          pageRouterGenerationsAfter: routerGenerations,
          viewerActiveBefore: this.surfaces.size > 0,
          viewerActiveAfter: this.surfaces.size > 0
        };
        transitions.push(transition);
        this.lastUiSurfaceCloseAt = now;
        this.logger.uiSurface("close", transition);
      }
      const transition = transitions.at(-1);
      if (transition) this.armPostUiProbe(doc, transition);
    }
    this.uiShellSnapshots.clear();
    for (const [shell, snapshot] of next) this.uiShellSnapshots.set(shell, snapshot);
  }

  private currentRouterGenerations(): number[] {
    return [...this.surfaces.values()]
      .map((surface) => surface.router?.generation ?? null)
      .filter((generation): generation is number => generation !== null);
  }

  private armPostUiProbe(doc: Document, transition: Record<string, unknown>): void {
    if (this.destroyed || !(this.options.debugEnabled?.() ?? false)) return;
    this.clearPostUiProbeTimer();
    const view = this.options.adapter.getViewState();
    const generations = [...this.surfaces.values()]
      .map((surface) => surface.router?.generation ?? null)
      .filter((generation): generation is number => generation !== null);
    const context: PostUiProbeArmContext = {
      sessionId: this.identity.id,
      viewerGeneration: this.viewerGeneration,
      pageGeneration: generations.length ? Math.max(...generations) : null,
      mountedPages: [...this.surfaces.keys()].sort((a, b) => a - b),
      documentPath: this.options.documentPath,
      transition,
      uiCloseAt: this.lastUiSurfaceCloseAt,
      lastSuccessfulStrokeAt: this.logger.lastSuccessfulStroke().lastEndAt
        ? Date.parse(String(this.logger.lastSuccessfulStroke().lastEndAt))
        : null,
      lastZoomSettleAt: this.lastZoomSettleAt,
      lastTouchPanAt: this.lastTouchPanAt,
      lastRouterBindAt: this.lastRouterBindAt,
      lastPageReplacementAt: this.lastPageReplacementAt
    };
    const now = Date.now();
    const arm = this.postUiInputProbe.arm(now, context);
    this.logger.postUiProbe("armed", {
      armId: arm.armId,
      expiresAt: arm.expiresAt,
      sessionId: context.sessionId,
      viewerGeneration: context.viewerGeneration,
      pageGeneration: context.pageGeneration,
      mountedPages: context.mountedPages,
      currentPdfPage: view.pageNumber,
      currentScale: view.scale,
      transition
    });
    const timerView = doc.defaultView;
    if (!timerView) return;
    this.postUiProbeTimer = timerView.setTimeout(() => {
      this.postUiProbeTimer = null;
      this.expirePostUiProbe();
    }, Math.max(0, arm.expiresAt - now) + 1);
  }

  private expirePostUiProbe(): void {
    const now = Date.now();
    for (const result of this.postUiInputProbe.expire(now)) this.logPostUiProbeResult(result);
    for (const result of this.postUiInputProbe.expireHandoffs(now)) {
      this.logger.inputHandoff("expired", {
        outcome: result.outcome,
        correlationId: result.correlationId,
        penContactId: result.penContactId,
        contact: result.contact,
        details: result.details
      });
      if (result.latency && result.latency.slowPhases.length > 0) {
        this.logger.inputRoutingLatency({
          correlationId: result.correlationId,
          penContactId: result.penContactId,
          physicalContactId: result.contact?.physicalContactId ?? null,
          outcome: result.outcome,
          ownershipStage: result.latency.ownershipStage,
          ownershipDecision: result.latency.ownershipDecision,
          totalMs: result.latency.totalMs,
          phaseDurations: result.latency.phaseDurations,
          slowPhases: result.latency.slowPhases
        });
      }
      this.logger.physicalContactTrace({
        outcome: result.outcome,
        outcomeClass: result.outcomeClass,
        correlationId: result.correlationId,
        penContactId: result.penContactId,
        physicalContactId: result.contact?.physicalContactId ?? null,
        lastObservedStage: result.contact?.lastObservedStage ?? null,
        contact: result.contact,
        trace: result.details.trace ?? null
      });
      this.logger.penRoutingRegression({
        outcome: result.outcome,
        correlationId: result.correlationId,
        page: result.contact?.page ?? null,
        previousSuccessfulCorrelationId: this.logger.lastSuccessfulStroke().lastCorrelationId,
        toolChangeId: this.lastToolChange?.id ?? null
      });
    }
  }

  private clearPostUiProbeTimer(): void {
    if (this.postUiProbeTimer === null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    (view?.clearTimeout ?? window.clearTimeout)(this.postUiProbeTimer);
    this.postUiProbeTimer = null;
  }

  private pointerEventPropagationDetails(
    event: PointerEvent,
    pageElement: HTMLElement | null,
    overlay: HTMLElement | null
  ): Record<string, unknown> {
    const path = typeof event.composedPath === "function" ? event.composedPath().slice(0, 12) : [];
    const pageInPath = Boolean(pageElement && path.includes(pageElement));
    const root = this.options.adapter.root;
    return {
      eventPhase: event.eventPhase,
      capturePhase: event.eventPhase === Event.CAPTURING_PHASE,
      bubblePhase: event.eventPhase === Event.BUBBLING_PHASE,
      targetId: getDebugNodeId(isElement(event.target) ? event.target : null),
      currentTargetId: getDebugNodeId(isElement(event.currentTarget) ? event.currentTarget : null),
      composedPath: path.map((entry) => isElement(entry) ? hitElementDetails(entry) : Object.prototype.toString.call(entry)),
      currentPageInComposedPath: pageInPath,
      adapterRootInComposedPath: path.includes(root),
      viewerHostInComposedPath: path.includes(this.options.adapter.host),
      targetWithinViewer: isElement(event.target) && (root.contains(event.target) || this.options.adapter.host.contains(event.target)),
      targetWithinPage: Boolean(pageElement && isElement(event.target) && pageElement.contains(event.target)),
      targetWithinOverlay: Boolean(overlay && isElement(event.target) && overlay.contains(event.target)),
      targetPageId: getDebugNodeId(this.closestPdfPageElement(event.target)),
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      propagationStopped: Reflect.get(event, "cancelBubble") === true,
      handwritingPreventDefaultCalled: event.defaultPrevented,
      handwritingStoppedPropagation: Reflect.get(event, "cancelBubble") === true
    };
  }

  private beginPenScrollEvidence(correlationId: string, pointerId: number): void {
    const root = this.options.adapter.scrollElement();
    this.penScrollEvidence.set(pointerId, {
      correlationId,
      beforeLeft: root.scrollLeft,
      beforeTop: root.scrollTop,
      maxDeltaPx: 0,
      terminalLeft: null,
      terminalTop: null,
      observedAt: Date.now()
    });
  }

  private updatePenScrollEvidence(): void {
    if (!this.penScrollEvidence.size) return;
    const root = this.options.adapter.scrollElement();
    for (const evidence of this.penScrollEvidence.values()) {
      evidence.maxDeltaPx = Math.max(
        evidence.maxDeltaPx,
        Math.abs(root.scrollLeft - evidence.beforeLeft),
        Math.abs(root.scrollTop - evidence.beforeTop)
      );
      evidence.observedAt = Date.now();
    }
  }

  private finishPenScrollEvidence(pointerId: number): Record<string, unknown> {
    this.updatePenScrollEvidence();
    const evidence = this.penScrollEvidence.get(pointerId);
    if (!evidence) return { nativeMovementObserved: false, maxScrollDeltaPx: 0 };
    const root = this.options.adapter.scrollElement();
    evidence.terminalLeft = root.scrollLeft;
    evidence.terminalTop = root.scrollTop;
    this.penScrollEvidence.delete(pointerId);
    return {
      nativeMovementObserved: evidence.maxDeltaPx > 0,
      scrollBefore: { left: evidence.beforeLeft, top: evidence.beforeTop },
      maxScrollDeltaPx: Number(evidence.maxDeltaPx.toFixed(2)),
      scrollAtTerminal: { left: evidence.terminalLeft, top: evidence.terminalTop },
      scrollDeltaWhileUnclaimed: evidence.maxDeltaPx > 0,
      scrollObservedAt: evidence.observedAt
    };
  }

  private recordDocumentHandoff(
    event: PointerEvent,
    hitTest: PointerHitTest,
    timing?: { capturedAt: number; hitTestMs: number }
  ): void {
    if (!(this.options.debugEnabled?.() ?? false) || event.pointerType !== "pen") return;
    for (const expired of this.postUiInputProbe.expireHandoffs(Date.now())) {
      this.logger.inputHandoff("expired", {
        outcome: expired.outcome,
        correlationId: expired.correlationId,
        contact: expired.contact,
        details: expired.details
      });
      this.logger.penRoutingRegression({
        outcome: expired.outcome,
        correlationId: expired.correlationId,
        page: expired.contact?.page ?? null,
        toolChangeId: this.lastToolChange?.id ?? null
      });
    }
    const page = hitTest.geometricPage?.element ?? null;
    const surface = hitTest.geometricPage ? this.surfaces.get(hitTest.geometricPage.pageNumber) : undefined;
    const router = surface?.router ?? null;
    const capturedAt = timing?.capturedAt ?? Date.now();
    const contact = this.postUiInputProbe.observeDocument(capturedAt, event.pointerId, "pen", {
      physicalContactId: this.physicalContactIdsByPointer.get(event.pointerId) ?? null,
      page: hitTest.geometricPage?.pageNumber ?? null,
      geometricPageId: getDebugNodeId(page),
      safeRecoveryPageId: getDebugNodeId(hitTest.safeRecoveryPage?.element ?? null),
      ...this.pointerEventPropagationDetails(event, page, surface?.overlay ?? null),
      routerBoundElementId: getDebugNodeId(router?.boundElement() ?? null),
      routerGeneration: router?.generation ?? null,
      pageMountGeneration: hitTest.geometricPage?.mountGeneration ?? null,
      viewerGeneration: this.viewerGeneration,
      routerExists: Boolean(router),
      routerAlive: Boolean(router?.isAlive()),
      routerBindsToCurrentPage: Boolean(router && page && router.bindsTo(page)),
      routerListenerAborted: Boolean(router?.isListenerAborted()),
      documentProbeListenerAborted: this.pointerProbeAbort.signal.aborted,
      pageConnected: Boolean(page?.isConnected),
      overlayId: getDebugNodeId(surface?.overlay ?? null),
      overlayConnected: Boolean(surface?.overlay.isConnected),
      pdfCanvasId: getDebugNodeId(page ? pdfRenderCanvas(page) : null),
      activeInputOwner: Boolean(page && inputOwners(page).get(page) === this),
      handledPointerBefore: this.handledDrawPointers.has(event.pointerId),
      handledPointerGenerationBefore: this.handledDrawPointers.get(event.pointerId) ?? null,
      pageGeneration: router?.generation ?? null,
      msSinceRouterBind: this.lastRouterBindAt === null ? null : Math.max(0, Date.now() - this.lastRouterBindAt),
      msSincePageReplacement: this.lastPageReplacementAt === null ? null : Math.max(0, Date.now() - this.lastPageReplacementAt),
      msSinceLastZoomSettle: this.lastZoomSettleAt === null ? null : Math.max(0, Date.now() - this.lastZoomSettleAt),
      msSinceLastTouchZoomPan: this.lastTouchPanAt === null ? null : Math.max(0, Date.now() - this.lastTouchPanAt),
      toolChangeId: this.lastToolChange?.id ?? null,
      selectedToolAtPointerDown: this.activeTool(),
      fallbackConsidered: this.shouldFallbackRoutePointer(event),
      fallbackEligible: Boolean(hitTest.safeRecoveryPage && !hitTest.pageOccludedByUi),
      fallbackRejectedReason: hitTest.pageOccludedByUi
        ? "ui-occluded"
        : hitTest.safeRecoveryPage
          ? null
          : "no-safe-recovery-page"
    });
    if (!contact) return;
    this.beginPenScrollEvidence(contact.correlationId, event.pointerId);
    const captured = this.postUiInputProbe.handoffStage(capturedAt, event.pointerId, "document-capture", {
      ...this.pointerEventPropagationDetails(event, page, surface?.overlay ?? null),
      hitTest: hitTest.details
    });
    this.logger.inputHandoff("document-capture", {
      ...(captured ?? contact),
      pointerType: event.pointerType || "(empty)",
      hitTest: hitTest.details
    });
    this.postUiInputProbe.handoffStage(Date.now(), event.pointerId, "hit-test", {
      page: hitTest.geometricPage?.pageNumber ?? null,
      pageOccludedByUi: hitTest.pageOccludedByUi,
      safeRecoveryPage: hitTest.safeRecoveryPage?.pageNumber ?? null,
      fallbackConsidered: true,
      fallbackEligible: Boolean(hitTest.safeRecoveryPage && !hitTest.pageOccludedByUi),
      fallbackRejectedReason: hitTest.pageOccludedByUi ? "ui-occluded" : hitTest.safeRecoveryPage ? null : "no-safe-recovery-page",
      ...hitTest.details,
      ...(timing && timing.hitTestMs >= POST_UI_INPUT_PHASE_THRESHOLD_MS
        ? { hitTestMs: roundMetric(timing.hitTestMs) }
        : {})
    });
  }

  private finishDocumentHandoff(
    event: PointerEvent,
    terminal: string,
    outcome?: PostUiProbeOutcome,
    details: Record<string, unknown> = {}
  ): void {
    if (!(this.options.debugEnabled?.() ?? false) || event.pointerType !== "pen") return;
    const scroll = this.finishPenScrollEvidence(event.pointerId);
    const evidence = this.postUiInputProbe.handoffStage(Date.now(), event.pointerId, "native-evidence", scroll);
    if (evidence) {
      this.logger.inputHandoff("native-evidence", {
        ...evidence,
        ...scroll,
        pointerType: event.pointerType || "(empty)"
      });
    }
    const result = this.postUiInputProbe.finishHandoff(Date.now(), event.pointerId, terminal, outcome, {
      ...details,
      ...scroll,
      lastSuccessfulStroke: this.logger.lastSuccessfulStroke(),
      msSinceLastSuccessfulStroke: this.logger.timeSinceLastSuccessfulStrokeMs(),
      msSinceUiClose: this.lastUiSurfaceCloseAt === null ? null : Math.max(0, Date.now() - this.lastUiSurfaceCloseAt),
      msSinceZoomSettle: this.lastZoomSettleAt === null ? null : Math.max(0, Date.now() - this.lastZoomSettleAt),
      msSinceLastTouchZoomPan: this.lastTouchPanAt === null ? null : Math.max(0, Date.now() - this.lastTouchPanAt),
      msSinceRouterBind: this.lastRouterBindAt === null ? null : Math.max(0, Date.now() - this.lastRouterBindAt),
      msSincePageReplacement: this.lastPageReplacementAt === null ? null : Math.max(0, Date.now() - this.lastPageReplacementAt),
      lastToolChange: this.lastToolChange,
      ...this.pointerEventPropagationDetails(event, this.closestPdfPageElement(event.target), null)
    });
    if (!result) return;
    if (result.latency && result.latency.slowPhases.length > 0) {
      this.logger.inputRoutingLatency({
        correlationId: result.correlationId,
        penContactId: result.penContactId,
        physicalContactId: result.contact?.physicalContactId ?? null,
        outcome: result.outcome,
        ownershipStage: result.latency.ownershipStage,
        ownershipDecision: result.latency.ownershipDecision,
        totalMs: result.latency.totalMs,
        phaseDurations: result.latency.phaseDurations,
        slowPhases: result.latency.slowPhases
      });
    }
    this.logger.inputHandoff("terminal", {
      outcome: result.outcome,
      correlationId: result.correlationId,
      penContactId: result.penContactId,
      contact: result.contact,
      details: result.details
    });
    this.logger.physicalContactTrace({
      outcome: result.outcome,
      outcomeClass: result.outcomeClass,
      correlationId: result.correlationId,
      penContactId: result.penContactId,
      physicalContactId: result.contact?.physicalContactId ?? null,
      lastObservedStage: result.contact?.lastObservedStage ?? null,
      fallbackRejectedReason: result.contact?.fallbackRejectedReason ?? null,
      contact: result.contact,
      trace: result.details.trace ?? null,
      nativeEvidence: {
        nativeMovementObserved: result.details.nativeMovementObserved ?? false,
        maxScrollDeltaPx: result.details.maxScrollDeltaPx ?? result.contact?.nativeScrollDeltaPx ?? 0,
        scrollBefore: result.details.scrollBefore ?? null,
        scrollAtTerminal: result.details.scrollAtTerminal ?? null
      }
    });
    if (result.outcome !== "post-ui-pen-success") {
      this.logger.penRoutingRegression({
        outcome: result.outcome,
        correlationId: result.correlationId,
        page: result.contact?.page ?? null,
        previousSuccessfulCorrelationId: this.logger.lastSuccessfulStroke().lastCorrelationId,
        toolChangeId: this.lastToolChange?.id ?? null
      });
    }
  }

  private pointerTargetOwnership(event: PointerEvent, hitTest: PointerHitTest): string {
    if (hitTest.pageOccludedByUi) return "obsidian-ui";
    const page = hitTest.geometricPage?.element ?? this.closestPdfPageElement(event.target);
    if (page && isElement(event.target) && page.contains(event.target)) return "pdf-page";
    if (hitTest.safeRecoveryPage) return "pdf-page-recovered";
    return "outside-page";
  }

  private pageGenerationFor(page: HTMLElement | null): number | null {
    if (!page) return null;
    for (const surface of this.surfaces.values()) {
      if (surface.page.element === page) return surface.page.mountGeneration ?? null;
    }
    return null;
  }

  private msSinceZoomSettle(): number | null {
    return this.lastZoomSettleAt === null ? null : Math.max(0, Date.now() - this.lastZoomSettleAt);
  }

  private beginNativePenContact(_event: PointerEvent): void {
    // Pen identity is recorded by the physical-contact collector. This hook stays
    // for post-UI probes that run before routing.
  }

  private safeComposedPath(event: PointerEvent): EventTarget[] | null {
    if (typeof event.composedPath !== "function") return null;
    try {
      return event.composedPath();
    } catch {
      return null;
    }
  }

  private boundedComposedPath(path: EventTarget[] | null): string[] {
    return (path ?? []).slice(0, 12).map((node) => describeTarget(node));
  }

  private recordPostUiProbeDocument(event: PointerEvent, hitTest: PointerHitTest): void {
    if (!(this.options.debugEnabled?.() ?? false)) return;
    const contact = this.postUiInputProbe.pointerDown(Date.now(), event.pointerId, event.pointerType || "(empty)", {
      physicalContactId: this.physicalContactIdsByPointer.get(event.pointerId) ?? null
    });
    if (!contact) return;
    const path = this.safeComposedPath(event);
    const page = hitTest.geometricPage?.element ?? null;
    const target = isElement(event.target) ? event.target : null;
    const documentDetails = {
      eventPhase: event.eventPhase,
      listenerPhase: "document-capture",
      targetId: getDebugNodeId(event.target),
      target: describeTarget(event.target),
      currentTargetId: getDebugNodeId(event.currentTarget),
      composedPathAvailable: path !== null,
      composedPathLength: path?.length ?? 0,
      composedPath: this.boundedComposedPath(path),
      pageInComposedPath: Boolean(page && path?.includes(page)),
      viewerInComposedPath: Boolean(path?.includes(this.options.adapter.root) || path?.includes(this.options.adapter.host)),
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      preventDefaultCalledByHandwriting: false,
      propagationStoppedByHandwriting: false,
      targetWithinViewer: hitTest.details.targetWithinViewer ?? null,
      targetWithinPage: Boolean(page && target && page.contains(target)),
      targetWithinOverlay: Boolean(target?.closest?.(".native-pdf-handwriting-page-overlay")),
      targetPageId: getDebugNodeId(hitTest.targetPage),
      geometricPageId: getDebugNodeId(page),
      geometricPage: hitTest.geometricPage?.pageNumber ?? null,
      safeRecoveryPageId: getDebugNodeId(hitTest.safeRecoveryPage?.element),
      safeRecoveryPage: hitTest.safeRecoveryPage?.pageNumber ?? null,
      elementFromPoint: hitTest.details.topHit ?? null,
      elementsFromPoint: hitTest.details.hitStack ?? [],
      targetOwnership: this.pointerTargetOwnership(event, hitTest),
      page: hitTest.geometricPage?.pageNumber ?? null,
      withinViewer: hitTest.details.targetWithinViewer ?? null,
      viewerGeneration: this.viewerGeneration,
      pageGeneration: this.pageGenerationFor(page),
      zoomTimelineId: this.activeZoomTimelineId,
      msSinceZoomSettle: this.msSinceZoomSettle()
    };
    const updated = this.postUiInputProbe.stage(Date.now(), event.pointerId, "document", documentDetails) ?? contact;
    this.logger.postUiProbe("document", { ...updated, ...documentDetails });
    this.recordPostUiProbeStage(event, "hit-test", {
      ...documentDetails,
      pageOccludedByUi: hitTest.pageOccludedByUi,
      topHitIsPdfPage: hitTest.details.topHitIsPdfPage ?? null,
      firstInteractiveHitBelongsToPage: hitTest.firstInteractiveHitBelongsToPage,
      staleOutsideHit: hitTest.details.staleOutsideHit ?? null
    });
    this.beginNativePenContact(event);
  }

  private recordPostUiProbeStage(
    event: PointerEvent,
    stage: PostUiProbeStage,
    details: Record<string, unknown> = {}
  ): void {
    if (!(this.options.debugEnabled?.() ?? false)) return;
    const path = this.safeComposedPath(event);
    const contact = this.postUiInputProbe.stage(Date.now(), event.pointerId, stage, {
      eventPhase: event.eventPhase,
      targetId: getDebugNodeId(event.target),
      currentTargetId: getDebugNodeId(event.currentTarget),
      composedPathAvailable: path !== null,
      composedPathLength: path?.length ?? 0,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      ...details
    });
    if (!contact) return;
    this.logger.postUiProbe(stage, {
      ...contact,
      pointerType: event.pointerType || "(empty)",
      targetId: getDebugNodeId(event.target),
      currentTargetId: getDebugNodeId(event.currentTarget),
      ...details
    });
    const handoff = event.pointerType === "pen"
      ? this.postUiInputProbe.handoffStage(Date.now(), event.pointerId, stage, details)
      : null;
    if (handoff) {
      this.logger.inputHandoff(stage, {
        ...handoff,
        pointerType: event.pointerType || "(empty)",
        ...details
      });
    }
  }

  private finishPostUiProbe(
    event: PointerEvent,
    terminal: string,
    details: Record<string, unknown> = {}
  ): void {
    const result = this.postUiInputProbe.finish(Date.now(), event.pointerId, terminal, details);
    this.finishDocumentHandoff(event, terminal, result?.outcome, details);
    if (!result) return;
    this.logPostUiProbeResult(result);
    if (result.outcome === "post-ui-pen-success") {
      this.postUiPendingPersistence = {
        correlationId: result.correlationId!,
        page: result.contact?.page ?? null
      };
      this.clearPostUiProbeTimer();
    }
  }

  private finishPostUiProbeWithOutcome(
    event: PointerEvent,
    outcome: PostUiProbeOutcome,
    details: Record<string, unknown> = {}
  ): void {
    const result = this.postUiInputProbe.finishWithOutcome(Date.now(), event.pointerId, outcome, details);
    this.finishDocumentHandoff(event, "pointerdown", outcome, details);
    if (!result) return;
    this.logPostUiProbeResult(result);
  }

  private logPostUiProbeResult(result: PostUiProbeResult): void {
    this.logger.postUiProbe("terminal", {
      armId: result.armId,
      correlationId: result.correlationId,
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
      pointerDownCount: result.pointerDownCount,
      observedPointerTypes: result.observedPointerTypes,
      contactCount: result.contactCount,
      contact: result.contact,
      details: result.details
    });
  }

  private postZoomContactEvidence(record: PhysicalContactRecord, pageNumber: number | null): Record<string, unknown> {
    const contact = record.contact;
    const pointer = contact.rawPointer.first;
    const touch = contact.rawTouch.first;
    const page = pageNumber === null ? undefined : this.options.adapter.pages().find((candidate) => candidate.pageNumber === pageNumber);
    const surface = pageNumber === null ? undefined : this.surfaces.get(pageNumber);
    return {
      physicalContactId: contact.physicalContactId,
      startedAt: contact.startedAt,
      endedAt: contact.endedAt,
      durationMs: contact.durationMs,
      classification: contact.classification,
      classificationTransitions: contact.classificationTransitions,
      pointerIds: contact.pointerIds,
      touchIdentifiers: contact.touchIdentifiers,
      pointerEventPenSeen: contact.pointerEventPenSeen,
      pointerEventTouchSeen: contact.pointerEventTouchSeen,
      touchEventSeen: contact.touchEventSeen,
      representation: contact.representation,
      rawPointerTypeAtDown: pointer?.pointerType ?? null,
      isPrimaryAtDown: pointer?.isPrimary ?? null,
      pressureAtDown: pointer?.pressure ?? null,
      tiltXAtDown: pointer?.tiltX ?? null,
      tiltYAtDown: pointer?.tiltY ?? null,
      buttonAtDown: pointer?.button ?? null,
      buttonsAtDown: pointer?.buttons ?? null,
      composedPathAtDown: pointer?.composedPath.slice(0, 12) ?? touch?.composedPath.slice(0, 12) ?? null,
      composedPathLabelsAtDown: pointer?.composedPathLabels ?? touch?.composedPathLabels ?? null,
      widthAtDown: pointer?.width ?? null,
      heightAtDown: pointer?.height ?? null,
      touchRadiusX: touch?.radiusX ?? null,
      touchRadiusY: touch?.radiusY ?? null,
      touchForce: touch?.force ?? null,
      firstPoint: contact.firstPoint,
      lastValidPoint: contact.lastValidPoint,
      validPhysicalDisplacementPx: requirePostZoomInputRuntime().validPhysicalDisplacementPx(contact),
      pointerCaptureLost: contact.pointerCaptureLost,
      terminalPointRejectReason: contact.terminalPointRejectReason,
      pageNumber,
      pageMountGeneration: surface?.page.mountGeneration ?? null,
      pageElementId: page ? getDebugNodeId(page.element) : null,
      overlayId: surface ? getDebugNodeId(surface.overlay) : null,
      routerGeneration: surface?.router?.generation ?? null
    };
  }

  private notePostZoomDurability(record: PhysicalContactRecord, details: {
    atMs: number;
    pageNumber: number | null;
    stylusIdentity: StylusIdentity;
    strokeStarted: boolean;
    routerReceived: boolean;
    routerRejected: boolean;
    routerRejectReason: string | null;
    route: PointerRoute | null;
    routeReason: string | null;
    scrollLeftAtStart: number | null;
    scrollTopAtStart: number | null;
    scrollLeftAtEnd: number;
    scrollTopAtEnd: number;
    nativeScrollDeltaPx: number | null;
    panObserved: boolean;
    pageElementId: number | null;
    overlayId: number | null;
    routerGeneration: number | null;
    pageMountGeneration: number | null;
    touchActionClasses: string[];
    activeElement: string;
  }): void {
    const contact = record.contact;
    const pointer = contact.rawPointer.first ?? contact.rawPointer.last;
    const events = this.postZoomDurability.note({
      atMs: details.atMs,
      physicalContactId: contact.physicalContactId,
      pointerType: pointer?.pointerType ?? (contact.touchEventSeen ? "touch" : null),
      pointerEventPenSeen: contact.pointerEventPenSeen,
      pointerEventTouchSeen: contact.pointerEventTouchSeen,
      touchEventSeen: contact.touchEventSeen,
      classification: contact.classification,
      pressure: pointer?.pressure ?? null,
      width: pointer?.width ?? null,
      height: pointer?.height ?? null,
      stylusIdentity: details.stylusIdentity,
      pageNumber: details.pageNumber,
      pageMountGeneration: details.pageMountGeneration,
      pageElementId: details.pageElementId,
      overlayId: details.overlayId,
      routerGeneration: details.routerGeneration,
      routerReceived: details.routerReceived,
      routerRejected: details.routerRejected,
      routerRejectReason: details.routerRejectReason,
      route: details.route,
      routeReason: details.routeReason,
      strokeStarted: details.strokeStarted,
      strokeEnded: details.strokeStarted,
      scrollLeftAtStart: details.scrollLeftAtStart,
      scrollTopAtStart: details.scrollTopAtStart,
      scrollLeftAtEnd: details.scrollLeftAtEnd,
      scrollTopAtEnd: details.scrollTopAtEnd,
      nativeScrollDeltaPx: details.nativeScrollDeltaPx,
      panObserved: details.panObserved,
      panAccepted: null,
      target: pointer?.composedPath[0] ?? null,
      composedPath: pointer?.composedPathLabels ?? contact.rawTouch.first?.composedPathLabels ?? pointer?.composedPath ?? contact.rawTouch.first?.composedPath ?? null,
      touchActionClasses: details.touchActionClasses,
      activeElement: details.activeElement
    });
    for (const event of events) {
      if (event.event === "post-zoom-recovery-regressed") this.logger.postZoomRecoveryRegressed({ ...event });
      else this.logger.postZoomPageDragContact({ ...event });
    }
  }

  private notePostZoomPhysicalContact(record: PhysicalContactRecord, target: EventTarget | null): void {
    const point = record.contact.firstPoint ?? record.contact.lastPoint;
    const geometricPage = point
      ? this.options.adapter.pages().find((candidate) => containsClientPoint(candidate.element, point.x, point.y))
      : undefined;
    const page = this.options.adapter.pages().find((candidate) => isPostZoomPageTarget(target, candidate.element));
    const blockedByOverlay = contactBlockedByOverlay(target);
    const decision = decidePostZoomPageContact({
      pageConnected: Boolean(page?.element.isConnected),
      targetInsidePage: Boolean(page),
      blockedByOverlay,
      geometricPageHit: Boolean(geometricPage?.element.isConnected)
    });
    const overPage = decision.recordPageContact;
    if (record.phase === "start" && overPage && record.contact.pointerEventPenSeen) {
      this.slowSpans.notePenDown(performance.now());
    }
    if (record.phase === "start" && decision.rejection) {
      this.postZoomTrace.noteRejectedPageContact({
        ...decision.rejection,
        physicalContactId: record.contact.physicalContactId,
        geometricPageNumber: geometricPage?.pageNumber ?? null
      });
    }
    const retained = record.phase === "terminal"
      ? this.postZoomTrace.retainedContact(record.contact.physicalContactId)
      : null;
    if (record.phase === "start") {
      const noted = this.postZoomTrace.notePageContact(Date.now(), overPage, record.contact.physicalContactId);
      if (noted && page) {
        const scroll = this.options.adapter.scrollElement();
        this.postZoomTrace.remember("post-zoom-contact", {
          ...noted,
          ...this.postZoomContactEvidence(record, page.pageNumber),
          startClassification: record.contact.classification,
          finalClassification: null,
          scrollLeftAtStart: scroll.scrollLeft,
          scrollTopAtStart: scroll.scrollTop,
          targetInsidePage: true,
          blockedByOverlay,
          ...this.gesturePolicyForPage(page.pageNumber),
          pointerTypeOrigins: this.pointerTypeOrigins.forContact(record.contact.pointerIds, record.contact.touchIdentifiers)
        });
      }
      return;
    }
    if ((!overPage || !page) && !retained) {
      if (record.phase === "terminal") {
        for (const pointerId of record.contact.pointerIds) {
          this.postZoomStrokePointers.delete(pointerId);
          this.postZoomRouterByPointer.delete(pointerId);
        }
      }
      return;
    }
    const pageNumber = page?.pageNumber ?? (typeof retained?.pageNumber === "number" ? retained.pageNumber : null);
    const surface = pageNumber === null ? undefined : this.surfaces.get(pageNumber);
    const strokeStarted = record.contact.pointerIds.some((pointerId) => this.postZoomStrokePointers.has(pointerId));
    const route = record.contact.pointerIds
      .map((pointerId) => this.postZoomRouterByPointer.get(pointerId))
      .find((entry) => entry);
    const validPhysicalDisplacement = requirePostZoomInputRuntime().validPhysicalDisplacementPx(record.contact);
    const scroll = this.options.adapter.scrollElement();
    const startLeft = typeof retained?.scrollLeftAtStart === "number" ? retained.scrollLeftAtStart : null;
    const startTop = typeof retained?.scrollTopAtStart === "number" ? retained.scrollTopAtStart : null;
    const nativeScrollDeltaPx = startLeft === null || startTop === null
      ? null
      : Math.hypot(scroll.scrollLeft - startLeft, scroll.scrollTop - startTop);
    const stylusIdentity = requirePostZoomInputRuntime().stylusIdentityFromClassification(record.contact);
    const observation: PostZoomContactObservation = {
      overAnnotatablePage: overPage,
      stylusIdentity,
      physicalContactId: record.contact.physicalContactId,
      strokeStarted,
      routerReceived: route?.received === true,
      routerRejected: route?.rejected === true,
      stalePageBinding: Boolean(surface && page && (surface.page.element !== page.element || !surface.router?.bindsTo(page.element))),
      inputOwnerMismatch: Boolean(page?.element.isConnected && inputOwners(page.element).get(page.element) !== this),
      fallbackRejected: false,
      nativePanWon: !strokeStarted
        && record.contact.pointerEventPenSeen
        && record.contact.terminalPointRejectReason == null
        && !record.contact.pointerCaptureLost
        && route?.received !== true
        && (validPhysicalDisplacement > 8 || (nativeScrollDeltaPx !== null && nativeScrollDeltaPx > 1)),
      pointerCaptureStale: route?.captureStale === true
        || record.contact.pointerCaptureLost
        || record.contact.terminalPointRejectReason?.startsWith("lostpointercapture") === true
    };
    if (overPage && page) this.notePostZoomDurability(record, {
      atMs: Date.now(),
      pageNumber,
      stylusIdentity,
      strokeStarted,
      routerReceived: observation.routerReceived,
      routerRejected: observation.routerRejected,
      routerRejectReason: observation.routerRejected ? (route?.routeReason ?? "route-rejected") : null,
      route: route?.route ?? null,
      routeReason: route?.routeReason ?? null,
      scrollLeftAtStart: startLeft,
      scrollTopAtStart: startTop,
      scrollLeftAtEnd: scroll.scrollLeft,
      scrollTopAtEnd: scroll.scrollTop,
      nativeScrollDeltaPx,
      panObserved: nativeScrollDeltaPx !== null && nativeScrollDeltaPx > 1,
      pageElementId: page ? getDebugNodeId(page.element) : null,
      overlayId: surface ? getDebugNodeId(surface.overlay) : null,
      routerGeneration: surface?.router?.generation ?? null,
      pageMountGeneration: surface?.page.mountGeneration ?? null,
      touchActionClasses: [...page.element.classList].filter((name) => name.startsWith("native-pdf-handwriting-touch-")),
      activeElement: describeTarget(page.element.ownerDocument.activeElement ?? null)
    });
    const anomaly = overPage ? this.postZoomTrace.anomaly(observation, Date.now()) : null;
    this.postZoomTrace.completeAdmittedContact(record.contact.physicalContactId, Date.now());
    const disposition = requirePostZoomInputRuntime().postZoomFinalDisposition({
      penToolActive: isDrawingTool(this.activeTool()),
      stylusIdentity,
      strokeStarted,
      anomalyClassification: anomaly?.classification ?? null
    });
    if (retained) {
      this.postZoomTrace.remember("post-zoom-contact", {
        ...this.postZoomContactEvidence(record, pageNumber),
        classification: record.contact.classification,
        finalClassification: record.contact.classification,
        stylusIdentity,
        strokeStarted,
        strokeEnded: strokeStarted,
        routerReceived: observation.routerReceived,
        routerRejected: observation.routerRejected,
        routerRejectReason: observation.routerRejected ? (route?.routeReason ?? "route-rejected") : null,
        route: route?.route ?? null,
        routeReason: route?.routeReason ?? null,
        fallbackConsidered: null,
        fallbackRejectedReason: null,
        pageMountGeneration: surface?.page.mountGeneration ?? retained.pageMountGeneration ?? null,
        pageElementId: page ? getDebugNodeId(page.element) : retained.pageElementId ?? null,
        overlayId: surface ? getDebugNodeId(surface.overlay) : retained.overlayId ?? null,
        routerGeneration: surface?.router?.generation ?? retained.routerGeneration ?? null,
        nativeScrollDeltaPx,
        panObserved: nativeScrollDeltaPx !== null && nativeScrollDeltaPx > 1,
        panAccepted: null,
        touchActionClasses: page
          ? [...page.element.classList].filter((name) => name.startsWith("native-pdf-handwriting-touch-"))
          : null,
        activeElement: describeTarget(page?.element.ownerDocument.activeElement ?? null),
        recoveryExperiment: this.postZoomTrace.diagnosis().recoveryExperiment,
        ...this.gesturePolicyForPage(pageNumber),
        ...disposition
      });
      const previousStroke = this.logger.lastSuccessfulStroke();
      const settleSnapshot = this.postZoomTrace.diagnosis().settleSnapshot;
      const regression = this.postZoomTrace.noteStylusIdentityRegression(requirePostZoomInputRuntime().stylusIdentityRegression({
        zoomBurstId: this.postZoomTrace.currentBurstId(),
        preZoomPointerType: previousStroke.pointerType,
        preZoomPointerEventPenSeen: previousStroke.pointerEventPenSeen,
        postZoomPointerType: record.contact.rawPointer.first?.pointerType ?? null,
        postZoomPointerEventPenSeen: record.contact.pointerEventPenSeen,
        postZoomStylusIdentity: stylusIdentity,
        strokeStarted,
        preZoomPageMountGeneration: typeof settleSnapshot?.pageMountGeneration === "number" ? settleSnapshot.pageMountGeneration : null,
        postZoomPageMountGeneration: typeof surface?.page.mountGeneration === "number" ? surface.page.mountGeneration : null,
        preZoomRouterGeneration: typeof previousStroke.lastRouterGeneration === "number" ? previousStroke.lastRouterGeneration : null,
        postZoomRouterGeneration: typeof surface?.router?.generation === "number" ? surface.router.generation : null,
        recoveryExperiment: this.postZoomTrace.diagnosis().recoveryExperiment
      }));
      if (regression) this.logger.postZoomStylusIdentityRegression({ ...regression });
    }
    for (const pointerId of record.contact.pointerIds) {
      this.postZoomStrokePointers.delete(pointerId);
      this.postZoomRouterByPointer.delete(pointerId);
    }
    if (!anomaly) return;
    this.logger.postZoomAnomaly({
      classification: anomaly.classification,
      zoomBurstId: anomaly.zoomBurstId,
      physicalContactId: anomaly.physicalContactId,
      stylusIdentity: anomaly.stylusIdentity,
      postZoomContactIndex: anomaly.postZoomContactIndex,
      lifecycle: anomaly.lifecycle
    });
  }

  private handlePhysicalContactEvent(event: PhysicalContactCollectorEvent): void {
    this.pinchCleanup.noteLivePens(
      [...this.surfaces.values()].flatMap((surface) => surface.router?.activePenIds() ?? [])
    );
    for (const record of event.records) {
      const pointers = record.contact.pointerIds;
      const touches = record.contact.touchIdentifiers;
      for (const pointerId of pointers) {
        if (touches.includes(pointerId)) this.pinchCleanup.associate(pointerId, pointerId);
      }
      const pointerId = pointers[0];
      const touchId = touches[0];
      if (pointers.length === 1 && touches.length === 1 && pointerId !== undefined && touchId !== undefined) {
        this.pinchCleanup.associate(pointerId, touchId);
      }
    }
    if (event.kind === "pointer" && event.pointerId !== null) {
      const pointer = event.event as PointerEvent;
      this.pinchCleanup.observePointer(event.pointerId, event.eventType, pointer.pointerType || "");
    } else if (event.event instanceof TouchEvent || "touches" in event.event) {
      const touch = event.event as TouchEvent;
      const changed = [...touch.changedTouches].map((point) => point.identifier);
      const active = [...touch.touches].map((point) => point.identifier);
      for (const prune of this.pinchCleanup.reconcileTouches(event.eventType, changed, active)) {
        this.logger.stalePinchContact({ ...prune });
      }
    } else {
      for (const identifier of event.touchIdentifiers) {
        this.pinchCleanup.observeTouch(identifier, event.eventType);
      }
    }
    this.notePinchTerminalIfQuiet();
    for (const reconciled of this.pinchCleanup.consumePointerReconciliations()) {
      this.logger.stalePinchPointerReconciled({ ...reconciled });
    }
    this.syncStylusPinchExclusion(event.stylusTouchAssociations ?? []);
    this.updatePhysicalContactMappings(event);
    if (event.kind === "pointer" && event.eventType === "pointerdown") {
      this.notePointerTypeOrigin(event.event, "document-physical-contact-collector", "capture");
    }
    if (event.kind === "touch" && event.eventType === "touchstart") {
      this.notePointerTypeOrigin(event.event, "document-physical-contact-collector", "capture");
    }
    for (const record of event.records) this.notePostZoomPhysicalContact(record, event.event.target);
    if (!event.shouldLog) return;
    this.logPhysicalContactRecords(event.records, event);
    const diagnostic = this.physicalContactDiagnostics(event);
    if (event.kind === "pointer" && event.eventType === "pointerdown") {
      const pointer = event.event as PointerEvent;
      const hitPage = this.closestPdfPageElement(pointer.target);
      const targetWithin = isElement(pointer.target)
        && (this.options.adapter.host.contains(pointer.target) || this.options.adapter.root.contains(pointer.target));
      const hitTest = this.shouldFallbackRoutePointer(pointer)
        ? this.inspectPointerHitOnce(pointer, hitPage, targetWithin)
        : emptyPointerHitTest(hitPage);
      this.logger.pointerSeen({
        source: "pointerdown",
        pointerType: pointer.pointerType || "(empty)",
        pointerId: pointer.pointerId,
        isPrimary: pointer.isPrimary,
        button: pointer.button,
        buttons: pointer.buttons,
        width: pointer.width,
        height: pointer.height,
        pressure: pointer.pressure,
        tiltX: pointer.tiltX,
        tiltY: pointer.tiltY,
        clientX: Math.round(pointer.clientX),
        clientY: Math.round(pointer.clientY),
        within: targetWithin,
        target: describeTarget(pointer.target),
        targetId: getDebugNodeId(pointer.target),
        hitPageId: getDebugNodeId(hitPage),
        hasDataPageNumber: Boolean(hitPage?.hasAttribute("data-page-number")),
        dataPageNumber: hitPage?.dataset.pageNumber ?? null,
        ...this.inputPolicyLogFields(),
        ...(hitTest.geometricPage ? { geometricPageNumber: hitTest.geometricPage.pageNumber } : {}),
        ...diagnostic
      });
    }
    if (event.kind === "touch" && event.eventType === "touchstart") {
      const touch = event.event as TouchEvent;
      const targetWithin = isElement(touch.target)
        && (this.options.adapter.host.contains(touch.target) || this.options.adapter.root.contains(touch.target));
      this.logger.pointerSeen({
        source: "touchstart",
        pointerType: "touch",
        touchCount: touch.touches.length,
        changedCount: touch.changedTouches.length,
        within: targetWithin,
        target: describeTarget(touch.target),
        touches: [...touch.changedTouches].slice(0, 8).map((point) => ({
          identifier: point.identifier,
          clientX: Math.round(point.clientX),
          clientY: Math.round(point.clientY),
          radiusX: point.radiusX,
          radiusY: point.radiusY,
          force: point.force
        })),
        ...diagnostic
      });
    }
  }

  private handlePhysicalContactDuplicate(details: PhysicalContactDuplicateObserver): void {
    this.logger.physicalContactDuplicateObserver({ ...details });
  }

  private syncStylusPinchExclusion(associations: readonly { touchIdentifier: number; physicalContactId: string; pointerId: number | null }[]): void {
    const live = new Set(associations.map((association) => association.touchIdentifier));
    for (const association of associations) {
      if (!this.pinchCleanup.excludeStylusTouch(association.touchIdentifier)) continue;
      this.logger.pinchTouchExcludedAsStylus({
        touchIdentifier: association.touchIdentifier,
        physicalContactId: association.physicalContactId,
        pointerId: association.pointerId,
        pointerType: "pen"
      });
    }
    for (const id of this.pinchCleanup.associationState().stylusAssociatedTouchIdentifiers) {
      if (live.has(id)) continue;
      this.pinchCleanup.releaseStylusTouch(id);
      this.postZoomTrace.noteBurstActivity({ stylusAssociationReleasedAt: Date.now() });
    }
    this.postZoomTrace.noteBurstActivity({
      ...this.pinchCleanup.associationState(),
      stylusAssociationSourcePhysicalContactId: associations[0]?.physicalContactId ?? null
    });
  }

  private updatePhysicalContactMappings(event: PhysicalContactCollectorEvent): void {
    for (const record of event.records) {
      const contact = record.contact;
      for (const pointerId of contact.pointerIds) {
        if (record.phase === "terminal") this.physicalContactIdsByPointer.delete(pointerId);
        else this.physicalContactIdsByPointer.set(pointerId, contact.physicalContactId);
      }
    }
    if (event.pointerId === null) return;
    if (event.pointerContactId !== null) {
      this.physicalContactIdsByPointer.set(event.pointerId, event.pointerContactId);
    } else if (event.eventType === "pointerup" || event.eventType === "pointercancel") {
      this.physicalContactIdsByPointer.delete(event.pointerId);
      this.clearPointerPerformanceTiming(event.pointerId);
    }
  }

  private physicalContactDiagnostics(event: PhysicalContactCollectorEvent): Record<string, unknown> {
    return {
      collectorId: event.collectorId,
      sessionId: event.sessionId,
      ownerCollectorId: event.ownerId,
      viewerGeneration: event.viewerGeneration,
      sessionGeneration: event.sessionGeneration,
      observerOwnerIds: event.observerOwnerIds,
      listenerRegistrationScope: event.registrationScope,
      registrationSource: event.registrationSource,
      pointerId: event.pointerId,
      touchIdentifiers: event.touchIdentifiers,
      eventTimeStamp: event.event instanceof Event ? event.event.timeStamp : null,
      alreadySeen: event.alreadySeen,
      chosenPhysicalContactId: event.chosenPhysicalContactId
    };
  }

  private logPhysicalContactRecords(
    records: PhysicalContactCollectorEvent["records"],
    _event?: PhysicalContactCollectorEvent
  ): void {
    for (const record of records) {
      const contact = record.contact;
      this.logger.pointerSeen({
        source: "physical-contact",
        collectorId: this.documentInputOwnership?.collectorId ?? null,
        ownerId: this.documentInputOwnerId,
        sessionGeneration: this.viewerGeneration,
        registrationScope: "document",
        registrationSource: this.documentInputRegistrationSource,
        phase: record.phase,
        physicalContactId: contact.physicalContactId,
        representation: contact.representation,
        pairedStreams: contact.pairedStreams,
        pointerEventPenSeen: contact.pointerEventPenSeen,
        pointerEventTouchSeen: contact.pointerEventTouchSeen,
        touchEventSeen: contact.touchEventSeen,
        pointerIds: contact.pointerIds,
        touchIdentifiers: contact.touchIdentifiers,
        penContactId: contact.penContactId,
        classification: contact.classification,
        classificationReason: contact.classificationReason,
        classificationTransitions: contact.classificationTransitions,
        startedAt: contact.startedAt,
        endedAt: contact.endedAt,
        durationMs: contact.durationMs,
        terminal: contact.terminal,
        pointerTerminal: contact.pointerTerminal,
        pointerCaptureLost: contact.pointerCaptureLost,
        touchTerminal: contact.touchTerminal,
        pointerMoveCount: contact.pointerMoveCount,
        touchMoveCount: contact.touchMoveCount,
        maxDisplacementPx: contact.maxDisplacementPx,
        firstPoint: contact.firstPoint,
        lastPoint: contact.lastPoint,
        rawPointer: contact.rawPointer,
        rawTouch: contact.rawTouch
      });
    }
  }

  private recordPhysicalPointerEvent(
    event: PointerEvent,
    eventType: RawPointerContactSample["eventType"]
  ): void {
    if (!(this.options.debugEnabled?.() ?? false)) return;
    if (this.seenPhysicalPointerEvents.has(event)) return;
    this.seenPhysicalPointerEvents.add(event);
    const now = Date.now();
    const sample = rawPointerContactSample(event, eventType);
    const records = this.physicalContactTracker.expire(now);
    const current = eventType === "pointerdown"
      ? this.physicalContactTracker.pointerDown(now, sample)
      : eventType === "pointermove"
        ? this.physicalContactTracker.pointerMove(now, sample)
        : this.physicalContactTracker.pointerEnd(now, sample);
    this.logPhysicalContactRecords([...records, ...current]);
  }

  private recordPhysicalTouchEvent(
    event: TouchEvent,
    eventType: RawTouchContactEvent["eventType"]
  ): void {
    if (!(this.options.debugEnabled?.() ?? false)) return;
    if (this.seenPhysicalTouchEvents.has(event)) return;
    this.seenPhysicalTouchEvents.add(event);
    const now = Date.now();
    const raw = rawTouchContactEvent(event, eventType);
    const records = this.physicalContactTracker.expire(now);
    const current = eventType === "touchstart"
      ? this.physicalContactTracker.touchStart(now, raw)
      : eventType === "touchmove"
        ? this.physicalContactTracker.touchMove(now, raw)
        : this.physicalContactTracker.touchEnd(now, raw);
    this.logPhysicalContactRecords([...records, ...current]);
  }

  private notePointerTypeOrigin(event: Event, listener: string, listenerPhase: PointerTypeListenerPhase): void {
    const origin = this.pointerTypeOrigins.note(pointerTypeOrigin(event, listener, listenerPhase));
    this.logger.pointerTypeOrigin({ ...origin });
  }

  private installPointerDownProbes(
    doc: Document,
    options: AddEventListenerOptions,
    within: (target: EventTarget | null) => boolean
  ): void {
    doc.addEventListener("pointerdown", (e: PointerEvent) => {
      this.notePointerTypeOrigin(e, "document-pointer-probe", "capture");
      this.noteUiInput(e);
      const hitPage = this.closestPdfPageElement(e.target);
      const capturedAt = Date.now();
      const hitTestStartedAt = performance.now();
      const hitTest = this.shouldFallbackRoutePointer(e)
        ? this.inspectPointerHitOnce(e, hitPage, within(e.target))
        : emptyPointerHitTest(hitPage);
      this.recordDocumentHandoff(e, hitTest, {
        capturedAt,
        hitTestMs: performance.now() - hitTestStartedAt
      });
      this.recordPostUiProbeDocument(e, hitTest);
      const documentTarget = isElement(e.target) ? e.target : null;
      const documentActivePenIds = [...new Set(
        [...this.surfaces.values()].flatMap((surface) => surface.router?.activePenIds() ?? [])
      )];
      const documentActiveTouchIds = this.pluginTouchPointerIds();
      const documentPhysicalContactId = this.physicalContactIdsByPointer.get(e.pointerId) ?? null;
      const duplicateLookingContactIds = documentPhysicalContactId === null
        ? []
        : [...this.physicalContactIdsByPointer.entries()]
          .filter(([pointerId, contactId]) => pointerId !== e.pointerId && contactId === documentPhysicalContactId)
          .map(([pointerId]) => pointerId)
          .slice(0, 8);
      let documentCoalescedCount = 0;
      let documentPredictedCount = 0;
      try {
        documentCoalescedCount = e.getCoalescedEvents?.().length ?? 0;
        const predicted = (e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }).getPredictedEvents;
        documentPredictedCount = predicted ? predicted.call(e).length : 0;
      } catch {
        // Browser diagnostic APIs can disappear while a viewer page is recycled.
      }
      this.logger.inputLifecycleEvent("pointerdown", {
        source: "document-capture",
        eventType: e.type,
        pointerType: e.pointerType || "(empty)",
        pointerId: e.pointerId,
        pointerMetadata: {
          isPrimary: e.isPrimary,
          button: e.button,
          buttons: e.buttons,
          pressure: e.pressure,
          width: e.width,
          height: e.height
        },
        targetClass: documentTarget ? {
          tag: documentTarget.tagName.toLowerCase(),
          id: documentTarget.id || null,
          classes: [...documentTarget.classList].slice(0, 6)
        } : null,
        targetId: getDebugNodeId(e.target),
        pageUiClassification: {
          page: hitTest.geometricPage?.pageNumber ?? null,
          targetWithinViewer: hitTest.details.targetWithinViewer ?? null,
          targetWithinPage: hitTest.details.targetWithinPage ?? null,
          pageOccludedByUi: hitTest.pageOccludedByUi,
          targetOwnership: this.pointerTargetOwnership(e, hitTest)
        },
        ownerBefore: hitTest.geometricPage
          ? inputOwners(hitTest.geometricPage.element).get(hitTest.geometricPage.element) === this ? "this-session" : "other-session"
          : "none",
        ownerAfter: hitTest.geometricPage
          ? inputOwners(hitTest.geometricPage.element).get(hitTest.geometricPage.element) === this ? "this-session" : "other-session"
          : "none",
        activePenCount: documentActivePenIds.length,
        activePenIds: documentActivePenIds.slice(0, 8),
        activeTouchCount: documentActiveTouchIds.length,
        activeTouchPointerIds: documentActiveTouchIds.slice(0, 8),
        captureSet: false,
        captureLost: false,
        generation: hitTest.geometricPage ? this.surfaces.get(hitTest.geometricPage.pageNumber)?.router?.generation ?? null : null,
        coalescedCount: documentCoalescedCount,
        predictedCount: documentPredictedCount,
        duplicateLookingContactCount: duplicateLookingContactIds.length,
        duplicateLookingContactIds,
        reason: "document-capture"
      });
      // Capture: own pen/mouse draw sync here. Page capture can stay deaf after
      // zoom while binds/alive still look healthy; bubble never runs if something
      // stops the event mid-descent. Microtask is too late for preventDefault.
      this.captureDrawPointerFallback(e, within, hitTest);
      if (e.pointerType === "pen") {
        const pointerId = e.pointerId;
        queueMicrotask(() => {
          const contact = this.postUiInputProbe.handoffSummary(pointerId);
          if (!contact || contact.routerReceived || contact.strokeStarted) return;
          this.postUiInputProbe.handoffStage(Date.now(), pointerId, "fallback", {
            fallbackConsidered: true,
            fallbackEligible: false,
            fallbackRejected: true,
            fallbackRejectedReason: "same-dispatch-no-router"
          });
          this.finishDocumentHandoff(e, "pointerdown", "pen-seen-document-not-router", {
            penSeenDocumentNotRouter: true,
            fallbackRejected: true,
            fallbackRejectedReason: "same-dispatch-no-router"
          });
        });
      }
    }, { ...options, passive: false });

    // Bubble: if the page router never marked the pointer, own the stroke here.
    doc.addEventListener("pointerdown", (e: PointerEvent) => {
      this.notePointerTypeOrigin(e, "document-pointer-fallback", "bubble");
      const hitPage = this.closestPdfPageElement(e.target);
      const hitTest = this.shouldFallbackRoutePointer(e)
        ? this.inspectPointerHit(e, hitPage, within(e.target))
        : emptyPointerHitTest(hitPage);
      this.bubbleDrawPointerFallback(e, within, hitTest);
    }, { capture: false, signal: this.pointerProbeAbort.signal, passive: false });
  }

  private installPointerUpCancelProbes(
    doc: Document,
    options: AddEventListenerOptions
  ): void {
    const clearHandled = (e: PointerEvent): void => {
      this.finishDocumentHandoff(e, e.type === "pointercancel" ? "pointercancel" : "pointerup", undefined, {
        terminalObservedByDocument: true,
        eventType: e.type
      });
      this.handledDrawPointers.delete(e.pointerId);
    };
    doc.addEventListener("pointerup", clearHandled, options);
    doc.addEventListener("pointercancel", clearHandled, options);
  }

  private beginInkStrokeGeometry(event: PointerEvent, samples: PointerSample[]): void {
    const geometry = new OpenInkStrokeGeometry();
    geometry.noteSamples(samples, false);
    this.openInkStrokeGeometry.set(event.pointerId, geometry);
  }

  private noteInkStrokeMove(event: PointerEvent, samples: PointerSample[]): void {
    this.openInkStrokeGeometry.get(event.pointerId)?.noteSamples(samples, true);
  }

  private finishInkStrokeGeometry(event: PointerEvent, samples: PointerSample[], terminalEvent: string): void {
    const geometry = this.openInkStrokeGeometry.get(event.pointerId);
    if (!geometry) return;
    this.openInkStrokeGeometry.delete(event.pointerId);
    if (samples.length > 0) geometry.noteSamples(samples, false);
    const record = geometry.finish(event.pointerId, terminalEvent, event);
    this.recentInkStrokeGeometry.push(record);
    if (this.recentInkStrokeGeometry.length > 3) this.recentInkStrokeGeometry.shift();
    this.logger.inkStrokeGeometry({ ...record });
  }

  /** Page capture loses Pencil moves after capture leaves the page. Document still sees them. */
  private continueOpenPenStroke(event: PointerEvent): void {
    if (this.destroyed || this.inputTeardownStarted || this.documentInputOwnershipRevoked) return;
    if (event.pointerType !== "pen") return;
    for (const surface of this.surfaces.values()) {
      if (surface.router?.acceptDocumentPenStroke(event)) return;
    }
  }

  private installWheelProbes(
    doc: Document,
    options: AddEventListenerOptions,
    within: (target: EventTarget | null) => boolean,
    adapter: ViewerInkSessionOptions["adapter"]
  ): void {
    let wheelPinchCount = 0;
    let lastWheelLogAt = 0;
    let wheelPanCount = 0;
    let lastWheelPanLogAt = 0;

    const withinNativePdfSidebar = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest(
        ".pdf-sidebar-container, .pdf-sidebar, .pdf-thumbnail-view, .pdf-outline-view"
      ));
    };

    const applyWheelPan = (root: HTMLElement, deltaX: number, deltaY: number, clientX: number, clientY: number): boolean => {
      return replayWheelPan(doc, () => {
        const vertical = deltaY === 0 ? false : scrollPdfByDetailed(root, deltaY, clientX, clientY).changed;
        const beforeLeft = root.scrollLeft;
        if (deltaX !== 0) root.scrollLeft += deltaX;
        return vertical || root.scrollLeft !== beforeLeft;
      });
    };

    const logWheelPan = (
      event: WheelEvent,
      phase: "in-view" | "sidebar" | "outside-viewer" | "no-scroll-root",
      details: Record<string, unknown>
    ): void => {
      const now = performance.now();
      wheelPanCount += 1;
      if (wheelPanCount > 1 && now - lastWheelPanLogAt < 80) return;
      lastWheelPanLogAt = now;
      this.notePointerTypeOrigin(event, "document-wheel", "capture");
      this.logger.pointerSeen({
        source: "wheel-pan",
        pointerType: "wheel",
        phase,
        ...details,
        burstIndex: wheelPanCount
      });
    };

    // Mac trackpad pinch = wheel+ctrl in Chromium/Electron — not pointerType "touch".
    // MockTab two-finger pan = plain continuous wheel. This document-capture
    // listener sees every Obsidian pane, so only own events in the PDF view;
    // native thumbnail/outline sidebars must retain their own scrolling.
    doc.addEventListener("wheel", (e: WheelEvent) => {
      if (isReplayingWheelPan(doc)) return;
      if (e.ctrlKey || e.metaKey) {
        if (this.mobilePinchZoom.handleWheel(e)) {
          e.preventDefault();
          return;
        }
        const now = performance.now();
        wheelPinchCount += 1;
        if (wheelPinchCount > 1 && now - lastWheelLogAt < 80) return;
        lastWheelLogAt = now;
        this.notePointerTypeOrigin(e, "document-wheel", "capture");
        this.logger.pointerSeen({
          source: "wheel-pinch",
          pointerType: "wheel",
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: Math.round(e.clientX),
          clientY: Math.round(e.clientY),
          within: within(e.target),
          target: describeTarget(e.target),
          burstIndex: wheelPinchCount
        });
        return;
      }
      if (e.deltaX === 0 && e.deltaY === 0) return;
      if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;

      const root = adapter.scrollElement();
      const inViewer = within(e.target);
      const target = describeTarget(e.target);

      if (withinNativePdfSidebar(e.target)) {
        logWheelPan(e, "sidebar", { deltaX: e.deltaX, deltaY: e.deltaY, within: inViewer, target });
        return;
      }
      if (!inViewer) {
        logWheelPan(e, "outside-viewer", { deltaX: e.deltaX, deltaY: e.deltaY, within: false, target });
        return;
      }
      if (!root) {
        logWheelPan(e, "no-scroll-root", { deltaX: e.deltaX, deltaY: e.deltaY, within: inViewer, target });
        return;
      }

      e.preventDefault();
      const changed = applyWheelPan(root, e.deltaX, e.deltaY, e.clientX, e.clientY);
      logWheelPan(e, "in-view", { deltaX: e.deltaX, deltaY: e.deltaY, within: true, target, changed });
    }, { ...options, passive: false });
  }

  private installGestureProbes(
    doc: Document,
    options: AddEventListenerOptions,
    within: (target: EventTarget | null) => boolean
  ): void {
    // Safari / some WebKit builds expose gesture* for pinch.
    for (const name of ["gesturestart", "gesturechange", "gestureend"] as const) {
      doc.addEventListener(name, (event) => {
        const e = event as Event & { scale?: number; rotation?: number };
        if (name === "gesturestart") this.notePointerTypeOrigin(e, "document-gesture", "capture");
        this.logger.pointerSeen({
          source: name,
          pointerType: "gesture",
          scale: e.scale,
          rotation: e.rotation,
          within: within(e.target),
          target: describeTarget(e.target)
        });
      }, options);
    }
  }


  private scheduleDeferredCanonicalPaint(surface: PageSurface): void {
    if (this.destroyed || surface.deferredCanonicalPaintFrame !== null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.paintDeferredCanonicalChunk(surface);
      return;
    }
    surface.deferredCanonicalPaintFrame = view.requestAnimationFrame(() => {
      surface.deferredCanonicalPaintFrame = null;
      this.paintDeferredCanonicalChunk(surface);
    });
  }

  /** Paint a bounded number of dense-page strokes per frame, keeping the captured raster visible until complete. */
  private paintDeferredCanonicalChunk(surface: PageSurface): void {
    const job = surface.deferredCanonicalPaint;
    if (this.destroyed || !job || !surface.inkLayer || !surface.inkLayerContext) return;
    if (this.surfaceHasLiveInkInput(surface)) {
      this.scheduleDeferredCanonicalPaint(surface);
      return;
    }
    if (
      this.ink.pageRevision(surface.page.pageNumber) !== job.pageRevision
      || surface.inkLayer.width !== job.pixelWidth
      || surface.inkLayer.height !== job.pixelHeight
    ) {
      surface.deferredCanonicalPaint = null;
      surface.inkLayerValid = false;
      surface.inkLayerBurstCapture = false;
      surface.rasterFallbackReady = false;
      surface.settleUpgradePending = false;
      return;
    }
    const startedAt = performance.now();
    const deadline = startedAt + this.frameTimingProfile().frameBudgetMs;
    const layerContext = surface.inkLayerContext;
    layerContext.setTransform(job.backingScale, 0, 0, job.backingScale, 0, 0);
    let painted = 0;
    while (job.nextIndex < job.strokes.length && (painted === 0 || performance.now() < deadline)) {
      const stroke = job.strokes[job.nextIndex];
      if (!stroke) {
        job.nextIndex = job.strokes.length;
        break;
      }
      this.paintCommittedStrokes(surface, layerContext, [stroke]);
      job.nextIndex += 1;
      painted += 1;
    }
    if (job.nextIndex < job.strokes.length) {
      this.scheduleDeferredCanonicalPaint(surface);
      return;
    }
    surface.deferredCanonicalPaint = null;
    surface.inkLayerValid = true;
    surface.inkLayerBackingScale = job.backingScale;
    surface.inkLayerBurstCapture = false;
    surface.inkLayerRevision = job.pageRevision;
    surface.rasterFallbackReady = false;
    surface.settleUpgradePending = false;
    const blitPixels = this.blitInkLayerToCanvas(
      surface,
      job.pixelWidth,
      job.pixelHeight,
      job.backingScale
    );
    this.paintLaserTrails(surface, surface.page.pageNumber);
    this.lastPagePaintAt.set(surface.page.pageNumber, { at: performance.now(), reason: "settle-upgrade" });
    this.logger.renderProfile({
      page: surface.page.pageNumber,
      operation: "page-canonical-chunked",
      reason: "settle-upgrade",
      durationMs: roundMetric(performance.now() - job.startedAt),
      chunkDurationMs: roundMetric(performance.now() - startedAt),
      strokeCount: job.strokes.length,
      vectorRepaintCount: job.strokes.length,
      pageRevision: job.pageRevision,
      cachedLayerRevision: surface.inkLayerRevision,
      useLayerCache: true,
      deferredCanonicalUpgrade: true,
      blitMode: "full-layer",
      blitPixels,
      visiblePageCount: this.surfaces.size
    });
  }

  /** Paint pages deferred by viewport culling / cheap neighbor settle once handoff ends. */
  private scheduleViewportPaint(): void {
    if (this.destroyed || this.viewportPaintFrame !== null || this.isZoomHandoffActive()) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const epoch = this.renderEpoch;
    this.viewportPaintFrame = view.requestAnimationFrame(() => {
      this.viewportPaintFrame = null;
      if (this.destroyed || this.isZoomHandoffActive()) return;
      if (deferredRenderDisposition("hq", epoch, this.renderEpoch) === "cancel") return;
      const rootRect = this.options.adapter.root.getBoundingClientRect();
      for (const surface of this.surfaces.values()) {
        const needsUpgrade = surface.viewportCullPending || surface.settleUpgradePending;
        if (!needsUpgrade || !this.surfaceNearViewport(surface, "idle", rootRect)) continue;
        const reason = surface.settleUpgradePending && !surface.viewportCullPending
          ? "settle-upgrade"
          : "viewport-enter";
        this.renderPage(surface.page.pageNumber, undefined, reason, true, true, rootRect);
      }
    });
  }

  /** Keep late refresh callbacks on the compositor path once a pinch owns the frame. */
  private deferRefreshDuringZoom(reason: string): boolean {
    // Explicit post-zoom verification may need one canonical projection while
    // the native handoff mask is still held; ordinary refreshes remain gated.
    if (reason === "create" || reason.startsWith("post-zoom")) return false;
    const zoomActive = this.zoomCompositing || this.isZoomGestureActive();
    const handoffActive = this.isZoomHandoffActive();
    if (!zoomActive && !handoffActive) return false;
    if (zoomActive) {
      this.logger.zoomRepaintInterrupt(reason, {
        kind: "full-refresh-during-zoom",
        deferred: true
      });
    } else {
      this.logger.zoomFlashProxy("full-refresh-during-handoff", { reason, deferred: true });
    }
    this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
    if (reason.includes("scroll") || reason.includes("pagechanging")) {
      this.markPendingMobileScrollRemount();
    }
    return true;
  }

  private scheduleRefresh(reason: string, repaintOnly = false): void {
    if (this.destroyed) return;
    if (this.zoomProfile) this.zoomProfile.refreshRequests += 1;
    if (repaintOnly) {
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      return;
    }
    // Full remount during pinch/CSS handoff fights compositing — layout-only path.
    if (reason !== "create" && (this.isZoomGestureActive() || this.isZoomHandoffActive())) {
      const kind = this.isZoomGestureActive() ? "full-refresh-during-zoom" : "full-refresh-during-handoff";
      this.logger.zoomRepaintInterrupt(reason, { kind });
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      if (reason.includes("scroll") || reason.includes("pagechanging")) {
        this.markPendingMobileScrollRemount();
      }
      return;
    }
    if (this.pendingScheduledRefresh) {
      this.pendingScheduledRefresh.reason = reason;
      if (!repaintOnly) this.pendingScheduledRefresh.repaintOnly = false;
    } else {
      this.pendingScheduledRefresh = { reason, repaintOnly };
    }
    if (this.resizeFrame !== null) return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      const pending = this.pendingScheduledRefresh;
      this.resizeFrame = null;
      this.pendingScheduledRefresh = null;
      if (!pending) return;
      if (this.deferRefreshDuringZoom(pending.reason)) return;
      const started = performance.now();
      if (pending.repaintOnly) this.repaintSurfaces(pending.reason);
      else this.refresh(pending.reason);
      this.recordZoomProfileTask(started, "refresh");
    });
  }

  /** Coalesce mobile scroll/pagechanging remounts to one display frame. */
  private scheduleMobileScrollRefresh(): void {
    if (this.destroyed || !this.runtimePlatform().mobile) return;
    if (this.zoomProfile) this.zoomProfile.mobileRefreshSignals += 1;
    if (this.isZoomGestureActive() || this.isZoomHandoffActive()) {
      this.markPendingMobileScrollRemount();
      if (this.zoomProfile) this.zoomProfile.mobileRefreshDeferred += 1;
      this.scheduleZoomRepaint("view-scroll-mobile", this.options.adapter.getViewState().scale);
      return;
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.refresh("view-scroll-mobile");
      return;
    }
    if (this.mobileScrollRefreshFrame !== null) {
      view.cancelAnimationFrame(this.mobileScrollRefreshFrame);
      this.mobileScrollRefreshFrame = null;
    }
    const burst = ++this.mountBurst;
    if (this.zoomProfile) this.zoomProfile.mobileRefreshFramesScheduled += 1;
    this.mobileScrollRefreshFrame = view.requestAnimationFrame(() => {
      this.mobileScrollRefreshFrame = null;
      if (this.destroyed || mountWorkSuperseded(burst, this.mountBurst)) return;
      if (this.isZoomGestureActive() || this.isZoomHandoffActive()) {
        this.markPendingMobileScrollRemount();
        if (this.zoomProfile) this.zoomProfile.mobileRefreshDeferred += 1;
        return;
      }
      if (this.zoomProfile) this.zoomProfile.mobileRefreshExecutions += 1;
      const started = performance.now();
      this.refresh("view-scroll-mobile");
      this.recordZoomProfileTask(started, "refresh");
    });
  }

  private markPendingMobileScrollRemount(): void {
    this.pendingMobileScrollRemount = true;
    this.postZoomTrace.remember("pending-mobile-remount", { pendingMobileScrollRemount: true });
  }

  private flushPendingMobileScrollRemount(): void {
    if (!this.pendingMobileScrollRemount || this.destroyed) return;
    this.pendingMobileScrollRemount = false;
    this.postZoomTrace.remember("pending-mobile-remount-cleared", { pendingMobileScrollRemount: false });
    if (!this.runtimePlatform().mobile) return;
    const pages = this.pagesForInkMount();
    if (this.mobileMountSetUnchanged(pages)) {
      this.postZoomTrace.remember("pending-mobile-remount-skipped", {
        reason: "mount-set-unchanged",
        mountPages: pages.map((page) => page.pageNumber)
      });
      return;
    }
    this.refresh("post-zoom-scroll-mobile");
    // A changed mount set may have created fresh overlays; put those new
    // surfaces under the same mask before this task yields to the browser.
    this.syncZoomOverlayLayouts("native-content");
  }

  private zoomBurstSnapshot(): Record<string, unknown> {
    const view = this.options.adapter.getViewState();
    const surface = this.surfaces.get(view.pageNumber);
    const pageElement = surface?.page.element ?? null;
    const router = surface?.router ?? null;
    return {
      zoomBurstId: this.postZoomTrace.currentBurstId(),
      scaleBefore: this.zoomBurstScaleStart,
      scaleAfter: this.zoomBurstScaleEnd ?? view.scale,
      currentPage: view.pageNumber,
      viewerGeneration: this.viewerGeneration,
      pageMountGeneration: surface?.page.mountGeneration ?? null,
      pageElementId: getDebugNodeId(pageElement),
      pageElementConnected: Boolean(pageElement?.isConnected),
      overlayId: getDebugNodeId(surface?.overlay ?? null),
      overlayConnected: Boolean(surface?.overlay.isConnected),
      routerGeneration: router?.generation ?? null,
      routerAlive: Boolean(router?.isAlive()),
      routerBindsToPage: Boolean(pageElement && router?.bindsTo(pageElement)),
      routerBoundElementId: getDebugNodeId(router?.boundElement() ?? null),
      routerListenerAborted: Boolean(router?.isListenerAborted()),
      pendingMobileScrollRemount: this.pendingMobileScrollRemount,
      zoomGestureActive: this.isZoomGestureActive(),
      zoomHandoffActive: this.isZoomHandoffActive(),
      activeTool: this.activeTool(),
      ...this.inputPolicyLogFields(),
      ...this.gesturePolicyForPage(view.pageNumber)
    };
  }

  private gesturePolicyForPage(pageNumber: number | null): Record<string, unknown> {
    if (pageNumber === null) return {};
    return this.surfaces.get(pageNumber)?.router?.gesturePolicy() ?? {};
  }

  /** Close a post-zoom window where the live page no longer matches its router. */
  private rebindStaleZoomRouters(reason: string): void {
    if (this.deferZoomMaintenanceForInput(`router-rebind:${reason}`)) return;
    const pages = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = pages.get(pageNumber);
      if (!current?.element.isConnected || this.surfaceHasLiveInkInput(surface)) continue;
      const sameElement = surface.page.element === current.element;
      const bound = Boolean(surface.router?.bindsTo(current.element) && surface.router.isAlive() && !surface.router.isListenerAborted());
      if (sameElement && bound) continue;
      if (!sameElement) this.remountSurfaceOnPageReplacement(surface, current);
      this.ensurePageRouter(surface, { force: true, reason });
    }
  }

  private mobileMountSetUnchanged(pages: AnnotationPageInfo[]): boolean {
    if (pages.length !== this.surfaces.size) return false;
    return pages.every((page) => {
      const surface = this.surfaces.get(page.pageNumber);
      return Boolean(surface
        && surface.page.element === page.element
        && surface.overlay.isConnected
        && page.element.contains(surface.overlay));
    });
  }

  private isZoomGestureActive(): boolean {
    return this.lastZoomSignalAt > 0
      && performance.now() - this.lastZoomSignalAt < ViewerInkSession.ZOOM_ACTIVE_MS;
  }

  /**
   * Development-only cross-plugin telemetry. The dedicated probe must opt in
   * on this window; HN keeps no telemetry history and never writes it to the
   * vault. Calls are lifecycle-level rather than input-path instrumentation.
   */
  private reportDevProbe(
    type: HnDevProbeDiagnostic["type"],
    metrics: Record<string, HnDevProbeMetric>
  ): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!isHnDevProbeActive(view)) return;
    emitHnDevProbeDiagnostic(view, {
      version: 1,
      source: "handwriting-natively",
      type,
      documentId: this.identity.id,
      at: performance.now(),
      metrics
    });
  }

  private startZoomProfile(scale: number | undefined, now: number): void {
    const scaleStart = this.lastKnownViewScale ?? scale ?? null;
    this.zoomProfile = {
      startedAt: now,
      gestureEndedAt: null,
      scaleStart,
      scaleEnd: scaleStart,
      minScale: scaleStart,
      maxScale: scaleStart,
      scaleChangingEvents: 0,
      scaleIntervals: this.frameTimingAccumulator(),
      scaleDeltas: new BoundedTiming(0),
      lastScaleAt: null,
      lastScale: scaleStart,
      frameIntervals: this.frameTimingAccumulator(),
      frameCount: 0,
      lastFrameAt: null,
      worstFrameOffsetMs: null,
      longTaskMaxMs: 0,
      lastPdfGeometry: null,
      lastInkGeometry: null,
      geometryReadCount: 0,
      geometryReadAfterWriteCount: 0,
      maxPdfGeometryDeltaPx: 0,
      maxInkGeometryDeltaPx: 0,
      maxPdfInkMismatchPx: 0,
      worstMismatchOffsetMs: null,
      initialScrollLeft: null,
      initialScrollTop: null,
      scrollEvents: 0,
      pageChangingEvents: 0,
      mobileRefreshSignals: 0,
      mobileRefreshDeferred: 0,
      mobileRefreshFramesScheduled: 0,
      mobileRefreshExecutions: 0,
      refreshRequests: 0,
      refreshExecutions: 0,
      layoutFramesScheduled: 0,
      layoutFramesExecuted: 0,
      coalescedVisualUpdates: 0,
      layoutSyncs: 0,
      compositorTicks: 0,
      bitmapBlits: 0,
      inkLayerCaptures: 0,
      inkLayerBlits: 0,
      vectorRepaints: 0,
      canvasResizes: 0,
      hqUpgrades: 0,
      routerRebinds: 0,
      routerDestroys: 0,
      taskCount: 0,
      totalTaskMs: 0,
      longestTaskMs: 0,
      layoutTaskCount: 0,
      layoutTaskTotalMs: 0,
      layoutTaskMaxMs: 0,
      refreshTaskCount: 0,
      refreshTaskTotalMs: 0,
      refreshTaskMaxMs: 0,
      compositorTaskCount: 0,
      compositorTaskTotalMs: 0,
      compositorTaskMaxMs: 0,
      settleTimerResets: 0,
      lastScrollLeft: null,
      lastScrollTop: null,
      maxScrollDeltaPx: 0,
      worstScrollOffsetMs: null,
      sidebarFollowActiveDuringZoom: false,
      sidebarFollowFramesDuringBurst: 0,
      maxSidebarOffsetJump: 0,
      sidebarFollowSuppressedTriggers: 0
    };
  }

  private recordZoomScale(scale: number, now: number): void {
    const profile = this.zoomProfile;
    if (!profile) return;
    profile.scaleChangingEvents += 1;
    profile.scaleEnd = scale;
    profile.minScale = profile.minScale === null ? scale : Math.min(profile.minScale, scale);
    profile.maxScale = profile.maxScale === null ? scale : Math.max(profile.maxScale, scale);
    if (profile.lastScaleAt !== null) profile.scaleIntervals.add(Math.max(0, now - profile.lastScaleAt));
    if (profile.lastScale !== null) profile.scaleDeltas.add(Math.abs(scale - profile.lastScale));
    profile.lastScaleAt = now;
    profile.lastScale = scale;
  }

  private recordZoomProfileTask(started: number, kind: "layout" | "refresh" | "compositor" = "layout"): void {
    const profile = this.zoomProfile;
    if (!profile) return;
    const duration = Math.max(0, performance.now() - started);
    profile.taskCount += 1;
    profile.totalTaskMs += duration;
    profile.longestTaskMs = Math.max(profile.longestTaskMs, duration);
    if (kind === "layout") {
      profile.layoutTaskCount += 1;
      profile.layoutTaskTotalMs += duration;
      profile.layoutTaskMaxMs = Math.max(profile.layoutTaskMaxMs, duration);
    } else if (kind === "refresh") {
      profile.refreshTaskCount += 1;
      profile.refreshTaskTotalMs += duration;
      profile.refreshTaskMaxMs = Math.max(profile.refreshTaskMaxMs, duration);
    } else {
      profile.compositorTaskCount += 1;
      profile.compositorTaskTotalMs += duration;
      profile.compositorTaskMaxMs = Math.max(profile.compositorTaskMaxMs, duration);
    }
  }

  /** Duck-typed bridge: BasePdfAdapter suppresses sidebar follow during pinch. */
  private setAdapterInkZoomBurstActive(active: boolean): void {
    const adapter = this.options.adapter as {
      setInkZoomBurstActive?(next: boolean): void;
    };
    adapter.setInkZoomBurstActive?.(active);
  }

  private consumeAdapterSidebarFollowZoomMetrics(): {
    sidebarFollowActiveDuringZoom: boolean;
    sidebarFollowFramesDuringBurst: number;
    maxSidebarOffsetJump: number;
    sidebarFollowSuppressedTriggers: number;
  } | null {
    const adapter = this.options.adapter as {
      consumeSidebarFollowZoomMetrics?(): {
        sidebarFollowActiveDuringZoom: boolean;
        sidebarFollowFramesDuringBurst: number;
        maxSidebarOffsetJump: number;
        sidebarFollowSuppressedTriggers: number;
      };
    };
    return adapter.consumeSidebarFollowZoomMetrics?.() ?? null;
  }

  private scheduleZoomOverlayLayout(): void {
    if (this.destroyed || !this.zoomCompositing) return;
    if (this.zoomLayoutFrame !== null) {
      if (this.zoomProfile) this.zoomProfile.coalescedVisualUpdates += 1;
      this.zoomPipelineTrace.noteEvent("visual-update-coalesced");
      return;
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    if (this.zoomProfile) this.zoomProfile.layoutFramesScheduled += 1;
    this.zoomPipelineTrace.noteEvent("layout-raf-request");
    const rafRequestedAt = performance.now();
    this.zoomLayoutFrame = view.requestAnimationFrame((timestamp) => {
      this.zoomLayoutFrame = null;
      if (this.destroyed || !this.zoomCompositing) return;
      this.zoomPipelineTrace.noteEvent("layout-raf");
      this.frameBudget.observeRaf(timestamp, this.options.adapter.host.ownerDocument.hidden);
      const now = performance.now();
      if (this.zoomProfile) {
        this.zoomProfile.layoutFramesExecuted += 1;
        this.zoomProfile.frameCount += 1;
        if (this.zoomProfile.lastFrameAt !== null) {
          const frameInterval = Math.max(0, now - this.zoomProfile.lastFrameAt);
          this.zoomProfile.frameIntervals.add(frameInterval);
          if (frameInterval >= this.zoomProfile.frameIntervals.maxMs) {
            this.zoomProfile.worstFrameOffsetMs = roundMs(now - this.zoomProfile.startedAt);
          }
        }
        this.zoomProfile.lastFrameAt = now;
      }
      const started = performance.now();
      const scroller = this.options.adapter.scrollElement();
      const beforeLeft = scroller.scrollLeft;
      const beforeTop = scroller.scrollTop;
      if (this.zoomProfile) {
        if (this.zoomProfile.initialScrollLeft === null) {
          this.zoomProfile.initialScrollLeft = beforeLeft;
          this.zoomProfile.initialScrollTop = beforeTop;
        }
        if (this.zoomProfile.lastScrollLeft !== null && this.zoomProfile.lastScrollTop !== null) {
          const frameDelta = Math.max(
            Math.abs(beforeLeft - this.zoomProfile.lastScrollLeft),
            Math.abs(beforeTop - this.zoomProfile.lastScrollTop)
          );
          if (frameDelta > this.zoomProfile.maxScrollDeltaPx) {
          this.zoomProfile.maxScrollDeltaPx = frameDelta;
          this.zoomProfile.worstScrollOffsetMs = roundMs(now - this.zoomProfile.startedAt);
        }
        }
      }
      const layoutTiming = this.syncZoomOverlayLayouts();
      const layoutMs = layoutTiming.totalMs;
      const geometryMs = layoutTiming.phaseDurations["geometry-read"];
      // Overlay layout must not correct scroll during the live gesture — any
      // delta here is plugin-owned and belongs in the burst profile.
      const pluginScrollDelta = Math.max(
        Math.abs(scroller.scrollLeft - beforeLeft),
        Math.abs(scroller.scrollTop - beforeTop)
      );
      if (this.zoomProfile) {
        if (pluginScrollDelta > this.zoomProfile.maxScrollDeltaPx) {
          this.zoomProfile.maxScrollDeltaPx = pluginScrollDelta;
          this.zoomProfile.worstScrollOffsetMs = roundMs(now - this.zoomProfile.startedAt);
        }
        this.zoomProfile.lastScrollLeft = scroller.scrollLeft;
        this.zoomProfile.lastScrollTop = scroller.scrollTop;
      }
      this.recordZoomProfileTask(started);
      const pluginWorkMs = performance.now() - started;
      this.zoomPipelineTrace.noteStage("overlay-layout", layoutMs, 1, "overlay-layout");
      this.zoomPipelineTrace.noteStage(
        "page-maintenance",
        layoutTiming.phaseDurations["page-snapshot"],
        1,
        "page-snapshot"
      );
      this.zoomPipelineTrace.noteStage(
        "router-maintenance",
        layoutTiming.phaseDurations["surface-reconcile"],
        1,
        "surface-reconcile"
      );
      this.zoomPipelineTrace.noteStage(
        "dom-read",
        layoutTiming.phaseDurations["page-snapshot"] + layoutTiming.phaseDurations["layout-read"] + geometryMs,
        1,
        "zoom-dom-read"
      );
      this.zoomPipelineTrace.noteStage("dom-write", layoutTiming.phaseDurations["overlay-write"], 1, "zoom-dom-write");
      this.zoomPipelineTrace.noteStage("text-layout", layoutTiming.phaseDurations["text-layout"], 1, "text-layout");
      this.zoomPipelineTrace.noteStage("cursor-refresh", layoutTiming.phaseDurations["cursor-refresh"], 1, "cursor-refresh");
      this.recordZoomPipelineFrame(now, pluginWorkMs);
      this.zoomFrameDiagnostics.notePluginOperation("overlay-layout", layoutMs);
      for (const [phase, durationMs] of Object.entries(layoutTiming.phaseDurations)) {
        this.zoomFrameDiagnostics.notePluginOperation(`overlay-${phase}`, durationMs);
      }
      this.zoomFrameDiagnostics.notePluginOperation("page-geometry-read", geometryMs);
      const frameGap = this.zoomFrameDiagnostics.recordFrame({
        requestedAt: rafRequestedAt,
        callbackAt: now,
        pluginWorkMs,
        context: {
          documentHidden: this.options.adapter.host.ownerDocument.hidden,
          visualViewportScale: view.visualViewport?.scale ?? null,
          devicePixelRatio: view.devicePixelRatio ?? null
        }
      });
      if (frameGap) this.logger.perfUnattributedFrameGap({ ...frameGap });
      if (pluginWorkMs >= SLOW_SPAN_SYNC_MS) {
        this.logger.zoomLongFrame({
          zoomBurstId: this.postZoomTrace.currentBurstId(),
          frameDeltaMs: this.zoomProfile?.lastFrameAt == null ? null : roundMs(pluginWorkMs),
          pluginWorkMs: roundMs(pluginWorkMs),
          contributors: {
            syncZoomOverlayLayouts: roundMs(layoutMs),
            overlayLayoutPhases: layoutTiming.phaseDurations,
            recordZoomGeometry: roundMs(geometryMs),
            geometryReads: layoutTiming.geometryReads,
            geometryReadAfterWrite: layoutTiming.geometryReadAfterWrite
          }
        });
      }
    });
  }

  private recordZoomPipelineFrame(timestampMs: number, totalPluginWorkMs: number, flushOnly = false): void {
    const state = this.options.adapter.getViewState();
    const scroller = this.options.adapter.scrollElement();
    const runtime = this.frameTimingProfile();
    const input = this.zoomInputState();
    const frame = {
      timestampMs,
      runtimeBudgetMs: runtime.frameBudgetMs,
      scale: state.scale,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
      pendingRaf: this.zoomLayoutFrame !== null || this.zoomSettleSliceFrame !== null,
      pendingSettle: this.zoomSettleTimer !== null
        || this.zoomSettleQueue.length > 0
        || this.zoomCompositeReleaseTimer !== null
        || this.zoomCompositeReleaseFrame !== null,
      nativeMutationCount: this.zoomNativeContentMutations,
      ...input,
      visiblePages: this.zoomActivePageCount,
      overlaysTouched: this.zoomCompositing ? this.zoomActivePageCount : 0,
      totalPluginWorkMs
    };
    if (flushOnly) this.zoomPipelineTrace.flushFrame(frame);
    else this.zoomPipelineTrace.recordFrame(frame);
  }

  private readZoomGeometry(surfaces: readonly PageSurface[]): {
    snapshots: Map<number, ZoomGeometrySnapshot>;
    readCount: number;
  } {
    const snapshots = new Map<number, ZoomGeometrySnapshot>();
    let readCount = 0;
    for (const surface of surfaces) {
      const pdf = pdfRenderCanvas(surface.page.element);
      const contentRect = pdf?.getBoundingClientRect() ?? null;
      if (contentRect) readCount += 1;
      const overlayRect = surface.overlay.getBoundingClientRect();
      readCount += 1;
      snapshots.set(surface.page.pageNumber, {
        contentRect: contentRect ? {
          left: contentRect.left,
          top: contentRect.top,
          width: contentRect.width,
          height: contentRect.height
        } : null,
        overlayRect: {
          left: overlayRect.left,
          top: overlayRect.top,
          width: overlayRect.width,
          height: overlayRect.height
        }
      });
    }
    return { snapshots, readCount };
  }

  private recordZoomGeometry(
    geometry: ReadonlyMap<number, ZoomGeometrySnapshot>,
    readCount: number
  ): void {
    const profile = this.zoomProfile;
    if (!profile || !this.logger.isEnabled()) return;
    profile.geometryReadCount += readCount;
    const now = performance.now();
    for (const [pageNumber, snapshot] of geometry) {
      const surface = this.surfaces.get(pageNumber);
      if (!surface) continue;
      const pdfRect = snapshot.contentRect;
      if (!pdfRect) continue;
      const inkRect = snapshot.overlayRect;
      profile.maxPdfGeometryDeltaPx = Math.max(profile.maxPdfGeometryDeltaPx, rectDelta(profile.lastPdfGeometry, pdfRect));
      profile.maxInkGeometryDeltaPx = Math.max(profile.maxInkGeometryDeltaPx, rectDelta(profile.lastInkGeometry, inkRect));
      const mismatch = rectMismatch(pdfRect, inkRect);
      if (mismatch > profile.maxPdfInkMismatchPx) {
        profile.maxPdfInkMismatchPx = mismatch;
        profile.worstMismatchOffsetMs = roundMs(now - profile.startedAt);
      }
      profile.lastPdfGeometry = pdfRect;
      profile.lastInkGeometry = inkRect;
    }
  }

  private startZoomLongTaskObserver(): void {
    if (!this.logger.isEnabled() || this.zoomLongTaskObserver || typeof PerformanceObserver === "undefined") {
      this.zoomFrameDiagnostics.setLongTaskObserverState(false, typeof PerformanceObserver === "undefined" ? "unsupported" : null);
      return;
    }
    try {
      const observer = new PerformanceObserver((entries) => {
        const longest = entries.getEntries().reduce((max, entry) => Math.max(max, entry.duration), 0);
        if (this.zoomProfile) this.zoomProfile.longTaskMaxMs = Math.max(this.zoomProfile.longTaskMaxMs, longest);
        this.zoomFrameDiagnostics.noteLongTask(longest);
      });
      observer.observe({ entryTypes: ["longtask"] });
      this.zoomLongTaskObserver = observer;
      this.zoomFrameDiagnostics.setLongTaskObserverState(true);
    } catch (error) {
      this.zoomLongTaskObserver = null;
      this.zoomFrameDiagnostics.setLongTaskObserverState(false, error instanceof Error ? error.name : "observe-error");
    }
  }

  private stopZoomLongTaskObserver(): void {
    this.zoomLongTaskObserver?.disconnect();
    this.zoomLongTaskObserver = null;
  }

  private cancelZoomOverlayLayout(): void {
    if (this.zoomLayoutFrame === null) return;
    this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.zoomLayoutFrame);
    this.zoomLayoutFrame = null;
  }

  private finishZoomProfile(): void {
    const profile = this.zoomProfile;
    if (!profile) return;
    const endedAt = profile.gestureEndedAt ?? performance.now();
    const profileEndedAt = performance.now();
    const sidebar = this.consumeAdapterSidebarFollowZoomMetrics();
    if (sidebar) {
      profile.sidebarFollowActiveDuringZoom = sidebar.sidebarFollowActiveDuringZoom;
      profile.sidebarFollowFramesDuringBurst = sidebar.sidebarFollowFramesDuringBurst;
      profile.maxSidebarOffsetJump = sidebar.maxSidebarOffsetJump;
      profile.sidebarFollowSuppressedTriggers = sidebar.sidebarFollowSuppressedTriggers;
    }
    this.stopZoomLongTaskObserver();
    this.recordZoomPipelineFrame(profileEndedAt, 0, true);
    const zoomPipelineSummary = this.zoomPipelineTrace.finish(profileEndedAt);
    this.lastZoomPipelineSummary = zoomPipelineSummary;
    const frameAttributionSummary = this.zoomFrameDiagnostics.summary();
    this.lastZoomFrameAttributionSummary = frameAttributionSummary;
    const mobilePdfZoom = (() => {
      try {
        return this.mobilePdfZoomDiagnostics();
      } catch {
        return null;
      }
    })();
    const scaleIntervals = profile.scaleIntervals.summary();
    const scaleDeltas = profile.scaleDeltas.summary();
    const frameIntervals = profile.frameIntervals.summary();
    const scroller = this.options.adapter.scrollElement();
    const rootRect = this.options.adapter.root.getBoundingClientRect();
    const metrics = {
      mobile: this.runtimePlatform().mobile,
      pluginVersion: this.options.pluginVersion ?? "unknown",
      gestureStartAt: roundMs(profile.startedAt),
      gestureEndAt: roundMs(endedAt),
      durationMs: roundMs(endedAt - profile.startedAt),
      profileWindowMs: roundMs(profileEndedAt - profile.startedAt),
      scaleStart: profile.scaleStart,
      scaleEnd: profile.scaleEnd,
      initialScale: profile.scaleStart,
      finalScale: profile.scaleEnd,
      minScale: profile.minScale,
      maxScale: profile.maxScale,
      scaleChangingEvents: profile.scaleChangingEvents,
      coalescedVisualUpdates: profile.coalescedVisualUpdates,
      scaleEvents: profile.scaleChangingEvents,
      scaleIntervalAvgMs: roundMetric(scaleIntervals.averageMs),
      scaleIntervalP50Ms: roundMetric(scaleIntervals.p50Ms),
      scaleIntervalP95Ms: roundMetric(scaleIntervals.p95Ms),
      scaleIntervalMaxMs: roundMetric(scaleIntervals.maxMs),
      scaleIntervalHistogram: scaleIntervals.histogram,
      scaleDeltaAvg: roundMetric(scaleDeltas.averageMs),
      scaleDeltaP95: roundMetric(scaleDeltas.p95Ms),
      scaleDeltaMax: roundMetric(scaleDeltas.maxMs),
      largestScaleDelta: roundMetric(scaleDeltas.maxMs),
      scaleDeltaHistogram: buildScaleDeltaHistogram(profile.scaleDeltas.sampleValues()),
      frameCount: profile.frameCount,
      frames: profile.frameCount,
      avgFrameDeltaMs: roundMetric(frameIntervals.averageMs),
      p50FrameDeltaMs: roundMetric(frameIntervals.p50Ms),
      p95FrameDeltaMs: roundMetric(frameIntervals.p95Ms),
      maxFrameIntervalMs: roundMetric(frameIntervals.maxMs),
      maxFrameDeltaMs: roundMetric(frameIntervals.maxMs),
      lateFrameCount: frameIntervals.lateFrameCount,
      lateFrames: frameIntervals.lateFrameCount,
      droppedFrameEstimate: frameIntervals.droppedFrameEstimate,
      droppedFrames: frameIntervals.droppedFrameEstimate,
      worstFrameOffsetMs: profile.worstFrameOffsetMs,
      frameIntervalHistogram: frameIntervals.histogram,
      longestLongTaskMs: roundMetric(profile.longTaskMaxMs),
      pdfGeometrySamples: profile.lastPdfGeometry ? profile.frameCount : 0,
      geometryReadCount: profile.geometryReadCount,
      geometryReadAfterWriteCount: profile.geometryReadAfterWriteCount,
      maxPdfGeometryDeltaPx: roundMetric(profile.maxPdfGeometryDeltaPx),
      maxInkGeometryDeltaPx: roundMetric(profile.maxInkGeometryDeltaPx),
      maxPdfInkMismatchPx: roundMetric(profile.maxPdfInkMismatchPx),
      worstMismatchOffsetMs: profile.worstMismatchOffsetMs,
      initialScrollLeft: profile.initialScrollLeft,
      initialScrollTop: profile.initialScrollTop,
      finalScrollLeft: roundMetric(scroller.scrollLeft),
      finalScrollTop: roundMetric(scroller.scrollTop),
      settleAfterLastScaleMs: profile.lastScaleAt === null ? null : roundMetric(Math.max(0, endedAt - profile.lastScaleAt)),
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMetric(Math.max(0, profileEndedAt - this.zoomCompositeSettledAt)) : null,
      viewportWidth: roundMetric(rootRect.width),
      viewportHeight: roundMetric(rootRect.height),
      devicePixelRatio: this.options.adapter.host.ownerDocument.defaultView?.devicePixelRatio ?? null,
      visiblePageCount: this.zoomActivePageCount,
      strokeCount: this.ink.all().length,
      scrollEvents: profile.scrollEvents,
      pageChangingEvents: profile.pageChangingEvents,
      mobileRefreshSignals: profile.mobileRefreshSignals,
      mobileRefreshDeferred: profile.mobileRefreshDeferred,
      mobileRefreshFramesScheduled: profile.mobileRefreshFramesScheduled,
      mobileRefreshExecutions: profile.mobileRefreshExecutions,
      refreshRequests: profile.refreshRequests,
      refreshExecutions: profile.refreshExecutions,
      layoutTaskCount: profile.layoutTaskCount,
      layoutTaskTotalMs: roundMs(profile.layoutTaskTotalMs),
      layoutTaskMaxMs: roundMs(profile.layoutTaskMaxMs),
      refreshTaskCount: profile.refreshTaskCount,
      refreshTaskTotalMs: roundMs(profile.refreshTaskTotalMs),
      refreshTaskMaxMs: roundMs(profile.refreshTaskMaxMs),
      compositorTaskCount: profile.compositorTaskCount,
      compositorTaskTotalMs: roundMs(profile.compositorTaskTotalMs),
      compositorTaskMaxMs: roundMs(profile.compositorTaskMaxMs),
      settleTimerResets: profile.settleTimerResets,
      layoutFramesScheduled: profile.layoutFramesScheduled,
      layoutFramesExecuted: profile.layoutFramesExecuted,
      layoutSyncs: profile.layoutSyncs,
      compositorTicks: profile.compositorTicks,
      bitmapBlits: profile.bitmapBlits,
      inkLayerCaptures: profile.inkLayerCaptures,
      inkLayerBlits: profile.inkLayerBlits,
      vectorRepaints: profile.vectorRepaints,
      canvasResizes: profile.canvasResizes,
      hqUpgrades: profile.hqUpgrades,
      routerRebinds: profile.routerRebinds,
      routerDestroys: profile.routerDestroys,
      pluginWorkMs: roundMs(profile.totalTaskMs),
      longestTaskMs: roundMs(profile.longestTaskMs),
      maxScrollDeltaPx: Number(profile.maxScrollDeltaPx.toFixed(2)),
      worstScrollOffsetMs: profile.worstScrollOffsetMs,
      sidebarFollowActiveDuringZoom: profile.sidebarFollowActiveDuringZoom,
      sidebarFollowFramesDuringBurst: profile.sidebarFollowFramesDuringBurst,
      maxSidebarOffsetJump: profile.maxSidebarOffsetJump,
      sidebarFollowSuppressedTriggers: profile.sidebarFollowSuppressedTriggers,
      frameTiming: this.frameTimingProfile(),
      nativeContentMutations: this.zoomNativeContentMutations,
      mobilePdfZoom: mobilePdfZoom?.trace ?? this.mobilePdfZoomTrace.summary(),
      frameAttributionSummary,
      zoomPipelineSummary,
      zoomNativeHandoffSummary: this.zoomNativeHandoffTrace.summary()
    };
    this.logger.zoomProfile(metrics);
    this.rememberZoomGesturePerformance(metrics);
    this.reportDevProbe("zoom-profile", {
      durationMs: metrics.durationMs,
      scaleChangingEvents: metrics.scaleChangingEvents,
      layoutFramesExecuted: metrics.layoutFramesExecuted,
      lateFrameCount: metrics.lateFrameCount,
      droppedFrameEstimate: metrics.droppedFrameEstimate,
      maxPdfInkMismatchPx: metrics.maxPdfInkMismatchPx,
      maxScrollDeltaPx: metrics.maxScrollDeltaPx,
      pluginWorkMs: metrics.pluginWorkMs
    });
    this.zoomProfile = null;
  }

  /**
   * Copy Logs keeps the last three finished gestures. A slow span is recorded
   * when frame p95 misses the runtime-derived late-frame threshold.
   */
  private rememberZoomGesturePerformance(metrics: {
    durationMs: number;
    scaleStart: number | null;
    scaleEnd: number | null;
    scaleChangingEvents: number;
    scaleIntervalP50Ms: number;
    scaleIntervalP95Ms: number;
    scaleIntervalMaxMs: number;
    scaleIntervalHistogram: Record<string, number>;
    frameCount: number;
    p50FrameDeltaMs: number;
    p95FrameDeltaMs: number;
    maxFrameIntervalMs: number;
    lateFrameCount: number;
    droppedFrameEstimate: number;
    longestLongTaskMs: number;
    maxPdfInkMismatchPx: number;
    frameIntervalHistogram: Record<string, number>;
    frameTiming: RuntimeFrameProfile;
  }): void {
    const summary = {
      zoomBurstId: this.zoomCorrelationId,
      durationMs: metrics.durationMs,
      scaleStart: metrics.scaleStart,
      scaleEnd: metrics.scaleEnd,
      scaleChangingEvents: metrics.scaleChangingEvents,
      scaleIntervalP50Ms: metrics.scaleIntervalP50Ms,
      scaleIntervalP95Ms: metrics.scaleIntervalP95Ms,
      scaleIntervalMaxMs: metrics.scaleIntervalMaxMs,
      scaleIntervalHistogram: metrics.scaleIntervalHistogram,
      frameCount: metrics.frameCount,
      p50FrameDeltaMs: metrics.p50FrameDeltaMs,
      p95FrameDeltaMs: metrics.p95FrameDeltaMs,
      maxFrameIntervalMs: metrics.maxFrameIntervalMs,
      lateFrameCount: metrics.lateFrameCount,
      droppedFrameEstimate: metrics.droppedFrameEstimate,
      longestLongTaskMs: metrics.longestLongTaskMs,
      maxPdfInkMismatchPx: metrics.maxPdfInkMismatchPx,
      frameIntervalHistogram: metrics.frameIntervalHistogram,
      frameTiming: metrics.frameTiming,
      mobilePdfZoom: this.mobilePdfZoomTrace.summary()
    };
    this.recentZoomGesturePerformance.push(summary);
    if (this.recentZoomGesturePerformance.length > 3) this.recentZoomGesturePerformance.shift();
    const frameTiming = metrics.frameTiming;
    if (metrics.p95FrameDeltaMs < frameTiming.lateFrameThresholdMs && metrics.longestLongTaskMs < SLOW_SPAN_SYNC_MS) return;
    const span = this.slowSpans.record({
      kind: "sync",
      category: "zoom",
      stage: "zoom-gesture-frame",
      durationMs: Math.max(metrics.p95FrameDeltaMs, metrics.longestLongTaskMs),
      activeWorkMs: metrics.longestLongTaskMs,
      waitMs: 0,
      reason: metrics.p95FrameDeltaMs >= frameTiming.lateFrameThresholdMs ? "frame-gap" : "long-task",
      thresholdMs: metrics.p95FrameDeltaMs >= frameTiming.lateFrameThresholdMs
        ? frameTiming.lateFrameThresholdMs
        : SLOW_SPAN_SYNC_MS,
      zoomBurstId: this.zoomCorrelationId
    });
    if (span) this.logger.perfSlowSpan({ ...span });
  }

  private scheduleZoomRepaint(reason: string, scale?: number): void {
    if (this.destroyed) return;
    if (this.shouldCoalesceZoomSettleSignal(reason, scale)) {
      if (this.zoomProfile) this.zoomProfile.coalescedVisualUpdates += 1;
      if (this.zoomCompositing) this.scheduleZoomOverlayLayout();
      return;
    }
    this.mountBurst += 1;
    const now = performance.now();
    this.lastZoomSignalAt = now;
    this.lastZoomSignalReason = reason;
    this.lastZoomSignalScale = scale ?? this.lastZoomSignalScale;
    // Keep one burst for the full gesture. A long, healthy pinch can last well
    // beyond ZOOM_ACTIVE_MS while still delivering scale ticks every frame;
    // the settle timer is the actual quiet-window boundary.
    if (!this.zoomProfile) {
      this.zoomCorrelationId = this.postZoomTrace.begin();
      this.zoomPipelineTrace.begin(this.zoomCorrelationId, now);
      if (this.logger.isEnabled()) {
        this.zoomNativeHandoffTrace.begin(this.zoomCorrelationId, now);
        this.zoomFrameDiagnostics.begin(this.zoomCorrelationId);
      }
      this.postZoomDurability.onZoomBegin(this.zoomCorrelationId);
      const seed = this.pinchCleanup.beginBurst();
      for (const prune of seed.pruned) this.logger.stalePinchContact({ ...prune });
      this.postZoomTrace.noteBurstActivity({
        seededPinchPointerIds: seed.seededPinchPointerIds,
        seededPinchTouchIdentifiers: seed.seededPinchTouchIdentifiers,
        prunedBeforeBurstPointerIds: seed.prunedBeforeBurstPointerIds,
        prunedBeforeBurstTouchIdentifiers: seed.prunedBeforeBurstTouchIdentifiers
      });
      this.settleTimerResetCount = 0;
      this.inGestureResetCount = 0;
      this.settleWaitStartedAt = 0;
      this.zoomGestureStartedAt = now;
      this.pinchTerminalAt = 0;
      this.pinchSawContact = false;
      this.lastScaleChangeAt = 0;
      this.liveInkOverlapStartedAt = 0;
      this.liveInkWaitAfterPinchTerminalMs = 0;
      this.penLiftedForSettleAt = 0;
      this.settleResetReasons = {};
      this.runZoomSettlePaintCallCount = 0;
      this.lastSettleDeferralReason = null;
      this.zoomSequence += 1;
      this.postZoomStrokePointers.clear();
      this.postZoomRouterByPointer.clear();
      this.zoomBurstStartedAt = now;
      this.zoomTickCount = 0;
      this.startZoomProfile(scale, now);
      // Prefer pre-burst scale so a single large jump is not treated as delta=0.
      this.zoomBurstScaleStart = this.lastKnownViewScale ?? scale ?? null;
      this.zoomTextLayoutLoggedPages.clear();
      this.zoomInkLayoutLoggedPhases.clear();
      this.zoomInkAnchorByPage.clear();
      this.zoomHandoffNeedsFinalRebase = false;
      this.setAdapterInkZoomBurstActive(true);
      this.startZoomLongTaskObserver();
      this.reportDevProbe("zoom-burst-start", {
        reason,
        scale: scale ?? null,
        surfaces: this.surfaces.size
      });
      this.logger.zoomLifecycle("zoom-burst-start", {
        zoomBurstId: this.zoomCorrelationId,
        reason,
        scale: scale ?? null,
        mountedPages: [...this.surfaces.keys()].sort((a, b) => a - b),
        routerGenerations: this.currentRouterGenerations(),
        ...this.zoomBurstSnapshot()
      });
    }
    this.zoomTickCount += 1;
    this.zoomPipelineTrace.noteEvent(`zoom-tick-${reason}`);
    if (reason.includes("scalechanging")) {
      this.zoomPipelineTrace.noteStage("scalechanging", 0, 1, "scalechanging");
    }
    if (this.zoomProfile) this.zoomProfile.compositorTicks += 1;
    if (scale !== undefined && (reason.includes("scalechanging") || reason.includes("data-scale"))) {
      this.recordZoomScale(scale, now);
    }
    this.zoomBurstReason = reason;
    // Only freeze ink bitmap during real zoom/rotation — pages-dom storms must keep repainting.
    if (ViewerInkSession.shouldCompositeDuring(reason) && !this.zoomCompositing) {
      this.beginZoomCompositing();
    }
    // Many scale events before the next paint share one overlay update.
    if (this.zoomCompositing) this.scheduleZoomOverlayLayout();
    if (scale !== undefined) {
      if (this.zoomBurstScaleStart === null) this.zoomBurstScaleStart = scale;
      this.zoomBurstScaleEnd = scale;
      this.lastKnownViewScale = scale;
    }
    const continuingScale = this.zoomSettleTimer !== null
      && (this.zoomBurstReason.includes("scale") || this.zoomBurstReason.includes("rotation"));
    this.zoomBurstReason = reason;
    const settleMs = continuingScale && !reason.includes("scale") && !reason.includes("rotation")
      ? this.zoomSettleCoalesceMs(scale)
      : this.zoomSettleDelayMs(reason, scale);
    if (reason.includes("scale") || reason.includes("rotation")) this.lastScaleChangeAt = now;
    this.postZoomTrace.remember("zoom-scale", {
      reason,
      tick: this.zoomTickCount,
      ...(scale !== undefined ? { scale: Number(scale.toFixed(4)) } : {})
    });
    this.logger.zoomTick({
      zoomBurstId: this.postZoomTrace.currentBurstId(),
      reason,
      tick: this.zoomTickCount,
      settleMs,
      ...(scale !== undefined ? { scale: Number(scale.toFixed(4)) } : {})
    });
    if (this.zoomSettleTimer !== null && this.zoomProfile) this.zoomProfile.settleTimerResets += 1;
    this.cancelPinchCleanupFrame();
    this.armZoomSettleTimer(settleMs, reason);
  }

  /**
   * Page renders and scroll ticks after the scale has stopped were restarting
   * the 560ms quiet window and writing a vault log each time. The last iPad
   * paste summed those cancelled waits into a 12–23s settle-timer-churn while
   * the zoom itself lasted about 1s.
   */
  private shouldCoalesceZoomSettleSignal(reason: string, scale?: number): boolean {
    if (!this.zoomProfile || this.zoomSettleTimer === null) return false;
    if (scale === undefined || this.zoomBurstScaleEnd === null) return false;
    const sameScale = Math.abs(scale - this.zoomBurstScaleEnd) < 1e-4;
    // PDF.js can publish the same data-scale attribute once per replaced page.
    // It is a structural observation, not a new scale gesture, so do not reset
    // the quiet timer for every page in a multi-page document.
    if (reason.includes("data-scale") && sameScale) return true;
    if (reason.includes("scale") || reason.includes("rotation")) return false;
    // Some mobile PDF hosts report a stale scale on the scroll notification
    // that follows a scale tick. Do not let that one-frame notification end a
    // live scale burst and arm the short layout settle timer.
    const recentScaleGesture = this.zoomProfile.scaleChangingEvents > 0
      && this.zoomBurstReason.includes("scale")
      && performance.now() - this.lastScaleChangeAt < ViewerInkSession.ZOOM_ACTIVE_MS;
    return sameScale || recentScaleGesture;
  }

  /**
   * Long coalesce covers stepped trackpad gaps (~200–500ms). Tiny absolute+relative
   * scale deltas use the short quiet window so micro-nudges feel instant.
   * Baseline is the pre-burst scale (`zoomBurstScaleStart`), never the first tick
   * alone (that would make every single-tick jump look like delta 0).
   */
  private zoomSettleDelayMs(reason: string, scale?: number): number {
    if (reason.includes("scale") || reason.includes("rotation")) return this.zoomSettleCoalesceMs(scale);
    return this.frameTimingProfile().frameBudgetMs;
  }

  private zoomSettleCoalesceMs(scale?: number): number {
    if (scale === undefined || this.zoomBurstScaleStart === null) {
      return ViewerInkSession.ZOOM_SETTLE_MS;
    }
    const start = this.zoomBurstScaleStart;
    const delta = Math.abs(scale - start);
    const relative = delta / Math.max(Math.abs(start), 1e-6);
    if (
      delta > 1e-6
      && delta < ViewerInkSession.ZOOM_SETTLE_TINY_SCALE_DELTA
      && relative < ViewerInkSession.ZOOM_SETTLE_TINY_RELATIVE
    ) {
      return ViewerInkSession.ZOOM_SETTLE_TINY_MS;
    }
    return ViewerInkSession.ZOOM_SETTLE_MS;
  }

  /** True while freehand/laser draft or live eraser/lasso path owns the pointer. */
  private surfaceHasLiveInkInput(surface: PageSurface): boolean {
    if (surface.builder) return true;
    if (surface.editPath.length > 0 && (surface.editTool === "eraser" || surface.editTool === "lasso")) return true;
    if ((surface.router?.activePenIds().length ?? 0) > 0) return true;
    return false;
  }


  private mouseInkingEnabled(): boolean {
    return this.options.mouseInkingEnabled?.() ?? this.options.settings.mouseInkingEnabled;
  }

  private isDesktopPdfPageEvent(
    event: Pick<PointerEvent, "clientX" | "clientY" | "target">
  ): boolean {
    if (this.runtimePlatform().mobile) return false;
    const page = this.options.adapter.pages().find(({ element }) =>
      containsClientPoint(element, event.clientX, event.clientY)
    );
    if (!page || !(event.target instanceof Element)) return false;
    if (page.element.contains(event.target)) return true;
    // A stale/retargeted event may still be visibly over the page. Recover it
    // only when the topmost hit confirms the page, never from geometry alone.
    if (!this.options.adapter.root.contains(event.target)) return false;
    const topHit = this.options.adapter.host.ownerDocument.elementFromPoint?.(event.clientX, event.clientY);
    return topHit instanceof Element && page.element.contains(topHit);
  }


  private canAnnotatePointerEvent(
    event: Pick<PointerEvent, "pointerType" | "clientX" | "clientY" | "target">
  ): boolean {
    const context = {
      mouseInkingEnabled: this.mouseInkingEnabled(),
      stylusConfirmed: this.stylusCapability === "confirmed",
      touchDrawFallback: this.touchAnnotationEnabled(),
      ...(event.pointerType === "mouse"
        ? { mouseOverPdfPage: this.isDesktopPdfPageEvent(event) }
        : {})
    };
    return canAnnotatePointer(event, context);
  }

  private touchAnnotationEnabled(): boolean {
    const enabled = this.options.touchDrawFallbackEnabled?.() ?? this.options.settings.touchDrawFallback;
    return enabled === true
      && this.stylusCapability !== "confirmed";
  }

  private promoteStylusCapability(event: Pick<PointerEvent, "pointerType">): void {
    if (event.pointerType !== "pen" || this.stylusCapability === "confirmed") return;
    this.stylusCapability = "confirmed";
    this.logger.inputLifecycleEvent("stylus-capability-promoted", {
      capability: this.stylusCapability,
      reason: "observed-pointerType-pen",
      ...this.inputPolicyLogFields()
    });
    this.syncTouchDrawPolicy("stylus-capability-promoted");
  }

  private pageEvidenceReason(page: AnnotationPageInfo): string | null {
    const reason = annotationPageSafetyReason(page);
    if (reason) return reason;
    if (!this.options.adapter.root.contains(page.element)
      && !this.options.adapter.host.contains(page.element)) return "outside-viewer-host";
    return null;
  }

  private recordPageEvidence(page: AnnotationPageInfo, reason: string | null): void {
    const surface = this.surfaces.get(page.pageNumber);
    if (surface) surface.annotationSafetyBlocked = reason;
    if (!reason) {
      this.pageSafetyDiagnostics.delete(page.pageNumber);
      return;
    }
    const diagnosticKey = `${reason}:${page.mountGeneration ?? "none"}:${getDebugNodeId(page.element)}`;
    if (this.pageSafetyDiagnostics.get(page.pageNumber) === diagnosticKey) return;
    this.pageSafetyDiagnostics.set(page.pageNumber, diagnosticKey);
    this.logger.inputLifecycleEvent("annotation-safety-blocked", {
      page: page.pageNumber,
      reason,
      pageId: getDebugNodeId(page.element),
      mountGeneration: page.mountGeneration ?? null,
      geometryConfidence: page.geometryConfidence ?? null,
      identityConfidence: page.identityConfidence ?? null
    });
  }

  private canAnnotateSurface(
    surface: PageSurface,
    event: Pick<PointerEvent, "pointerType" | "clientX" | "clientY" | "target">
  ): boolean {
    if (this.destroyed || this.inputTeardownStarted || this.documentInputOwnershipRevoked) return false;
    if (!this.canAnnotatePointerEvent(event)) return false;
    const current = this.options.adapter.page(surface.page.pageNumber);
    let reason = this.pageEvidenceReason(surface.page);
    if (surface.page.mountGeneration !== undefined) {
      reason = current ? this.pageEvidenceReason(current) : "page-not-found";
      if (!reason && current && !annotationPageMountMatches(current, surface.page)) {
        reason = "stale-page-generation";
      }
    } else if (current && current.element === surface.page.element) {
      reason = this.pageEvidenceReason(current);
    }
    if (reason) {
      this.recordPageEvidence(current ?? surface.page, reason);
      return false;
    }
    this.recordPageEvidence(surface.page, null);
    return true;
  }

  private inputPolicyLogFields(): Record<string, unknown> {
    return {
      ...describeInputPolicies({
        mouseInkingEnabled: this.mouseInkingEnabled()
      }),
      stylusCapability: this.stylusCapability,
      touchDrawFallback: this.touchAnnotationEnabled(),
      activeTool: this.activeTool()
    };
  }

  private resolvedPolicyForPointer(
    event: Pick<PointerEvent, "pointerType" | "clientX" | "clientY" | "target">
  ): string {
    if (event.pointerType === "pen") return "annotate";
    if (event.pointerType === "touch") return this.touchAnnotationEnabled() ? "annotate-touch-fallback" : "native";
    if (event.pointerType === "mouse" && this.isDesktopPdfPageEvent(event)) {
      return this.mouseInkingEnabled() ? "annotate-page" : "native";
    }
    return "native";
  }

  /** Live annotation gesture (ink/edit) or selection/text manipulation. */
  private hasActiveAnnotationGesture(): boolean {
    if (this.hasAnyLiveInkInput()) return true;
    if (this.moveDrag || this.textMoveDrag || this.textBoxTransformDrag) return true;
    if (this.activeTextEditor) return true;
    return false;
  }

  private zoomInputState(): {
    inputPending: boolean;
    activeAnnotationGesture: boolean;
    activePinchPointers: number;
    activePinchTouches: number;
    activeTouchPointerCount: number;
  } {
    const activeAnnotationGesture = this.hasActiveAnnotationGesture();
    const pinch = this.pinchCleanup.activePinchCount();
    const activeTouchPointerCount = this.pluginTouchPointerIds().length;
    return {
      inputPending: activeAnnotationGesture
        || pinch.pointers > 0
        || pinch.touches > 0
        || activeTouchPointerCount > 0,
      activeAnnotationGesture,
      activePinchPointers: pinch.pointers,
      activePinchTouches: pinch.touches,
      activeTouchPointerCount
    };
  }

  private deferZoomMaintenanceForInput(reason: string): boolean {
    const state = this.zoomInputState();
    if (!state.inputPending) return false;
    if (!this.zoomMaintenanceDeferredForInput) {
      this.logger.zoomComposite("settle-deferred", {
        reason: "input-pending",
        maintenance: reason,
        ...state
      });
    }
    this.zoomMaintenanceDeferredForInput = true;
    return true;
  }

  private resumeZoomMaintenanceAfterInput(): void {
    if (!this.zoomMaintenanceDeferredForInput || this.zoomInputState().inputPending) return;
    this.zoomMaintenanceDeferredForInput = false;
    if (this.zoomCompositing) {
      this.scheduleZoomOverlayLayout();
      return;
    }
    if (
      this.zoomCompositeSettledAt > 0
      && this.zoomSettleQueue.length === 0
      && this.zoomSettleSliceFrame === null
      && this.isZoomHandoffActive()
    ) {
      this.releaseZoomCompositeAfterNativeRender();
    }
  }

  /** Transient pen hit-page class only while a stylus tip is actively routed. */
  private hasActivePenCapability(): boolean {
    for (const surface of this.surfaces.values()) {
      if ((surface.router?.activePenIds().length ?? 0) > 0) return true;
      if (surface.builder && surface.router) {
        // Prefer pen-owned drafts; mouse annotate still uses routers without hit-page lock.
        const pens = surface.router.activePenIds();
        if (pens.length > 0) return true;
      }
    }
    return false;
  }

  /** Annotation shortcuts must not hijack native PDF/editor selection. */
  private annotationShortcutContext(): boolean {
    if (!this.isAttached()) return false;
    if (this.activeTextEditor) return false;
    const tool = this.activeTool();
    // Lasso/text own annotation selection shortcuts; otherwise require an existing selection.
    if (tool === "lasso" || tool === "text") return true;
    this.reconcileSelection();
    return this.selected.length > 0 || this.selectedTexts.length > 0;
  }

  private hasAnyLiveInkInput(): boolean {
    for (const surface of this.surfaces.values()) {
      if (this.surfaceHasLiveInkInput(surface)) return true;
    }
    return false;
  }

  private cancelPinchCleanupFrame(): void {
    if (this.pinchCleanupFrame === null) return;
    window.cancelAnimationFrame(this.pinchCleanupFrame);
    this.pinchCleanupFrame = null;
  }

  /** Plugin touch ids still held by page routers. Logged, not cleared. */
  private pluginTouchPointerIds(): number[] {
    const ids = new Set<number>();
    for (const surface of this.surfaces.values()) {
      for (const pointerId of surface.router?.activeTouchPointerIds() ?? []) ids.add(pointerId);
    }
    return [...ids];
  }

  /**
   * Experiment: do not open the post-zoom window until pinch pointer and touch
   * terminals have arrived, then one animation frame. Capture release is not repeated.
   */
  private awaitPinchGestureCleanup(): boolean {
    const pluginTouchPointerIds = this.pluginTouchPointerIds();
    const report = this.pinchCleanup.evaluate(performance.now(), PINCH_CLEANUP_MAX_WAIT_MS);
    if (!report.quiescent) {
      this.lastSettleDeferralReason = "pinch-cleanup";
      this.armZoomSettleTimer(32);
      return true;
    }
    if (this.pinchCleanup.needsAnimationFrame()) {
      // Finger release already ran on this turn. That is the one post-terminal
      // frame; waiting for another rAF was the 50ms flag.
      if (report.quiescent && this.pinchTerminalAt !== 0) {
        this.pinchCleanup.noteAnimationFrame();
      } else {
        this.lastSettleDeferralReason = "pinch-cleanup-frame";
        this.cancelPinchCleanupFrame();
        this.pinchCleanupFrame = window.requestAnimationFrame(() => {
          this.pinchCleanupFrame = null;
          this.pinchCleanup.noteAnimationFrame();
          this.runZoomSettlePaint();
        });
        this.refreshZoomBurstActivity();
        return true;
      }
    }
    this.postZoomTrace.noteGestureCleanup({
      ...report,
      pluginTouchPointerIds
    });
    const cleanupSpan = this.slowSpans.record({
      kind: "async",
      category: "zoom",
      stage: "gesture-cleanup-wait",
      durationMs: report.gestureCleanupWaitMs,
      activeWorkMs: 0,
      waitMs: report.gestureCleanupWaitMs,
      reason: this.lastSettleDeferralReason,
      zoomBurstId: this.zoomCorrelationId
    });
    if (cleanupSpan) this.logger.perfSlowSpan({ ...cleanupSpan });
    return false;
  }

  private armZoomSettleTimer(delayMs: number, reason = this.lastSettleDeferralReason ?? "timer-reset"): void {
    const pinch = this.pinchCleanup.activePinchCount();
    const pinchStillActive = pinch.pointers > 0 || pinch.touches > 0;
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      if (pinchStillActive && (reason.includes("scale") || reason.includes("rotation"))) {
        this.inGestureResetCount += 1;
      } else if (reason !== "pinch-terminal") {
        this.settleTimerResetCount += 1;
        const bucket = settleResetBucket(reason);
        this.settleResetReasons[bucket] = (this.settleResetReasons[bucket] ?? 0) + 1;
      }
    }
    this.lastSettleDeferralReason = reason;
    if (this.settleWaitStartedAt === 0) this.settleWaitStartedAt = performance.now();
    this.zoomSettleTimerGeneration += 1;
    const generation = this.zoomSettleTimerGeneration;
    this.zoomSettleTimerDueAt = performance.now() + delayMs;
    this.zoomSettleTimer = window.setTimeout(() => {
      if (generation !== this.zoomSettleTimerGeneration) return;
      this.zoomSettleTimer = null;
      this.runZoomSettlePaint();
    }, delayMs);
    this.armZoomBurstWatchdog();
  }

  /**
   * One pause while the tip is down. The old 120ms retry logged and re-armed
   * for the whole stroke (19.7s, 34 resets on the last iPad paste) and stamped
   * lastZoomSignalAt so the zoom burst never went quiet.
   */
  private pauseZoomSettleForLiveInk(reason: "live-ink" | "live-ink-slice"): void {
    this.lastSettleDeferralReason = reason;
    if (this.liveInkOverlapStartedAt === 0) this.liveInkOverlapStartedAt = performance.now();
    if (this.zoomSettlePausedForLiveInk) return;
    this.zoomSettlePausedForLiveInk = true;
    this.zoomSettlePausedAt = performance.now();
    this.zoomSettlePausedReason = reason;
    const alreadyLoggedByInputGate = this.zoomMaintenanceDeferredForInput;
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    if (!alreadyLoggedByInputGate) {
      this.logger.zoomComposite("settle-deferred", {
        reason,
        pages: this.surfaces.size,
        remaining: this.zoomSettleQueue.length,
        once: true
      });
    }
  }

  private scheduleZoomSettleResume(): void {
    this.resumeZoomMaintenanceAfterInput();
    if (!this.zoomSettlePausedForLiveInk || this.zoomSettleResumeTimer !== null) return;
    this.closeLiveInkOverlap(performance.now());
    this.penLiftedForSettleAt = performance.now();
    this.zoomSettleResumeTimer = window.setTimeout(() => {
      this.zoomSettleResumeTimer = null;
      this.resumeZoomSettleAfterLiveInk();
    }, 0);
  }

  /** Pencil overlap after the fingers are already up. The stroke itself is not a settle stall. */
  private closeLiveInkOverlap(at: number): void {
    if (this.liveInkOverlapStartedAt === 0 || this.pinchTerminalAt === 0) return;
    const start = Math.max(this.liveInkOverlapStartedAt, this.pinchTerminalAt);
    this.liveInkWaitAfterPinchTerminalMs += Math.max(0, at - start);
    this.liveInkOverlapStartedAt = 0;
  }

  /**
   * Fingers-up ends the gesture. The 560ms window is only for scale ticks that
   * can still arrive while the pinch is held. A resize that does not change
   * scale uses the same short delay.
   */
  private notePinchTerminalIfQuiet(): void {
    if (!this.zoomProfile) return;
    const pinch = this.pinchCleanup.activePinchCount();
    if (pinch.pointers > 0 || pinch.touches > 0) {
      this.pinchSawContact = true;
      return;
    }
    if (!this.pinchSawContact || this.pinchTerminalAt !== 0) return;
    this.pinchTerminalAt = performance.now();
    if (this.hasAnyLiveInkInput()) {
      this.pauseZoomSettleForLiveInk("live-ink");
      return;
    }
    this.armZoomSettleTimer(this.frameTimingProfile().frameBudgetMs, "pinch-terminal");
    this.resumeZoomMaintenanceAfterInput();
  }

  private resumeZoomSettleAfterLiveInk(): void {
    if (this.destroyed || !this.zoomSettlePausedForLiveInk) return;
    if (this.hasAnyLiveInkInput()) return;
    const pausedAt = this.zoomSettlePausedAt;
    const reason = this.zoomSettlePausedReason;
    this.zoomSettlePausedForLiveInk = false;
    this.zoomSettlePausedAt = null;
    this.zoomSettlePausedReason = null;
    const liftLagMs = this.penLiftedForSettleAt === 0
      ? (pausedAt === null ? 0 : performance.now() - pausedAt)
      : performance.now() - this.penLiftedForSettleAt;
    this.penLiftedForSettleAt = 0;
    const span = this.slowSpans.record({
      kind: "async",
      category: "zoom",
      stage: "settle-paused-for-live-ink",
      durationMs: liftLagMs,
      activeWorkMs: 0,
      waitMs: liftLagMs,
      reason,
      zoomBurstId: this.zoomCorrelationId
    });
    if (span) this.logger.perfSlowSpan({ ...span });
    if (reason === "live-ink-slice" && this.zoomSettleQueue.length > 0) {
      this.paintZoomSettleSlice();
      return;
    }
    this.runZoomSettlePaint();
  }

  private armZoomBurstWatchdog(): void {
    if (this.zoomBurstWatchdog !== null) window.clearTimeout(this.zoomBurstWatchdog);
    this.zoomBurstWatchdog = window.setTimeout(() => {
      this.zoomBurstWatchdog = null;
      this.considerZoomBurstWatchdog();
    }, ZOOM_BURST_STUCK_MS);
  }

  private clearZoomBurstWatchdog(): void {
    if (this.zoomBurstWatchdog === null) return;
    window.clearTimeout(this.zoomBurstWatchdog);
    this.zoomBurstWatchdog = null;
  }

  private considerZoomBurstWatchdog(): void {
    if (this.destroyed || !this.postZoomTrace.isBurstOpen()) return;
    this.refreshZoomBurstActivity();
    const pinch = this.pinchCleanup.activePinchCount();
    const pinchWatch = this.pinchCleanup.watchState();
    const decision = decideZoomBurstWatchdog({
      now: performance.now(),
      lastZoomSignalAt: this.lastZoomSignalAt,
      zoomSettleTimerArmed: this.zoomSettleTimer !== null,
      zoomSettleTimerDueAt: this.zoomSettleTimerDueAt,
      pinchCleanupFrameArmed: this.pinchCleanupFrame !== null,
      activePinchPointers: pinch.pointers,
      activePinchTouches: pinch.touches,
      liveInk: this.hasAnyLiveInkInput(),
      gestureCleanupTimedOut: pinchWatch.timedOut
    });
    this.postZoomTrace.noteBurstActivity({ lastWatchdogReason: decision.reason, lastWatchdogAction: decision.action });
    if (decision.action === "wait") {
      this.logger.zoomLifecycle("zoom-burst-watchdog-wait", {
        zoomBurstId: this.postZoomTrace.currentBurstId(),
        reason: decision.reason,
        ...this.postZoomTrace.diagnosis().burstActivity
      });
      this.armZoomBurstWatchdog();
      return;
    }
    this.lastSettleDeferralReason = decision.reason;
    this.logger.zoomLifecycle("zoom-burst-watchdog-recovery", {
      zoomBurstId: this.postZoomTrace.currentBurstId(),
      event: "zoom-burst-watchdog-recovery",
      reason: decision.reason,
      ...this.postZoomTrace.diagnosis().burstActivity
    });
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    this.runZoomSettlePaint();
  }

  private refreshZoomBurstActivity(): void {
    if (!this.postZoomTrace.isBurstOpen()) return;
    const beganAt = this.postZoomTrace.diagnosis().beganAt;
    const beganMs = beganAt ? Date.parse(beganAt) : Date.now();
    const pinch = this.pinchCleanup.activePinchCount();
    const pinchDiag = this.pinchCleanup.diagnostics();
    const pinchWatch = this.pinchCleanup.watchState();
    const liveInkPages = [...this.surfaces.entries()]
      .filter(([, surface]) => this.surfaceHasLiveInkInput(surface))
      .map(([page]) => page);
    this.postZoomTrace.noteBurstActivity({
      activeBurstAgeMs: Math.max(0, Date.now() - beganMs),
      lastZoomSignalAt: this.lastZoomSignalAt,
      lastZoomSignalReason: this.lastZoomSignalReason,
      lastZoomSignalScale: this.lastZoomSignalScale,
      lastZoomSignalAgeMs: this.lastZoomSignalAt > 0 ? Math.max(0, Math.round(performance.now() - this.lastZoomSignalAt)) : null,
      zoomSettleTimerArmed: this.zoomSettleTimer !== null,
      zoomSettleTimerDueAt: this.zoomSettleTimerDueAt,
      zoomSettleTimerGeneration: this.zoomSettleTimerGeneration,
      settleTimerResetCount: this.settleTimerResetCount,
      runZoomSettlePaintCallCount: this.runZoomSettlePaintCallCount,
      lastRunZoomSettlePaintAt: this.lastRunZoomSettlePaintAt,
      lastSettleDeferralReason: this.lastSettleDeferralReason,
      pinchCleanupEvaluateCount: pinchDiag.evaluateCount,
      pinchCleanupQuiescent: (pinch.pointers === 0 && pinch.touches === 0) || pinchWatch.timedOut,
      gestureCleanupTimedOut: pinchWatch.timedOut,
      lastPinchEventAgeMs: pinchWatch.lastPinchEventAgeMs,
      stalePinchPointerIds: pinchWatch.stalePointerIds,
      stalePinchTouchIdentifiers: pinchWatch.staleTouchIds,
      pinchCleanupNeedsAnimationFrame: pinchDiag.needsAnimationFrame,
      pinchCleanupFrameArmed: this.pinchCleanupFrame !== null,
      liveInkAtLastSettleAttempt: liveInkPages.length > 0,
      liveInkPages,
      activePenIds: [...this.surfaces.values()].flatMap((surface) => surface.router?.activePenIds() ?? []),
      ...this.pinchCleanup.associationState(),
      ...this.pinchCleanup.reconciliationState(),
      activeTouchPointerIds: this.pluginTouchPointerIds(),
      zoomProfileActive: this.zoomProfile !== null,
      zoomCompositing: this.zoomCompositing,
      zoomHandoffActive: this.isZoomHandoffActive(),
      pendingMobileScrollRemount: this.pendingMobileScrollRemount
    });
  }

  private runZoomSettlePaint(): void {
    if (this.destroyed) return;
    this.runZoomSettlePaintCallCount += 1;
    this.lastRunZoomSettlePaintAt = performance.now();
    if (this.awaitPinchGestureCleanup()) {
      this.zoomFrameDiagnostics.setPhase("post-pinch-live-ink");
      return;
    }
    // Keep CSS compositing + draft canvas intact until the tip lifts. Mid-drag
    // settle was clearing the live draft and force-rebinding routers (log proof).
    if (this.hasAnyLiveInkInput()) {
      this.zoomFrameDiagnostics.setPhase("post-pinch-live-ink");
      this.pauseZoomSettleForLiveInk("live-ink");
      return;
    }
    this.zoomFrameDiagnostics.setPhase("handoff");
    const settleWorkStarted = performance.now();
    const burstTicks = this.zoomTickCount;
    const burstDurationMs = roundMs(performance.now() - this.zoomBurstStartedAt);
    const scaleStart = this.zoomBurstScaleStart;
    const scaleEnd = this.zoomBurstScaleEnd;
    this.cancelZoomOverlayLayout();
    const finalLayoutStarted = performance.now();
    if (this.zoomCompositing) this.syncZoomOverlayLayouts();
    this.recordZoomProfileTask(finalLayoutStarted);
    if (this.zoomProfile) this.zoomProfile.gestureEndedAt = performance.now();
    this.setAdapterInkZoomBurstActive(false);
    this.zoomBurstStartedAt = 0;
    this.zoomTickCount = 0;
    this.zoomBurstScaleStart = null;
    this.zoomBurstScaleEnd = null;
    this.lastZoomSignalAt = 0;
    this.cancelZoomSettleSlice();
    this.endZoomCompositing();
    this.zoomCompositeSettledAt = performance.now();
    this.lastZoomHandoffSettledAt = this.zoomCompositeSettledAt;
    this.lastZoomSettleAt = Date.now();
    this.zoomSettleSliceStartedAt = this.zoomCompositeSettledAt;
    this.pinchCleanup.endBurst();
    this.rebindStaleZoomRouters("zoom-settle");
    // Refresh the retained diagnosis after any live-ink pause has ended. The
    // first deferred attempt may have recorded a pen that lifted before settle.
    this.refreshZoomBurstActivity();
    this.handledDrawPointers.clear();
    this.postZoomTrace.remember("zoom-cleared-handled-pointers", { zoomBurstId: this.zoomCorrelationId });
    const settleSnapshot = {
      ...this.zoomBurstSnapshot(),
      // Captured before the burst fields are cleared. The live snapshot reads those fields.
      scaleBefore: scaleStart,
      scaleAfter: scaleEnd ?? this.options.adapter.getViewState().scale
    };
    this.clearZoomBurstWatchdog();
    const settledAt = Date.now();
    const settledBurstId = this.postZoomTrace.settle(settledAt, settleSnapshot);
    if (settledBurstId) this.postZoomDurability.onZoomSettle(settledBurstId, settledAt);
    this.slowSpans.beginPostZoom(settledBurstId, performance.now());
    const settleSpan = this.slowSpans.record({
      kind: "sync",
      category: "zoom",
      stage: "zoom-settle",
      durationMs: performance.now() - settleWorkStarted,
      activeWorkMs: performance.now() - settleWorkStarted,
      waitMs: 0,
      zoomBurstId: settledBurstId
    });
    if (settleSpan) this.logger.perfSlowSpan({ ...settleSpan });
    const nowPerf = performance.now();
    const zoomGestureDurationMs = this.pinchTerminalAt !== 0 && this.zoomGestureStartedAt !== 0
      ? this.pinchTerminalAt - this.zoomGestureStartedAt
      : null;
    const pinchTerminalToSettleMs = this.pinchTerminalAt !== 0 ? nowPerf - this.pinchTerminalAt : null;
    const lastScaleChangeToSettleMs = this.lastScaleChangeAt !== 0 ? nowPerf - this.lastScaleChangeAt : null;
    const liveInkWaitAfterPinchTerminalMs = this.pinchTerminalAt !== 0 ? this.liveInkWaitAfterPinchTerminalMs : null;
    const postGestureMs = pinchTerminalToSettleMs
      ?? (this.zoomGestureStartedAt !== 0 ? nowPerf - this.zoomGestureStartedAt : 0);
    const perceivedPostGestureMs = Math.max(0, postGestureMs - (liveInkWaitAfterPinchTerminalMs ?? 0));
    const layoutWait = this.lastSettleDeferralReason === "resize"
      || this.lastSettleDeferralReason === "pages-page-render"
      || this.lastSettleDeferralReason === "pinch-cleanup-frame"
      || this.lastSettleDeferralReason === "pinch-terminal";
    const unexpectedWaitMs = layoutWait
      ? Math.max(0, perceivedPostGestureMs - this.frameTimingProfile().frameBudgetMs)
      : perceivedPostGestureMs;
    const gestureCleanup = this.postZoomTrace.diagnosis().gestureCleanup;
    const gestureCleanupWaitMs = typeof gestureCleanup?.gestureCleanupWaitMs === "number"
      ? gestureCleanup.gestureCleanupWaitMs
      : null;
    const settlePhaseDurations = {
      "settle-timer-wait": this.settleWaitStartedAt === 0
        ? null
        : Math.max(0, nowPerf - this.settleWaitStartedAt),
      "pinch-terminal-to-settle": pinchTerminalToSettleMs,
      "gesture-cleanup": gestureCleanupWaitMs,
      "live-ink": liveInkWaitAfterPinchTerminalMs,
      "last-scale-change-to-settle": lastScaleChangeToSettleMs,
      "unattributed-post-gesture": unexpectedWaitMs
    };
    this.postZoomTrace.noteBurstActivity({
      zoomGestureDurationMs: zoomGestureDurationMs === null ? null : Math.round(zoomGestureDurationMs * 10) / 10,
      pinchTerminalToSettleMs: pinchTerminalToSettleMs === null ? null : Math.round(pinchTerminalToSettleMs * 10) / 10,
      lastScaleChangeToSettleMs: lastScaleChangeToSettleMs === null ? null : Math.round(lastScaleChangeToSettleMs * 10) / 10,
      liveInkWaitAfterPinchTerminalMs: liveInkWaitAfterPinchTerminalMs === null ? null : Math.round(liveInkWaitAfterPinchTerminalMs * 10) / 10,
      inGestureResetCount: this.inGestureResetCount,
      postGestureResetCount: this.settleTimerResetCount
    });
    const churn = this.slowSpans.recordSettleChurn({
      settleDelayMs: unexpectedWaitMs,
      settleTimerResetCount: this.settleTimerResetCount,
      inGestureResetCount: this.inGestureResetCount,
      resetReasons: this.settleResetReasons,
      lastDeferralReason: this.lastSettleDeferralReason,
      zoomBurstId: settledBurstId,
      zoomGestureDurationMs,
      pinchTerminalToSettleMs,
      lastScaleChangeToSettleMs,
      liveInkWaitAfterPinchTerminalMs,
      phaseDurations: settlePhaseDurations
    });
    if (churn) this.logger.perfSlowSpan({ ...churn });
    this.settleWaitStartedAt = 0;
    this.inGestureResetCount = 0;
    this.liveInkWaitAfterPinchTerminalMs = 0;
    this.settleResetReasons = {};
    this.logger.zoomLifecycle("zoom-burst-settle", {
      zoomBurstId: this.zoomCorrelationId,
      burstTicks,
      burstDurationMs,
      scaleStart,
      scaleEnd,
      routerGenerations: this.currentRouterGenerations(),
      ...settleSnapshot,
      ...(this.postZoomTrace.diagnosis().gestureCleanup ?? {})
    });
    this.zoomSettleBurst = {
      reason: this.zoomBurstReason,
      burstTicks,
      burstDurationMs,
      ...(scaleStart !== null ? { scaleStart } : {}),
      ...(scaleEnd !== null ? { scaleEnd } : {})
    };
    this.zoomSettleStats = {
      pagesRepainted: 0,
      canvasesResized: 0,
      strokesRedrawn: 0,
      skippedDisconnected: 0,
      skippedCulled: 0,
      skippedBlitOnly: 0
    };
    this.zoomSettlePaintedPages.clear();
    const order = this.zoomSettlePageOrder();
    // Sync: focus gets a cheap full-backing blit-stretch so geometry matches under the
    // CSS mask without a 58-stroke vector wall. HQ focus + cheap neighbors drain on rAF.
    this.zoomSettleQueue = [];
    if (order.focus !== null) {
      this.paintOneZoomSettlePage(order.focus, "focus-fast");
      const focusSurface = this.surfaces.get(order.focus);
      if (focusSurface?.settleUpgradePending) {
        this.zoomSettleQueue.push({ page: order.focus, tier: "focus" });
      }
    }
    for (const page of order.neighbors) {
      this.zoomSettleQueue.push({ page, tier: "neighbor" });
    }
    this.zoomSettleQueue.reverse();
    this.logger.zoomComposite("settle-paint", {
      pages: (order.focus !== null ? 1 : 0) + order.neighbors.length,
      focusPage: order.focus,
      neighborPages: order.neighbors.length,
      focusHqQueued: this.zoomSettleQueue.some((item) => item.tier === "focus"),
      burstTicks,
      sliced: true,
      focusSync: true,
      focusFast: true
    });
    this.reportDevProbe("zoom-settled", {
      reason: this.zoomBurstReason,
      ticks: burstTicks,
      durationMs: burstDurationMs,
      scaleStart,
      scaleEnd,
      surfaces: this.surfaces.size,
      sliced: true,
      focusPage: order.focus,
      neighborPages: order.neighbors.length
    });
    if (this.zoomSettleQueue.length === 0) {
      this.finishZoomSettleSlices();
      return;
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      while (this.zoomSettleQueue.length > 0) {
        const item = this.zoomSettleQueue.pop()!;
        this.paintOneZoomSettlePage(item.page, item.tier);
      }
      this.zoomSettleQueue.length = 0;
      this.finishZoomSettleSlices();
      return;
    }
    this.zoomSettleSliceFrame = view.requestAnimationFrame(() => {
      this.zoomSettleSliceFrame = null;
      this.paintZoomSettleSlice();
    });
  }

  /**
   * Pin the adapter's current page (else largest visible intersection) for sync HQ.
   * Remaining pages in the visible working set settle as cheap neighbors under
   * the CSS mask; farther pages stay deferred for idle viewport work.
   */
  private zoomSettlePageOrder(): { focus: number | null; neighbors: number[] } {
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const view = this.options.adapter.root.getBoundingClientRect();
    const working = this.zoomWorkingSurfaces(view);
    this.zoomActivePageCount = working.length;
    this.zoomWorkingPageNumbers = new Set(working.map((surface) => surface.page.pageNumber));
    const ranked = working.map((surface) => ({
      pageNumber: surface.page.pageNumber,
      area: this.surfaceViewportIntersectionArea(surface, view)
    }));
    ranked.sort((a, b) => b.area - a.area);

    let focus: number | null = null;
    if (this.surfaces.has(currentPage)) {
      focus = currentPage;
    } else if (ranked[0] && ranked[0].area > 0) {
      focus = ranked[0].pageNumber;
    } else if (ranked[0]) {
      focus = ranked[0].pageNumber;
    }

    const neighbors = ranked
      .filter((entry) => entry.pageNumber !== focus)
      .map((entry) => entry.pageNumber);
    return { focus, neighbors };
  }

  private surfaceViewportIntersectionArea(surface: PageSurface, view: DOMRect): number {
    const rect = surface.overlay.getBoundingClientRect();
    const left = Math.max(view.left, rect.left);
    const top = Math.max(view.top, rect.top);
    const right = Math.min(view.right, rect.right);
    const bottom = Math.min(view.bottom, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  private paintZoomSettleSlice(): void {
    if (this.destroyed) return;
    if (this.hasAnyLiveInkInput()) {
      this.pauseZoomSettleForLiveInk("live-ink-slice");
      return;
    }
    if (this.zoomSettleQueue.length === 0) {
      this.finishZoomSettleSlices();
      return;
    }

    const item = this.zoomSettleQueue.pop()!;
    const started = performance.now();
    this.paintOneZoomSettlePage(item.page, item.tier);
    this.recordZoomPipelineFrame(performance.now(), performance.now() - started);

    if (this.zoomSettleQueue.length === 0) {
      this.finishZoomSettleSlices();
      return;
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      while (this.zoomSettleQueue.length > 0) {
        const next = this.zoomSettleQueue.pop()!;
        this.paintOneZoomSettlePage(next.page, next.tier);
      }
      this.zoomSettleQueue.length = 0;
      this.finishZoomSettleSlices();
      return;
    }
    this.zoomSettleSliceFrame = view.requestAnimationFrame(() => {
      this.zoomSettleSliceFrame = null;
      this.paintZoomSettleSlice();
    });
  }

  private paintOneZoomSettlePage(
    pageNumber: number,
    tier: "focus-fast" | "focus" | "neighbor"
  ): void {
    const reasonBase = this.zoomSettleBurst?.reason ?? this.zoomBurstReason;
    const reason = tier === "focus-fast"
      ? `${reasonBase}-settle-focus-fast`
      : tier === "focus"
        ? `${reasonBase}-settle-focus`
        : `${reasonBase}-settle-neighbor`;
    const surface = this.surfaces.get(pageNumber);
    const started = performance.now();
    const strokesBefore = this.zoomSettleStats.strokesRedrawn;
    const resizedBefore = this.zoomSettleStats.canvasesResized;
    const blitBefore = this.zoomSettleStats.skippedBlitOnly;
    const pages = this.options.adapter.pages();
    const current = pages.find((page) => page.pageNumber === pageNumber);
    let paintPath: "disconnected" | "culled" | "blit-only" | "blit-stretch" | "canonical-vector" | "skip" = "skip";
    if (!surface || !current) {
      this.zoomSettleStats.skippedDisconnected += 1;
      paintPath = "disconnected";
    } else {
      if (!this.reattachSurface(surface, current)) {
        if (current.element.isConnected) this.remountSurfaceOnPageReplacement(surface, current);
        else {
          this.zoomSettleStats.skippedDisconnected += 1;
          paintPath = "disconnected";
        }
      }
      if (this.surfaces.get(pageNumber) && paintPath !== "disconnected") {
        this.ensurePageRouter(surface, {
          reason: this.surfaceHasLiveInkInput(surface) ? `${reason}-live-ink` : reason
        });
        const upgradeBefore = surface.settleUpgradePending;
        const layout = this.pageLayout(surface);
        const geometryBatch = this.logger.isEnabled()
          ? this.readZoomGeometry([surface])
          : null;
        if (geometryBatch && this.zoomProfile) this.zoomProfile.geometryReadCount += geometryBatch.readCount;
        const geometry = geometryBatch?.snapshots.get(pageNumber);
        const previousLayoutCache = this.zoomLayoutCache;
        this.zoomLayoutCache = new Map([[pageNumber, layout]]);
        let painted = false;
        try {
          painted = this.renderPage(pageNumber, this.zoomSettleStats, reason);
        } finally {
          this.zoomLayoutCache = previousLayoutCache;
        }
        this.logZoomInkLayout(surface, "settle", layout, geometry);
        if (this.zoomProfile && tier === "focus" && painted) this.zoomProfile.hqUpgrades += 1;
        if (painted && !this.zoomSettlePaintedPages.has(pageNumber)) {
          this.zoomSettlePaintedPages.add(pageNumber);
          this.zoomSettleStats.pagesRepainted += 1;
        }
        else if (!painted && surface.viewportCullPending) {
          this.zoomSettleStats.skippedCulled += 1;
          paintPath = "culled";
        }
        if (paintPath !== "culled") {
          if (this.zoomSettleStats.skippedBlitOnly > blitBefore) paintPath = "blit-only";
          else if (surface.settleUpgradePending && (tier === "focus-fast" || tier === "neighbor")) {
            paintPath = "blit-stretch";
          } else if (this.zoomSettleStats.strokesRedrawn > strokesBefore) {
            paintPath = "canonical-vector";
          } else if (painted) {
            paintPath = upgradeBefore && !surface.settleUpgradePending ? "canonical-vector" : "blit-stretch";
          }
        }
      }
    }
    const durationMs = performance.now() - started;
    if (paintPath === "canonical-vector") {
      this.zoomPipelineTrace.noteStage("canonical-paint", durationMs, 1, "canonical-paint");
    } else if (paintPath === "blit-stretch") {
      this.zoomPipelineTrace.noteStage("ink-blit", durationMs, 1, "settle-blit");
    }
    this.zoomPipelineTrace.noteStage("page-maintenance", durationMs, 1, "settle-page");
    this.zoomPipelineTrace.noteStage("router-maintenance", 0, 1, "settle-router");
    const canvasResizeCount = this.zoomSettleStats.canvasesResized - resizedBefore;
    if (canvasResizeCount > 0) {
      this.zoomPipelineTrace.noteStage("canvas-resize", 0, canvasResizeCount, "canvas-resize");
    }
    this.logger.zoomComposite("settle-slice", {
      page: pageNumber,
      tier,
      path: paintPath,
      durationMs: roundMs(durationMs),
      remaining: this.zoomSettleQueue.length,
      pagesRepainted: this.zoomSettleStats.pagesRepainted,
      strokesRedrawn: this.zoomSettleStats.strokesRedrawn - strokesBefore,
      canvasesResized: canvasResizeCount,
      skippedBlitOnly: this.zoomSettleStats.skippedBlitOnly - blitBefore
    });
    this.recordZoomProfileTask(started);
  }

  private finishZoomSettleSlices(): void {
    const burst = this.zoomSettleBurst;
    const stats = this.zoomSettleStats;
    const durationMs = roundMs(performance.now() - this.zoomSettleSliceStartedAt);
    const toolbarStartedAt = performance.now();
    this.ensureSelectionToolbar();
    this.zoomPipelineTrace.noteStage("toolbar-refresh", performance.now() - toolbarStartedAt, 1, "selection-toolbar");
    const cursorStartedAt = performance.now();
    this.refreshZoomWorkingSurfaceCursors();
    this.zoomPipelineTrace.noteStage("cursor-refresh", performance.now() - cursorStartedAt, 1, "settle-cursor-refresh");
    const view = this.options.adapter.getViewState();
    if (durationMs >= this.frameTimingProfile().lateFrameThresholdMs && this.isZoomHandoffActive()) {
      this.logger.zoomFlashProxy("paint-duration-spike", {
        reason: burst?.reason ?? this.zoomBurstReason,
        durationMs,
        pagesRepainted: stats.pagesRepainted,
        strokesRedrawn: stats.strokesRedrawn,
        canvasesResized: stats.canvasesResized,
        skippedCulled: stats.skippedCulled,
        skippedBlitOnly: stats.skippedBlitOnly,
        sliced: true
      });
    }
    this.logger.zoomRepaint({
      reason: burst?.reason ?? this.zoomBurstReason,
      durationMs,
      pagesRepainted: stats.pagesRepainted,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      skippedCulled: stats.skippedCulled,
      skippedBlitOnly: stats.skippedBlitOnly,
      scale: Number(view.scale.toFixed(4)),
      frameBudgetMs: this.frameTimingProfile().frameBudgetMs,
      sliced: true,
      ...(burst ? {
        burstTicks: burst.burstTicks,
        burstDurationMs: burst.burstDurationMs,
        ...(burst.scaleStart !== undefined ? { scaleStart: burst.scaleStart } : {}),
        ...(burst.scaleEnd !== undefined ? { scaleEnd: burst.scaleEnd } : {})
      } : {})
    });
    this.reportDevProbe("zoom-repaint", {
      reason: burst?.reason ?? this.zoomBurstReason,
      durationMs,
      pagesRepainted: stats.pagesRepainted,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      skippedCulled: stats.skippedCulled,
      skippedBlitOnly: stats.skippedBlitOnly,
      scale: Number(view.scale.toFixed(4)),
      sliced: true
    });
    this.finishZoomProfile();
    this.zoomSettleBurst = null;
    this.releaseZoomCompositeAfterNativeRender();
  }

  private cancelZoomSettleSlice(): void {
    if (this.zoomSettleSliceFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.zoomSettleSliceFrame);
      this.zoomSettleSliceFrame = null;
    }
    this.zoomSettleQueue = [];
    this.zoomSettleBurst = null;
  }

  private static isZoomRepaintSource(source: ViewStateSource): boolean {
    return source === "scalechanging" || source === "data-scale" || source === "rotationchanging";
  }

  private static shouldCompositeDuring(reason: string): boolean {
    return reason.includes("scalechanging")
      || reason.includes("data-scale")
      || reason.includes("rotationchanging")
      || reason.includes("rotation");
  }

  private static isZoomPaintReason(reason: string): boolean {
    return ViewerInkSession.shouldCompositeDuring(reason)
      || reason.includes("resize")
      || reason.includes("zoom");
  }

  /** Reopen a short compositor handoff for a redraw that arrives just after release. */
  private holdLateNativeContent(): void {
    const now = performance.now();
    if (this.isZoomHandoffActive()) {
      this.zoomHandoffNeedsFinalRebase = true;
      return;
    }
    if (this.lastZoomHandoffSettledAt <= 0
      || now - this.lastZoomHandoffSettledAt >= ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS) return;
    this.beginZoomCompositing();
    this.endZoomCompositing();
    this.zoomCompositeSettledAt = now;
    this.lastZoomHandoffSettledAt = now;
    this.zoomHandoffNeedsFinalRebase = true;
  }

  private beginZoomCompositing(): void {
    this.cancelZoomCompositeRelease();
    this.cancelZoomSettleSlice();
    this.zoomCompositeSettledAt = 0;
    this.zoomNativeContentMutations = 0;
    this.lastZoomNativeContentAt = 0;
    this.zoomHandoffNeedsFinalRebase = false;
    this.zoomMaintenanceDeferredForInput = false;
    this.zoomCompositing = true;
    const started = performance.now();
    // The layout pass admits only the current visible working set. Pages that
    // stay outside the validated idle margin remain deferred for the existing
    // post-handoff viewport painter.
    this.syncZoomOverlayLayouts();
    this.recordZoomProfileTask(started, "compositor");
    this.logger.zoomComposite("begin", { pages: this.zoomActivePageCount });
  }

  private endZoomCompositing(): void {
    this.zoomCompositing = false;
    // Do not drain HQ upgrades here — CSS handoff still holds the overlay.
    // releaseZoomCompositeLayers() drains after the compositing class is removed.
  }

  /** True while burst paint is frozen OR CSS handoff has not released yet. */
  private isZoomHandoffActive(): boolean {
    if (this.zoomCompositing) return true;
    if (this.zoomCompositeReleaseTimer !== null || this.zoomCompositeReleaseFrame !== null) return true;
    for (const surface of this.surfaces.values()) {
      if (surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) return true;
    }
    return false;
  }

  private finishZoomNativeHandoffTrace(): void {
    const summary = this.zoomNativeHandoffTrace.finish();
    if (summary) this.lastZoomNativeHandoffSummary = summary;
  }

  private nativeHandoffPhase(): NativeHandoffPhase {
    if (this.zoomCompositing) return "active-pinch";
    if (this.isZoomHandoffActive()) return "handoff";
    return "settled";
  }

  private hasZoomCompositingClass(): boolean {
    for (const surface of this.surfaces.values()) {
      if (surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) return true;
    }
    return false;
  }

  /**
   * PDF.js asynchronously replaces its canvas/text layers after scalechanging.
   * Keep our already-positioned layer over that native transition, then release
   * on the first stable frame whose input, native-content, and ink dependencies
   * are all satisfied. A bounded retry remains the fallback for missing signals.
   */
  private zoomReleaseGate(now: number, stableRafReady = false): ZoomReleaseGate {
    const cleanup = this.pinchCleanup.evaluate(now, PINCH_CLEANUP_MAX_WAIT_MS);
    const handoff = this.zoomNativeHandoffTrace.summary();
    const renderSignals = [
      handoff?.signals.canvasReplacement,
      handoff?.signals.pagerendered
    ].filter((signal): signal is NonNullable<typeof signal> => Boolean(signal));
    const nativeRenderSignalCount = renderSignals.reduce((count, signal) => count + signal.count, 0);
    const nativeRenderSignalAt = renderSignals.reduce<number | null>(
      (latest, signal) => signal.lastAt === null ? latest : Math.max(latest ?? signal.lastAt, signal.lastAt),
      null
    );
    const timeoutReached = this.zoomCompositeSettledAt > 0
      && now - this.zoomCompositeSettledAt >= ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS;
    const nativeRenderSignalReady = nativeRenderSignalCount > 0 || timeoutReached;
    const nativeContentQuiet = this.lastZoomNativeContentAt === 0
      || now - this.lastZoomNativeContentAt >= ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS;
    const replacementReady = this.replacementInkReady();
    const inputTerminalsReady = cleanup.quiescent;
    return {
      inputTerminalsReady,
      inputTerminalTimedOut: cleanup.gestureCleanupTimedOut,
      nativeRenderSignalReady,
      nativeRenderSignalCount,
      nativeRenderSignalAt,
      nativeContentQuiet,
      replacementInkReady: replacementReady,
      stableRafReady,
      timeoutReached,
      ready: inputTerminalsReady
        && nativeRenderSignalReady
        && nativeContentQuiet
        && replacementReady
        && stableRafReady
    };
  }

  private zoomReleaseGateDelayMs(now: number, gate: ZoomReleaseGate): number {
    if (gate.ready) return 0;
    let nextAt = now + ViewerInkSession.ZOOM_RELEASE_GATE_RETRY_MS;
    if (!gate.nativeRenderSignalReady && this.zoomCompositeSettledAt > 0) {
      nextAt = Math.min(
        nextAt,
        this.zoomCompositeSettledAt + ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS
      );
    }
    if (!gate.nativeContentQuiet && this.lastZoomNativeContentAt > 0) {
      nextAt = Math.min(
        nextAt,
        this.lastZoomNativeContentAt + ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS
      );
    }
    return Math.max(0, nextAt - now);
  }

  private releaseZoomCompositeAfterNativeRender(): void {
    if (this.destroyed) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    this.cancelZoomCompositeRelease();
    const now = performance.now();
    const gate = this.zoomReleaseGate(now);
    const delayMs = this.zoomReleaseGateDelayMs(now, gate);
    this.logger.zoomComposite("release-scheduled", {
      pages: this.surfaces.size,
      delayMs: roundMs(delayMs),
      nativeContentMutations: this.zoomNativeContentMutations,
      sinceSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null,
      inputTerminalsReady: gate.inputTerminalsReady,
      inputTerminalTimedOut: gate.inputTerminalTimedOut,
      nativeRenderSignalReady: gate.nativeRenderSignalReady,
      nativeRenderSignalCount: gate.nativeRenderSignalCount,
      nativeRenderSignalAt: gate.nativeRenderSignalAt,
      nativeContentQuiet: gate.nativeContentQuiet,
      replacementInkReady: gate.replacementInkReady,
      stableRafReady: gate.stableRafReady,
      timeoutReached: gate.timeoutReached,
      gateReadyBeforeStableRaf: gate.ready
    });
    if (!view) {
      this.rebaseZoomAfterNativeRender();
      const fallbackGate = this.zoomReleaseGate(performance.now(), true);
      if (fallbackGate.ready) this.releaseZoomCompositeLayers();
      return;
    }
    this.zoomCompositeReleaseTimer = window.setTimeout(() => {
      this.zoomCompositeReleaseTimer = null;
      if (this.destroyed || this.zoomCompositing) return;
      this.zoomCompositeReleaseFrame = view.requestAnimationFrame(() => {
        this.zoomCompositeReleaseFrame = null;
        if (this.destroyed || this.zoomCompositing) return;
        this.rebaseZoomAfterNativeRender();
        const stableAt = performance.now();
        const stableGate = this.zoomReleaseGate(stableAt, true);
        this.zoomNativeHandoffTrace.noteStableRaf({
          at: stableAt,
          compositorHeld: !stableGate.ready,
          phase: this.nativeHandoffPhase()
        });
        this.logger.zoomComposite("release-scheduled", {
          pages: this.surfaces.size,
          delayMs: 0,
          nativeContentMutations: this.zoomNativeContentMutations,
          sinceSettleMs: this.zoomCompositeSettledAt > 0
            ? roundMs(stableAt - this.zoomCompositeSettledAt)
            : null,
          inputTerminalsReady: stableGate.inputTerminalsReady,
          inputTerminalTimedOut: stableGate.inputTerminalTimedOut,
          nativeRenderSignalReady: stableGate.nativeRenderSignalReady,
          nativeRenderSignalCount: stableGate.nativeRenderSignalCount,
          nativeRenderSignalAt: stableGate.nativeRenderSignalAt,
          nativeContentQuiet: stableGate.nativeContentQuiet,
          replacementInkReady: stableGate.replacementInkReady,
          stableRafReady: true,
          timeoutReached: stableGate.timeoutReached,
          gateReadyBeforeStableRaf: stableGate.ready
        });
        if (!stableGate.ready) {
          this.releaseZoomCompositeAfterNativeRender();
          return;
        }
        this.releaseZoomCompositeLayers();
      });
    }, delayMs);
  }

  private currentAdapterViewerGeneration(): number {
    if (!("viewerGeneration" in this.options.adapter)) return 0;
    const generation = this.options.adapter.viewerGeneration;
    return typeof generation === "number" && Number.isFinite(generation) ? generation : 0;
  }

  private queueNativeHandoffUpdate(input:
    | { kind: "mutation"; change: AnnotationPageContentMutation }
    | { kind: "lifecycle"; change: AnnotationPageLifecycleChange }
    | { kind: "resize"; signalAt: number; viewerGeneration: number }
  ): void {
    if (this.destroyed) return;
    const viewerGeneration = input.kind === "mutation" || input.kind === "lifecycle"
      ? input.change.viewerGeneration
      : input.viewerGeneration;
    if ("viewerGeneration" in this.options.adapter
      && viewerGeneration !== this.currentAdapterViewerGeneration()) return;

    if (this.pendingNativeHandoffUpdate?.viewerGeneration !== undefined
      && this.pendingNativeHandoffUpdate.viewerGeneration !== viewerGeneration) {
      this.nativeHandoffUpdateToken += 1;
      if (this.nativeHandoffUpdateFrame !== null) {
        this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.nativeHandoffUpdateFrame);
        this.nativeHandoffUpdateFrame = null;
      }
      this.pendingNativeHandoffUpdate = null;
    }
    const pending = this.pendingNativeHandoffUpdate ?? {
      viewerGeneration,
      mutation: null,
      lifecycle: null,
      resizeSignalAt: null
    };
    this.pendingNativeHandoffUpdate = pending;

    if (input.kind === "mutation") {
      const previous = pending.mutation;
      const pageNumbers = new Set([...(previous?.pageNumbers ?? []), ...input.change.pageNumbers]);
      pending.mutation = {
        ...input.change,
        recordCount: (previous?.recordCount ?? 0) + input.change.recordCount,
        pageNumbers: [...pageNumbers].sort((left, right) => left - right).slice(0, 64),
        mountGenerations: { ...(previous?.mountGenerations ?? {}), ...input.change.mountGenerations },
        firstSignalAt: Math.min(previous?.firstSignalAt ?? input.change.firstSignalAt, input.change.firstSignalAt),
        lastSignalAt: Math.max(previous?.lastSignalAt ?? input.change.lastSignalAt, input.change.lastSignalAt)
      };
    } else if (input.kind === "lifecycle") {
      pending.lifecycle = input.change;
    } else {
      pending.resizeSignalAt = input.signalAt;
    }

    const pageNumbers = input.kind === "mutation"
      ? input.change.pageNumbers
      : input.kind === "lifecycle" ? input.change.pageNumbers : undefined;
    if (input.kind !== "resize" && this.nativeHandoffNeedsImmediateRecovery(pageNumbers)) {
      this.flushNativeHandoffUpdate();
      return;
    }
    this.scheduleNativeHandoffUpdate();
  }

  private nativeHandoffNeedsImmediateRecovery(pageNumbers?: number[]): boolean {
    const filter = pageNumbers?.length ? new Set(pageNumbers) : null;
    const pages = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      if (filter && !filter.has(pageNumber)) continue;
      const page = pages.get(pageNumber);
      if (!page?.element.isConnected) continue;
      if (!surface.overlay.isConnected || surface.page.element !== page.element) return true;
    }
    return false;
  }

  private scheduleNativeHandoffUpdate(): void {
    if (this.destroyed || this.nativeHandoffUpdateFrame !== null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.flushNativeHandoffUpdate();
      return;
    }
    const token = this.nativeHandoffUpdateToken;
    let frame = 0;
    frame = view.requestAnimationFrame(() => {
      if (this.nativeHandoffUpdateFrame !== frame || token !== this.nativeHandoffUpdateToken) return;
      this.nativeHandoffUpdateFrame = null;
      const pending = this.pendingNativeHandoffUpdate;
      this.pendingNativeHandoffUpdate = null;
      if (!pending || this.destroyed) return;
      this.processNativeHandoffUpdate(pending);
    });
    this.nativeHandoffUpdateFrame = frame;
  }

  private flushNativeHandoffUpdate(): void {
    const pending = this.pendingNativeHandoffUpdate;
    if (!pending) return;
    this.pendingNativeHandoffUpdate = null;
    this.nativeHandoffUpdateToken += 1;
    if (this.nativeHandoffUpdateFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.nativeHandoffUpdateFrame);
      this.nativeHandoffUpdateFrame = null;
    }
    this.processNativeHandoffUpdate(pending);
  }

  private processNativeHandoffUpdate(update: PendingNativeHandoffUpdate): void {
    if (this.destroyed) return;
    if ("viewerGeneration" in this.options.adapter
      && update.viewerGeneration !== this.currentAdapterViewerGeneration()) return;
    const callbackStartedAt = performance.now();
    const lifecycle = update.lifecycle;
    if (lifecycle?.kind === "viewer-replaced") {
      this.onPagesChanged("viewer-replaced");
      return;
    }
    if (lifecycle?.kind === "render") {
      this.zoomNativeHandoffTrace.noteSignal({
        name: "pagerendered",
        signalAt: lifecycle.signalAt ?? callbackStartedAt,
        callbackAt: callbackStartedAt,
        callbackWorkMs: performance.now() - callbackStartedAt,
        pageNumbers: lifecycle.pageNumbers,
        viewerGeneration: lifecycle.viewerGeneration,
        mountGenerations: lifecycle.mountGenerations,
        phase: this.nativeHandoffPhase()
      });
    }
    const mutationResult = update.mutation
      ? this.processPdfPageContentMutation(update.mutation)
      : { handled: false, reattached: false };
    const hasMutation = update.mutation !== null;
    if (lifecycle) {
      this.onPagesChanged(
        `page-${lifecycle.kind}`,
        hasMutation && mutationResult.handled ? { deferSurfaceUpdate: true } : undefined
      );
    }
    if (update.resizeSignalAt !== null && !lifecycle && !mutationResult.handled) {
      this.processRootResize();
    }
  }

  /** Adapter breadcrumb for the native PDF.js canvas/text layer replacement. */
  onPdfPageContentMutation(change: number | AnnotationPageContentMutation): void {
    if (this.destroyed) return;
    const signalAt = performance.now();
    const normalized: AnnotationPageContentMutation = typeof change === "number"
      ? {
        recordCount: change,
        pageNumbers: this.options.adapter.pages().map((page) => page.pageNumber).slice(0, 64),
        viewerGeneration: this.currentAdapterViewerGeneration(),
        mountGenerations: {},
        firstSignalAt: signalAt,
        lastSignalAt: signalAt
      }
      : change;
    for (const surface of this.surfaces.values()) this.observeMobileCustomPinch(surface, "mutation");
    this.holdLateNativeContent();
    this.queueNativeHandoffUpdate({ kind: "mutation", change: normalized });
  }

  private processPdfPageContentMutation(change: AnnotationPageContentMutation): NativeHandoffMutationResult {
    if (this.destroyed) return { handled: false, reattached: false };
    const callbackStartedAt = performance.now();
    const recordCount = change.recordCount;
    const pageNumbers = change.pageNumbers;
    const viewerGeneration = change.viewerGeneration;
    const mountGenerations = change.mountGenerations;
    const firstSignalAt = change.firstSignalAt;
    const lastSignalAt = change.lastSignalAt;
    const noteNativeReplacementTrace = (): void => {
      const callbackWorkMs = performance.now() - callbackStartedAt;
      this.zoomNativeHandoffTrace.noteSignal({
        name: "canvasReplacement",
        signalAt: firstSignalAt,
        callbackAt: callbackStartedAt,
        pageNumbers,
        viewerGeneration,
        mountGenerations,
        replacementRecordCount: recordCount,
        phase: this.nativeHandoffPhase()
      });
      this.zoomNativeHandoffTrace.noteSignal({
        name: "mutationObserver",
        signalAt: lastSignalAt,
        callbackAt: callbackStartedAt,
        callbackWorkMs,
        pageNumbers,
        viewerGeneration,
        mountGenerations,
        phase: this.nativeHandoffPhase()
      });
    };
    this.zoomPipelineTrace.noteEvent("mutation-observer");
    this.zoomPipelineTrace.noteStage("mutation-observer", 0, 1, "mutation-observer");
    this.zoomPipelineTrace.noteStage("pdfjs-callback", 0, 1, "canvas-replacement");
    this.zoomPipelineTrace.noteStage("page-maintenance", 0, Math.max(1, recordCount), "page-content-mutation");
    this.zoomFrameDiagnostics.noteObserverSignal("mutationObserver");
    this.zoomFrameDiagnostics.notePdfSignal("canvasReplacement");
    for (const surface of this.surfaces.values()) {
      if (surface.strokePerformance) surface.strokePerformance.mutationRefreshes += 1;
    }
    const pages = this.options.adapter.pages();
    const pagesMap = new Map(pages.map((p) => [p.pageNumber, p]));
    this.notePageMutationShieldNativeContent(recordCount, pages.length);
    const detachedOverlayPages = [...this.surfaces.entries()]
      .filter(([pageNumber, surface]) => {
        const page = pagesMap.get(pageNumber);
        return !surface.overlay.isConnected && page && page.element.isConnected;
      })
      .map(([pageNumber]) => pageNumber);
    // Pinch zoom can replace the live `.page` while the predecessor + overlay
    // stay connected. Remount before PointerRouter is left listening on a shell
    // that no longer receives canvas hits.
    const driftedPageElements = [...this.surfaces.entries()]
      .filter(([pageNumber, surface]) => {
        const live = pagesMap.get(pageNumber);
        return Boolean(live && live.element !== surface.page.element && live.element.isConnected);
      })
      .map(([pageNumber]) => pageNumber);
    if (detachedOverlayPages.length > 0) {
      this.logger.zoomFlashProxy("overlay-disconnected", {
        pages: detachedOverlayPages,
        zoomCompositing: this.zoomCompositing,
        handoff: this.isZoomHandoffActive()
      });
    }
    if (driftedPageElements.length > 0) {
      this.logger.zoomFlashProxy("page-element-drifted", {
        pages: driftedPageElements,
        zoomCompositing: this.zoomCompositing,
        handoff: this.isZoomHandoffActive()
      });
    }
    const needsReattach = detachedOverlayPages.length > 0 || driftedPageElements.length > 0;
    const reattachCandidates = [...new Set([...detachedOverlayPages, ...driftedPageElements])];
    const reattached = needsReattach && this.tryReattachDisconnectedSurfaces(pages);
    const reattachedOverlayPages = reattached
      ? reattachCandidates.filter((pageNumber) => {
        const surface = this.surfaces.get(pageNumber);
        const live = pagesMap.get(pageNumber);
        return Boolean(
          surface
          && live
          && surface.page.element === live.element
          && surface.overlay.isConnected
          && live.element.contains(surface.overlay)
        );
      })
      : [];
    // Release timer is only armed after finishZoomSettleSlices. While focus-fast
    // has painted and HQ/neighbor slices are still draining under the CSS mask,
    // treat that window like handoff so native remounts stay layout-only.
    const settleSlicesPending = this.zoomSettleSliceFrame !== null || this.zoomSettleQueue.length > 0;
    let releasePending = this.zoomCompositing
      || this.zoomCompositeReleaseTimer !== null
      || this.zoomCompositeReleaseFrame !== null
      || this.zoomHandoffNeedsFinalRebase;
    let handoffGuard = releasePending || settleSlicesPending || this.hasZoomCompositingClass();
    const now = performance.now();
    // PDF.js can publish its final canvas after the bounded release gate. Reopen
    // only this recent post-settle window so the late redraw gets one canonical
    // rebase under the same compositor mask instead of a second zoom burst.
    const recentSettle = this.zoomCompositeSettledAt > 0
      && now - this.zoomCompositeSettledAt < ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS;
    if (!handoffGuard && !reattached && recentSettle) {
      this.beginZoomCompositing();
      this.endZoomCompositing();
      this.zoomCompositeSettledAt = now;
      this.lastZoomHandoffSettledAt = now;
      this.zoomHandoffNeedsFinalRebase = true;
      releasePending = true;
      handoffGuard = true;
    }
    this.reportDevProbe("host-page-content-mutation", {
      records: recordCount,
      releasePending,
      settleSlicesPending,
      zoomCompositing: this.zoomCompositing,
      handoff: this.isZoomHandoffActive(),
      pageCount: pages.length,
      detachedOverlays: detachedOverlayPages.length,
      reattachedOverlays: reattachedOverlayPages.length
    });

    // A native redraw can remove our overlay even after the compositor's
    // handoff. Recover that rare case without treating every canvas/text-layer
    // update as a page remount (which was the source of zoom flashing).
    if (!handoffGuard && !reattached) {
      noteNativeReplacementTrace();
      return { handled: false, reattached: false };
    }
    if (releasePending || settleSlicesPending) {
      this.zoomNativeContentMutations += recordCount;
      this.lastZoomNativeContentAt = now;
    }
    this.logger.zoomComposite("native-content", {
      records: recordCount,
      nativeContentMutations: this.zoomNativeContentMutations,
      releasePending,
      settleSlicesPending,
      pageCount: pages.length,
      detachedOverlayPages,
      reattachedOverlayPages,
      sinceSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null
    });

    const handoffHandled = handoffGuard && this.isZoomHandoffActive();
    if (handoffHandled) {
      // PDF.js may finish canvas/text replacement after the first zoom settle.
      // Follow that geometry immediately, but reserve the one canonical redraw
      // for the quiet handoff boundary instead of beginning another zoom burst.
      this.syncZoomOverlayLayouts("native-content");
      if (!this.zoomCompositing) this.zoomHandoffNeedsFinalRebase = true;
      if (reattached) {
        this.logger.zoomFlashProxy("reattach-layout-only", {
          reattachedOverlayPages,
          skippedRepaint: true
        });
      }
    } else if (reattached) {
      this.repaintSurfaces("native-content-reattach");
    }
    // Only arm release after settle slices finished (releasePending from finish).
    if (releasePending && !this.zoomCompositing) this.releaseZoomCompositeAfterNativeRender();
    noteNativeReplacementTrace();
    return { handled: handoffHandled || reattached, reattached };
  }

  /**
   * `pages-settled` is emitted when page nodes return, before PDF.js finishes
   * painting their canvases. Track its later canvas/text-layer work so the
   * source-PDF shield cannot reveal that white intermediate frame.
   */
  private notePageMutationShieldNativeContent(recordCount: number, pageCount: number): void {
    const shield = this.pageMutationShield;
    if (!shield) return;
    this.pageMutationShieldNativeContentMutations += recordCount;
    this.lastPageMutationShieldNativeContentAt = performance.now();
    this.logger.pdfPageAction("page-shield-native-content", {
      action: shield.action,
      pageNumber: shield.pageNumber,
      records: recordCount,
      nativeContentMutations: this.pageMutationShieldNativeContentMutations,
      pageCount,
      sinceSettleMs: this.pageMutationShieldSettledAt > 0
        ? roundMs(this.lastPageMutationShieldNativeContentAt - this.pageMutationShieldSettledAt)
        : null
    });
    if (this.pageMutationShieldSettledAt > 0) this.schedulePageMutationShieldRelease();
  }

  private releaseZoomCompositeLayers(): void {
    const nativeContentQuiet = this.lastZoomNativeContentAt === 0
      || performance.now() - this.lastZoomNativeContentAt >= ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS;
    if (!nativeContentQuiet && !this.destroyed) {
      this.logger.zoomComposite("release-scheduled", {
        pages: this.surfaces.size,
        delayMs: ViewerInkSession.ZOOM_RELEASE_GATE_RETRY_MS,
        nativeContentMutations: this.zoomNativeContentMutations,
        releaseBlocked: "native-content-mutating"
      });
      this.releaseZoomCompositeAfterNativeRender();
      return;
    }
    this.recordInkVisibility("before-final-canonical");
    this.rebaseZoomAfterNativeRender();
    // Native scale correction can publish a scroll/pagechanging signal while
    // the handoff is still masked. Reconcile only when the mobile mount set
    // actually changed, and do that work under the compositor so it cannot
    // become a second visible refresh after the overlay is removed.
    this.flushPendingMobileScrollRemount();
    this.recordInkVisibility("after-final-canonical");
    if (!this.replacementInkReady(true) && !this.destroyed) {
      this.logger.zoomComposite("release-scheduled", {
        pages: this.surfaces.size,
        delayMs: ViewerInkSession.ZOOM_RELEASE_GATE_RETRY_MS,
        nativeContentMutations: this.zoomNativeContentMutations,
        sinceSettleMs: this.zoomCompositeSettledAt > 0
          ? roundMs(performance.now() - this.zoomCompositeSettledAt)
          : null,
        replacementInkReady: false,
        releaseBlocked: "replacement-ink-unavailable"
      });
      if (this.options.adapter.host.ownerDocument.defaultView) this.releaseZoomCompositeAfterNativeRender();
      return;
    }
    this.recordInkVisibility("before-composite-release");
    const now = performance.now();
    for (const surface of this.surfaces.values()) {
      surface.overlay.classList.remove("native-pdf-handwriting-zoom-compositing");
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (view) {
      view.requestAnimationFrame(() => {
        this.zoomNativeHandoffTrace.noteStableRaf({
          at: performance.now(),
          compositorHeld: this.isZoomHandoffActive(),
          phase: this.nativeHandoffPhase()
        });
        this.recordInkVisibility("post-composite-release-frame-1");
        view.requestAnimationFrame(() => {
          this.zoomNativeHandoffTrace.noteStableRaf({
            at: performance.now(),
            compositorHeld: this.isZoomHandoffActive(),
            phase: this.nativeHandoffPhase()
          });
          this.recordInkVisibility("post-composite-release-frame-2");
          this.finishZoomNativeHandoffTrace();
        });
      });
    } else {
      this.finishZoomNativeHandoffTrace();
    }
    const heldAfterSettleMs = this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null;
    this.logger.zoomComposite("release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs
    });
    this.postZoomTrace.remember("zoom-release", {
      pages: this.surfaces.size,
      heldAfterSettleMs
    });
    this.logger.zoomLifecycle("zoom-burst-release", {
      zoomBurstId: this.postZoomTrace.currentBurstId(),
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs,
      routerGenerations: this.currentRouterGenerations()
    });
    this.reportDevProbe("zoom-composite-release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null
    });
    this.zoomCompositeSettledAt = 0;
    this.zoomHandoffNeedsFinalRebase = false;
    this.lastZoomFrameAttributionSummary = this.zoomFrameDiagnostics.finish();
    // Strict settle may have deferred off-screen pages; idle-margin prefetch once handoff ends.
    this.scheduleViewportPaint();
  }

  /**
   * The retry loop runs every 32ms while PDF.js replaces page content. Do not
   * sample canvas pixels there: one getImageData call per sample multiplied by
   * 64 samples per mounted page can starve the pointer/rAF path. Geometry and
   * canonical-layer state are the cheap gate; the bounded pixel probe remains
   * at the actual release boundary below.
   */
  private replacementInkReady(requirePixelEvidence = false): boolean {
    const activePageNumber = this.options.adapter.getViewState().pageNumber;
    if (requirePixelEvidence) {
      const evidence: InkVisibilitySnapshot[] = [];
      for (const pageNumber of this.surfaces.keys()) {
        const snapshot = this.lastInkVisibilityByPage.get(pageNumber);
        if (!snapshot) return false;
        evidence.push(snapshot);
      }
      return replacementInkReadyForActivePages(evidence, activePageNumber);
    }
    for (const [pageNumber, surface] of this.surfaces) {
      const geometryUnavailable = !surface.overlay.isConnected
        || !surface.canvas.isConnected
        || surface.canvas.width <= 0
        || surface.canvas.height <= 0;
      if (geometryUnavailable && pageNumber !== activePageNumber) continue;
      if (geometryUnavailable) return false;
      if (
        this.ink.page(pageNumber).length > 0
        && (!surface.inkLayerValid || surface.inkLayerBurstCapture)
        && !surface.rasterFallbackReady
      ) return false;
    }
    return true;
  }

  private recordInkVisibility(phase: InkVisibilityPhase): void {
    for (const [pageNumber, surface] of this.surfaces) {
      const snapshot = this.inkVisibilitySnapshot(pageNumber, surface, phase);
      const previous = this.lastInkPixelByPage.has(pageNumber) ? this.lastInkPixelByPage.get(pageNumber)! : null;
      this.lastInkVisibilityByPage.set(pageNumber, snapshot);
      this.logger.inkVisibility({ ...snapshot, cause: inkVisibilityCause(snapshot) });
      const flash = inkVisibilityFlash({ previousHasInk: previous, current: snapshot });
      if (flash) {
        this.logger.inkVisibilityFlash({
          ...flash,
          zoomBurstId: this.postZoomTrace.currentBurstId(),
          viewerGeneration: this.viewerGeneration,
          pageMountGeneration: surface.page.mountGeneration,
          routerGeneration: surface.router?.generation ?? null
        });
      }
      if (snapshot.pixelProbeRan) this.lastInkPixelByPage.set(pageNumber, snapshot.pixelProbeHasInk);
    }
  }

  private inkVisibilitySnapshot(pageNumber: number, surface: PageSurface, phase: InkVisibilityPhase): InkVisibilitySnapshot {
    const canvas = surface.canvas;
    const styles = canvas.ownerDocument.defaultView?.getComputedStyle(surface.overlay);
    const probe = probeInkCanvas({
      width: canvas.width,
      height: canvas.height,
      readAlpha: (x, y) => {
        try {
          return surface.context.getImageData(x, y, 1, 1).data[3] ?? 0;
        } catch {
          return null;
        }
      }
    });
    const rect = surface.overlay.getBoundingClientRect();
    return {
      pageNumber,
      phase,
      modelStrokeCount: this.ink.page(pageNumber).length,
      overlayConnected: surface.overlay.isConnected,
      overlayDisplay: styles?.display || surface.overlay.style.display || "visible",
      overlayVisibility: styles?.visibility || surface.overlay.style.visibility || "visible",
      overlayOpacity: styles?.opacity || surface.overlay.style.opacity || "1",
      compositingClassPresent: surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing"),
      canvasConnected: canvas.isConnected,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canonicalPaintComplete: surface.inkLayerValid && !surface.inkLayerBurstCapture && !surface.rasterFallbackReady,
      canonicalPaintDeferred: surface.rasterFallbackReady,
      ...probe,
      overlayRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }

  private cancelZoomCompositeRelease(): void {
    if (this.zoomCompositeReleaseFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.zoomCompositeReleaseFrame);
      this.zoomCompositeReleaseFrame = null;
    }
    if (this.zoomCompositeReleaseTimer !== null) {
      window.clearTimeout(this.zoomCompositeReleaseTimer);
      this.zoomCompositeReleaseTimer = null;
    }
  }

  /** Align overlay boxes during zoom burst without paintCommittedStrokes. */
  private syncZoomOverlayLayouts(phase: "burst" | "native-content" = "burst"): ZoomOverlayLayoutTiming {
    const startedAt = performance.now();
    const phaseDurations: ZoomOverlayLayoutTiming["phaseDurations"] = {
      "page-snapshot": 0,
      "surface-reconcile": 0,
      "layout-read": 0,
      "geometry-read": 0,
      "overlay-write": 0,
      "text-layout": 0,
      "layout-diagnostic": 0,
      "cursor-refresh": 0
    };
    if (this.zoomProfile) this.zoomProfile.layoutSyncs += 1;
    const snapshotStartedAt = performance.now();
    const pages = this.options.adapter.pages();
    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
    phaseDurations["page-snapshot"] = performance.now() - snapshotStartedAt;
    const active: PageSurface[] = [];
    const rootRect = this.options.adapter.root.getBoundingClientRect();
    const working = this.zoomWorkingSurfaces(rootRect, byNumber);
    // Reconcile page nodes and routers before taking geometry reads. Reattach
    // used to read and write one page at a time, forcing layout between pages.
    const deferHealthyRouterMaintenance = this.deferZoomMaintenanceForInput("router-maintenance");
    const reconcileStartedAt = performance.now();
    for (const surface of working) {
      const pageNumber = surface.page.pageNumber;
      const current = byNumber.get(pageNumber);
      if (!current) continue;
      const routerHealthy = Boolean(
        surface.router
        && surface.router.isAlive()
        && surface.router.bindsTo(current.element)
        && !surface.router.isListenerAborted()
      );
      if (!this.reattachSurface(surface, current, false, !deferHealthyRouterMaintenance || !routerHealthy)) {
        // Page node replaced while the overlay stayed on the old node — move
        // both overlay and page-bound PointerRouter onto the live page.
        if (current.element.isConnected) {
          this.remountSurfaceOnPageReplacement(surface, current, false);
        } else {
          continue;
        }
      }
      if (!deferHealthyRouterMaintenance || !routerHealthy) this.ensurePageRouter(surface);
      active.push(surface);
    }
    this.zoomActivePageCount = active.length;
    this.zoomWorkingPageNumbers = new Set(active.map((surface) => surface.page.pageNumber));
    phaseDurations["surface-reconcile"] = performance.now() - reconcileStartedAt;

    // Read every page layout first, then apply all overlay/text writes using
    // that one-frame snapshot. This preserves the existing coordinates while
    // avoiding read-after-write reflows across mounted pages.
    const layoutReadStartedAt = performance.now();
    const layouts = new Map<number, PageCoordinateLayout>();
    for (const surface of active) layouts.set(surface.page.pageNumber, this.pageLayout(surface));
    phaseDurations["layout-read"] = performance.now() - layoutReadStartedAt;
    const geometryReadStartedAt = performance.now();
    const geometry = this.logger.isEnabled()
      ? this.readZoomGeometry(active)
      : { snapshots: new Map<number, ZoomGeometrySnapshot>(), readCount: 0 };
    phaseDurations["geometry-read"] = performance.now() - geometryReadStartedAt;
    this.recordZoomGeometry(geometry.snapshots, geometry.readCount);
    this.zoomLayoutCache = layouts;
    try {
      // Keep class/canvas handoff writes together before the overlay/text
      // writes. A page can enter the working set after the pinch starts.
      for (const surface of active) {
        if (!surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) {
          this.captureInkLayerFromCanvas(surface, layouts.get(surface.page.pageNumber));
        }
        surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
      }
      for (const surface of active) {
        const layout = layouts.get(surface.page.pageNumber);
        const overlayWriteStartedAt = performance.now();
        this.syncOverlayLayout(surface, layout);
        phaseDurations["overlay-write"] += performance.now() - overlayWriteStartedAt;
        const textLayoutStartedAt = performance.now();
        this.syncTextLayoutDuringZoom(surface, layout);
        phaseDurations["text-layout"] += performance.now() - textLayoutStartedAt;
        const layoutDiagnosticStartedAt = performance.now();
        this.logZoomInkLayout(surface, phase, layout, geometry.snapshots.get(surface.page.pageNumber));
        phaseDurations["layout-diagnostic"] += performance.now() - layoutDiagnosticStartedAt;
      }
      // Keep the same layout snapshot alive while cursor projection runs so a
      // late cursor refresh cannot resolve page geometry again after writes.
      if (!this.isZoomGestureActive() && !this.deferZoomMaintenanceForInput("cursor-refresh")) {
        const cursorRefreshStartedAt = performance.now();
        this.refreshSurfaceCursors(active);
        phaseDurations["cursor-refresh"] = performance.now() - cursorRefreshStartedAt;
      }
    } finally {
      this.zoomLayoutCache = null;
    }
    return {
      totalMs: roundMs(performance.now() - startedAt),
      geometryReads: geometry.readCount,
      geometryReadAfterWrite: 0,
      phaseDurations: Object.fromEntries(
        Object.entries(phaseDurations).map(([name, durationMs]) => [name, roundMs(durationMs)])
      ) as ZoomOverlayLayoutTiming["phaseDurations"]
    };
  }

  /**
   * A delayed PDF.js render often adjusts the page by a few pixels. Rebuild
   * once after its quiet window, while the compositor layer still masks the
   * handoff; never start a second settle-timer resize-driven zoom cycle.
   */
  private rebaseZoomAfterNativeRender(): void {
    if (this.destroyed || !this.zoomHandoffNeedsFinalRebase) return;
    this.zoomHandoffNeedsFinalRebase = false;
    const started = performance.now();
    const stats = {
      pagesRepainted: 0,
      deferredCanonicalPages: 0,
      canvasesResized: 0,
      strokesRedrawn: 0,
      skippedDisconnected: 0,
      skippedCulled: 0,
      skippedBlitOnly: 0
    };
    const pages = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    const working = this.zoomWorkingSurfaces(undefined, pages);
    this.zoomActivePageCount = working.length;
    this.zoomWorkingPageNumbers = new Set(working.map((surface) => surface.page.pageNumber));
    const reconciled: PageSurface[] = [];
    for (const surface of working) {
      const pageNumber = surface.page.pageNumber;
      const current = pages.get(pageNumber);
      if (!current) {
        stats.skippedDisconnected += 1;
        continue;
      }
      if (!this.reattachSurface(surface, current, false)) {
        if (current.element.isConnected) {
          this.remountSurfaceOnPageReplacement(surface, current, false);
        } else {
          stats.skippedDisconnected += 1;
          continue;
        }
      }
      this.ensurePageRouter(surface, {
        reason: this.surfaceHasLiveInkInput(surface) ? "zoom-handoff-final-live-ink" : "zoom-handoff-final"
      });
      reconciled.push(surface);
    }
    const layouts = new Map<number, PageCoordinateLayout>();
    for (const surface of reconciled) layouts.set(surface.page.pageNumber, this.pageLayout(surface));
    const geometry = this.logger.isEnabled()
      ? this.readZoomGeometry(reconciled)
      : { snapshots: new Map<number, ZoomGeometrySnapshot>(), readCount: 0 };
    if (this.zoomProfile) this.zoomProfile.geometryReadCount += geometry.readCount;
    const previousLayoutCache = this.zoomLayoutCache;
    this.zoomLayoutCache = layouts;
    try {
      for (const surface of reconciled) {
        const pageNumber = surface.page.pageNumber;
        // A dense page can keep the already-captured committed raster visible
        // while the final PDF-space vector rebase is queued after handoff.
        // This avoids blocking release on a multi-second HQ repaint.
        const preserveExistingDeferredRaster = this.ink.page(pageNumber).length >= ViewerInkSession.DEFERRED_CANONICAL_CHUNK_STROKES
          && surface.rasterFallbackReady
          && surface.settleUpgradePending
          && surface.canvas.width > 0
          && surface.canvas.height > 0;
        if (preserveExistingDeferredRaster) {
          stats.deferredCanonicalPages += 1;
          this.logZoomInkLayout(surface, "handoff-final", layouts.get(pageNumber), geometry.snapshots.get(pageNumber));
          continue;
        }
        const canDeferDenseRebase = this.ink.page(pageNumber).length >= ViewerInkSession.LARGE_ZOOM_RASTER_FALLBACK_STROKES
          && surface.inkLayerValid
          && !surface.inkLayerBurstCapture
          && surface.inkLayer !== null
          && surface.inkLayer.width > 0
          && surface.inkLayer.width === surface.canvas.width
          && surface.inkLayer.height === surface.canvas.height;
        if (canDeferDenseRebase) {
          const fallbackLayout = layouts.get(pageNumber) ?? this.pageLayout(surface);
          const fallbackWidth = Math.max(1, fallbackLayout.contentWidth || 1);
          const fallbackHeight = Math.max(1, fallbackLayout.contentHeight || 1);
          const { backingScale: fallbackBackingScale } = this.resolveInkBacking(fallbackWidth, fallbackHeight);
          const fallbackBlitStartedAt = performance.now();
          this.blitInkLayerToCanvas(surface, surface.canvas.width, surface.canvas.height, fallbackBackingScale);
          const fallbackBlitDurationMs = roundMetric(performance.now() - fallbackBlitStartedAt);
          surface.inkLayerValid = false;
          surface.inkLayerBackingScale = null;
          surface.inkLayerBurstCapture = true;
          surface.inkLayerRevision = null;
          surface.rasterFallbackReady = true;
          surface.settleUpgradePending = true;
          stats.deferredCanonicalPages += 1;
          this.logger.renderProfile({
            page: pageNumber,
            operation: "page-raster-fallback",
            reason: "zoom-handoff-final",
            durationMs: fallbackBlitDurationMs,
            strokeCount: this.ink.page(pageNumber).length,
            canvasResized: false,
            vectorRepaintCount: 0,
            useLayerCache: true,
            includeActivePreview: false,
            zoomCompositing: this.zoomCompositing,
            visiblePageCount: this.surfaces.size,
            deferredCanonicalUpgrade: true,
            rasterSource: "previous-canonical-layer",
            fallbackBlitDurationMs
          });
          this.logZoomInkLayout(surface, "handoff-final", layouts.get(pageNumber), geometry.snapshots.get(pageNumber));
          continue;
        }
        surface.inkLayerValid = false;
        surface.inkLayerBackingScale = null;
        surface.inkLayerBurstCapture = false;
        surface.inkLayerRevision = null;
        surface.rasterFallbackReady = false;
        const painted = this.renderPage(pageNumber, stats, "zoom-handoff-final");
        this.logZoomInkLayout(surface, "handoff-final", layouts.get(pageNumber), geometry.snapshots.get(pageNumber));
        if (painted) stats.pagesRepainted += 1;
        else if (surface.viewportCullPending) stats.skippedCulled += 1;
      }
    } finally {
      this.zoomLayoutCache = previousLayoutCache;
    }
    this.logger.zoomComposite("final-canonical", {
      pagesRepainted: stats.pagesRepainted,
      deferredCanonicalPages: stats.deferredCanonicalPages,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      skippedCulled: stats.skippedCulled,
      durationMs: roundMs(performance.now() - started)
    });
  }

  /** Compatibility entrypoint for adapter/test resize notifications. */
  private handleRootResize(): void {
    this.processRootResize();
  }

  private processRootResize(): void {
    // After the first settle, PDF.js replaces canvas/text layers and changes
    // their final size. A ResizeObserver used to turn this into a second zoom
    // debounce + repaint, visibly moving ink alongside the native page update.
    if (this.isZoomHandoffActive()) {
      this.syncZoomOverlayLayouts("native-content");
      if (!this.zoomCompositing) this.zoomHandoffNeedsFinalRebase = true;
      return;
    }
    // Zoom already drives scheduleZoomRepaint via scalechanging.
    if (this.isZoomGestureActive()) return;
    this.scheduleRefresh("resize", true);
  }

  private repaintSurfaces(
    reason: string,
    burst?: { burstTicks: number; burstDurationMs: number; scaleStart?: number; scaleEnd?: number }
  ): void {
    if (this.destroyed) return;
    const started = performance.now();
    const stats = {
      pagesRepainted: 0,
      canvasesResized: 0,
      strokesRedrawn: 0,
      skippedDisconnected: 0,
      skippedCulled: 0,
      skippedBlitOnly: 0
    };
    const pages = this.options.adapter.pages();
    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = byNumber.get(pageNumber);
      if (!current) {
        stats.skippedDisconnected += 1;
        continue;
      }
      if (!this.reattachSurface(surface, current)) {
        if (current.element.isConnected) {
          this.remountSurfaceOnPageReplacement(surface, current);
        } else {
          stats.skippedDisconnected += 1;
          continue;
        }
      }
      if (ViewerInkSession.isZoomPaintReason(reason)) {
        // Force-rebind mid-stroke drops capture and orphans the live draft (log: rebind during draw).
        if (!this.surfaceHasLiveInkInput(surface)) {
          this.ensurePageRouter(surface, { force: true, reason });
        } else {
          this.ensurePageRouter(surface, { reason: `${reason}-live-ink` });
        }
      }
      const painted = this.renderPage(pageNumber, stats, reason);
      if (ViewerInkSession.isZoomPaintReason(reason)) this.logZoomInkLayout(surface, "settle");
      if (painted) stats.pagesRepainted += 1;
      else if (surface.viewportCullPending) stats.skippedCulled += 1;
    }
    this.ensureSelectionToolbar();
    this.refreshSurfaceCursors();
    const view = this.options.adapter.getViewState();
    const durationMs = roundMs(performance.now() - started);
    if (durationMs >= this.frameTimingProfile().lateFrameThresholdMs && this.isZoomHandoffActive()) {
      this.logger.zoomFlashProxy("paint-duration-spike", {
        reason,
        durationMs,
        pagesRepainted: stats.pagesRepainted,
        strokesRedrawn: stats.strokesRedrawn,
        canvasesResized: stats.canvasesResized,
        skippedCulled: stats.skippedCulled,
        skippedBlitOnly: stats.skippedBlitOnly
      });
    }
    this.logger.zoomRepaint({
      reason,
      durationMs,
      pagesRepainted: stats.pagesRepainted,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      skippedCulled: stats.skippedCulled,
      skippedBlitOnly: stats.skippedBlitOnly,
      scale: Number(view.scale.toFixed(4)),
      frameBudgetMs: this.frameTimingProfile().frameBudgetMs,
      ...(burst ? {
        burstTicks: burst.burstTicks,
        burstDurationMs: burst.burstDurationMs,
        ...(burst.scaleStart !== undefined ? { scaleStart: burst.scaleStart } : {}),
        ...(burst.scaleEnd !== undefined ? { scaleEnd: burst.scaleEnd } : {})
      } : {})
    });
    if (ViewerInkSession.isZoomPaintReason(reason)) {
      this.reportDevProbe("zoom-repaint", {
        reason,
        durationMs,
        pagesRepainted: stats.pagesRepainted,
        canvasesResized: stats.canvasesResized,
        strokesRedrawn: stats.strokesRedrawn,
        skippedDisconnected: stats.skippedDisconnected,
        skippedCulled: stats.skippedCulled,
        skippedBlitOnly: stats.skippedBlitOnly,
        scale: Number(view.scale.toFixed(4))
      });
    }
  }

  private frameTimingProfile(): RuntimeFrameProfile {
    return this.frameBudget.snapshot();
  }

  private frameTimingAccumulator(): BoundedTiming {
    return new BoundedTiming(undefined, undefined, () => this.frameTimingProfile());
  }

  private frameTimingEnvironment(): { fallbackRefreshHz: number; platform: string; runtime: string } {
    const platform = this.runtimePlatform();
    const view = this.options.adapter.host.ownerDocument.defaultView;
    const userAgent = view?.navigator.userAgent ?? "";
    const runtime = /electron/i.test(userAgent)
      ? "electron"
      : /capacitor/i.test(userAgent)
        ? "capacitor-wkwebview"
        : /applewebkit/i.test(userAgent) && platform.mobile
          ? "wkwebview"
          : "webview";
    return {
      // WebKit commonly runs Obsidian's mobile view at 60 Hz; the same
      // conservative fallback avoids calling a healthy 60 Hz desktop slow.
      fallbackRefreshHz: 60,
      platform: platform.mobile ? (platform.phone ? "mobile-phone" : "mobile-tablet") : "desktop",
      runtime
    };
  }

  /**
   * A short, low-work idle rAF window distinguishes genuine 30 Hz delivery
   * from active-work frames that consistently miss every other 60 Hz frame.
   * It is deliberately sparse and never logs or performs layout.
   */
  private startFrameProfileSampling(): void {
    if (!this.options.runtimePlatform) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view || typeof view.requestAnimationFrame !== "function") return;
    const scheduleWindow = (): void => {
      if (this.destroyed) return;
      const document = this.options.adapter.host.ownerDocument;
      if (document.hidden) {
        this.frameProfileTimer = view.setTimeout(scheduleWindow, 1_000);
        return;
      }
      let remaining = ViewerInkSession.FRAME_PROFILE_IDLE_SAMPLE_COUNT;
      const sample = (timestamp: number): void => {
        this.frameProfileRaf = null;
        if (this.destroyed) return;
        const hidden = this.options.adapter.host.ownerDocument.hidden;
        this.frameBudget.observeRaf(timestamp, hidden, "idle");
        if (hidden) {
          this.frameProfileTimer = view.setTimeout(scheduleWindow, 1_000);
          return;
        }
        remaining -= 1;
        if (remaining > 0) {
          this.frameProfileRaf = view.requestAnimationFrame(sample);
        } else {
          this.frameProfileTimer = view.setTimeout(scheduleWindow, ViewerInkSession.FRAME_PROFILE_IDLE_RESAMPLE_MS);
        }
      };
      this.frameProfileRaf = view.requestAnimationFrame(sample);
    };
    scheduleWindow();
  }

  private stopFrameProfileSampling(): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (this.frameProfileRaf !== null) {
      view?.cancelAnimationFrame(this.frameProfileRaf);
      this.frameProfileRaf = null;
    }
    if (this.frameProfileTimer !== null) {
      view?.clearTimeout(this.frameProfileTimer);
      this.frameProfileTimer = null;
    }
  }

  private runtimePlatform(): { mobile: boolean; phone: boolean } {
    return this.options.runtimePlatform?.() ?? { mobile: false, phone: false };
  }

  static async create(options: ViewerInkSessionOptions): Promise<ViewerInkSession> {
    const urgent = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => {
      const sink = options.vaultLog;
      if (!sink) return;
      if (sink.writeUrgent) await sink.writeUrgent("info", event, payload);
      else sink.write("info", event, payload);
    };
    const platform = options.runtimePlatform?.() ?? { mobile: false, phone: false };
    await ensurePostZoomInputRuntime();
    if (options.onDeletePage && options.onInsertPage) await ensurePdfThumbnailRuntime();
    const domPageCount = options.adapter.pages().length;
    await urgent("session create begin", {
      document: options.documentPath,
      mobile: platform.mobile,
      phone: platform.phone,
      domPageCount,
      toolbarPlacement: resolveToolbarPlacement(
        options.toolbarPlacement?.() ?? options.settings.toolbarPlacement
      )
    });
    let contentHash: string | undefined;
    try {
      const readDocument = options.readDocument ?? options.readSourcePdf;
      if (!readDocument) throw new Error("Document bytes unavailable for identity");
      const sourceBytes = await readDocument();
      // An empty byte array is a test/fallback signal, not a useful PDF
      // identity. Real PDFs always receive a content-derived key.
      if (sourceBytes.byteLength > 0) contentHash = hashDocumentContent(sourceBytes);
    } catch (error) {
      await urgent("session content identity unavailable", {
        document: options.documentPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const session = new ViewerInkSession({
      ...options,
      ...(contentHash ? { contentHash } : {})
    });
    try {
    await urgent("session create constructor ok", {
      document: options.documentPath,
      mobile: platform.mobile
    });
    session.persistEpoch = options.claimPersistEpoch?.(session.identity.id) ?? 1;
    await urgent("session create sidecar begin", {
      document: options.documentPath,
      documentId: session.identity.id
    });
    const identityInput: DocumentIdentityInput = {
      vaultPath: options.documentPath,
      ...(contentHash ? { contentHash } : {})
    };
    const sidecarResult = await options.sidecars.loadForDocumentWithStatus(identityInput);
    const legacyPaths = new Set<string>();
    if (sidecarResult.identity) {
      legacyPaths.add(sidecarResult.identity.stored.vaultPath);
      for (const alias of sidecarResult.identity.stored.aliases ?? []) legacyPaths.add(alias);
    }
    const recoveryInput: DocumentIdentityInput = {
      ...identityInput,
      ...(legacyPaths.size ? { legacyPaths: [...legacyPaths] } : {})
    };
    const recoveryResult = await options.recovery.loadForDocumentWithStatus(recoveryInput);
    const conflicts = [
      ...(sidecarResult.conflict ? [{ store: "sidecar", conflict: sidecarResult.conflict }] : []),
      ...(recoveryResult.conflict ? [{ store: "recovery", conflict: recoveryResult.conflict }] : [])
    ];
    if (conflicts.length) {
      const paths = conflicts.flatMap(({ conflict }) => conflict.paths).join(", ");
      const message = `Conflicting annotation snapshots found for ${options.documentPath}; preserved files require review: ${paths}`;
      options.notice(message);
      await urgent("session create annotation conflict", {
        document: options.documentPath,
        documentId: session.identity.id,
        conflicts
      });
      throw new Error(message);
    }
    const sidecar = sidecarResult.data;
    const recovery = recoveryResult.data;
    const stored = pickNewerSidecar(sidecar, recovery);
    const sidecarStrokes = countSidecarStrokes(sidecar);
    const recoveryStrokes = countSidecarStrokes(recovery);
    const loadedStrokes = countSidecarStrokes(stored);
    const sidecarTexts = countSidecarTexts(sidecar);
    const recoveryTexts = countSidecarTexts(recovery);
    const loadedTexts = countSidecarTexts(stored);
    const quarantined = [sidecarResult.quarantined, recoveryResult.quarantined].filter(
      (result): result is NonNullable<typeof result> => result !== null
    );
    const repaired = [sidecarResult.repaired, recoveryResult.repaired].filter(
      (result): result is NonNullable<typeof result> => result !== undefined
    );
    for (const result of quarantined) {
      session.logger.sidecarQuarantined({ documentId: session.identity.id, ...result });
    }
    for (const result of repaired) {
      session.logger.sidecarRepaired({ documentId: session.identity.id, ...result });
    }
    if (quarantined.length) {
      const repairedSources = new Set(repaired.map((result) => result.sourcePath));
      const unrepaired = quarantined.filter((result) => !repairedSources.has(result.sourcePath));
      const deleted = quarantined.filter((result) => result.artifactDeleted);
      const retained = quarantined.filter((result) => !result.artifactDeleted);
      const messages: string[] = [];
      if (retained.length) {
        messages.push(`Malformed annotation data was moved to ${retained.map((result) => result.quarantinePath).join(", ")}.`);
      }
      if (deleted.length) {
        messages.push(`Malformed annotation data with no valid backup was removed; affected stores start empty.`);
      }
      if (repaired.length) {
        messages.push(`Automatically restored ${repaired.map((result) => result.store).join(" and ")} from validated backup.`);
      }
      if (unrepaired.length) {
        messages.push(stored ? "A valid remaining annotation snapshot was kept." : "Opened with empty annotations.");
      }
      options.notice(messages.join(" "));
    }
    await urgent("session create sidecar ok", {
      document: options.documentPath,
      documentId: session.identity.id,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
      loadedStrokes,
      loadedTexts,
      hasSidecar: Boolean(sidecar),
      hasRecovery: Boolean(recovery),
      repaired: repaired.map((result) => ({
        store: result.store,
        sourcePath: result.sourcePath,
        quarantinePath: result.quarantinePath,
        backupPath: result.backupPath
      })),
      quarantined: quarantined.map((result) => ({
        store: result.store,
        sourcePath: result.sourcePath,
        quarantinePath: result.quarantinePath,
        error: result.error,
        artifactDeleted: result.artifactDeleted === true
      }))
    });
    session.logger.sidecarLoad({
      documentId: session.identity.id,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
      loadedStrokes,
      loadedTexts,
      sidecarUpdatedAt: sidecar?.updatedAt ?? null,
      recoveryUpdatedAt: recovery?.updatedAt ?? null
    });
    const storedSource = stored === recovery ? "recovery" : stored === sidecar ? "sidecar" : null;
    for (const page of stored?.pages ?? []) {
      if (page.width > 1 && page.height > 1) {
        session.pageMetrics.set(page.page, { width: page.width, height: page.height });
      }
      for (const stroke of page.strokes) {
        session.ink.add(stroke);
        session.recordStrokeReloadRestoration(stroke, storedSource ?? "unknown", "session-create");
      }
      for (const text of page.texts ?? []) session.texts.add(text);
    }
    pdfSurfaceExtensions(options.adapter)?.setInkPreviewProvider?.((pageNumber) => ({
      revision: session.ink.pageRevision(pageNumber),
      strokes: session.ink.page(pageNumber)
    }));
    await urgent("session create hydrate ok", {
      document: options.documentPath,
      loadedStrokes,
      loadedTexts,
      pagesWithInk: stored?.pages?.length ?? 0
    });
    session.reconcileToolbarMount("session-create");
    await urgent("session create toolbar ok", {
      document: options.documentPath,
      toolbarPlacement: session.currentToolbarPlacement()
    });
    session.logger.sessionAttach({
      scrollRoot: describeScrollElement(options.adapter.scrollElement()),
      ...describeInputPolicies(options.settings),
      activeTool: options.settings.toolPreferences.activeTool,
      runtimePlatform: session.runtimePlatform().mobile ? "mobile" : "desktop",
      toolbarPlacement: session.currentToolbarPlacement(),
      loadedStrokes,
      loadedTexts,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
      persistEpoch: session.persistEpoch
    });
    session.refreshDiagnostics();
    const mountPages = session.pagesForInkMount();
    await urgent("session create refresh begin", {
      document: options.documentPath,
      mobile: platform.mobile,
      phone: platform.phone,
      domPageCount,
      currentPage: options.adapter.getViewState().pageNumber,
      mountPageCount: mountPages.length,
      mountPages: mountPages.map((page) => page.pageNumber),
      toolbarPlacement: session.currentToolbarPlacement()
    });
    session.refresh("create");
    await urgent("session create refresh ok", {
      document: options.documentPath,
      surfaces: session.surfaces.size,
      mountPages: [...session.surfaces.keys()].sort((a, b) => a - b),
      toolbarPlacement: session.currentToolbarPlacement(),
      mobile: platform.mobile
    });
    session.lastKnownViewScale = options.adapter.getViewState().scale;
    if (options.restoredAddPageMutation) {
      const state = options.restoredAddPageMutation;
      const details = session.addPageLifecycleDetails(state);
      session.logger.addPageLifecycle("restored", details);
      if (details.beforeScale !== details.afterScale || details.beforeScaleMode !== details.afterScaleMode) {
        session.logger.addPageLifecycle("scale-changed", details);
      }
      if (details.staleSurfaceOverlap === true) {
        session.logger.addPageLifecycle("stale-surface-overlap", details);
      }
    }
    return session;
    } catch (error) {
      await session.destroy({ silent: true, alreadyPersisted: true }).catch(() => undefined);
      throw error;
    }
  }

  refresh(reason = "manual"): void {
    if (this.destroyed) return;
    this.reconcileToolbarMount(reason);
    this.addPageControl?.refresh();
    if (this.zoomProfile) this.zoomProfile.refreshExecutions += 1;
    if (this.deferRefreshDuringZoom(reason)) return;

    const pages = this.pagesForInkMount();
    // Scroll settle: layout-only when mount set already matches — avoid invalidate/repaint storm.
    if (
      (reason === "view-scroll-mobile" || reason === "view-pagechanging")
      && this.runtimePlatform().mobile
      && this.mobileMountSetUnchanged(pages)
    ) {
      for (const page of pages) {
        const surface = this.surfaces.get(page.pageNumber);
        if (!surface) continue;
        if (surface.page.element !== page.element) {
          this.remountSurfaceOnPageReplacement(surface, page);
          continue;
        }
        surface.page = page;
        this.syncOverlayLayout(surface);
        this.ensurePageRouter(surface, { reason: `${reason}-skip-unchanged` });
      }
      this.logger.refresh(`${reason}-skip-unchanged`, {
        selected: this.selected.length,
        surfaces: this.surfaces.size,
        mountPages: pages.map((page) => page.pageNumber)
      });
      return;
    }

    if (this.refreshDepth >= 4) {
      this.logger.loopBlocked("refresh", this.refreshDepth);
      return;
    }
    this.refreshDepth += 1;
    this.reconcileSelection();
    // A refresh reattaches/synchronizes page chrome; it does not imply that
    // committed ink pixels changed. Keep valid layer caches so a PDF.js DOM
    // refresh becomes a blit instead of repainting every dense-page stroke.
    this.renderEpoch += 1;
    this.logger.refresh(reason, {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      mountPages: pages.map((page) => page.pageNumber)
    });
    try {
      const live = new Set(pages.map((page) => page.pageNumber));
      for (const [pageNumber, surface] of this.surfaces) {
        const current = pages.find((page) => page.pageNumber === pageNumber)
          ?? this.options.adapter.page(pageNumber);
        if (!current || !live.has(pageNumber)) {
          this.commitActiveDrawBeforeSurfaceLoss(surface, "page-outside-mobile-mount");
          surface.router?.destroy();
          this.clearTouchDrawPolicy(surface.page.element);
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (current.element !== surface.page.element) {
          this.commitActiveDrawBeforeSurfaceLoss(surface, "page-element-replaced");
          surface.router?.destroy();
          this.clearTouchDrawPolicy(surface.page.element);
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (!this.reattachSurface(surface, current)) {
          this.commitActiveDrawBeforeSurfaceLoss(surface, "page-overlay-disconnected");
          surface.router?.destroy();
          this.clearTouchDrawPolicy(surface.page.element);
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
      }
      for (const page of pages) {
        if (!this.surfaces.has(page.pageNumber)) this.surfaces.set(page.pageNumber, this.mountPage(page));
        this.surfaces.get(page.pageNumber)?.router?.syncToolState();
        this.renderPage(page.pageNumber);
      }
      for (const pageNumber of [...this.surfaces.keys()]) {
        if (!live.has(pageNumber)) {
          const surface = this.surfaces.get(pageNumber);
          if (surface) this.commitActiveDrawBeforeSurfaceLoss(surface, "post-refresh-page-unmounted");
          surface?.router?.destroy();
          if (surface) {
            this.clearTouchDrawPolicy(surface.page.element);
            this.releaseInputOwner(surface.page.element);
            this.releaseSurfaceBuffers(surface);
          }
          surface?.overlay.remove();
          this.surfaces.delete(pageNumber);
        }
      }
      this.syncTouchDrawPolicy(reason);
      this.ensureSelectionToolbar();
      this.syncAnnotationCursorMode();
    } finally {
      this.refreshDepth -= 1;
    }
  }

  /**
   * Desktop: PDF.js already exposes the mounted page shells. Mobile: the
   * measured working set is the current page plus the policy preload radius,
   * which stays zero until a device trace promotes one.
   */
  private pagesForInkMount(): AnnotationPageInfo[] {
    const candidates: AnnotationPageInfo[] = [];
    const mobile = this.runtimePlatform().mobile;
    const policy = documentMountPolicy([], mobile ? "constrained" : "desktop");
    if (!mobile) {
      candidates.push(...this.options.adapter.pages());
    } else {
      const currentPage = this.options.adapter.getViewState().pageNumber;
      for (const pageNumber of workingSetPageNumbers([currentPage], policy.preloadRadiusPages)) {
        const page = this.options.adapter.page(pageNumber);
        if (page) candidates.push(page);
      }
      if (candidates.length === 0) {
        const fallback = this.options.adapter.page(1) ?? this.options.adapter.pages()[0];
        if (fallback) candidates.push(fallback);
      }
    }
    const pad = 1;
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const resolved: AnnotationPageInfo[] = [];
    for (let pageNumber = currentPage - pad; pageNumber <= currentPage + pad; pageNumber += 1) {
      if (pageNumber < 1) continue;
      const page = this.options.adapter.page(pageNumber);
      if (page) resolved.push(page);
    }
    if (resolved.length > 0) return resolved;
    const fallback = this.options.adapter.page(1) ?? this.options.adapter.pages()[0];
    return fallback ? [fallback] : [];
  }

  /** Tool/draw-mode swaps update hit-testing/cursors/text chrome without rebuilding ink pixels. */
  private refreshToolChrome(reason = "tool-chrome"): void {
    this.logger.refresh(reason, {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      activeTool: this.activeTool(),
      textBoxesInteractable: this.textBoxesInteractable(),
      chromeOnly: true
    });
    for (const surface of this.surfaces.values()) {
      surface.router?.syncToolState();
      this.renderTextAnnotations(surface);
      // Selection remains available for move/copy/delete shortcuts, but its
      // blue pixels are transient lasso chrome and must disappear immediately
      // when the user switches to a drawing tool.
      if (this.activeTool() === "lasso") this.renderSelectionChrome(surface);
      else this.clearSelectionChrome(surface);
    }
    this.syncTouchDrawPolicy(reason);
    this.syncAnnotationCursorMode();
    this.refreshSurfaceCursors();
    this.ensureSelectionToolbar();
  }

  /** Prefer page-local ink/text paint after undoable edits; full refresh only for undo/redo. */
  private executeHistory(command: Command, pages?: number | readonly number[] | null): void {
    if (pages != null) {
      for (const page of typeof pages === "number" ? [pages] : pages) {
        if (Number.isFinite(page)) this.historyDirtyPages.add(page);
      }
    }
    this.history.execute(command);
  }

  /**
   * Append a newly committed stroke to the canonical layer without rebuilding
   * every stroke already on the page. Releasing the pen used to invalidate the
   * layer and repaint the complete page, so repeated short strokes became
   * progressively slower as the page accumulated ink.
   */
  private appendCommittedStroke(surface: PageSurface, stroke: InkStroke): boolean {
    const pageRevision = this.ink.pageRevision(surface.page.pageNumber);
    const expectedLayerRevision = pageRevision - 1;
    const cacheRevisionMatches = surface.inkLayerRevision === expectedLayerRevision;
    if (
      this.zoomCompositing
      || !surface.inkLayerValid
      || !surface.inkLayer
      || !surface.inkLayerContext
      || surface.inkLayerBurstCapture
      || surface.inkLayerBackingScale === null
      || surface.builder !== undefined
      || surface.editPath.length > 0
      || surface.wetPreviewActive
      || surface.pendingLivePaint !== null
    ) return false;
    if (!cacheRevisionMatches) {
      this.logger.renderProfile({
        page: surface.page.pageNumber,
        operation: "stroke-append-rejected",
        reason: "cache-revision-mismatch",
        durationMs: 0,
        strokeId: stroke.id,
        pageRevision,
        expectedLayerRevision,
        cachedLayerRevision: surface.inkLayerRevision,
        inkLayerValid: surface.inkLayerValid,
        inkLayerBurstCapture: surface.inkLayerBurstCapture,
        committedCanvasWetHidden: surface.canvas.classList.contains("is-wet-hidden"),
        wetPreviewActive: surface.wetPreviewActive
      });
      return false;
    }

    this.syncOverlayLayout(surface);
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    if (
      surface.canvas.width !== pixelWidth
      || surface.canvas.height !== pixelHeight
      || surface.inkLayer.width !== pixelWidth
      || surface.inkLayer.height !== pixelHeight
      || Math.abs(surface.inkLayerBackingScale - backingScale) >= 1e-6
    ) return false;

    const previousStroke = this.ink.page(surface.page.pageNumber).at(-2);
    const beforeEvidence = previousStroke
      ? this.strokeCachePixelEvidence(surface, previousStroke)
      : null;
    if (previousStroke && beforeEvidence) {
      this.recordStrokeCacheHandoff(surface, stroke, "before", pageRevision, expectedLayerRevision, beforeEvidence);
    }

    const startedAt = performance.now();
    surface.paintGeneration = ++this.nextPaintGeneration;
    const layerContext = surface.inkLayerContext;
    const strokeRegion = this.strokeDamageBounds(surface, stroke);
    const previewTransferReady = surface.liveDrawPreviewStrokeId === stroke.id
      && surface.draftCanvas.width === pixelWidth
      && surface.draftCanvas.height === pixelHeight
      && typeof layerContext.drawImage === "function";
    if (previewTransferReady) {
      // The draft is already the final-quality stroke. Transfer its pixels to
      // the canonical layer instead of running the entire long path again on
      // pointer-up. Predicted samples live on a separate canvas and therefore
      // cannot leak into the committed bitmap.
      this.beginStrokePixelEvidence(surface, stroke, surface.inkLayer, layerContext);
      layerContext.save();
      layerContext.setTransform(1, 0, 0, 1, 0, 0);
      layerContext.globalCompositeOperation = "source-over";
      const left = Math.max(0, Math.floor(strokeRegion.minX * backingScale) - 2);
      const top = Math.max(0, Math.floor(strokeRegion.minY * backingScale) - 2);
      const right = Math.min(pixelWidth, Math.ceil(strokeRegion.maxX * backingScale) + 2);
      const bottom = Math.min(pixelHeight, Math.ceil(strokeRegion.maxY * backingScale) + 2);
      if (right > left && bottom > top) {
        layerContext.drawImage(surface.draftCanvas, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
      } else {
        layerContext.drawImage(surface.draftCanvas, 0, 0);
      }
      layerContext.restore();
      layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.recordStrokeRendered(surface, stroke);
      this.finishStrokePixelEvidence(surface, stroke, surface.inkLayer, layerContext);
    } else {
      this.paintCommittedStrokes(surface, layerContext, [stroke]);
    }
    surface.inkLayerBackingScale = backingScale;
    surface.inkLayerRevision = pageRevision;
    const blitPixels = this.blitInkLayerRegionsToCanvas(
      surface,
      [strokeRegion],
      pixelWidth,
      pixelHeight,
      backingScale
    );
    if (previousStroke && beforeEvidence) {
      const afterEvidence = this.strokeCachePixelEvidence(surface, previousStroke);
      this.recordStrokeCacheHandoff(surface, stroke, "after", pageRevision, expectedLayerRevision, afterEvidence);
      if (
        this.ink.page(surface.page.pageNumber).some((candidate) => candidate.id === previousStroke.id)
        && beforeEvidence.canvas.available
        && beforeEvidence.canvas.nonTransparentPixels > 0
        && afterEvidence.canvas.available
        && afterEvidence.canvas.nonTransparentPixels === 0
      ) {
        this.logger.strokeLifecycle("stroke-cache-anomaly", {
          page: surface.page.pageNumber,
          priorStrokeId: previousStroke.id,
          triggeringStrokeId: stroke.id,
          pageRevision,
          cachedLayerRevision: surface.inkLayerRevision,
          canvasGeneration: surface.canvasGeneration,
          paintGeneration: surface.paintGeneration,
          reason: "model-present-prior-stroke-pixel-absent-after-append"
        });
      }
    }
    this.clearLiveDrawPreview(surface, [strokeRegion], backingScale);
    this.paintLaserTrails(surface, surface.page.pageNumber);
    surface.viewportCullPending = false;
    surface.settleUpgradePending = false;
    const completedAt = performance.now();
    const profile = surface.strokePerformance;
    this.noteStrokeCanvasCommit(surface, completedAt, startedAt);
    if (profile) this.schedulePaintAcknowledgement(surface, completedAt, profile);
    this.lastPagePaintAt.set(surface.page.pageNumber, { at: completedAt, reason: "history-add-stroke" });
    const durationMs = roundMetric(completedAt - startedAt);
    if (surface.strokePerformance) {
      surface.strokePerformance.renderUpdates += 1;
      surface.strokePerformance.renderTotalMs += durationMs;
      surface.strokePerformance.maxPluginCallbackMs = Math.max(surface.strokePerformance.maxPluginCallbackMs, durationMs);
      if (surface.strokePerformance.lastRenderAt !== null) {
        surface.strokePerformance.frameIntervals.add(Math.max(0, completedAt - surface.strokePerformance.lastRenderAt));
      }
      surface.strokePerformance.lastRenderAt = completedAt;
    }
    this.logger.renderProfile({
      page: surface.page.pageNumber,
      operation: "stroke-append",
      reason: "history-add-stroke",
      operationCount: 1,
      totalMs: durationMs,
      maxDurationMs: durationMs,
      durationMs,
      strokeCount: 1,
      pageStrokeCount: this.ink.page(surface.page.pageNumber).length,
      pageRevision,
      cachedLayerRevision: surface.inkLayerRevision,
      appendedStrokeCount: 1,
      incremental: true,
      canvasResized: false,
      canvasResizeCount: 0,
      vectorRepaintCount: previewTransferReady ? 0 : 1,
      previewTransfer: previewTransferReady,
      hqUpgradeCount: 0,
      backingScale: roundMetric(backingScale),
      width: roundMetric(width),
      height: roundMetric(height),
      useLayerCache: true,
      includeActivePreview: false,
      zoomCompositing: false,
      visiblePageCount: this.surfaces.size,
      blitMode: "damage-region",
      blitRegionCount: 1,
      blitPixels,
      previewTransferMode: previewTransferReady ? "damage-region" : "vector-stamp"
    });
    return true;
  }

  /**
   * Commit an eraser gesture into the cached layer without repainting every
   * stroke on a dense page. Partial erasing can replay the same destination-out
   * path into the cached layer; whole-stroke erasing retains the clipped
   * candidate restamp fallback because pixels outside the path must disappear.
   */
  private patchCommittedErase(surface: PageSurface, command: ReplacePageStrokesCommand): boolean {
    if (
      command.pageNumber !== surface.page.pageNumber
      || !surface.inkLayerValid
      || !surface.inkLayer
      || !surface.inkLayerContext
      || !surface.inkLayer.width
      || !surface.inkLayer.height
      || surface.inkLayerBurstCapture
      || surface.inkLayerRevision !== this.ink.pageRevision(surface.page.pageNumber) - 1
      || surface.canvas.width !== surface.inkLayer.width
      || surface.canvas.height !== surface.inkLayer.height
    ) return false;
    let damage = surface.wetDamage.drain();
    let damageSource: "wet-preview" | "path-bounds" = "wet-preview";
    if (damage.length === 0 && surface.editPath.length > 0 && surface.eraserSize !== undefined) {
      const mapper = this.mapper(surface);
      const points = surface.editPath.map((point) => mapper.toViewport(point));
      const lineWidth = Math.max(1, surface.eraserSize * this.displayScale(surface));
      damage = [pathBoundsWithPadding(points, lineWidth / 2)];
      damageSource = "path-bounds";
    }
    if (damage.length === 0) return false;

    const layout = this.pageLayout(surface);
    const width = Math.max(1, layout.contentWidth || 1);
    const height = Math.max(1, layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    if (
      pixelWidth !== surface.inkLayer.width
      || pixelHeight !== surface.inkLayer.height
      || surface.inkLayerBackingScale === null
      || Math.abs(surface.inkLayerBackingScale - backingScale) >= 1e-6
    ) return false;

    let maxStrokeWidth = 0;
    for (const stroke of command.beforeStrokes) {
      if (Number.isFinite(stroke.width)) maxStrokeWidth = Math.max(maxStrokeWidth, stroke.width);
    }
    const padding = Math.max(2, maxStrokeWidth * this.displayScale(surface) / 2 + 2);
    const patchLedger = new DamageLedger();
    for (const rect of damage) {
      patchLedger.add({
        minX: Math.max(0, rect.minX - padding),
        minY: Math.max(0, rect.minY - padding),
        maxX: Math.min(width, rect.maxX + padding),
        maxY: Math.min(height, rect.maxY + padding)
      });
    }
    const fastPath = surface.eraserWholeStrokes !== true
      && surface.eraserSize !== undefined
      && surface.editPath.length > 0;
    const mapper = this.mapper(surface);
    if (fastPath) {
      const points = surface.editPath.map((point) => mapper.toViewport(point));
      const lineWidth = Math.max(1, surface.eraserSize! * this.displayScale(surface));
      patchLedger.add(pathBoundsWithPadding(points, lineWidth / 2));
    }
    const patches = patchLedger.drain();
    const layerContext = surface.inkLayerContext;
    const startedAt = performance.now();
    let repaintedStrokes = 0;
    let patchStrategy: "destination-out" | "candidate-restamp" = "candidate-restamp";
    surface.paintGeneration = ++this.nextPaintGeneration;
    if (fastPath) {
      const points = surface.editPath.map((point) => mapper.toViewport(point));
      const lineWidth = Math.max(1, surface.eraserSize! * this.displayScale(surface));
      this.wetRenderer.erase(surface.inkLayer, points, lineWidth, backingScale, new DamageLedger());
      patchStrategy = "destination-out";
    } else {
      if (typeof layerContext.clip !== "function") return false;
      layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      for (const patch of patches) {
        if (patch.maxX <= patch.minX || patch.maxY <= patch.minY) continue;
        layerContext.clearRect(patch.minX, patch.minY, patch.maxX - patch.minX, patch.maxY - patch.minY);
        const pageCorners = [
          mapper.toPage({ x: patch.minX, y: patch.minY }),
          mapper.toPage({ x: patch.maxX, y: patch.minY }),
          mapper.toPage({ x: patch.minX, y: patch.maxY }),
          mapper.toPage({ x: patch.maxX, y: patch.maxY })
        ];
        const pageBounds: Bounds = {
          minX: Math.min(...pageCorners.map((point) => point.x)),
          minY: Math.min(...pageCorners.map((point) => point.y)),
          maxX: Math.max(...pageCorners.map((point) => point.x)),
          maxY: Math.max(...pageCorners.map((point) => point.y))
        };
        const candidates = this.ink.pageIntersecting(surface.page.pageNumber, pageBounds);
        repaintedStrokes += candidates.length;
        layerContext.save();
        layerContext.beginPath();
        layerContext.rect(patch.minX, patch.minY, patch.maxX - patch.minX, patch.maxY - patch.minY);
        layerContext.clip();
        this.paintCommittedStrokes(surface, layerContext, candidates);
        layerContext.restore();
      }
    }
    surface.inkLayerRevision = this.ink.pageRevision(surface.page.pageNumber);
    surface.inkLayerBackingScale = backingScale;
    surface.inkLayerBurstCapture = false;
    const blitPixels = this.blitInkLayerRegionsToCanvas(surface, patches, pixelWidth, pixelHeight, backingScale);
    this.paintLaserTrails(surface, surface.page.pageNumber);
    this.clearLiveDrawPreview(surface, patches, backingScale);
    this.lastPagePaintAt.set(surface.page.pageNumber, { at: performance.now(), reason: "erase-patch" });
    const durationMs = roundMetric(performance.now() - startedAt);
    this.logger.renderProfile({
      page: surface.page.pageNumber,
      operation: "erase-patch",
      reason: "history-erase",
      durationMs,
      strokeCount: repaintedStrokes,
      pageStrokeCount: this.ink.page(surface.page.pageNumber).length,
      pageRevision: this.ink.pageRevision(surface.page.pageNumber),
      cachedLayerRevision: surface.inkLayerRevision,
      patchCount: patches.length,
      damageSource,
      patchStrategy,
      blitMode: "damage-region",
      blitRegionCount: patches.length,
      blitPixels,
      useLayerCache: true,
      includeActivePreview: false,
      zoomCompositing: this.zoomCompositing,
      visiblePageCount: this.surfaces.size
    });
    return true;
  }

  /** Keep an existing zoom raster interactive while partial eraser history catches up. */
  private patchRasterFallbackErase(surface: PageSurface, command: ReplacePageStrokesCommand): boolean {
    if (
      command.pageNumber !== surface.page.pageNumber
      || (!surface.rasterFallbackReady && !surface.inkLayerBurstCapture && !surface.wetPreviewUsesCommittedCanvas)
      || (!surface.settleUpgradePending && !surface.wetPreviewUsesCommittedCanvas)
      || surface.eraserWholeStrokes === true
      || surface.eraserSize === undefined
      || surface.editPath.length === 0
      || !surface.canvas.width
      || !surface.canvas.height
    ) return false;
    const layout = this.pageLayout(surface);
    const width = Math.max(1, layout.contentWidth || 1);
    const height = Math.max(1, layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) return false;
    const mapper = this.mapper(surface);
    const points = surface.editPath.map((point) => mapper.toViewport(point));
    const lineWidth = Math.max(1, surface.eraserSize * this.displayScale(surface));
    const startedAt = performance.now();
    const damage = new DamageLedger();
    this.wetRenderer.erase(surface.canvas, points, lineWidth, backingScale, damage);
    if (surface.inkLayer && surface.inkLayer.width === pixelWidth && surface.inkLayer.height === pixelHeight) {
      this.wetRenderer.erase(surface.inkLayer, points, lineWidth, backingScale, new DamageLedger());
    }
    surface.inkLayerValid = false;
    surface.inkLayerBackingScale = null;
    surface.inkLayerBurstCapture = true;
    surface.inkLayerRevision = null;
    surface.rasterFallbackReady = true;
    surface.settleUpgradePending = true;
    this.clearLiveDrawPreview(surface, damage.drain(), backingScale);
    this.logger.renderProfile({
      page: surface.page.pageNumber,
      operation: "erase-raster-fallback",
      reason: "history-erase",
      durationMs: roundMetric(performance.now() - startedAt),
      pathPointCount: points.length,
      blitMode: "none",
      deferredCanonicalUpgrade: true,
      rasterSource: "existing-deferred-raster",
      useLayerCache: false,
      visiblePageCount: this.surfaces.size
    });
    this.scheduleViewportPaint();
    return true;
  }

  /** Append a committed stroke to the visible deferred raster and upgrade later. */
  private patchDeferredRasterStroke(surface: PageSurface, stroke: InkStroke): boolean {
    if (
      !surface.inkLayer
      || !surface.inkLayerContext
      || (!surface.rasterFallbackReady && !surface.inkLayerBurstCapture)
      || !surface.settleUpgradePending
      || surface.inkLayer.width === 0
      || surface.inkLayer.height === 0
    ) return false;
    const layout = this.pageLayout(surface);
    const width = Math.max(1, layout.contentWidth || 1);
    const height = Math.max(1, layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    if (
      surface.canvas.width !== pixelWidth
      || surface.canvas.height !== pixelHeight
      || surface.inkLayer.width !== pixelWidth
      || surface.inkLayer.height !== pixelHeight
    ) return false;
    const startedAt = performance.now();
    const mapper = this.mapper(surface);
    const scale = this.displayScale(surface);
    const paint = (context: CanvasRenderingContext2D): void => {
      context.save();
      context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.drawPointsForMapper(
        context,
        mapper,
        scale,
        stroke.points,
        stroke.color,
        stroke.width,
        stroke.opacity,
        stroke.tool,
        false,
        stroke.id,
        stroke.eraseMasks,
        stroke.penType
      );
      context.restore();
    };
    paint(surface.inkLayerContext);
    paint(surface.context);
    const strokeRegion = this.strokeDamageBounds(surface, stroke);
    surface.inkLayerValid = false;
    surface.inkLayerBackingScale = null;
    surface.inkLayerBurstCapture = true;
    surface.inkLayerRevision = null;
    surface.rasterFallbackReady = true;
    surface.settleUpgradePending = true;
    this.clearLiveDrawPreview(surface, [strokeRegion], backingScale);
    this.paintLaserTrails(surface, surface.page.pageNumber);
    this.logger.renderProfile({
      page: surface.page.pageNumber,
      operation: "stroke-raster-fallback",
      reason: "history-add-stroke",
      durationMs: roundMetric(performance.now() - startedAt),
      strokeCount: 1,
      pageStrokeCount: this.ink.page(surface.page.pageNumber).length,
      tool: stroke.tool,
      pointCount: stroke.points.length,
      deferredCanonicalUpgrade: true,
      rasterSource: "existing-deferred-raster",
      useLayerCache: false,
      visiblePageCount: this.surfaces.size
    });
    this.scheduleViewportPaint();
    return true;
  }

  private paintAfterHistory(command?: Command, action?: HistoryChangeAction): void {
    if (this.historyDirtyPages.size === 0) {
      this.refresh("history");
      return;
    }
    const pages = [...this.historyDirtyPages];
    this.historyDirtyPages.clear();
    this.logger.refresh("history-local", {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      pages: pages.length
    });
    const incrementalStroke = command instanceof AddStrokeCommand
      && (action === "execute" || action === "redo")
      ? command.strokeForIncrementalPaint
      : null;
    for (const page of pages) {
      const surface = this.surfaces.get(page);
      if (!surface) continue;
      const appended = incrementalStroke?.page === page
        ? this.appendCommittedStroke(surface, incrementalStroke)
        : false;
      const deferredStroke = !appended && incrementalStroke?.page === page
        ? this.patchDeferredRasterStroke(surface, incrementalStroke)
        : false;
      const patchedErase = command instanceof ReplacePageStrokesCommand
        ? this.patchCommittedErase(surface, command)
        : false;
      const rasterErase = !patchedErase && command instanceof ReplacePageStrokesCommand
        ? this.patchRasterFallbackErase(surface, command)
        : false;
      if (!appended && !deferredStroke && !patchedErase && !rasterErase) {
        this.invalidateInkLayer(surface);
        this.renderPage(page);
      }
      this.historyPaintedPages.add(page);
    }
    this.ensureSelectionToolbar();
  }

  private needsPagePaint(page: number): boolean {
    if (this.historyPaintedPages.has(page)) {
      this.historyPaintedPages.delete(page);
      return false;
    }
    return true;
  }

  private ensureSelectionToolbar(options?: { resetPlacement?: boolean }): void {
    const count = this.selected.length + this.selectedTexts.length;
    if (!count || this.selectionPage === null) return;
    if (options?.resetPlacement) this.selectionToolbar.resetPlacement();
    const anchor = this.autoToolbarAnchor();
    this.selectionToolbar.show(count, anchor);
    this.selectionToolbar.reposition(anchor);
  }

  private autoToolbarAnchor(): ViewportPoint {
    const root = this.options.adapter.root;
    const rootRect = root.getBoundingClientRect();
    const defaultAnchor: ViewportPoint = {
      x: Math.max(8, (rootRect.width - 280) / 2),
      y: 8
    };
    const surface = this.selectionPage ? this.surfaces.get(this.selectionPage) : undefined;
    if (!surface || !this.selectionShape) return defaultAnchor;

    const bounds = shapeBounds(this.selectionShape);
    const mapper = this.mapper(surface);
    const topCenterView = mapper.toViewport({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY });
    const clientPoint = this.overlayClientFromViewport(surface, topCenterView);
    const clientCenterX = clientPoint.x;
    const clientTopY = clientPoint.y;
    const visible = clientCenterX >= rootRect.left && clientCenterX <= rootRect.right
      && clientTopY >= rootRect.top && clientTopY <= rootRect.bottom;
    if (!visible) return defaultAnchor;

    return {
      x: clientCenterX - rootRect.left - 140,
      y: clientTopY - rootRect.top - 56
    };
  }

  private cancelCustomPinches(reason: "lifecycle" | "disabled" = "lifecycle"): void {
    for (const surface of this.surfaces.values()) {
      surface.router?.cancelCustomPinch(reason);
      if (surface.mobileCustomPinch) this.cancelMobileCustomPinch(surface, "capability-lost");
    }
    this.clearMobileCssZoom();
  }

  onPageLifecycleChange(change: AnnotationPageLifecycleChange): void {
    // PDF.js also reports a replace when it virtualizes an unrelated page.
    // Validate the active anchor first: additions below the viewport must not
    // cancel a live pinch, while replacement of the anchored page still fails
    // closed before page maintenance can detach its shell.
    if (change.kind === "replace") {
      for (const surface of this.surfaces.values()) {
        if (!surface.mobileCustomPinch) continue;
        this.observeMobileCustomPinch(surface, "mutation");
        if (!surface.mobileCustomPinch) surface.router?.cancelCustomPinch("lifecycle");
      }
    } else if (change.kind === "reload" || change.kind === "viewer-replaced" || change.kind === "unmount") {
      this.cancelCustomPinches("lifecycle");
    }
    const adapterGeneration = "viewerGeneration" in this.options.adapter
      ? this.options.adapter.viewerGeneration
      : change.viewerGeneration;
    if (change.viewerGeneration !== adapterGeneration) return;
    this.zoomPipelineTrace.noteEvent(`pdfjs-${change.kind}`);
    this.zoomPipelineTrace.noteStage("pdfjs-callback", 0, 1, `pdfjs-${change.kind}`);
    this.zoomPipelineTrace.noteStage("page-maintenance", 0, 1, `page-${change.kind}`);
    this.zoomFrameDiagnostics.notePdfSignal(change.kind === "render" ? "pagerendered" : "pagesMutation");
    if (change.kind === "render") {
      for (const surface of this.surfaces.values()) this.observeMobileCustomPinch(surface, "render");
    }
    this.queueNativeHandoffUpdate({ kind: "lifecycle", change });
  }

  onZoomChange(change: AnnotationZoomChange): void {
    const hasCustomCssPinch = [...this.surfaces.values()].some((surface) => surface.mobileCustomPinch);
    if (!hasCustomCssPinch) this.clearMobileCssZoom();
    const adapterGeneration = "viewerGeneration" in this.options.adapter
      ? this.options.adapter.viewerGeneration
      : change.viewerGeneration;
    if (change.viewerGeneration !== adapterGeneration) return;
    for (const surface of this.surfaces.values()) {
      this.observeMobileCustomPinch(surface, change.phase === "settled" ? "scale-settled" : "scale-changing");
      if (change.phase === "settled" && (change.source === "geometry" || change.source === "mutation-fallback")) {
        this.observeMobileCustomPinch(surface, "geometry");
      }
    }
    if (change.phase !== "settled") {
      this.zoomPipelineTrace.noteEvent("scalechanging");
      this.zoomPipelineTrace.noteStage("scalechanging", 0, 1, "scalechanging");
    }
    const source: ViewStateSource = change.phase === "settled" ? "data-scale" : "scalechanging";
    this.onViewStateChange(this.options.adapter.getViewState(), source);
  }

  onViewStateChange(state: AnnotationViewState, source: ViewStateSource): void {
    this.zoomPipelineTrace.noteEvent(`view-state-${source}`);
    this.zoomPipelineTrace.noteStage("view-state", 0, 1, `view-state-${source}`);
    if (source === "scalechanging") {
      this.zoomPipelineTrace.noteEvent("scalechanging");
      this.zoomPipelineTrace.noteStage("scalechanging", 0, 1, "scalechanging");
      this.zoomFrameDiagnostics.notePdfSignal("scalechanging");
    }
    this.logger.viewState(state, source);
    if (this.zoomProfile) {
      if (source === "scroll") this.zoomProfile.scrollEvents += 1;
      if (source === "pagechanging") this.zoomProfile.pageChangingEvents += 1;
    }
    if (source === "scroll") {
      if (this.selected.length) this.selectionToolbar.relayout();
      // Mobile only mounts current±pad — debounce remount; never full-refresh mid-zoom.
      if (this.runtimePlatform().mobile) this.scheduleMobileScrollRefresh();
      else this.scheduleViewportPaint();
      this.lastKnownViewScale = state.scale;
      return;
    }
    if (ViewerInkSession.isZoomRepaintSource(source)) {
      if (this.selected.length) this.selectionToolbar.relayout();
      this.scheduleZoomRepaint(`view-${source}`, state.scale);
      return;
    }
    // Pinch fires unstable pagechanging — coalesce with scroll remount path on mobile.
    if (source === "pagechanging" && this.runtimePlatform().mobile) {
      if (this.selected.length) this.selectionToolbar.relayout();
      this.scheduleMobileScrollRefresh();
      this.lastKnownViewScale = state.scale;
      return;
    }
    this.refresh(`view-${source}`);
    this.lastKnownViewScale = state.scale;
  }

  /**
   * Complete Add Page only after the replacement page set is observable.
   * Native PDF reloads may finish after the source-PDF write promise resolves;
   * restoring before that point lets PDF.js overwrite the captured scale.
   */
  private completePendingAddPageMutation(reason: string, pages: AnnotationPageInfo[]): boolean {
    const state = this.pendingAddPageMutation;
    if (!state || this.destroyed || pages.length < state.pageCountBefore + 1) return false;
    if (!this.addPageMutationViewRestored) {
      this.options.adapter.restoreViewState(state.viewState);
      this.addPageMutationViewRestored = true;
    }
    const details = this.addPageLifecycleDetails(state);
    details.settleReason = reason;
    this.noteAddPageStage("first-replacement-page-observed");
    this.addPageControl?.refresh();
    if (this.addPageControl?.isConnected()) this.noteAddPageStage("add-page-control-remounted");
    this.noteAddPageStage("mutation-complete");
    this.activeAddPageTiming = null;
    this.logger.addPageLifecycle("mutation-complete", details);
    if (details.beforeScale !== details.afterScale || details.beforeScaleMode !== details.afterScaleMode) {
      this.logger.addPageLifecycle("scale-changed", details);
    }
    if (details.staleSurfaceOverlap === true) {
      this.logger.addPageLifecycle("stale-surface-overlap", details);
    }
    this.pendingAddPageMutation = null;
    this.addPageMutationViewRestored = false;
    this.options.onAddPageMutationResolved?.(state);
    this.releasePageMutationShieldAfterSettled();
    return true;
  }

  onPagesChanged(reason: string, options?: { deferSurfaceUpdate?: boolean }): void {
    const pages = this.options.adapter.pages();
    this.logger.inputLifecycleEvent("page-structure", {
      reason,
      pageCount: pages.length,
      mountedPages: [...this.surfaces.keys()].sort((a, b) => a - b)
    });
    const overlayConnected = Object.fromEntries(
      [...this.surfaces.entries()].map(([pageNumber, surface]) => [pageNumber, surface.overlay.isConnected])
    );
    this.logger.pagesChanged(reason, pages.length, overlayConnected);

    // PDF++ reload often replaces the viewer tree — root disconnects and MutationObserver dies.
    if (!this.options.adapter.host.isConnected || !this.options.adapter.root.isConnected) {
      this.notifyDetached("root-disconnected");
      return;
    }

    // A source-PDF rewrite can publish the rebuilt pages without first
    // delivering an observable empty-page callback. The Add Page restore must
    // therefore settle on the expected page count, not only on
    // `pages-settled`.
    const addPageSettled = this.completePendingAddPageMutation(reason, pages);
    if (reason === "pages-settled" && !addPageSettled) this.releasePageMutationShieldAfterSettled();

    if (!pages.length) {
      // Transient empty during rebuild. Keep Add Page visible now; the timer is only a detach fallback.
      this.noteAddPageStage("page-dom-became-empty");
      this.addPageControl?.holdDuringReplacement();
      this.scheduleDetachCheck();
      return;
    }

    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    if (this.uiIntegrityTimer !== null) {
      window.clearTimeout(this.uiIntegrityTimer);
      this.uiIntegrityTimer = null;
    }

    this.focusInsertedPageIfReady(reason, pages);
    this.reconcileAddPageControl(pages);
    this.reconcileToolbarMount(reason);
    this.scheduleUiIntegrityCheck(reason);
    if (options?.deferSurfaceUpdate) return;

    if (this.isZoomGestureActive() && ViewerInkSession.shouldCompositeDuring(this.zoomBurstReason)) {
      this.scheduleZoomRepaint(`pages-${reason}`, this.options.adapter.getViewState().scale);
      return;
    }

    if (this.tryReattachDisconnectedSurfaces(pages)) {
      this.scheduleRefresh(`pages-reattach-${reason}`, true);
      return;
    }

    if (this.canSyncPagesWithoutRefresh(pages)) {
      for (const page of pages) {
        const surface = this.surfaces.get(page.pageNumber);
        if (surface) surface.page = page;
      }
      this.scheduleRefresh(`pages-sync-${reason}`, true);
      return;
    }

    this.scheduleRefresh(`pages-${reason}`);
  }

  private noteAddPageStage(stage: string, at = Date.now()): void {
    const timing = this.activeAddPageTiming;
    if (!timing?.mark(stage, at)) return;
    this.logger.addPageTiming(stage, timing.report(at));
  }

  /** Move Add Page as soon as a last page exists. Do not wait for ink refresh. */
  private reconcileAddPageControl(pages: AnnotationPageInfo[]): void {
    const pending = this.pendingAddPageMutation;
    const replacementReady = Boolean(pending && pages.length >= pending.pageCountBefore + 1);
    if (replacementReady) this.noteAddPageStage("first-replacement-page-observed");
    this.addPageControl?.refresh();
    if (replacementReady && this.addPageControl?.isConnected()) {
      this.noteAddPageStage("add-page-control-remounted");
    }
  }

  private scheduleDetachCheck(): void {
    if (this.destroyed || this.detachNotified || this.detachCheckTimer !== null) return;
    this.detachCheckTimer = window.setTimeout(() => {
      this.detachCheckTimer = null;
      if (this.destroyed || this.detachNotified) return;
      const { adapter } = this.options;
      if (!adapter.host.isConnected || !adapter.root.isConnected) {
        this.notifyDetached("root-disconnected-settled");
        return;
      }
      const pages = adapter.pages();
      if (!pages.length) {
        this.notifyDetached("pages-empty-settled");
        return;
      }
      // Pages returned under the same root — recover without full recreate.
      this.onPagesChanged("pages-settled");
    }, 450);
  }

  private notifyDetached(reason: string): void {
    if (this.destroyed || this.detachNotified) return;
    this.detachNotified = true;
    this.releasePageMutationShield(`detached:${reason}`);
    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    this.logger.pagesChanged(`detach:${reason}`, 0, {});
    this.options.onDetached?.();
  }

  private reconcileToolbarMount(reason: string): void {
    if (this.destroyed || !this.options.adapter.host.isConnected || !this.options.adapter.root.isConnected) return;
    const placement = this.currentToolbarPlacement();
    const toolbar = this.toolbar.element;
    const rail = mountedToolbarRail(toolbar);
    const toolbarConnected = toolbar.isConnected && this.options.adapter.host.contains(toolbar);
    const sidebarExpected = placement !== "main";
    const sidebarConnected = sidebarExpected
      && toolbarConnected
      && Boolean(rail)
      && this.options.adapter.host.contains(rail)
      && rail!.classList.contains(`is-${placement}`);
    const placementMatches = sidebarExpected
      ? sidebarConnected
      : toolbarConnected && !rail;
    if (placementMatches) return;

    this.lastToolbarUnmountReason = toolbar.isConnected ? `reconcile:${reason}` : reason;
    this.toolbarUiGeneration = Math.min(999, this.toolbarUiGeneration + 1);
    try {
      this.options.adapter.mountToolbar(toolbar, placement);
      this.lastToolbarMountReason = reason;
    } catch (error) {
      if (reason === "session-create") throw error;
    }
  }

  private scheduleUiIntegrityCheck(reason: string): void {
    if (this.destroyed) return;
    if (this.uiIntegrityTimer !== null) window.clearTimeout(this.uiIntegrityTimer);
    this.uiIntegrityTimer = window.setTimeout(() => {
      this.uiIntegrityTimer = null;
      this.verifyHandwritingUi(reason);
    }, 0);
  }

  private verifyHandwritingUi(reason: string): void {
    if (this.destroyed || !this.options.adapter.host.isConnected || !this.options.adapter.root.isConnected) return;
    const state = this.handwritingUiState(reason);
    const missing = state.toolbarExpected === true
      && (!state.toolbarConnected || (state.sidebarExpected === true && !state.sidebarConnected));
    if (!missing) return;
    const key = JSON.stringify([
      state.viewerGeneration,
      state.toolbarGeneration,
      state.pageCount,
      state.currentPage,
      state.toolbarConnected,
      state.sidebarConnected
    ]);
    if (key === this.lastHandwritingUiMissingKey) return;
    this.lastHandwritingUiMissingKey = key;
    this.logger.handwritingUiMissing(state);
  }

  private handwritingUiState(reason: string, details: Record<string, unknown> = {}): Record<string, unknown> {
    const placement = this.currentToolbarPlacement();
    const toolbar = this.toolbar.element;
    const rail = mountedToolbarRail(toolbar);
    const toolbarConnected = toolbar.isConnected && this.options.adapter.host.contains(toolbar);
    const sidebarExpected = placement !== "main";
    const sidebarConnected = sidebarExpected
      && toolbarConnected
      && Boolean(rail)
      && this.options.adapter.host.contains(rail)
      && rail!.classList.contains(`is-${placement}`);
    let currentPage: number | null = null;
    try {
      currentPage = this.options.adapter.getViewState().pageNumber;
    } catch {
      currentPage = null;
    }
    return {
      viewerGeneration: this.addPageViewerGeneration(),
      viewerElementDebugId: getDebugNodeId(this.options.adapter.root),
      oldViewerElementDebugId: this.previousViewerElementDebugId,
      sessionGeneration: this.viewerGeneration,
      toolbarGeneration: this.toolbarUiGeneration,
      hostDebugId: getDebugNodeId(this.options.adapter.host),
      mountReason: this.lastToolbarMountReason,
      unmountReason: this.lastToolbarUnmountReason,
      reason,
      connectedState: {
        host: this.options.adapter.host.isConnected,
        viewer: this.options.adapter.root.isConnected,
        toolbar: toolbar.isConnected,
        toolbarInHost: toolbarConnected,
        sidebar: Boolean(rail?.isConnected)
      },
      viewerConnected: this.options.adapter.root.isConnected,
      toolbarExpected: true,
      toolbarConnected,
      sidebarExpected,
      sidebarConnected,
      toolbarPlacement: placement,
      pageCount: Math.min(999, this.options.adapter.pages().length),
      currentPage,
      documentInputOwnership: documentInputOwnershipSnapshot(this.options.adapter.host.ownerDocument),
      ...(this.lastAddPageOperationId ? { addPageOperationId: this.lastAddPageOperationId } : {}),
      ...details
    };
  }

  /** Write a bounded UI snapshot into the vault log when Copy logs is pressed. */
  writeCopiedLogUiSnapshot(): Record<string, unknown> {
    this.ipadInputTrace?.start(this.options.debugEnabled?.() === true);
    const host = this.options.adapter.host;
    const root = this.options.adapter.root;
    const toolbar = this.toolbar.element;
    const toolbarControls = [...toolbar.querySelectorAll<HTMLElement>("[data-control]")]
      .slice(0, 32)
      .map((control) => control.dataset.control ?? "unknown");
    const nativeAddButtons = [...host.querySelectorAll<HTMLElement>("button, [role='button']")]
      .filter((button) => {
        const label = [
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.textContent,
          button.className
        ].filter(Boolean).join(" ");
        return /\badd\b|\bplus\b/i.test(label) || button.textContent?.trim() === "+";
      })
      .slice(0, 8)
      .map((button) => ({
        label: [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
          .filter(Boolean).join(" ").trim().slice(0, 96),
        classes: [...button.classList].slice(0, 8),
        connected: button.isConnected
      }));
    const snapshot = {
      ...this.handwritingUiState("copy-logs"),
      rootConnected: root.isConnected,
      hostConnected: host.isConnected,
      customToolbarCount: host.querySelectorAll(".native-pdf-handwriting-toolbar").length,
      toolbarControls,
      eraserControlConnected: Boolean(toolbar.querySelector("[data-control='eraser']")),
      addPageControlCount: root.querySelectorAll(".native-pdf-handwriting-add-page").length,
      thumbnailAddPageControlCount: host.querySelectorAll(".native-pdf-handwriting-thumbnail-add-page").length,
      pdfViewerShellCount: host.querySelectorAll(".pdf-viewer, .pdfViewer").length,
      nativePdfToolbarCount: host.querySelectorAll(".pdf-toolbar, .pdf-toolbar-container").length,
      nativeAddButtons
    };
    this.refreshZoomBurstActivity();
    const lastZoomTrace = this.postZoomTrace.diagnosis();
    const activeBurstAgeMs = typeof lastZoomTrace.burstActivity?.activeBurstAgeMs === "number"
      ? lastZoomTrace.burstActivity.activeBurstAgeMs
      : 0;
    if (lastZoomTrace.beganAt && !lastZoomTrace.settledAt && activeBurstAgeMs > ZOOM_BURST_STUCK_MS) {
      this.logger.zoomBurstStuck({
        zoomBurstId: lastZoomTrace.zoomBurstId,
        activeBurstAgeMs,
        lastSettleDeferralReason: lastZoomTrace.burstActivity?.lastSettleDeferralReason ?? null,
        zoomSettleTimerArmed: lastZoomTrace.burstActivity?.zoomSettleTimerArmed ?? null
      });
    }
    this.logger.zoomDiagnosis({
      mobilePdfZoom: this.mobilePdfZoomDiagnostics(),
      lastZoomTrace,
      lastPostZoomDurabilityTrace: this.postZoomDurability.snapshot(Date.now()),
      lastPointerTypeOrigins: this.pointerTypeOrigins.snapshot(),
      physicalContactHotPath: physicalContactHotPathStats(),
      frameTiming: this.frameTimingProfile(),
      performanceSlowSpanSummary: this.slowSpans.summary(),
      slowInkStrokeSummary: this.slowSpans.slowInkStrokeSummary(),
      frameAttributionSummary: this.lastZoomFrameAttributionSummary ?? this.zoomFrameDiagnostics.summary(),
      zoomPipelineSummary: this.lastZoomPipelineSummary ?? this.zoomPipelineTrace.summary(),
      zoomNativeHandoffSummary: this.lastZoomNativeHandoffSummary ?? this.zoomNativeHandoffTrace.summary(),
      lastZoomGesturePerformance: this.recentZoomGesturePerformance.map((entry) => ({ ...entry })),
      lastInkStrokeGeometry: this.recentInkStrokeGeometry.slice(),
      lastSuccessfulStroke: this.logger.lastSuccessfulStroke(),
      inputLifecycle: this.logger.inputLifecycleSnapshot(),
      ipadInputTrace: this.ipadInputTrace?.snapshot() ?? null
    });
    this.logger.handwritingUiSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Obsidian has no in-place PDF.js document replacement API: modifyBinary
   * destroys its page DOM before the replacement document is ready. Preserve
   * the visible native canvas plus committed ink in a document-level layer so
   * that mandatory reload looks like a stable page transition instead of a
   * full-view white flash.
   */
  private async armPageMutationShield(action: "delete" | "insert" | "reorder", pageNumber: number): Promise<void> {
    this.releasePageMutationShield("superseded");
    const ownerDocument = this.options.adapter.host.ownerDocument;
    const view = ownerDocument.defaultView;
    if (!view || !ownerDocument.body) {
      this.logger.pdfPageAction("page-shield-skipped", { action, pageNumber, reason: "document-unavailable" });
      return;
    }

    const shield = createDetachedDiv(ownerDocument);
    shield.className = "native-pdf-handwriting-page-mutation-shield";
    shield.dataset.pageAction = action;
    shield.dataset.pageNumber = String(pageNumber);

    // Copy already-rendered page canvases before asking Electron for a full
    // composited screenshot. The canvas shield is synchronous and covers the
    // expensive PDF reload path, so Add/Delete can begin without waiting for
    // capturePage on large or busy documents.
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;
    let capturedPages = 0;

    for (const surface of this.surfaces.values()) {
      const nativeCanvas = pdfRenderCanvas(surface.page.element);
      // pdfRenderCanvas deliberately falls back to any page canvas for layout
      // recovery; a draft canvas alone cannot cover the native PDF reload.
      if (!nativeCanvas || nativeCanvas.classList.contains("native-pdf-handwriting-draft-canvas")) continue;
      const rect = nativeCanvas.getBoundingClientRect();
      if (
        rect.width < 8
        || rect.height < 8
        || rect.right <= 0
        || rect.bottom <= 0
        || rect.left >= viewportWidth
        || rect.top >= viewportHeight
      ) continue;

      const snapshot = createDetachedEl(ownerDocument, "canvas");
      const context = snapshot.getContext("2d");
      if (!context) continue;
      const deviceScale = Number.isFinite(view.devicePixelRatio) && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1;
      // Prefer PDF.js' already-rendered bitmap resolution. The fallback keeps
      // the shield sharp on hosts that only expose CSS canvas dimensions.
      snapshot.width = Math.max(1, nativeCanvas.width || Math.round(rect.width * deviceScale));
      snapshot.height = Math.max(1, nativeCanvas.height || Math.round(rect.height * deviceScale));
      snapshot.className = "native-pdf-handwriting-page-mutation-snapshot";
      snapshot.dataset.pageNumber = String(surface.page.pageNumber);
      setElementCssProps(snapshot, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });

      try {
        context.drawImage(nativeCanvas, 0, 0, snapshot.width, snapshot.height);
        const inkRect = surface.canvas.getBoundingClientRect();
        if (inkRect.width >= 1 && inkRect.height >= 1) {
          const scaleX = snapshot.width / rect.width;
          const scaleY = snapshot.height / rect.height;
          context.drawImage(
            surface.canvas,
            (inkRect.left - rect.left) * scaleX,
            (inkRect.top - rect.top) * scaleY,
            inkRect.width * scaleX,
            inkRect.height * scaleY
          );
        }
      } catch {
        // A host canvas may reject readback; skip that page rather than
        // allowing a partial/empty shield to obscure the live viewer.
        snapshot.remove();
        continue;
      }
      shield.append(snapshot);
      capturedPages += 1;
    }

    if (capturedPages) {
      ownerDocument.body.append(shield);
      this.pageMutationShield = {
        element: shield,
        action,
        pageNumber,
        capturedPages,
        timeout: view.setTimeout(() => this.releasePageMutationShield("timeout"), ViewerInkSession.PAGE_MUTATION_SHIELD_TIMEOUT_MS)
      };
      this.logger.pdfPageAction("page-shield-captured", { action, pageNumber, capturedPages });
      return;
    }

    // Hosts without a readable page canvas still get the full renderer
    // snapshot. This remains an awaited fallback, not the normal Add/Delete
    // path, so capturePage latency cannot delay responsive page actions.
    const windowCapture = await captureNativePdfMutationScreenshot(this.options.adapter.host);
    if (windowCapture.kind === "captured") {
      const { screenshot } = windowCapture;
      const snapshot = createDetachedEl(ownerDocument, "img");
      snapshot.className = "native-pdf-handwriting-page-mutation-window-snapshot";
      snapshot.src = screenshot.dataUrl;
      snapshot.alt = "";
      snapshot.setAttribute("aria-hidden", "true");
      setElementCssProps(snapshot, {
        left: `${screenshot.left}px`,
        top: `${screenshot.top}px`,
        width: `${screenshot.width}px`,
        height: `${screenshot.height}px`
      });
      shield.append(snapshot);
      ownerDocument.body.append(shield);
      this.pageMutationShield = {
        element: shield,
        action,
        pageNumber,
        capturedPages: 1,
        timeout: view.setTimeout(() => this.releasePageMutationShield("timeout"), ViewerInkSession.PAGE_MUTATION_SHIELD_TIMEOUT_MS)
      };
      this.logger.pdfPageAction("page-shield-window-captured", {
        action,
        pageNumber,
        left: screenshot.left,
        top: screenshot.top,
        width: screenshot.width,
        height: screenshot.height
      });
      return;
    }
    this.logger.pdfPageAction("page-shield-window-skipped", { action, pageNumber, reason: windowCapture.reason });
    this.logger.pdfPageAction("page-shield-skipped", { action, pageNumber, reason: "no-visible-native-canvas" });
  }

  /** Begin the post-reload render handoff once replacement page nodes return. */
  private releasePageMutationShieldAfterSettled(): void {
    if (!this.pageMutationShield) return;
    if (this.pageMutationShieldSettledAt === 0) this.pageMutationShieldSettledAt = performance.now();
    this.schedulePageMutationShieldRelease();
  }

  /** Release as soon as rebuilt visible canvases survive two paints. */
  private schedulePageMutationShieldRelease(): void {
    const shield = this.pageMutationShield;
    if (!shield) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.releasePageMutationShield("pages-settled-no-window");
      return;
    }
    this.cancelPageMutationShieldRelease();
    this.pageMutationShieldReleaseFramesRemaining = ViewerInkSession.PAGE_MUTATION_SHIELD_READY_FRAMES;
    this.logger.pdfPageAction("page-shield-waiting", {
      action: shield.action,
      pageNumber: shield.pageNumber,
      maxWaitMs: ViewerInkSession.PAGE_MUTATION_SHIELD_RENDER_TIMEOUT_MS,
      nativeContentMutations: this.pageMutationShieldNativeContentMutations,
      sinceSettleMs: roundMs(performance.now() - this.pageMutationShieldSettledAt)
    });
    this.waitForPageMutationShieldReadiness(view);
  }

  private waitForPageMutationShieldReadiness(view: Window): void {
    this.pageMutationShieldReleaseFrame = view.requestAnimationFrame(() => {
      this.pageMutationShieldReleaseFrame = null;
      const shield = this.pageMutationShield;
      if (!shield) return;
      const now = performance.now();
      const canvas = this.pageMutationCanvasReadiness();
      const nativeQuiet = this.lastPageMutationShieldNativeContentAt === 0
        || now - this.lastPageMutationShieldNativeContentAt >= ViewerInkSession.PAGE_MUTATION_SHIELD_RENDER_QUIET_MS;
      const timedOut = now - this.pageMutationShieldSettledAt >= ViewerInkSession.PAGE_MUTATION_SHIELD_RENDER_TIMEOUT_MS;
      if (canvas.ready && nativeQuiet) this.pageMutationShieldReleaseFramesRemaining -= 1;
      else this.pageMutationShieldReleaseFramesRemaining = ViewerInkSession.PAGE_MUTATION_SHIELD_READY_FRAMES;
      if (timedOut || this.pageMutationShieldReleaseFramesRemaining <= 0) {
        this.logger.pdfPageAction("page-shield-ready", {
          action: shield.action,
          pageNumber: shield.pageNumber,
          readyPages: canvas.readyPages,
          visiblePages: canvas.visiblePages,
          nativeQuiet,
          timedOut,
          heldMs: roundMs(now - this.pageMutationShieldSettledAt)
        });
        this.releasePageMutationShield(timedOut ? "pages-settled-timeout" : "pages-settled-ready");
        return;
      }
      this.waitForPageMutationShieldReadiness(view);
    });
  }

  private pageMutationCanvasReadiness(): { ready: boolean; visiblePages: number; readyPages: number } {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    const pages = this.options.adapter.pages();
    const visible = pages.filter((page) => {
      const rect = page.element.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8 && rect.right > 0 && rect.bottom > 0
        && rect.left < (view?.innerWidth ?? 0) && rect.top < (view?.innerHeight ?? 0);
    });
    const considered = visible.length > 0 ? visible : pages;
    const readyPages = considered.filter((page) => {
      const canvas = pdfRenderCanvas(page.element);
      if (!canvas || !canvas.isConnected || canvas.width < 1 || canvas.height < 1) return false;
      const rect = canvas.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8;
    }).length;
    return { ready: considered.length > 0 && readyPages === considered.length, visiblePages: considered.length, readyPages };
  }

  private cancelPageMutationShieldRelease(): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (this.pageMutationShieldReleaseFrame !== null) {
      view?.cancelAnimationFrame(this.pageMutationShieldReleaseFrame);
      this.pageMutationShieldReleaseFrame = null;
    }
    this.pageMutationShieldReleaseFramesRemaining = 0;
  }

  private releasePageMutationShield(reason: string): void {
    const shield = this.pageMutationShield;
    if (!shield) return;
    const view = shield.element.ownerDocument.defaultView;
    if (shield.timeout !== null) view?.clearTimeout(shield.timeout);
    this.cancelPageMutationShieldRelease();
    this.pageMutationShield = null;
    this.pageMutationShieldSettledAt = 0;
    this.pageMutationShieldNativeContentMutations = 0;
    this.lastPageMutationShieldNativeContentAt = 0;
    shield.element.remove();
    this.logger.pdfPageAction("page-shield-released", {
      action: shield.action,
      pageNumber: shield.pageNumber,
      capturedPages: shield.capturedPages,
      reason
    });
  }

  private reattachSurface(
    surface: PageSurface,
    page: AnnotationPageInfo,
    syncLayout = true,
    maintainRouter = true
  ): boolean {
    if (!page.element.isConnected || surface.page.element !== page.element) return false;
    if (surface.overlay.isConnected) {
      if (!page.element.contains(surface.overlay)) return false;
      this.rememberPageMetrics(page);
      this.applyTouchDrawPolicy(page.element, this.touchDrawPolicyEnabled ?? false);
      if (syncLayout) this.syncOverlayLayout(surface);
      if (maintainRouter) this.ensurePageRouter(surface);
      return true;
    }
    this.ensurePagePositioning(page.element);
    page.element.append(surface.overlay);
    this.rememberPageMetrics(page);
    this.applyTouchDrawPolicy(page.element, this.touchDrawPolicyEnabled ?? false);
    if (syncLayout) this.syncOverlayLayout(surface);
    if (maintainRouter) this.ensurePageRouter(surface);
    return true;
  }

  private remountSurfaceOnPageReplacement(surface: PageSurface, page: AnnotationPageInfo, syncLayout = true): void {
    this.lastPageReplacementAt = Date.now();
    const previousPage = surface.page.element;
    this.logger.inputLifecycleEvent("page-dom-replacement", {
      page: page.pageNumber,
      previousPageId: getDebugNodeId(previousPage),
      nextPageId: getDebugNodeId(page.element),
      previousConnected: previousPage.isConnected,
      nextConnected: page.element.isConnected
    });
    this.commitActiveDrawBeforeSurfaceLoss(surface, "pdf-page-replaced");
    surface.router?.destroy();
    surface.router = null;
    this.clearTouchDrawPolicy(previousPage);
    this.releaseInputOwner(previousPage);
    this.ensurePagePositioning(page.element);
    page.element.append(surface.overlay);
    surface.page = page;
    this.claimInputOwner(page.element, page.pageNumber);
    this.rememberPageMetrics(page);
    this.applyTouchDrawPolicy(page.element, this.touchDrawPolicyEnabled ?? false);
    if (syncLayout) this.syncOverlayLayout(surface);
    surface.router = this.createPageRouter(surface);
  }

  private tryReattachDisconnectedSurfaces(pages: AnnotationPageInfo[]): boolean {
    let reattached = false;
    for (const page of pages) {
      const surface = this.surfaces.get(page.pageNumber);
      if (!surface) continue;
      const overlayBelongsToPage = surface.overlay.isConnected && page.element.contains(surface.overlay);
      if (overlayBelongsToPage && surface.page.element === page.element) continue;
      if (!page.element.isConnected) continue;
      // PDF.js can replace a page while its prior page and overlay remain
      // connected. Move both the overlay and its page-bound router together.
      if (surface.page.element !== page.element || surface.overlay.isConnected) {
        this.remountSurfaceOnPageReplacement(surface, page);
        reattached = true;
        continue;
      }
      if (this.reattachSurface(surface, page)) reattached = true;
    }
    return reattached;
  }

  private canSyncPagesWithoutRefresh(pages: AnnotationPageInfo[]): boolean {
    if (pages.length !== this.surfaces.size) return false;
    return pages.every((page) => {
      const surface = this.surfaces.get(page.pageNumber);
      if (!surface) return false;
      return surface.page.element === page.element
        && surface.overlay.isConnected
        && page.element.contains(surface.overlay);
    });
  }

  isDirty(): boolean {
    return this.saveCoordinator.hasUnsavedChanges() || this.autosave.isDirty(this.identity.id);
  }

  async manualSave(): Promise<void> {
    const started = performance.now();
    this.logger.textTool("manual-save-start", { textCount: this.texts.all().length, dirty: this.isDirty() });
    this.toolbar.setSaveStatus("saving");
    try {
      await this.saveCoordinator.manualSave();
      // A pending debounce may contain the pre-manual-save snapshot. Marking it
      // clean cancels that stale timer instead of replaying it after this save.
      this.autosave.markClean(this.identity.id);
      this.toolbar.setSaveStatus("saved", new Date());
      this.options.notice("Annotations saved.");
      this.logger.textTool("manual-save-complete", { textCount: this.texts.all().length, dirty: this.isDirty() });
      this.reportDevProbe("manual-save", { ok: true, durationMs: roundMs(performance.now() - started), dirty: this.isDirty() });
    } catch (error) {
      this.toolbar.setSaveStatus("failed");
      this.options.notice(`Save failed: ${this.errorMessage(error)}`);
      this.logger.textTool("manual-save-error", { textCount: this.texts.all().length, error: this.errorMessage(error) });
      this.reportDevProbe("manual-save", { ok: false, durationMs: roundMs(performance.now() - started) });
      throw error;
    }
  }

  /** Import selected native pages after the current page and commit one sidecar remap. */
  async importPagesAfter(afterPage: number): Promise<void> {
    if (!this.options.onImportPages || !this.options.writeSourcePdf) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("insert-cancel", { requestedPageNumber: afterPage, reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    this.logger.pdfPageAction("insert-start", { requestedPageNumber: afterPage + 1, kind: "import", dirty: this.isDirty() });
    try {
      const mutation = await this.options.onImportPages(afterPage);
      if (!mutation) {
        this.logger.pdfPageAction("insert-cancel", { requestedPageNumber: afterPage + 1, reason: "picker-cancel" });
        return;
      }
      this.commitActiveTextEditor("page-import");
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      const beforeMetrics = new Map(this.pageMetrics);
      const readDocument = this.options.readDocument ?? this.options.readSourcePdf;
      if (!readDocument) return;
      const beforePdf = await readDocument();
      const expectedPageCount = this.options.adapter.pages().length + mutation.pageCount;
      this.pendingInsertedPageFocus = {
        pageNumber: mutation.pageNumber,
        expectedPageCount
      };
      await this.armPageMutationShield("insert", mutation.pageNumber);
      await this.options.writeSourcePdf(mutation.bytes);
      const remapped = this.applyImportedPagesToSession(before, mutation.pageNumber, mutation.pageCount);
      try {
        await this.persist(remapped, "page-import");
      } catch (error) {
        await this.options.writeSourcePdf(beforePdf).catch((rollbackError) => {
          throw new Error(`${this.errorMessage(error)}; PDF rollback failed: ${this.errorMessage(rollbackError)}`);
        });
        this.restoreSidecarSnapshot(before, beforeMetrics);
        await this.persist(before, "page-import-rollback").catch(() => undefined);
        throw error;
      }
      this.autosave.markClean(this.identity.id);
      this.saveCoordinator.markSaved();
      this.toolbar.setSaveStatus("saved", new Date());
      this.focusInsertedPageIfReady("import-complete", this.options.adapter.pages());
      this.logger.pdfPageAction("insert-complete", {
        requestedPageNumber: afterPage + 1,
        insertedPage: mutation.pageNumber,
        count: mutation.pageCount,
        sourcePageNumbers: mutation.pageNumbers
      });
      this.options.notice(`Imported ${mutation.pageCount} page${mutation.pageCount === 1 ? "" : "s"}.`);
    } catch (error) {
      this.pendingInsertedPageFocus = null;
      this.releasePageMutationShield("insert-error");
      this.logger.pdfPageAction("insert-error", {
        requestedPageNumber: afterPage + 1,
        kind: "import",
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not import pages: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  private addPageViewerGeneration(): number | null {
    const candidate = this.options.adapter as AnnotationSurface & { viewerGeneration?: unknown };
    return typeof candidate.viewerGeneration === "number" && Number.isFinite(candidate.viewerGeneration)
      ? candidate.viewerGeneration
      : null;
  }

  private captureAddPageMutationState(operationId: string, startedAt: number): AddPageMutationRestoreState {
    const viewState = this.options.adapter.getViewState();
    const pages = this.options.adapter.pages().slice(0, 64);
    const mounted = [...this.surfaces.entries()].slice(0, 64);
    const scroll = this.options.adapter.scrollElement();
    return {
      operationId,
      startedAt,
      capturedAt: Date.now(),
      viewState,
      pageCountBefore: this.options.adapter.pages().length,
      currentPageBefore: viewState.pageNumber,
      mountedPageNumbers: mounted.map(([pageNumber]) => pageNumber),
      pageMountGenerationsBefore: pages.map((page) => page.mountGeneration ?? null),
      routerGenerationsBefore: this.currentRouterGenerations(),
      viewerGenerationBefore: this.addPageViewerGeneration(),
      viewerElementDebugIdBefore: getDebugNodeId(this.options.adapter.root),
      pageDomIds: pages.map((page) => getDebugNodeId(page.element)),
      canvasIds: pages.map((page) => getDebugNodeId(pdfRenderCanvas(page.element))),
      overlayIds: mounted.map(([, surface]) => getDebugNodeId(surface.overlay)),
      pageRectsBefore: pages.map((page) => rectDetails(page.element)),
      viewportBefore: rectDetails(this.options.adapter.root),
      scrollBefore: {
        left: scroll.scrollLeft,
        top: scroll.scrollTop,
        width: scroll.clientWidth,
        height: scroll.clientHeight
      },
      beforePageElements: pages.map((page) => page.element),
      beforeOverlayElements: mounted.map(([, surface]) => surface.overlay)
    };
  }

  private addPageLifecycleDetails(state: AddPageMutationRestoreState): Record<string, unknown> {
    const viewState = this.options.adapter.getViewState();
    const pages = this.options.adapter.pages().slice(0, 64);
    const mounted = [...this.surfaces.entries()].slice(0, 64);
    const scroll = this.options.adapter.scrollElement();
    const pageElements = new Set(pages.map((page) => page.element));
    const overlayElements = new Set(mounted.map(([, surface]) => surface.overlay));
    const stalePages = state.beforePageElements
      ? state.beforePageElements.filter((element) => element.isConnected && !pageElements.has(element)).length
      : null;
    const staleOverlays = state.beforeOverlayElements
      ? state.beforeOverlayElements.filter((element) => element.isConnected && !overlayElements.has(element)).length
      : null;
    return {
      addPageOperationId: state.operationId,
      startedAt: state.startedAt,
      capturedAt: state.capturedAt,
      elapsedMs: Math.max(0, Date.now() - state.startedAt),
      pageCountBefore: state.pageCountBefore,
      pageCountAfter: this.options.adapter.pages().length,
      pageCountDelta: this.options.adapter.pages().length - state.pageCountBefore,
      expectedPageCountDelta: 1,
      currentPageBefore: state.currentPageBefore,
      currentPageAfter: viewState.pageNumber,
      beforeScale: Number(state.viewState.scale.toFixed(4)),
      afterScale: Number(viewState.scale.toFixed(4)),
      beforeScaleMode: state.viewState.scaleMode ?? null,
      afterScaleMode: viewState.scaleMode ?? null,
      beforeScrollFraction: Number(state.viewState.scrollFraction.toFixed(4)),
      afterScrollFraction: Number(viewState.scrollFraction.toFixed(4)),
      mountedPageNumbersBefore: state.mountedPageNumbers,
      mountedPageNumbersAfter: mounted.map(([pageNumber]) => pageNumber),
      pageMountGenerationsBefore: state.pageMountGenerationsBefore,
      pageMountGenerationsAfter: pages.map((page) => page.mountGeneration ?? null),
      routerGenerationsBefore: state.routerGenerationsBefore,
      routerGenerationsAfter: this.currentRouterGenerations(),
      viewerGenerationBefore: state.viewerGenerationBefore,
      viewerGenerationAfter: this.addPageViewerGeneration(),
      pageDomIdsBefore: state.pageDomIds,
      pageDomIdsAfter: pages.map((page) => getDebugNodeId(page.element)),
      canvasIdsBefore: state.canvasIds,
      canvasIdsAfter: pages.map((page) => getDebugNodeId(pdfRenderCanvas(page.element))),
      overlayIdsBefore: state.overlayIds,
      overlayIdsAfter: mounted.map(([, surface]) => getDebugNodeId(surface.overlay)),
      pageRectsBefore: state.pageRectsBefore,
      pageRectsAfter: pages.map((page) => rectDetails(page.element)),
      viewportBefore: state.viewportBefore,
      viewportAfter: rectDetails(this.options.adapter.root),
      scrollBefore: state.scrollBefore,
      scrollAfter: {
        left: scroll.scrollLeft,
        top: scroll.scrollTop,
        width: scroll.clientWidth,
        height: scroll.clientHeight
      },
      staleOldPagesConnected: stalePages,
      staleOldOverlaysConnected: staleOverlays,
      oldSurfaceDetachMs: state.beforePageElements?.every((element) => !element.isConnected)
        && state.beforeOverlayElements?.every((element) => !element.isConnected)
        ? Math.max(0, Date.now() - state.capturedAt)
        : null,
      staleSurfaceOverlap: (stalePages ?? 0) > 0 || (staleOverlays ?? 0) > 0
    };
  }

  async addPageAt(requestedPageNumber: number): Promise<void> {
    if (!this.options.onInsertPage) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("insert-cancel", { requestedPageNumber, reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    const startedAt = Date.now();
    let mutation: AddPageMutationRestoreState | null = null;
    this.activeAddPageTiming = new AddPageTiming(this.id(), startedAt);
    this.noteAddPageStage("add-page-ui-click", startedAt);
    this.noteAddPageStage("add-page-ui-busy", startedAt);
    this.addPageControl?.holdDuringReplacement();
    this.logger.pdfPageAction("insert-start", { requestedPageNumber, dirty: this.isDirty() });
    try {
      // The source PDF is replaced in place. Flush first so its sidecar has
      // the just-finished stroke/text edit before PDF.js reloads the document.
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      mutation = this.captureAddPageMutationState(this.id(), startedAt);
      this.lastAddPageOperationId = mutation.operationId;
      this.pendingAddPageMutation = mutation;
      this.addPageMutationViewRestored = false;
      this.options.onAddPageMutationStart?.(mutation);
      this.activeAddPageTiming?.setOperationId(mutation.operationId);
      this.noteAddPageStage("mutation-start");
      this.logger.addPageLifecycle("before-mutation", this.addPageLifecycleDetails(mutation));
      this.pendingInsertedPageFocus = {
        pageNumber: requestedPageNumber,
        expectedPageCount: mutation.pageCountBefore + 1
      };
      await this.armPageMutationShield("insert", requestedPageNumber);
      const report = (stage: string): void => this.noteAddPageStage(stage);
      const insertedPage = await this.options.onInsertPage(requestedPageNumber, report);
      if (this.pendingInsertedPageFocus) this.pendingInsertedPageFocus.pageNumber = insertedPage;
      this.applyInsertedPageToSession(before, insertedPage);
      this.completePendingAddPageMutation("insert-complete", this.options.adapter.pages());
      this.focusInsertedPageIfReady("insert-complete", this.options.adapter.pages());
      this.logger.pdfPageAction("insert-complete", {
        requestedPageNumber,
        insertedPage,
        ...(mutation ? { addPageOperationId: mutation.operationId } : {})
      });
      this.options.notice(`Added page ${insertedPage}.`);
    } catch (error) {
      this.pendingInsertedPageFocus = null;
      this.releasePageMutationShield("insert-error");
      this.pendingAddPageMutation = null;
      this.addPageMutationViewRestored = false;
      this.activeAddPageTiming = null;
      if (mutation && !this.destroyed) this.options.onAddPageMutationResolved?.(mutation);
      this.logger.pdfPageAction("insert-error", {
        requestedPageNumber,
        ...(mutation ? { addPageOperationId: mutation.operationId } : {}),
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not add a page: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  private async scanDocument(): Promise<void> {
    if (!this.options.openScanDocument || !this.options.onInsertScannedPages) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("scan-cancel", { reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const requestedPageNumber = Math.max(1, currentPage + 1);
    this.logger.pdfPageAction("scan-start", { requestedPageNumber, dirty: this.isDirty() });
    try {
      const pages = await this.options.openScanDocument();
      if (!pages?.length) {
        this.logger.pdfPageAction("scan-cancel", { requestedPageNumber, reason: "capture-canceled" });
        return;
      }
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      this.pendingInsertedPageFocus = {
        pageNumber: requestedPageNumber,
        expectedPageCount: this.options.adapter.pages().length + pages.length
      };
      await this.armPageMutationShield("insert", requestedPageNumber);
      const insertedPage = await this.options.onInsertScannedPages(requestedPageNumber, pages);
      if (this.pendingInsertedPageFocus) this.pendingInsertedPageFocus.pageNumber = insertedPage;
      this.applyInsertedPagesToSession(before, insertedPage, pages.length);
      this.focusInsertedPageIfReady("scan-complete", this.options.adapter.pages());
      this.logger.pdfPageAction("scan-complete", {
        requestedPageNumber,
        insertedPage,
        count: pages.length
      });
      this.options.notice(`Inserted ${pages.length} scanned page${pages.length === 1 ? "" : "s"} after page ${currentPage}.`);
    } catch (error) {
      this.pendingInsertedPageFocus = null;
      this.releasePageMutationShield("scan-error");
      this.logger.pdfPageAction("scan-error", {
        requestedPageNumber,
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not scan document: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  /** Focus only once native PDF.js has published the post-insert page count. */
  private focusInsertedPageIfReady(reason: string, pages: AnnotationPageInfo[]): void {
    const pending = this.pendingInsertedPageFocus;
    if (!pending || pages.length < pending.expectedPageCount) return;
    if (!this.options.adapter.focusPage(pending.pageNumber)) return;
    this.pendingInsertedPageFocus = null;
    this.logger.pdfPageAction("insert-focus", { pageNumber: pending.pageNumber, reason, pageCount: pages.length });
  }

  /** Keep live ink/text state synchronized with the remapped on-disk sidecar. */
  private applyInsertedPageToSession(before: SidecarSchemaV1, insertedPage: number): void {
    this.applyInsertedPagesToSession(before, insertedPage, 1);
  }

  private applyInsertedPagesToSession(before: SidecarSchemaV1, insertedPage: number, count: number): void {
    this.commitActiveTextEditor("page-insert");
    this.cancelTextBoxTransform("page-insert", false);
    const remapped = insertPagesIntoSidecar(before, insertedPage, count);
    this.ink.clear();
    this.texts.clear();
    for (const page of remapped.pages) {
      for (const stroke of page.strokes) this.ink.add(stroke);
      for (const text of page.texts ?? []) this.texts.add(text);
    }
    const metrics = [...this.pageMetrics.entries()];
    this.pageMetrics.clear();
    for (const [page, value] of metrics) this.pageMetrics.set(page >= insertedPage ? page + count : page, value);
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.autosave.markClean(this.identity.id);
    this.saveCoordinator.markSaved();
    this.toolbar.setSaveStatus("saved", new Date());
    this.scheduleRefresh("page-insert", true);
  }

  private applyImportedPagesToSession(
    before: SidecarSchemaV1,
    insertedPage: number,
    insertedPageCount: number
  ): SidecarSchemaV1 {
    this.cancelTextBoxTransform("page-import", false);
    const remapped = insertPagesIntoSidecar(before, insertedPage, insertedPageCount);
    this.hydrateSidecarSnapshot(remapped);
    const metrics = [...this.pageMetrics.entries()];
    this.pageMetrics.clear();
    for (const [page, value] of metrics) {
      this.pageMetrics.set(page >= insertedPage ? page + insertedPageCount : page, value);
    }
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.scheduleRefresh("page-import", true);
    return remapped;
  }

  private hydrateSidecarSnapshot(snapshot: SidecarSchemaV1): void {
    this.ink.clear();
    this.texts.clear();
    for (const page of snapshot.pages) {
      for (const stroke of page.strokes) this.ink.add(stroke);
      for (const text of page.texts ?? []) this.texts.add(text);
    }
  }

  private restoreSidecarSnapshot(
    snapshot: SidecarSchemaV1,
    metrics: ReadonlyMap<number, { width: number; height: number }>
  ): void {
    this.hydrateSidecarSnapshot(snapshot);
    this.pageMetrics.clear();
    for (const [page, value] of metrics) this.pageMetrics.set(page, value);
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.autosave.markClean(this.identity.id);
    this.saveCoordinator.markSaved();
    this.toolbar.setSaveStatus("saved", new Date());
    this.scheduleRefresh("page-import-rollback", true);
  }

  private async reorderPage(fromPage: number, toPage: number): Promise<void> {
    if (!this.options.onReorderPage || fromPage === toPage) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("reorder-cancel", { fromPage, toPage, reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    this.logger.pdfPageAction("reorder-start", { fromPage, toPage, dirty: this.isDirty() });
    try {
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      const metrics = new Map(this.pageMetrics);
      await this.armPageMutationShield("reorder", fromPage);
      await this.options.onReorderPage(fromPage, toPage);
      this.applyReorderedPageToSession(before, fromPage, toPage, metrics);
      this.logger.pdfPageAction("reorder-complete", { fromPage, toPage });
      this.options.notice(`Moved page ${fromPage} to position ${toPage}.`);
    } catch (error) {
      this.releasePageMutationShield("reorder-error");
      this.logger.pdfPageAction("reorder-error", {
        fromPage,
        toPage,
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not reorder page ${fromPage}: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  private async deletePage(pageNumber: number): Promise<void> {
    if (!this.options.onDeletePage) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("delete-cancel", { pageNumber, reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    this.logger.pdfPageAction("delete-start", { pageNumber, dirty: this.isDirty() });
    try {
      // Make the persisted sidecar authoritative before main rewrites both the
      // PDF and its page-numbered sidecar/recovery data.
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      await this.armPageMutationShield("delete", pageNumber);
      await this.options.onDeletePage(pageNumber);
      this.applyDeletedPageToSession(before, pageNumber);
      this.logger.pdfPageAction("delete-complete", { pageNumber });
      this.options.notice(`Deleted page ${pageNumber}.`);
    } catch (error) {
      this.releasePageMutationShield("delete-error");
      this.logger.pdfPageAction("delete-error", { pageNumber, error: this.errorMessage(error) });
      this.options.notice(`Could not delete page ${pageNumber}: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  /** Deletes original page numbers together so PDF, sidecar, and live state stay aligned. */
  private async deletePages(requestedPageNumbers: readonly number[]): Promise<void> {
    if (!this.options.onDeletePages) return;
    const pageNumbers = [...new Set(requestedPageNumbers)]
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1)
      .sort((left, right) => right - left);
    if (pageNumbers.length <= 1) {
      if (pageNumbers[0] !== undefined) await this.deletePage(pageNumbers[0]);
      return;
    }
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("delete-cancel", {
        pageNumbers,
        count: pageNumbers.length,
        reason: "page-mutation-in-flight"
      });
      return;
    }
    this.pageMutationInFlight = true;
    const firstPage = pageNumbers.at(-1)!;
    const lastPage = pageNumbers[0]!;
    this.logger.pdfPageAction("delete-range-start", {
      pageNumbers,
      firstPage,
      lastPage,
      count: pageNumbers.length,
      dirty: this.isDirty()
    });
    try {
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      await this.armPageMutationShield("delete", lastPage);
      await this.options.onDeletePages(pageNumbers);
      this.applyDeletedPagesToSession(before, pageNumbers);
      this.logger.pdfPageAction("delete-range-complete", {
        pageNumbers,
        firstPage,
        lastPage,
        count: pageNumbers.length
      });
      this.options.notice(`Deleted ${pageNumbers.length} pages.`);
    } catch (error) {
      this.releasePageMutationShield("delete-range-error");
      this.logger.pdfPageAction("delete-range-error", {
        pageNumbers,
        count: pageNumbers.length,
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not delete ${pageNumbers.length} pages: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  /** Keep live ink/text state synchronized with a reordered on-disk sidecar. */
  private applyReorderedPageToSession(
    before: SidecarSchemaV1,
    fromPage: number,
    toPage: number,
    metrics: ReadonlyMap<number, { width: number; height: number }>
  ): void {
    this.commitActiveTextEditor("page-reorder");
    this.cancelTextBoxTransform("page-reorder", false);
    const remapped = reorderPageInSidecar(before, fromPage, toPage);
    this.hydrateSidecarSnapshot(remapped);
    this.pageMetrics.clear();
    for (const [page, value] of metrics) {
      this.pageMetrics.set(reorderPageNumber(page, fromPage, toPage), value);
    }
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.autosave.markClean(this.identity.id);
    this.saveCoordinator.markSaved();
    this.toolbar.setSaveStatus("saved", new Date());
    this.scheduleRefresh("page-reorder", true);
  }

  /** Keep live ink/text state synchronized with the remapped on-disk sidecar. */
  private applyDeletedPageToSession(before: SidecarSchemaV1, deletedPage: number): void {
    this.applyDeletedPagesToSession(before, [deletedPage]);
  }

  /** Applies a descending original-page deletion plan once to the live session. */
  private applyDeletedPagesToSession(before: SidecarSchemaV1, deletedPageNumbers: readonly number[]): void {
    this.commitActiveTextEditor("page-delete");
    this.cancelTextBoxTransform("page-delete", false);
    const deletedPages = [...new Set(deletedPageNumbers)].sort((left, right) => right - left);
    let remapped = before;
    for (const pageNumber of deletedPages) remapped = removePageFromSidecar(remapped, pageNumber);
    this.ink.clear();
    this.texts.clear();
    for (const page of remapped.pages) {
      for (const stroke of page.strokes) this.ink.add(stroke);
      for (const text of page.texts ?? []) this.texts.add(text);
    }
    const metrics = [...this.pageMetrics.entries()];
    this.pageMetrics.clear();
    const deletedSet = new Set(deletedPages);
    for (const [page, value] of metrics) {
      if (deletedSet.has(page)) continue;
      let removedBeforePage = 0;
      for (let i = 0; i < deletedPages.length; i++) {
        const dp = deletedPages[i];
        if (dp !== undefined && dp < page) {
          removedBeforePage = deletedPages.length - i;
          break;
        }
      }
      this.pageMetrics.set(page - removedBeforePage, value);
    }
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.autosave.markClean(this.identity.id);
    this.saveCoordinator.markSaved();
    this.toolbar.setSaveStatus("saved", new Date());
    this.scheduleRefresh("page-delete", true);
  }

  async flush(): Promise<void> {
    if (this.writesAbandoned) return;
    if (this.options.settings.autosave) await this.autosave.flush(this.identity.id);
    else if (this.options.settings.saveWhenClosing && this.isDirty()) await this.manualSave();
  }

  /** Stop this session from writing the sidecar — a newer session owns the document. */
  abandonWrites(reason = "abandoned"): void {
    if (this.writesAbandoned) return;
    this.writesAbandoned = true;
    this.autosave.abandon();
    this.saveCoordinator.markSaved();
    this.logger.sidecarPersist({
      reason,
      documentId: this.identity.id,
      strokeCount: this.ink.all().length,
      textCount: this.texts.all().length,
      dirty: false,
      updatedAt: new Date().toISOString(),
      skipped: "abandoned-writer"
    });
  }

  getDocumentId(): string {
    return this.identity.id;
  }

  getPersistEpoch(): number {
    return this.persistEpoch;
  }

  emergencyPersist(writeSync: VaultSyncWriter, options: { force?: boolean; reason?: string } = {}): void {
    const reason = options.reason ?? "emergency";
    if (this.writesAbandoned) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount: this.ink.all().length,
        textCount: this.texts.all().length,
        dirty: false,
        updatedAt: new Date().toISOString(),
        skipped: "abandoned-writer"
      });
      return;
    }
    const liveEpoch = this.options.livePersistEpoch?.(this.identity.id);
    if (liveEpoch !== undefined && liveEpoch !== this.persistEpoch) {
      this.abandonWrites(`stale-epoch-emergency:${this.persistEpoch}<${liveEpoch}`);
      return;
    }
    // Main can call emergencyPersist before destroy({ alreadyPersisted: true }).
    // Finalize first so that snapshot cannot omit a line held during teardown.
    for (const surface of this.surfaces.values()) {
      this.commitActiveDrawBeforeSurfaceLoss(surface, "emergency-persist");
    }
    const strokeCount = this.ink.all().length;
    const textCount = this.texts.all().length;
    if (!options.force && !this.isDirty()) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: false,
        updatedAt: new Date().toISOString(),
        skipped: "not-dirty"
      });
      return;
    }
    try {
      const snapshot = this.snapshot();
      const serialized = serializeSidecar(snapshot);
      writeSync(this.options.sidecars.pathFor(this.identity.id), serialized);
      writeSync(this.options.recovery.pathFor(this.identity.id), serialized);
      this.autosave.markClean(this.identity.id);
      this.saveCoordinator.markSaved();
      this.alreadyEmergencyPersisted = true;
      // Block further async persist; in-flight drains re-check stillOwnsPersist.
      this.writesAbandoned = true;
      this.autosave.abandon();
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount: countSidecarStrokes(snapshot),
        textCount: countSidecarTexts(snapshot),
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: this.isDirty(),
        updatedAt: new Date().toISOString(),
        error: this.errorMessage(error)
      });
    }
  }

  private mobilePdfZoomDiagnostics(): MobilePdfZoomDiagnostics {
    const settingEnabled = this.customMobilePdfPinchZoomEnabledOverride
      ?? this.options.settings.customMobilePdfPinchZoom === true;
    const extensions = pdfSurfaceExtensions(this.options.adapter);
    const report = extensions?.compatibilityReport?.();
    const surfaceType = this.options.adapter.surfaceType ?? "image";
    let mode: MobileCustomPdfZoomMode = "native-fallback";
    let fallbackReasons: MobileCustomPdfZoomFallbackReason[] = [];
    if (surfaceType !== "pdf") {
      fallbackReasons = ["non-pdf-surface"];
    } else if (!report?.platform) {
      fallbackReasons = [
        ...(!settingEnabled ? ["setting-disabled" as const] : []),
        "platform-unknown"
      ];
    } else if (!report.profile) {
      fallbackReasons = [
        ...(!settingEnabled ? ["setting-disabled" as const] : []),
        "viewer-root-unavailable"
      ];
    } else {
      const page = this.options.adapter.page(this.options.adapter.getViewState().pageNumber) ?? null;
      const plan = planMobileCustomPdfZoom({
        enabled: settingEnabled,
        surfaceType,
        platform: report.platform,
        profile: report.profile,
        page
      });
      mode = plan.mode;
      fallbackReasons = [...plan.fallbackReasons];
    }
    if (mode === "native-fallback") {
      this.mobilePdfZoomTrace.setFallbackReason(fallbackReasons[0] ?? "unsupported");
    }
    const active = [...this.surfaces.values()].find((surface) => surface.mobileCustomPinch);
    return {
      settingEnabled,
      mode,
      fallbackReasons,
      active: Boolean(active),
      activePhase: active?.mobileCustomPinch?.nativePhase() ?? null,
      trace: this.mobilePdfZoomTrace.summary()
    };
  }

  getMobilePdfZoomDiagnostics(): MobilePdfZoomDiagnostics {
    return this.mobilePdfZoomDiagnostics();
  }

  getDiagnostics(): SessionDiagnostics {
    return {
      documentPath: this.options.documentPath,
      compatibility: this.options.adapter.compatibilityReport(),
      mobilePdfZoom: this.mobilePdfZoomDiagnostics(),
      debug: this.debugState
    };
  }

  /** Bounded ownership state for plugin-level session registry diagnostics. */
  getUiLifecycleSnapshot(reason = "session-registry"): Record<string, unknown> {
    const pageRouters = [...this.surfaces.values()].filter((surface) => surface.router).length;
    const ownsDocumentInput = this.documentInputOwnership?.isOwner() === true && !this.pointerProbeAbort.signal.aborted;
    const activeInputCollectors = {
      documentProbeListener: ownsDocumentInput ? 1 : 0,
      pageRouters,
      ownedInputPages: this.ownedInputPages.size,
      physicalContactPointers: this.physicalContactIdsByPointer.size,
      physicalContactCollector: this.physicalContactCollectorLease?.snapshot().listenerRegistered ? 1 : 0
    };
    const base = (() => {
      try {
        return this.handwritingUiState(reason);
      } catch (error) {
        return {
          reason,
          uiSnapshotError: error instanceof Error ? error.message : String(error)
        };
      }
    })();
    return {
      ...base,
      destroyed: this.destroyed,
      detachNotified: this.detachNotified,
      activeInputCollectors: {
        ...activeInputCollectors,
        total: Object.values(activeInputCollectors).reduce((sum, count) => sum + count, 0)
      },
      physicalContactCollector: this.physicalContactCollectorLease?.snapshot() ?? null,
      mobilePdfZoom: this.mobilePdfZoomDiagnostics(),
      activeRouterGenerations: [...this.surfaces.values()]
        .map((surface) => surface.router?.generation ?? null)
        .filter((generation): generation is number => generation !== null)
    };
  }

  refreshDiagnostics(): void {
    this.updateDebug();
  }

  private beginInputTeardown(): void {
    if (this.inputTeardownStarted) return;
    this.inputTeardownStarted = true;
    this.physicalContactCollectorLease?.release();
    this.physicalContactCollectorLease = null;
    this.pointerProbeAbort.abort();
    for (const surface of this.surfaces.values()) {
      surface.router?.destroy();
      surface.router = null;
    }
    this.gestureOwnership.replaceGeneration();
    this.handledDrawPointers.clear();
    this.physicalContactIdsByPointer.clear();
    this.pointerDownPerformanceAt.clear();
    this.pointerInputAt.clear();
    this.pointerRouteReceivedAt.clear();
    this.clearPostUiProbeTimer();
    this.uiShellMutationObserver?.disconnect();
    this.uiShellMutationObserver = null;
  }

  /** `window` is the capture listener. Both paths use the same text-versus-ink split. */
  handleKeyDown(event: KeyboardEvent, _source: "session" | "window" = "session"): boolean {
    // A native contenteditable owns every editor shortcut while it is open. The
    // window-level listener may receive a retargeted event from Obsidian, so
    // checking event.target alone is not sufficient here. Cmd/Ctrl+A is the
    // exception: claim it before Obsidian's document shortcuts can move the
    // selection outside this editor. Ctrl/Cmd+A stays with that text.
    // Ctrl/Cmd+Option+A selects the ink on the current page.
    if (this.destroyed) return false;
    if (this.handleActiveTextEditorSelectAll(event)) {
      this.logKeyboardShortcut(event, "native-text", null, true);
      return true;
    }
    const textFocused = Boolean(this.activeTextEditor) || shouldIgnoreSelectionShortcut(event.target);
    const historyAction = parseHistoryShortcut(event);
    const action = parseSelectionShortcut(event);
    if (textFocused && !event.altKey) {
      this.logKeyboardShortcut(event, "native-text", null, false);
      return false;
    }
    if (historyAction) {
      const ok = historyAction === "undo" ? this.history.undo() : this.history.redo();
      if (!ok) {
        this.logKeyboardShortcut(event, "ignored", historyAction === "undo" ? "undo-ink" : "redo-ink", false);
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      this.logKeyboardShortcut(event, "ink-command", historyAction === "undo" ? "undo-ink" : "redo-ink", true);
      return true;
    }
    if (action === "delete" && textFocused) return false;
    if (action === "delete") {
      this.reconcileSelection();
      if (this.selected.length > 0 || this.selectedTexts.length > 0) {
        this.applySelectionShortcut(action);
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      // Thumbnail sidebar: Backspace/Delete removes the selected PDF page.
      if (this.thumbnailSidebarActions?.handleKeyDown(event)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    }
    if (!action || !this.canSelectionShortcut(action)) {
      if (inkHotkeyCommand(event)) this.logKeyboardShortcut(event, "ignored", inkHotkeyCommand(event), false);
      return false;
    }
    this.applySelectionShortcut(action);
    event.preventDefault();
    event.stopPropagation();
    this.logKeyboardShortcut(event, "ink-command", inkHotkeyCommand(event), true);
    return true;
  }

  private logKeyboardShortcut(
    event: KeyboardEvent,
    route: "native-text" | "ink-command" | "ignored",
    command: InkHotkeyCommand | null,
    defaultPrevented: boolean
  ): void {
    const target = event.target;
    const focusKind = this.activeTextEditor
      || (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']"))
      ? "text-editor"
      : target instanceof Element && target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-selection-toolbar")
        ? "toolbar"
        : target instanceof Element && (this.options.adapter.host.contains(target) || this.options.adapter.root.contains(target))
          ? "pdf"
          : "other";
    this.logger.keyboardShortcut({
      key: event.key.toLowerCase(),
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
      shift: event.shiftKey,
      focusKind,
      route,
      command,
      defaultPrevented
    });
  }

  private preserveEditorTextSelection(run: () => void): void {
    const editor = this.activeTextEditor;
    const selection = editor?.element.ownerDocument.getSelection() ?? null;
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    run();
    if (!editor || !range || !selection || !editor.element.isConnected) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private handleActiveTextEditorSelectAll(event: KeyboardEvent): boolean {
    const editor = this.activeTextEditor;
    if (!editor || editor.composing || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a") return false;
    const targetIsEditor = event.target instanceof Node && editor.element.contains(event.target);
    if (!targetIsEditor && editor.element.ownerDocument.activeElement !== editor.element) return false;

    event.preventDefault();
    event.stopPropagation();
    const range = editor.element.ownerDocument.createRange();
    range.selectNodeContents(editor.element);
    const selection = editor.element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.captureActiveTextSelection("select-all-shortcut");
    this.logText(editor.surface, "select-all-shortcut", {
      annotationId: editor.draft.id,
      characterCount: plainTextFromRuns(editor.runs).length,
      ...this.editorSelectionMetrics(editor.element)
    });
    return true;
  }

  canSelectionShortcut(action: SelectionShortcutAction): boolean {
    if (this.destroyed) return false;
    if (action === "selectAll") return this.isAttached();
    if (action === "paste") {
      const clipboard = StrokeClipboard.peek();
      return this.annotationShortcutContext() && Boolean(clipboard?.strokes.length || clipboard?.texts.length);
    }
    this.reconcileSelection();
    return this.selected.length > 0 || this.selectedTexts.length > 0;
  }

  /** Whether this mounted PDF session can switch the active annotation tool. */
  canSelectTool(): boolean {
    return !this.destroyed && this.isAttached();
  }

  /** Select a toolbar tool through its normal preference and chrome updates. */
  selectTool(tool: ToolId): boolean {
    if (!this.canSelectTool()) return false;
    this.toolbar.selectTool(tool);
    return true;
  }

  canUndo(): boolean {
    return !this.destroyed && this.history.canUndo();
  }

  canRedo(): boolean {
    return !this.destroyed && this.history.canRedo();
  }

  undo(): boolean {
    return this.applyHistory("undo");
  }

  redo(): boolean {
    return this.applyHistory("redo");
  }

  /** Whether this session has selected freehand ink suitable for SVG export. */
  canExportSelectedInkSvg(): boolean {
    if (this.destroyed || !this.isAttached()) return false;
    this.reconcileSelection();
    return this.selected.length > 0;
  }

  applySelectionShortcut(action: SelectionShortcutAction): void {
    this.preserveEditorTextSelection(() => this.applySelectionShortcutNow(action));
  }

  private applySelectionShortcutNow(action: SelectionShortcutAction): void {
    this.logger.textTool("selection-shortcut", {
      action,
      page: this.selectionPage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
    if (action === "selectAll") this.selectAllOnCurrentPage();
    else if (action === "copy") this.copySelection();
    else if (action === "cut") this.cutSelection();
    else if (action === "paste") this.pasteSelection();
    else if (action === "delete") this.deleteSelection();
  }

  /** True when this session can run a freehand clear command. */
  canClearFreehandDrawings(): boolean {
    return !this.destroyed && this.isAttached();
  }

  /**
   * Remove freehand ink strokes (not text annotations).
   * - `"all"`: every page
   * - `"selected"`: pages that currently have selected strokes, else the current viewer page
   * - number[]: explicit 1-based pages
   * Returns how many strokes were cleared.
   */
  clearFreehandDrawings(scope: "all" | "selected" | readonly number[]): number {
    if (!this.canClearFreehandDrawings()) return 0;

    let pages: number[];
    if (scope === "all") {
      pages = [...new Set(this.ink.all().map((stroke) => stroke.page))];
    } else if (scope === "selected") {
      this.reconcileSelection();
      const fromSelection = new Set(this.selected.map((stroke) => stroke.page));
      if (this.selectionPage != null) fromSelection.add(this.selectionPage);
      pages = fromSelection.size > 0
        ? [...fromSelection]
        : [this.options.adapter.getViewState().pageNumber];
    } else {
      pages = [...new Set(scope.filter((page) => Number.isFinite(page) && page >= 1))];
    }

    const strokes: InkStroke[] = [];
    for (const page of new Set(pages)) {
      for (const stroke of this.ink.page(page)) {
        strokes.push(stroke);
      }
    }
    if (strokes.length === 0) {
      this.logger.textTool("clear-freehand-skipped", {
        scope: scope === "all" || scope === "selected" ? scope : "pages",
        pages,
        reason: "no-strokes"
      });
      return 0;
    }

    const dirtyPages = [...new Set(strokes.map((stroke) => stroke.page))].sort((a, b) => a - b);
    this.clearSelection({ refresh: false });
    this.logger.textTool("clear-freehand", {
      scope: scope === "all" || scope === "selected" ? scope : "pages",
      pages: dirtyPages,
      strokeCount: strokes.length
    });
    this.executeHistory({
      label: dirtyPages.length === 1
        ? `Clear freehand on page ${dirtyPages[0]}`
        : `Clear freehand on ${dirtyPages.length} pages`,
      execute: () => {
        for (const stroke of strokes) this.ink.remove(stroke.id, "clear-freehand");
      },
      undo: () => {
        for (const stroke of strokes) this.ink.add(stroke);
      }
    }, dirtyPages);
    return strokes.length;
  }

  private applyHistory(action: "undo" | "redo"): boolean {
    const before = this.texts.all().length;
    const applied = action === "undo" ? this.history.undo() : this.history.redo();
    this.logger.textTool(`history-${action}`, {
      applied,
      textCountBefore: before,
      textCountAfter: this.texts.all().length
    });
    return applied;
  }

  async exportCopy(mode: "flattened" | "editable" = "flattened"): Promise<void> {
    const texts = this.texts.all();
    this.logger.textTool("export-start", {
      mode,
      textCount: texts.length,
      textPageCount: new Set(texts.map((text) => text.page)).size,
      richTextCount: texts.filter((text) => text.runs.length > 1).length,
      unicodeTextCount: texts.filter((text) => /[^\x20-\x7e\n]/.test(text.text)).length
    });
    try {
      await this.autosave.flush(this.identity.id);
      if (!this.options.writeExport || !pdfSurfaceExtensions(this.options.adapter)) {
        this.options.notice("Document export is unavailable for this annotation surface.");
        return;
      }
      const readDocument = this.options.readDocument ?? this.options.readSourcePdf;
      if (!readDocument) throw new Error("Document bytes unavailable for export");
      const bytes = await this.exporter.export({
        sourceBytes: await readDocument(),
        getStrokes: () => this.ink.all(),
        getTexts: () => this.texts.all(),
        mode,
        pageMetrics: this.exportPageMetrics()
      });
      const sourceName = this.options.documentPath.split("/").pop() ?? "document.pdf";
      const name = mode === "editable" ? editableAnnotatedFilename(sourceName) : annotatedFilename(sourceName);
      const path = await this.options.writeExport(name, bytes);
      this.options.notice(`Exported ${typeof path === "string" ? path : name}. Original PDF unchanged.`);
      this.logger.textTool("export-complete", { mode, textCount: this.texts.all().length, byteCount: bytes.length });
    } catch (error) {
      this.logger.textTool("export-error", { mode, textCount: this.texts.all().length, error: this.errorMessage(error) });
      throw error;
    }
  }

  async exportImageCopy(): Promise<void> {
    const mode = "image";
    this.logger.textTool("export-start", {
      mode,
      textCount: this.texts.all().length,
      textPageCount: new Set(this.texts.all().map((text) => text.page)).size,
      richTextCount: this.texts.all().filter((text) => text.runs.length > 1).length,
      unicodeTextCount: this.texts.all().filter((text) => /[^\\x20-\\x7e\\n]/.test(text.text)).length
    });
    try {
      this.commitActiveTextEditor("image-export");
      for (const surface of this.surfaces.values()) this.commitActiveDrawBeforeSurfaceLoss(surface, "image-export");
      await this.autosave.flush(this.identity.id);
      const imageExtensions = imageSurfaceExtensions(this.options.adapter);
      const image = imageExtensions?.imageElement?.();
      if (!this.options.writeExport || !image) {
        this.options.notice("Image export is unavailable for this annotation surface.");
        return;
      }
      const page = this.options.adapter.page(1);
      if (!page) throw new Error("Annotated image page is unavailable");
      const sourceName = this.options.documentPath.split("/").pop() ?? "image.png";
      const sourceExtension = sourceName.split(".").pop()?.toLowerCase();
      const format: ImageRasterFormat = sourceExtension === "png" ? "png" : "jpeg";
      const outputExtension = format === "png" ? "png" : sourceExtension === "jpeg" ? "jpeg" : "jpg";
      const output = await this.imageExporter.export({
        source: image,
        ownerDocument: image.ownerDocument,
        width: page.width,
        height: page.height,
        format,
        render: (target) => this.renderImageAnnotations(target, page)
      });
      const stem = sourceName.replace(/\\.[a-z0-9]+$/i, "") || "image";
      const name = `${stem}_annotated.${outputExtension}`;
      const path = await this.options.writeExport(name, output.bytes);
      this.options.notice(`Exported ${typeof path === "string" ? path : name}. Original image unchanged.`);
      this.logger.textTool("export-complete", {
        mode,
        textCount: this.texts.all().length,
        byteCount: output.bytes.length,
        width: output.width,
        height: output.height,
        format
      });
    } catch (error) {
      this.logger.textTool("export-error", {
        mode,
        textCount: this.texts.all().length,
        error: this.errorMessage(error)
      });
      throw error;
    }
  }

  /** Export only the current selected strokes; sidecars and the source PDF stay untouched. */
  async exportSelectedInkSvg(): Promise<void> {
    this.reconcileSelection();
    const strokes = [...this.selected];
    if (!strokes.length) {
      this.options.notice("Select PDF ink to export as SVG.");
      return;
    }
    if (!this.options.writeSvgExport) throw new Error("SVG export is unavailable in this PDF view");

    const exported = exportInkStrokesToSvg(strokes, { pageMetrics: this.exportPageMetrics() });
    if (!exported.strokeCount) {
      this.options.notice("The selected PDF ink has no drawable points.");
      return;
    }
    const sourceName = this.options.documentPath.split("/").pop() ?? "document.pdf";
    const base = sourceName.replace(/\.pdf$/i, "") || "document";
    const name = `${base}_selected_ink.svg`;
    const path = await this.options.writeSvgExport(name, exported.svg);
    this.options.notice(`Exported ${typeof path === "string" ? path : name}. Source PDF unchanged.`);
    this.logger.textTool("export-selected-svg", {
      strokeCount: exported.strokeCount,
      pages: exported.pages.map((page) => page.page),
      width: round(exported.bounds.width),
      height: round(exported.bounds.height)
    });
  }

  async destroy(options: { silent?: boolean; alreadyPersisted?: boolean } = {}): Promise<boolean> {
    if (this.destroyed) return true;
    this.ipadInputTrace?.release();
    this.stopFrameProfileSampling();
    // Remove document-level probes before any persistence/close await so a
    // registry removal cannot leave a stale session observing the next event.
    this.revokeDocumentInputOwnership("released");
    this.cancelCustomPinches("lifecycle");
    this.physicalContactCollectorLease?.release();
    this.physicalContactCollectorLease = null;
    this.syncEffectiveDrawState(options.silent ? "session-destroy" : "plugin-unload", "lifecycle");
    this.releasePageMutationShield("session-destroy");
    this.commitActiveTextEditor("destroy");
    this.cancelTextBoxTransform("destroy");
    // Emergency persistence snapshots below must include a line that is still
    // held when the PDF view closes or replaces its pages.
    for (const surface of this.surfaces.values()) {
      this.commitActiveDrawBeforeSurfaceLoss(surface, "session-destroy");
    }
    // Session removal can race replacement attachment. Silent teardown must
    // stop every document-level collector and page router before any awaited
    // persistence work, so a stale session cannot observe the next contact.
    if (options.silent) this.beginInputTeardown();
    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    const strokeCount = this.ink.all().length;
    const textCount = this.texts.all().length;
    const dirty = this.isDirty();
    const alreadyPersisted = Boolean(options.alreadyPersisted || this.alreadyEmergencyPersisted);
    this.logger.sessionDestroy({
      reason: options.silent ? "silent" : "close",
      silent: Boolean(options.silent),
      strokeCount,
      textCount,
      dirty,
      alreadyPersisted
    });
    if (!alreadyPersisted) {
      const writeSync = this.options.writeSync;
      if (writeSync) this.emergencyPersist(writeSync, { force: dirty || strokeCount > 0, reason: options.silent ? "destroy-silent" : "destroy" });
    }
    if (!options.silent) {
      if (!this.options.settings.autosave && this.isDirty()) {
        const choice = await this.options.decideUnsaved?.() ?? "cancel";
        if (!await this.saveCoordinator.prepareClose(choice)) return false;
      } else if (this.options.settings.saveWhenClosing && !alreadyPersisted) {
        try {
          await this.autosave.flush(this.identity.id);
        } catch (error) {
          await this.options.recovery.save(this.snapshot());
          this.options.notice(`Pending annotations kept for recovery: ${this.errorMessage(error)}`);
        }
      }
    } else if (!alreadyPersisted) {
      try {
        await this.autosave.flush(this.identity.id);
      } catch {
        await this.options.recovery.save(this.snapshot()).catch(() => undefined);
      }
    }
    this.beginInputTeardown();
    this.destroyed = true;
    if (this.laserFadeFrame !== null) {
      window.cancelAnimationFrame(this.laserFadeFrame);
      this.laserFadeFrame = null;
    }
    this.laserTrails = [];
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.nativeHandoffUpdateFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.nativeHandoffUpdateFrame);
      this.nativeHandoffUpdateFrame = null;
    }
    this.nativeHandoffUpdateToken += 1;
    this.pendingNativeHandoffUpdate = null;
    if (this.viewportPaintFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.viewportPaintFrame);
      this.viewportPaintFrame = null;
    }
    if (this.mobileScrollRefreshFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.mobileScrollRefreshFrame);
      this.mobileScrollRefreshFrame = null;
    }
    this.pendingMobileScrollRemount = false;
    this.clearZoomBurstWatchdog();
    this.zoomSettlePausedForLiveInk = false;
    this.zoomSettlePausedAt = null;
    this.zoomSettlePausedReason = null;
    if (this.zoomSettleResumeTimer !== null) {
      window.clearTimeout(this.zoomSettleResumeTimer);
      this.zoomSettleResumeTimer = null;
    }
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    for (const timer of this.strokeRenderVerificationTimers.values()) window.clearTimeout(timer);
    this.strokeRenderVerificationTimers.clear();
    for (const timer of this.strokePixelVerificationTimers.values()) window.clearTimeout(timer);
    this.strokePixelVerificationTimers.clear();
    this.cancelZoomSettleSlice();
    this.cancelZoomOverlayLayout();
    this.cancelZoomCompositeRelease();
    this.endZoomCompositing();
    this.releaseZoomCompositeLayers();
    this.setAdapterInkZoomBurstActive(false);
    this.finishZoomProfile();
    this.finishZoomNativeHandoffTrace();
    this.syncAnnotationCursorMode(true);
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) {
      if (surface.textIntent) this.clearTextIntentTimer(surface.textIntent);
      this.logger.inputLifecycleEvent("surface-unmount", {
        page: surface.page.pageNumber,
        pageId: getDebugNodeId(surface.page.element),
        routerGeneration: surface.router?.generation ?? null,
        reason: "session-destroy"
      });
      surface.router?.destroy();
      this.clearTouchDrawPolicy(surface.page.element);
      this.releaseInputOwner(surface.page.element);
      this.releaseSurfaceBuffers(surface);
    }
    this.surfaces.clear();
    this.selectionToolbar.destroy();
    if (this.textContextMenuSuppressTimer !== null) window.clearTimeout(this.textContextMenuSuppressTimer);
    this.textContextMenuSuppressTimer = null;
    this.textContextMenuTargetId = null;
    this.textContextMenu.destroy();
    this.mobilePinchZoom.destroy();
    this.clearMobileCssZoom();
    if (this.mobilePinchIndicatorFadeTimer !== null) {
      const view = this.options.adapter.host.ownerDocument.defaultView;
      (view?.clearTimeout ?? window.clearTimeout)(this.mobilePinchIndicatorFadeTimer);
      this.mobilePinchIndicatorFadeTimer = null;
    }
    this.mobilePinchIndicator?.remove();
    this.mobilePinchIndicator = null;
    this.addPageControl?.destroy();
    this.thumbnailSidebarActions?.destroy();
    this.findBridge?.destroy();
    this.handledDrawPointers.clear();
    this.physicalContactIdsByPointer.clear();
    this.pointerDownPerformanceAt.clear();
    this.pointerInputAt.clear();
    this.pointerRouteReceivedAt.clear();
    this.clearPostUiProbeTimer();
    this.uiShellSnapshots.clear();
    this.uiShellMutationObserver?.disconnect();
    this.uiShellMutationObserver = null;
    this.documentInputOwnership?.release();
    this.documentInputOwnership = null;
    this.pointerProbeAbort.abort();
    this.toolbar.destroy();
    pdfSurfaceExtensions(this.options.adapter)?.setInkPreviewProvider?.(null);
    this.options.adapter.destroy();
    await this.autosave.close().catch(() => undefined);
    return true;
  }

  updateAnnotationRecoveryOptions(options: Pick<PluginSettings, "automaticAnnotationRecovery" | "annotationBackupPath">): void {
    this.options.sidecars.updateRecoveryOptions({
      automaticRecovery: options.automaticAnnotationRecovery,
      backupFolder: options.annotationBackupPath
    });
    this.options.recovery.updateRecoveryOptions({
      automaticRecovery: options.automaticAnnotationRecovery,
      backupFolder: options.annotationBackupPath
    });
  }

  setCustomMobilePdfPinchZoomEnabled(enabled: boolean): void {
    this.customMobilePdfPinchZoomEnabledOverride = enabled;
    if (!enabled) this.cancelCustomPinches("disabled");
    for (const surface of this.surfaces.values()) surface.router?.syncToolState();
  }

  /** Apply live mouse-button setting changes without recreating the viewer. */
  updateMouseInputBindings(): void {
    this.syncAnnotationCursorMode();
    this.syncTouchDrawPolicy("input-settings");
    this.refreshSurfaceCursors();
  }

  private syncAnnotationCursorMode(forceOff = false): void {
    const tool = this.activeTool();
    // A primary-button drawing binding hides the native cursor for ink/eraser.
    const hideNativeCursor = !forceOff
      && this.mouseInkingEnabled()
      && (isInkDrawTool(tool) || tool === "eraser");
    this.options.adapter.root.classList.toggle("native-pdf-handwriting-hide-native-cursor", hideNativeCursor);
  }

  private isEffectiveDrawTool(tool: ToolId): boolean {
    return isInkDrawTool(tool) || tool === "eraser";
  }

  /** Log effective draw capability, not only persisted preferences. */
  private syncEffectiveDrawState(reason: string, source: string): void {
    const tool = this.activeTool();
    const next = this.isEffectiveDrawTool(tool);
    const previousTool = this.lastObservedTool;
    this.lastObservedTool = tool;
    if (this.effectiveDrawEnabledState === next) return;
    const activePenIds = [...new Set([...this.surfaces.values()].flatMap((surface) => surface.router?.activePenIds() ?? []))];
    const ownerPages = [...this.surfaces]
      .filter(([, surface]) => surface.router?.activePenIds().length)
      .map(([page]) => page);
    const currentOwner = ownerPages.length ? ownerPages.join(",") : "idle";
    const ownerBefore = !next && currentOwner !== "idle" ? currentOwner : this.lastDrawOwner;
    const ownerAfter = next ? currentOwner : "idle";
    const activePenIdsBefore = !next && activePenIds.length ? activePenIds : this.lastActivePenIds;
    this.logger.drawStateChanged({
      from: this.effectiveDrawEnabledState,
      to: next,
      effectiveFrom: this.effectiveDrawEnabledState,
      effectiveTo: next,
      storedDrawEnabled: this.isEffectiveDrawTool(tool),
      reason,
      source,
      selectedToolBefore: previousTool,
      selectedToolAfter: tool,
      activePenSettings: this.options.settings.toolPreferences.pen,
      inkCapableBefore: this.isEffectiveDrawTool(previousTool),
      inkCapableAfter: next,
      activePenIdsBefore,
      activePenIds,
      activePenCount: activePenIds.length,
      ownerBefore,
      ownerAfter,
      duringActiveStroke: this.hasAnyLiveInkInput(),
      page: this.options.adapter.getViewState().pageNumber,
      inputPolicies: this.inputPolicyLogFields()
    });
    this.lastDrawOwner = ownerAfter;
    this.lastActivePenIds = activePenIds;
    this.effectiveDrawEnabledState = next;
  }

  /** Apply transient pen hit policy; never permanently disable PDF.js text/annotation layers. */
  private syncTouchDrawPolicy(reason: string): void {
    const penHit = this.hasActivePenCapability();
    const fallbackHit = this.touchAnnotationEnabled();
    const annotationHit = penHit || fallbackHit;
    for (const surface of this.surfaces.values()) {
      this.applyTouchDrawPolicy(surface.page.element, annotationHit);
      this.ensurePageRouter(surface);
      surface.router?.syncToolState();
    }
    if (this.touchDrawPolicyEnabled === annotationHit) return;
    this.touchDrawPolicyEnabled = annotationHit;
    this.logger.touchInput("policy", {
      enabled: annotationHit,
      reason,
      penHit,
      fallbackHit,
      surfaces: this.surfaces.size,
      ...this.inputPolicyLogFields()
    });
  }

  private applyTouchDrawPolicy(pageElement: HTMLElement, enabled = false): void {
    // Transient pen capability only — never a permanent Draw-mode lock.
    pageElement.classList.toggle("native-pdf-handwriting-draw-hit-page", enabled);
    pageElement.classList.remove("native-pdf-handwriting-touch-draw-page");
    const layers = pageElement.querySelectorAll<HTMLElement>(":scope > .textLayer, :scope > .annotationLayer");
    for (const layer of layers) {
      setElementCssProps(layer, { pointerEvents: enabled ? "none" : "" });
    }
  }

  private clearTouchDrawPolicy(pageElement: HTMLElement): void {
    // A newly attached session may claim the page while an old one is still
    // tearing down. Only the active owner may remove its touch policy.
    if (inputOwners(pageElement).get(pageElement) !== this) return;
    pageElement.classList.remove(
      "native-pdf-handwriting-draw-hit-page",
      "native-pdf-handwriting-touch-draw-page",
      "native-pdf-handwriting-touch-none",
      "native-pdf-handwriting-touch-pan-xy",
      "native-pdf-handwriting-touch-custom-pinch",
      "native-pdf-handwriting-pen-capturing"
    );
    const layers = pageElement.querySelectorAll<HTMLElement>(":scope > .textLayer, :scope > .annotationLayer");
    for (const layer of layers) {
      setElementCssProps(layer, { pointerEvents: "" });
    }
  }

  /** Physical eraser tips temporarily route as Eraser without changing saved tool choice. */
  private activeTool(): ToolPreferences["activeTool"] {
    return this.temporaryStylusEraserPointers > 0
      ? "eraser"
      : this.options.settings.toolPreferences.activeTool;
  }

  /** Text boxes steal hits only in Text/lasso — pen/eraser/laser must pass through. */
  private textBoxesInteractable(): boolean {
    const tool = this.activeTool();
    return tool === "text" || tool === "lasso";
  }

  /** A finger may claim only a committed text box; every other touch stays native. */
  private isTouchTextTarget(surface: PageSurface, event: PointerEvent): boolean {
    if (!this.textBoxesInteractable() || event.pointerType !== "touch") return false;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".native-pdf-handwriting-text-box")
      : null;
    if (target && surface.overlay.contains(target)) {
      // The rendered text layer is the authoritative committed-text surface;
      // avoid a second store lookup here because a just-loaded annotation may
      // already be painted while its index is still settling.
      return target.dataset.annotationId !== undefined;
    }
    // A long-press selection can replace the text-layer node while the native
    // touch lifecycle is still active. WebKit may then retarget the next tap
    // to the page/overlay instead of the replacement box. Recover by geometry
    // so a second tap on the selected words still enters the editor.
    if (target) return false;
    const point = this.textPointerToPagePoint(surface, event);
    return this.textAt(surface.page.pageNumber, point) !== null;
  }

  private refreshSurfaceCursors(surfaces: Iterable<PageSurface> = this.surfaces.values()): void {
    for (const surface of surfaces) surface.router?.refreshCursors();
  }

  private refreshZoomWorkingSurfaceCursors(): void {
    for (const pageNumber of this.zoomWorkingPageNumbers) {
      this.surfaces.get(pageNumber)?.router?.refreshCursors();
    }
  }

  private mountPage(page: AnnotationPageInfo): PageSurface {
    this.claimInputOwner(page.element, page.pageNumber);
    this.rememberPageMetrics(page);
    const overlay = this.options.adapter.mountOverlay(page.pageNumber);
    const canvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    canvas.className = "native-pdf-handwriting-canvas";
    if (this.options.settings.hideStylusAnnotationLabel) canvas.setAttribute("aria-hidden", "true");
    else canvas.setAttribute("aria-label", `Annotations for PDF page ${page.pageNumber}`);
    overlay.append(canvas);
    const draftCanvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    draftCanvas.className = "native-pdf-handwriting-draft-canvas";
    draftCanvas.setAttribute("aria-hidden", "true");
    overlay.append(draftCanvas);
    const predictionCanvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    predictionCanvas.className = "native-pdf-handwriting-prediction-canvas";
    predictionCanvas.setAttribute("aria-hidden", "true");
    overlay.append(predictionCanvas);
    const selectionCanvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    selectionCanvas.className = "native-pdf-handwriting-selection-canvas";
    selectionCanvas.setAttribute("aria-hidden", "true");
    overlay.append(selectionCanvas);
    const textLayer = createDetachedDiv(overlay.ownerDocument);
    textLayer.className = "native-pdf-handwriting-text-layer";
    overlay.append(textLayer);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    const draftContext = draftCanvas.getContext("2d");
    if (!draftContext) throw new Error("Canvas 2D rendering is unavailable");
    const predictionContext = predictionCanvas.getContext("2d");
    if (!predictionContext) throw new Error("Canvas 2D rendering is unavailable");
    const selectionContext = selectionCanvas.getContext("2d");
    if (!selectionContext) throw new Error("Canvas 2D rendering is unavailable");
    const surface: PageSurface = {
      page,
      overlay,
      canvas,
      draftCanvas,
      predictionCanvas,
      selectionCanvas,
      textLayer,
      context,
      draftContext,
      predictionContext,
      selectionContext,
      canvasGeneration: 0,
      paintGeneration: 0,
      inkLayer: null,
      inkLayerContext: null,
      inkLayerValid: false,
      inkLayerBackingScale: null,
      inkLayerBurstCapture: false,
      inkLayerRevision: null,
      rasterFallbackReady: false,
      viewportCullPending: false,
      settleUpgradePending: false,
      deferredCanonicalPaint: null,
      deferredCanonicalPaintFrame: null,
      router: null,
      mobileCustomPinch: null,
      livePaintFrame: null,
      livePaintFallbackTimer: null,
      pendingLivePaint: null,
      pendingLivePaintAt: null,
      pendingLiveInputAt: null,
      paintAcknowledgementFrame: null,
      paintAcknowledgementCancel: null,
      strokePerformance: null,
      liveEraserPaintedPoints: 0,
      wetPreviewActive: false,
      wetPreviewUsesCommittedCanvas: false,
      wetDamage: new DamageLedger(),
      liveDrawPaintedPoints: 0,
      liveDrawPageBounds: null,
      liveDrawPreviewStrokeId: null,
      predictedPreview: [],
      predictedPreviewPainted: false,
      builder: undefined,
      pressureConditioner: undefined,
      pressureLastPagePoint: undefined,
      simulateMousePressure: false,
      laserDraft: false,
      laserDiscardedPoints: 0,
      shapeHoldTimer: null,
      shapePreview: null,
      shapeResize: null,
      editPath: [],
      editTool: undefined,
      eraserSize: undefined,
      eraserWholeStrokes: undefined,
      textIntent: null,
      pendingRouterHandoff: null,
      annotationSafetyBlocked: null
    };
    surface.router = this.createPageRouter(surface);
    this.ensurePagePositioning(page.element);
    this.applyTouchDrawPolicy(page.element, this.touchDrawPolicyEnabled ?? false);
    this.syncOverlayLayout(surface);
    this.logger.inputLifecycleEvent("surface-mount", {
      page: page.pageNumber,
      pageId: getDebugNodeId(page.element),
      overlayId: getDebugNodeId(overlay),
      routerGeneration: surface.router?.generation ?? null
    });
    return surface;
  }

  /** Keep exactly one session's page router active for a live PDF page node. */
  private claimInputOwner(pageElement: HTMLElement, page: number): void {
    const owners = inputOwners(pageElement);
    const previous = owners.get(pageElement);
    if (previous && previous !== this) {
      this.logger.inputOwner("supersede", { page });
      this.logger.inputLifecycleEvent("input-owner-supersede", {
        source: "session-input",
        page,
        pageId: getDebugNodeId(pageElement),
        ownerBefore: "other-session",
        ownerAfter: "this-session",
        reason: "page-router-replacement",
        unexpected: true
      });
      void previous.destroy({ silent: true, alreadyPersisted: true });
    }
    owners.set(pageElement, this);
    this.ownedInputPages.add(pageElement);
    this.logger.inputOwner("claim", { page, replaced: Boolean(previous && previous !== this) });
    this.logger.inputLifecycleEvent("input-owner-claim", {
      source: "session-input",
      page,
      pageId: getDebugNodeId(pageElement),
      replaced: Boolean(previous && previous !== this),
      ownerBefore: previous ? "other-session" : "none",
      ownerAfter: "this-session",
      activePenCount: this.surfaces.get(page)?.router?.activePenIds().length ?? 0,
      activeTouchCount: this.pluginTouchPointerIds().length,
      reason: "page-router-bind"
    });
  }

  private releaseInputOwner(pageElement: HTMLElement): void {
    this.ownedInputPages.delete(pageElement);
    const owners = inputOwners(pageElement);
    if (owners.get(pageElement) !== this) return;
    owners.delete(pageElement);
    this.logger.inputOwner("release", { page: pageElement.dataset.pageNumber ?? null });
    this.logger.inputLifecycleEvent("input-owner-release", {
      source: "session-input",
      page: pageElement.dataset.pageNumber ?? null,
      pageId: getDebugNodeId(pageElement),
      ownerBefore: "this-session",
      ownerAfter: "none",
      activePenCount: this.surfaces.get(Number(pageElement.dataset.pageNumber))?.router?.activePenIds().length ?? 0,
      activeTouchCount: this.pluginTouchPointerIds().length,
      reason: "page-router-unbind"
    });
  }

  /** Shared, diagnostic-only metadata for bounded semantic input transitions. */
  private inputLifecycleDetails(
    surface: PageSurface,
    event: Event | null,
    details: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const pointer = event instanceof PointerEvent ? event : null;
    const target = isElement(event?.target) ? event.target : null;
    const activePenIds = [...new Set(
      [...this.surfaces.values()].flatMap((candidate) => candidate.router?.activePenIds() ?? [])
    )];
    const activeTouchPointerIds = this.pluginTouchPointerIds();
    const owner = inputOwners(surface.page.element).get(surface.page.element);
    const ownerState = owner === this ? "this-session" : owner ? "other-session" : "none";
    const duplicateLookingContactIds = pointer
      ? [...this.physicalContactIdsByPointer.entries()]
        .filter(([pointerId, contactId]) => pointerId !== pointer.pointerId
          && contactId === this.physicalContactIdsByPointer.get(pointer.pointerId))
        .map(([pointerId]) => pointerId)
        .slice(0, 8)
      : [];
    let coalescedCount = 0;
    let predictedCount = 0;
    if (pointer) {
      try {
        coalescedCount = pointer.getCoalescedEvents?.().length ?? 0;
        const predicted = (pointer as PointerEvent & {
          getPredictedEvents?: () => PointerEvent[];
        }).getPredictedEvents;
        predictedCount = predicted ? predicted.call(pointer).length : 0;
      } catch {
        // Browser diagnostic APIs can disappear during page recycling.
      }
    }
    return {
      source: pointer ? "page-pointer-router" : event instanceof TouchEvent ? "page-touch-router" : "session-input",
      eventType: event?.type ?? null,
      pointerType: pointer?.pointerType ?? (event instanceof TouchEvent ? "touch" : null),
      pointerId: pointer?.pointerId ?? null,
      pointerMetadata: pointer ? {
        isPrimary: pointer.isPrimary,
        button: pointer.button,
        buttons: pointer.buttons,
        pressure: pointer.pressure,
        width: pointer.width,
        height: pointer.height
      } : null,
      targetClass: target ? {
        tag: target.tagName.toLowerCase(),
        id: target.id || null,
        classes: [...target.classList].slice(0, 6)
      } : null,
      pageUiClassification: {
        page: surface.page.pageNumber,
        targetWithinPage: Boolean(target && surface.page.element.contains(target)),
        targetWithinOverlay: Boolean(target && surface.overlay.contains(target)),
        annotationChrome: isAnnotationChromeTarget(event?.target ?? null),
        pageConnected: surface.page.element.isConnected,
        overlayConnected: surface.overlay.isConnected
      },
      ownerBefore: ownerState,
      ownerAfter: ownerState,
      activePenCount: activePenIds.length,
      activePenIds: activePenIds.slice(0, 8),
      activeTouchCount: activeTouchPointerIds.length,
      activeTouchPointerIds: activeTouchPointerIds.slice(0, 8),
      captureSet: pointer ? Boolean(surface.router?.hasPointerCapture(pointer.pointerId)) : false,
      captureLost: event?.type === "lostpointercapture"
        || (typeof details.reason === "string" && details.reason.includes("lost")),
      generation: surface.router?.generation ?? null,
      routerAlive: Boolean(surface.router?.isAlive()),
      coalescedCount,
      predictedCount,
      duplicateLookingContactCount: duplicateLookingContactIds.length,
      duplicateLookingContactIds,
      ...details
    };
  }

  private customMobilePdfPinchZoomEnabled(surface: PageSurface): boolean {
    try {
      const enabled = this.customMobilePdfPinchZoomEnabledOverride
        ?? this.options.settings.customMobilePdfPinchZoom === true;
      const extensions = pdfSurfaceExtensions(this.options.adapter);
      const report = extensions?.compatibilityReport?.();
      if (!extensions || !report?.profile || !report.platform) return false;
      return planMobileCustomPdfZoom({
        enabled,
        surfaceType: this.options.adapter.surfaceType ?? "image",
        platform: report.platform,
        profile: report.profile,
        page: surface.page
      }).mode === "custom-mobile";
    } catch {
      return false;
    }
  }

  private startActiveMobilePinch(frame: MobilePinchZoomFrame): { accepted: boolean; scale?: number } {
    let surface = frame.generation === 0 ? null : this.activeMobilePinchSurface;
    if (!surface) {
      const first = frame.points[0];
      const second = frame.points[1];
      const clientX = first && second ? (first.clientX + second.clientX) / 2 : null;
      const clientY = first && second ? (first.clientY + second.clientY) / 2 : null;
      surface = this.mobilePinchSurfaceAt(clientX, clientY);
    }
    if (!surface || !this.customMobilePdfPinchZoomEnabled(surface)) return { accepted: false };
    if (surface.mobileCustomPinch) this.cancelMobileCustomPinch(surface, "capability-lost");
    this.activeMobilePinchSurface = surface;
    this.startMobileCustomPinch(surface, frame);
    const state = surface.mobileCustomPinch;
    return state
      ? { accepted: true, scale: state.initialScale() }
      : { accepted: false };
  }

  private previewActiveMobilePinch(scale: number, focalPoint: MobilePinchZoomFocalPoint): void {
    const surface = this.activeMobilePinchSurface;
    if (!surface) return;
    this.previewMobileCustomPinch(surface, scale, focalPoint);
  }

  private endActiveMobilePinch(
    scale: number,
    reason: "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled"
  ): void {
    const surface = this.activeMobilePinchSurface;
    if (!surface) return;
    this.endMobileCustomPinch(surface, reason, scale);
    if (reason !== "pointerup") this.activeMobilePinchSurface = null;
  }

  private cancelActiveMobilePinch(reason: string): void {
    const surface = this.activeMobilePinchSurface;
    if (surface?.mobileCustomPinch) this.cancelMobileCustomPinch(surface, "capability-lost");
    this.activeMobilePinchSurface = null;
    this.logger.inputLifecycleEvent("mobile-pinch-cancel", { reason });
  }

  private persistMobilePinchScale(_scale: number): void {
    // CSS/container zoom is already retained by the compositor. Do not mirror
    // it into PDF.js currentScale or the handwriting sidecar.
  }

  private mobilePinchSurfaceAt(clientX: number | null, clientY: number | null): PageSurface | null {
    const candidates = [...this.surfaces.values()];
    if (clientX !== null && clientY !== null) {
      for (const surface of candidates) {
        const rect = surface.page.element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0
          && clientX >= rect.left && clientX <= rect.right
          && clientY >= rect.top && clientY <= rect.bottom) return surface;
      }
    }
    let currentPage: number | null = null;
    try {
      currentPage = this.options.adapter.getViewState().pageNumber;
    } catch {
      // Native viewer may be between page generations.
    }
    return candidates.find((surface) => surface.page.pageNumber === currentPage)
      ?? candidates[0]
      ?? null;
  }

  private mobilePinchWheelEligible(target: EventTarget | null, adapter: ViewerInkSessionOptions["adapter"]): boolean {
    if (adapter.surfaceType !== "pdf") return false;
    if (!(target instanceof Element) || !adapter.root.contains(target)) return false;
    if (target.closest(
      ".pdf-sidebar-container, .pdf-sidebar, .pdf-thumbnail-view, .pdf-outline-view, "
      + ".canvas-wrapper, .excalidraw, .excalidraw-wrapper, "
      + ".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, "
      + ".native-pdf-handwriting-selection-toolbar"
    )) return false;
    return Boolean(this.mobilePinchSurfaceAt(null, null));
  }

  private updateMobilePinchIndicator(
    scale: number,
    reset: () => void,
    ownerDocument: Document
  ): void {
    if (!this.mobilePinchIndicator) {
      const indicator = createDetachedEl(ownerDocument, "button");
      indicator.type = "button";
      indicator.className = "native-pdf-handwriting-mobile-zoom-indicator";
      indicator.setAttribute("aria-label", "Tap to reset PDF zoom to 100%");
      indicator.addEventListener("click", () => reset(), { signal: this.pointerProbeAbort.signal });
      ownerDocument.body?.append(indicator);
      this.mobilePinchIndicator = indicator;
    }
    const percent = Math.round(scale * 100);
    this.mobilePinchIndicator.textContent = `🔍 ${percent}%`;
    this.mobilePinchIndicator.classList.toggle("is-faded", percent === 100);
    if (this.mobilePinchIndicatorFadeTimer !== null) {
      const view = ownerDocument.defaultView;
      (view?.clearTimeout ?? window.clearTimeout)(this.mobilePinchIndicatorFadeTimer);
      this.mobilePinchIndicatorFadeTimer = null;
    }
    if (percent === 100) {
      const view = ownerDocument.defaultView;
      this.mobilePinchIndicatorFadeTimer = (view?.setTimeout ?? window.setTimeout)(() => {
        this.mobilePinchIndicator?.classList.add("is-faded");
      }, 1500);
    }
  }

  private rememberMobileCssZoomTarget(target: HTMLElement): void {
    if (this.mobileCssZoomTarget === target) return;
    this.clearMobileCssZoom();
    this.mobileCssZoomTarget = target;
    this.mobileCssZoomPreviousInlineValue = target.style.getPropertyValue("zoom");
  }

  private mobilePdfCssZoomFactor(): number {
    const target = this.mobileCssZoomTarget;
    if (!target?.isConnected) return 1;
    try {
      const inline = Number.parseFloat(target.style.getPropertyValue("zoom"));
      if (Number.isFinite(inline) && inline > 0) return inline;
      const computed = target.ownerDocument.defaultView?.getComputedStyle(target).getPropertyValue("zoom");
      const parsed = Number.parseFloat(computed ?? "");
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    } catch {
      return 1;
    }
  }

  private overlayViewportFromClient(
    surface: PageSurface,
    clientX: number,
    clientY: number,
    rect = surface.overlay.getBoundingClientRect()
  ): { x: number; y: number } {
    const zoom = this.mobilePdfCssZoomFactor();
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom
    };
  }

  private overlayClientFromViewport(
    surface: PageSurface,
    viewport: { x: number; y: number },
    rect = surface.overlay.getBoundingClientRect()
  ): { x: number; y: number } {
    const zoom = this.mobilePdfCssZoomFactor();
    return {
      x: rect.left + viewport.x * zoom,
      y: rect.top + viewport.y * zoom
    };
  }

  private clearMobileCssZoom(): void {
    const target = this.mobileCssZoomTarget;
    if (target && this.mobileCssZoomPreviousInlineValue !== null) {
      if (this.mobileCssZoomPreviousInlineValue) target.style.setProperty("zoom", this.mobileCssZoomPreviousInlineValue);
      else target.style.removeProperty("zoom");
    }
    this.mobileCssZoomTarget = null;
    this.mobileCssZoomPreviousInlineValue = null;
    this.mobileCssZoomScale = 1;
  }

  private startMobileCustomPinch(surface: PageSurface, frame: CustomPinchFrame): void {
    if (surface.mobileCustomPinch || frame.points.length < 2) return;
    const extensions = pdfSurfaceExtensions(this.options.adapter);
    let scrollRoot: HTMLElement;
    try {
      scrollRoot = this.options.adapter.scrollElement();
    } catch {
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    const first = frame.points[0];
    const second = frame.points[1];
    if (!extensions || !first || !second) {
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    const focalPoint = {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2
    };
    const initialDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    if (!Number.isFinite(initialDistance) || initialDistance <= 1) {
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    let rootRect: DOMRect;
    try {
      rootRect = scrollRoot.getBoundingClientRect();
    } catch {
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    const hasViewport = rootRect.width > 1 && rootRect.height > 1;
    let pages: MobilePdfCssZoomPage[];
    try {
      pages = this.options.adapter.pages()
        .filter((page) => page.element.isConnected)
        .map((page) => {
          const rect = page.element.getBoundingClientRect();
          const visible = page.pageNumber === surface.page.pageNumber
            || !hasViewport
            || (rect.right > rootRect.left && rect.left < rootRect.right
              && rect.bottom > rootRect.top && rect.top < rootRect.bottom);
          const overlay = this.surfaces.get(page.pageNumber)?.overlay;
          return {
            pageNumber: page.pageNumber,
            element: page.element,
            ...(overlay ? { overlay } : {}),
            visible
          };
        });
    } catch {
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    const zoomTarget = this.options.adapter.root;
    this.rememberMobileCssZoomTarget(zoomTarget);
    const initialScale = this.mobileCssZoomScale;
    const compositor = new MobilePdfCssZoom();
    let started = false;
    const traceStarted = this.mobilePdfZoomTrace.begin({
      mode: "custom-mobile",
      at: typeof performance === "undefined" ? Date.now() : performance.now(),
      pageCount: pages.filter((page) => page.visible).length,
      initialScale,
      midpoint: focalPoint
    });
    if (traceStarted) {
      this.zoomPipelineTrace.setMode("custom-mobile");
      this.zoomFrameDiagnostics.setMode("custom-mobile");
      this.zoomNativeHandoffTrace.setMode("custom-mobile");
      this.postZoomTrace.setMode("custom-mobile");
      this.postZoomDurability.setMode("custom-mobile");
    }
    try {
      started = traceStarted && compositor.begin({
        root: zoomTarget,
        scrollRoot,
        pages,
        initialScale,
        focalPoint,
        maxVisiblePages: 4
      }, (frame) => {
        this.mobilePdfZoomTrace.noteSample(frame.focalPoint, frame.previewScale);
        this.mobilePdfZoomTrace.noteTransformFrame(frame.zoomDurationMs);
      });
    } catch {
      // A changing PDF page is native-owned until a later qualified gesture.
    }
    if (!started) {
      compositor.cancel();
      this.mobilePdfZoomTrace.cancel("css-zoom-unavailable");
      this.zoomPipelineTrace.setMode("native");
      this.zoomFrameDiagnostics.setMode("native");
      this.zoomNativeHandoffTrace.setMode("native");
      this.postZoomTrace.setMode("native");
      this.postZoomDurability.setMode("native");
      surface.router?.cancelCustomPinch("disabled");
      return;
    }
    this.mobilePdfZoomTrace.notePromote();
    let transaction: MobilePdfCssZoomTransaction | null = null;
    transaction = new MobilePdfCssZoomTransaction({
      compositor,
      initialScale,
      onPreview: (scale, point) => this.mobilePdfZoomTrace.noteSample(point, scale),
      onComplete: (completion) => {
        if (surface.mobileCustomPinch === transaction) surface.mobileCustomPinch = null;
        if (completion.phase === "cancelled") {
          this.mobilePdfZoomTrace.cancel(completion.reason);
        } else {
          this.mobileCssZoomScale = completion.scale;
          this.mobilePdfZoomTrace.release({
            at: typeof performance === "undefined" ? Date.now() : performance.now(),
            focalAnchorErrorPx: 0,
            canonicalRenderWork: false
          });
        }
        extensions.setInkZoomBurstActive?.(false);
      }
    });
    surface.mobileCustomPinch = transaction;
    extensions.setInkZoomBurstActive?.(true);
  }

  private previewMobileCustomPinch(
    surface: PageSurface,
    previewScale: number,
    focalPoint: MobilePinchZoomFocalPoint
  ): void {
    const state = surface.mobileCustomPinch;
    if (!state || !Number.isFinite(previewScale)) return;
    const boundedScale = Math.max(0.1, Math.min(10, previewScale));
    state.preview(boundedScale, focalPoint);
  }

  private endMobileCustomPinch(
    surface: PageSurface,
    reason: "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled",
    latestScale?: number
  ): void {
    const state = surface.mobileCustomPinch;
    if (!state) return;
    if (reason !== "pointerup") {
      state.cancel("capability-lost");
      return;
    }
    state.commit(Number.isFinite(latestScale) ? latestScale : undefined);
  }

  private observeMobileCustomPinch(
    surface: PageSurface,
    signal: MobilePdfZoomHandoffSignal
  ): void {
    surface.mobileCustomPinch?.observe(signal);
  }

  private cancelMobileCustomPinch(
    surface: PageSurface,
    reason: MobilePdfZoomHandoffCancelReason
  ): void {
    surface.mobileCustomPinch?.cancel(reason);
  }

  private handleTouchDoubleTap(point: TouchDoubleTapPoint): void {
    const enabled = this.options.touchDoubleTapEraserEnabled?.()
      ?? this.options.settings.touchDoubleTapEraser;
    if (!enabled || this.hasAnyLiveInkInput() || this.temporaryStylusEraserPointers > 0) {
      this.touchDoubleTapState = null;
      return;
    }
    const at = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = consumeTouchDoubleTap(this.touchDoubleTapState, point, at);
    this.touchDoubleTapState = result.next;
    if (!result.doubleTap) return;

    const active = this.activeTool();
    const next = active === "eraser"
      ? (this.touchDoubleTapPreviousTool ?? "pen")
      : "eraser";
    this.touchDoubleTapPreviousTool = active === "eraser" ? null : active;
    this.lastUiInputPointerType = "touch";
    this.touchDoubleTapChangingTool = true;
    try {
      this.toolbar.activateTool(next);
    } finally {
      this.touchDoubleTapChangingTool = false;
    }
  }

  /**
   * WebKit's PDF text layer can publish the TouchEvent stream while its
   * promoting PointerEvents are retargeted/reused. Recognize the gesture from
   * the native touchstart stream so the feature does not depend on a
   * pointerdown reaching the same page router twice.
   */
  private handleTouchDoubleTapStart(event: TouchEvent, surface: PageSurface): void {
    if (classifyInputTarget(event.target).targetClass !== "page"
      || event.touches.length !== 1
      || this.hasActivePenCapability()) {
      this.touchDoubleTapState = null;
      return;
    }
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch || !(touch.target instanceof Node) || !surface.page.element.contains(touch.target)) {
      this.touchDoubleTapState = null;
      return;
    }
    this.handleTouchDoubleTap(touch);
  }

  private createPageRouter(surface: PageSurface): PointerRouter {
    const router = new PointerRouter(surface.page.element, {
      activeTool: () => this.activeTool(),
      canAnnotatePointer: (event) => this.canAnnotateSurface(surface, event),
      touchAnnotationEnabled: () => this.touchAnnotationEnabled(),
      pointerInputCapabilities: () => detectPointerInputCapabilities(surface.page.element),
      mouseInkingEnabled: () => this.mouseInkingEnabled(),
      onStylusEraserStart: () => {
        this.temporaryStylusEraserPointers += 1;
        this.refreshSurfaceCursors();
      },
      onStylusEraserEnd: () => {
        this.temporaryStylusEraserPointers = Math.max(0, this.temporaryStylusEraserPointers - 1);
        this.refreshSurfaceCursors();
      },
      scrollRoot: () => this.options.adapter.scrollElement(),
      cursorParent: () => surface.overlay,
      eraserCursorDiameter: () => this.options.settings.toolPreferences.eraser.size * this.displayScale(surface),
      drawCursorColor: () => {
        const prefs = this.options.settings.toolPreferences;
        const activeTool = this.activeTool();
        if (activeTool === "laser") return prefs.laser.color;
        return prefs[resolveDrawingTool(activeTool)].color;
      },
      projectCursor: (clientX, clientY) => this.projectInkScreenPoint(surface, clientX, clientY),
      isInputOwnerActive: () => !this.destroyed
        && !this.inputTeardownStarted
        && !this.documentInputOwnershipRevoked
        && inputOwners(surface.page.element).get(surface.page.element) === this,
      onStart: (samples, route, event) => {
        const recoveredAfterRouterRebind = Boolean(surface.builder);
        if (recoveredAfterRouterRebind) {
          this.commitActiveDrawBeforeSurfaceLoss(surface, "router-rebind-recovery");
        }
        this.pointerStart(surface, samples, route, event);
        if (route === "draw" && surface.builder && !surface.laserDraft) {
          this.recordStrokeLifecycleStart(surface, event);
          this.recordPostUiProbeStage(event, "stroke-start", {
            page: surface.page.pageNumber,
            pointCount: surface.builder.preview(this.simplifyStrokesEnabled()).length,
            inputType: event.pointerType || "(empty)",
            correlationId: this.postUiInputProbe.handoffCorrelationId(event.pointerId),
            ...this.pointerEventPropagationDetails(event, surface.page.element, surface.overlay)
          });
        }
        if (event.pointerType === "pen") this.syncTouchDrawPolicy("pen-start");
        this.logger.inputLifecycleEvent("route-decision", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          routerGeneration: surface.router?.generation ?? null,
          routerBindsToPage: Boolean(surface.router?.bindsTo(surface.page.element)),
          inputOwnerIsThisSession: inputOwners(surface.page.element).get(surface.page.element) === this,
          ...this.inputPolicyLogFields(),
          activeTool: this.activeTool(),
          recoveredAfterRouterRebind,
          defaultPrevented: event.defaultPrevented,
          pointerCapture: Boolean(surface.router?.hasPointerCapture(event.pointerId)),
          handledPointerGeneration: this.handledDrawPointers.get(event.pointerId) ?? null,
          touchAction: [...surface.page.element.classList].filter((name) => name.startsWith("native-pdf-handwriting-touch-")),
          reason: recoveredAfterRouterRebind ? "router-rebind-recovery" : "pointerdown-route"
        }));
        const existingRoute = this.postZoomRouterByPointer.get(event.pointerId);
        this.postZoomRouterByPointer.set(event.pointerId, {
          received: existingRoute?.received ?? true,
          rejected: existingRoute?.rejected ?? false,
          route: existingRoute?.route ?? route,
          routeReason: existingRoute?.routeReason ?? null,
          captureStale: this.handledDrawPointers.get(event.pointerId) !== undefined
            && this.handledDrawPointers.get(event.pointerId) !== surface.router?.generation
        });
        if (route === "draw" && event.pointerType === "pen") this.postZoomStrokePointers.add(event.pointerId);
        if (route === "draw" && surface.builder && event.pointerType === "pen") {
          this.logger.inputStroke("start", {
            page: surface.page.pageNumber,
            routerGeneration: surface.router?.generation ?? null,
            correlationId: this.postUiInputProbe.handoffCorrelationId(event.pointerId),
            pointerType: event.pointerType,
            physicalContactId: this.physicalContactIdsByPointer.get(event.pointerId) ?? null,
            pointerEventPenSeen: true,
            classification: "pen-only",
            pressure: event.pressure,
            width: event.width,
            height: event.height,
            touchEvidenceSeen: false
          });
        }
      },
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onPredictedMove: (samples, route, event) => {
        if (route !== "draw" || event.pointerType !== "pen" || !surface.builder || surface.laserDraft) {
          surface.predictedPreview = [];
          return;
        }
        const predicted = this.toPagePoints(surface, samples, false);
        const anchor = surface.builder.preview(false).at(-1);
        surface.predictedPreview = predicted.filter((point, index) => {
          const previous = index === 0 ? anchor : predicted[index - 1];
          return !previous
            || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.01
            || point.time !== previous.time;
        });
        this.scheduleLivePaint(surface, "draw", 0, event);
      },
      onEnd: (samples, route, event) => {
        const hadPenStroke = route === "draw" && Boolean(surface.builder) && event.pointerType === "pen";
        this.logger.inputLifecycleEvent("pointer-end", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          reason: "pointerup"
        }));
        this.pointerEnd(surface, samples, route, event);
        if (event.pointerType === "pen") this.syncTouchDrawPolicy("pen-end");
        if (hadPenStroke) {
          this.logger.inputStroke("end", {
            page: surface.page.pageNumber,
            routerGeneration: surface.router?.generation ?? null,
            correlationId: this.postUiInputProbe.handoffCorrelationId(event.pointerId)
          });
        }
        this.finishPostUiProbe(event, "pointerup", {
          page: surface.page.pageNumber,
          visibleStrokePoints: hadPenStroke ? (this.ink.page(surface.page.pageNumber).at(-1)?.points.length ?? 0) : 0,
          persistedStrokePoints: null,
          route,
          routerGeneration: surface.router?.generation ?? null
        });
        this.clearPointerPerformanceTiming(event.pointerId);
      },
      onCancel: (route, event) => {
        this.logger.inputLifecycleEvent("pointer-cancel", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          reason: "router-pointercancel"
        }));
        this.pointerCancel(surface, route, event);
        this.finishPostUiProbe(event, "pointercancel", {
          page: surface.page.pageNumber,
          visibleStrokePoints: 0,
          persistedStrokePoints: null,
          route,
          routerGeneration: surface.router?.generation ?? null
        });
        this.clearPointerPerformanceTiming(event.pointerId);
        if (event.pointerType === "pen") this.syncTouchDrawPolicy("pen-cancel");
      },
      customPinchEnabled: () => this.customMobilePdfPinchZoomEnabled(surface),
      onCustomPinchStart: (frame) => {
        if (this.activeMobilePinchSurface && this.activeMobilePinchSurface !== surface) {
          this.cancelMobileCustomPinch(this.activeMobilePinchSurface, "capability-lost");
        }
        this.activeMobilePinchSurface = surface;
        if (!this.mobilePinchZoom.start(frame)) this.activeMobilePinchSurface = null;
      },
      onCustomPinchFrame: (frame) => {
        if (this.activeMobilePinchSurface !== surface) return;
        this.mobilePinchZoom.frame(frame);
      },
      onCustomPinchEnd: (reason) => {
        if (this.activeMobilePinchSurface !== surface) return;
        this.mobilePinchZoom.end(reason);
      },
      onTouchStart: (event) => {
        this.notePointerTypeOrigin(event, "page-touch-router", "capture");
        this.logger.inputLifecycleEvent("touchstart", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          reason: "touchstart-capture"
        }));
        // Touch fallback is an annotation route, so recognize before its
        // pointerdown can create a live stroke. Native finger navigation uses
        // the TouchEvent path below instead.
        if (!this.touchAnnotationEnabled()) this.handleTouchDoubleTapStart(event, surface);
      },
      onTouchPointerDown: (event) => {
        const editor = this.activeTextEditor;
        const target = event.target;
        if (editor && !(target instanceof Node && editor.element.contains(target))) {
          this.logText(editor.surface, "outside-touch-close", {
            annotationId: editor.draft.id,
            existing: Boolean(editor.existing),
            pointerId: event.pointerId
          });
          this.commitActiveTextEditor("outside-touch");
        }
        // With the explicit touch-drawing fallback, pointerdown is the only
        // safe pre-stroke point to switch tools; TouchEvent recognition is
        // intentionally skipped for that route to avoid counting one tap
        // twice.
        if (this.touchAnnotationEnabled()) this.handleTouchDoubleTap(event);
      },
      touchTextTarget: (event) => this.isTouchTextTarget(surface, event),
      onRouterReceived: (event, generation) => {
        this.promoteStylusCapability(event);
        this.postZoomRouterByPointer.set(event.pointerId, {
          received: true,
          rejected: false,
          route: null,
          routeReason: null,
          captureStale: false
        });
        if (event.type === "pointerdown") {
          const receivedAt = performance.now();
          this.pointerDownPerformanceAt.set(event.pointerId, receivedAt);
          this.pointerRouteReceivedAt.set(event.pointerId, receivedAt);
          this.pointerInputAt.set(event.pointerId, normalizedPointerEventTime(event, receivedAt));
        }
        this.notePointerTypeOrigin(event, "page-pointer-router", "capture");
        this.recordPostUiProbeStage(event, "router-received", {
          page: surface.page.pageNumber,
          pageMountGeneration: surface.page.mountGeneration ?? null,
          routerGeneration: generation,
          routerAlive: Boolean(surface.router?.isAlive()),
          routerBindsToPage: Boolean(surface.router?.bindsTo(surface.page.element)),
          routerBoundElementId: getDebugNodeId(surface.router?.boundElement() ?? surface.page.element),
          routerListenerAborted: Boolean(surface.router?.isListenerAborted()),
          pageConnected: surface.page.element.isConnected,
          overlayConnected: surface.overlay.isConnected,
          handledPointerGeneration: this.handledDrawPointers.get(event.pointerId) ?? null,
          ...this.pointerEventPropagationDetails(event, surface.page.element, surface.overlay)
        });
        this.logger.inputLifecycleEvent("router-received", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          listenerGeneration: generation,
          reason: "page-capture-listener"
        }));
        this.logger.pageRouter("received", {
          page: surface.page.pageNumber,
          listenerGeneration: generation,
          pointerType: event.pointerType || "(empty)",
          pointerId: event.pointerId,
          targetId: getDebugNodeId(event.target),
          currentTargetId: getDebugNodeId(event.currentTarget),
          pageId: getDebugNodeId(surface.page.element),
          pdfCanvasId: getDebugNodeId(pdfRenderCanvas(surface.page.element)),
          inkCanvasId: getDebugNodeId(surface.canvas),
          routerBoundElementId: getDebugNodeId(surface.router?.boundElement() ?? surface.page.element),
          routerListenerAborted: Boolean(surface.router?.isListenerAborted()),
          pageInComposedPath: typeof event.composedPath === "function" && event.composedPath().includes(surface.page.element),
          adapterRootInComposedPath: typeof event.composedPath === "function" && event.composedPath().includes(this.options.adapter.root),
          cancelable: event.cancelable,
          defaultPrevented: event.defaultPrevented,
          propagationStopped: Reflect.get(event, "cancelBubble") === true
        });
      },
      isPointerHandled: (pointerId, generation) => this.wasDrawPointerHandled(pointerId, generation),
      onPointerHandled: (pointerId, generation) => {
        this.markDrawPointerHandled(pointerId, generation);
      },
      onPointerOwnerReleased: (generation, handoff) => {
        this.releaseDrawPointerOwner(generation, handoff);
        if (handoff && (handoff.routed.length || handoff.activePenIds.length)) {
          surface.pendingRouterHandoff = handoff;
        }
      },
      onPointerRejected: (reason, event, generation) => {
        const existing = this.postZoomRouterByPointer.get(event.pointerId);
        this.postZoomRouterByPointer.set(event.pointerId, {
          received: existing?.received ?? true,
          rejected: true,
          route: reason === "annotation-chrome" ? "native" : "ignored",
          routeReason: reason,
          captureStale: existing?.captureStale ?? false
        });
        this.recordPostUiProbeStage(event, "router-rejected", {
          page: surface.page.pageNumber,
          pageMountGeneration: surface.page.mountGeneration ?? null,
          routerGeneration: generation,
          rejection: reason,
          staleRouter: reason === "inactive-owner" || reason === "stale-generation"
        });
        const pageElement = surface.page.element;
        this.logger.inputLifecycleEvent("router-rejected", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          reason,
          listenerGeneration: generation,
          unexpected: reason === "inactive-owner" || reason === "stale-generation"
        }));
        this.logger.pageRouter("rejected", {
          page: surface.page.pageNumber,
          reason,
          listenerGeneration: generation,
          activeListenerGeneration: surface.router?.generation ?? null,
          handledByGeneration: this.handledDrawPointers.get(event.pointerId) ?? null,
          pointerType: event.pointerType || "(empty)",
          pointerId: event.pointerId,
          targetId: getDebugNodeId(event.target),
          pageId: getDebugNodeId(pageElement),
          pageConnected: pageElement.isConnected,
          bindsToPage: Boolean(surface.router?.bindsTo(pageElement)),
          routerAlive: Boolean(surface.router?.isAlive()),
          activeInputOwner: inputOwners(pageElement).get(pageElement) === this,
          ...this.inputPolicyLogFields(),
          activeTool: this.activeTool()
        });
      },
      onRoute: (route, event) => {
        this.logger.inputLifecycleEvent("pointer-route", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          reason: "classified"
        }));
        this.updateDebug(surface, event);
        this.logger.pointerRoute(route, {
          page: surface.page.pageNumber,
          pointerType: event.pointerType || "(empty)",
          pointerId: event.pointerId,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons: event.buttons,
          width: event.width,
          height: event.height,
          pressure: event.pressure,
          ...this.inputPolicyLogFields(),
          touchDrawPolicyEnabled: this.touchDrawPolicyEnabled,
          resolvedPolicy: this.resolvedPolicyForPointer(event),
          route,
          ...(route === "draw" ? { pressureProfile: this.pressureProfile() } : {}),
          clientX: Math.round(event.clientX),
          clientY: Math.round(event.clientY)
        });
      },
      onRouteDecision: (route, reason, event) => {
        this.logger.inputLifecycleEvent("route-decision", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          routeReason: reason,
          reason: "classifier"
        }));
        const existing = this.postZoomRouterByPointer.get(event.pointerId);
        this.postZoomRouterByPointer.set(event.pointerId, {
          received: true,
          rejected: existing?.rejected ?? false,
          route,
          routeReason: reason,
          captureStale: existing?.captureStale ?? false
        });
        this.recordPostUiProbeStage(event, "route", {
          page: surface.page.pageNumber,
          route,
          routeReason: reason,
          routerGeneration: surface.router?.generation ?? null,
          correlationId: this.postUiInputProbe.handoffCorrelationId(event.pointerId),
          ...this.pointerEventPropagationDetails(event, surface.page.element, surface.overlay)
        });
        if (event.pointerType === "pen" && route === "native") {
          this.finishPostUiProbeWithOutcome(event, "post-ui-pen-routed-native", {
            page: surface.page.pageNumber,
            route,
            routeReason: reason,
            routerGeneration: surface.router?.generation ?? null
          });
        }
      },
      onPointerClaim: (route, event, details) => {
        this.logger.inputLifecycleEvent("pointer-claim", this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          route,
          reason: details.captureSucceeded ? "annotation-claim" : "capture-failed",
          unexpected: !details.preventDefaultCalled || !details.propagationStopped || !details.captureSucceeded,
          ...details
        }));
        this.recordPostUiProbeStage(event, "claim", {
          page: surface.page.pageNumber,
          route,
          claimFailed: !details.preventDefaultCalled || !details.propagationStopped || !details.captureSucceeded,
          correlationId: this.postUiInputProbe.handoffCorrelationId(event.pointerId),
          ...this.pointerEventPropagationDetails(event, surface.page.element, surface.overlay),
          ...details
        });
      },
      onTouchLifecycle: (phase, event, details) => {
        const reason = typeof details.reason === "string" ? details.reason : "";
        if (reason === "touchend-all-clear" || reason === "touchcancel-all-clear") {
          for (const prune of this.pinchCleanup.clearActiveTouches("touch-list-all-clear")) {
            this.logger.stalePinchContact({ ...prune });
          }
        }
        this.logger.inputLifecycleEvent(`touch-${phase}`, this.inputLifecycleDetails(surface, event, {
          page: surface.page.pageNumber,
          reason: details.reason ?? `touch-${phase}`,
          unexpected: phase === "primary-reset",
          ...details
        }));
        this.logger.touchInput(phase, {
          page: surface.page.pageNumber,
          ...(event instanceof PointerEvent
            ? { pointerId: event.pointerId, isPrimary: event.isPrimary }
            : {}),
          ...details
        });
      },
      onTouchPan: (phase, event, details) => {
        this.lastTouchPanAt = Date.now();
        this.logger.touchPan(phase, {
          page: surface.page.pageNumber,
          pointerId: event?.pointerId ?? null,
          ...details
        });
      }
    }, undefined, this.gestureOwnership, false);
    this.lastRouterBindAt = Date.now();
    if (surface.pendingRouterHandoff) {
      const handoff = surface.pendingRouterHandoff;
      surface.pendingRouterHandoff = null;
      router.adoptPointerState(handoff);
      this.logger.inputLifecycleEvent("router-handoff", {
        page: surface.page.pageNumber,
        listenerGeneration: router.generation,
        routedPointerIds: handoff.routed.map(({ pointerId }) => pointerId),
        activePenIds: handoff.activePenIds
      });
    }
    return router;
  }

  /**
   * Zoom / PDF.js page recycling can move the overlay onto a live page node
   * while PointerRouter is still bound to a detached or recycled predecessor.
   * Without a rebind, Draw mode sees no pointer route events.
   * Also rebinds when listeners were aborted but the element reference still matches.
   */

  private markDrawPointerHandled(pointerId: number, generation: number): void {
    this.handledDrawPointers.set(pointerId, generation);
  }

  private wasDrawPointerHandled(pointerId: number, generation?: number): boolean {
    if (generation === undefined) return this.handledDrawPointers.has(pointerId);
    return requirePostZoomInputRuntime().pointerHandledForGeneration(this.handledDrawPointers, pointerId, generation);
  }

  private releaseDrawPointerOwner(generation: number, handoff?: PointerRouterHandoff): void {
    const preserved = new Set(handoff?.routed.map(({ pointerId }) => pointerId) ?? []);
    for (const [pointerId, ownerGeneration] of this.handledDrawPointers) {
      if (ownerGeneration === generation && !preserved.has(pointerId)) this.handledDrawPointers.delete(pointerId);
    }
  }

  private closestPdfPageElement(target: EventTarget | null): HTMLElement | null {
    if (!isElement(target)) return null;
    const page = target.closest(".page, .pdf-page-view, .native-pdf-handwriting-image-page");
    if (!isHTMLElement(page) || isHandwritingPageChrome(page)) return null;
    return page;
  }

  /**
   * Resolve the visual page independently of event.target. Mobile PDF.js can
   * retarget a pen down to a stale layer or a sibling UI node while the page
   * is still visibly present. The result is also the bounded anomaly payload;
   * normal pointer-down logs stay small.
   */
  private inspectPointerHitOnce(
    event: PointerEvent,
    targetPage: HTMLElement | null,
    targetWithin: boolean
  ): PointerHitTest {
    const cached = this.pointerHitTestCache.get(event);
    if (cached) return cached;
    const hitTest = this.inspectPointerHit(event, targetPage, targetWithin);
    this.pointerHitTestCache.set(event, hitTest);
    return hitTest;
  }

  private inspectPointerHit(
    event: PointerEvent,
    targetPage: HTMLElement | null,
    targetWithin: boolean
  ): PointerHitTest {
    const doc = this.options.adapter.host.ownerDocument;
    let topHit: Element | null = null;
    let hitEntries: Element[] = [];
    try {
      topHit = doc.elementFromPoint?.(event.clientX, event.clientY) ?? null;
      hitEntries = doc.elementsFromPoint?.(event.clientX, event.clientY) ?? (topHit ? [topHit] : []);
    } catch {
      topHit = null;
      hitEntries = [];
    }

    const pagesByElement = new Map<HTMLElement, AnnotationPageInfo>();
    for (const surface of this.surfaces.values()) pagesByElement.set(surface.page.element, surface.page);
    // Avoid scanning every desktop page on every pen down. The mounted surface
    // set is the routing authority; add only a directly hit replacement shell
    // when PDF.js has not surfaced it through the session yet.
    for (const candidate of [targetPage, this.closestPdfPageElement(topHit)]) {
      if (!candidate || pagesByElement.has(candidate)) continue;
      const pageNumber = Number(candidate.dataset.pageNumber);
      if (!Number.isFinite(pageNumber) || pageNumber < 1) continue;
      try {
        const page = this.options.adapter.page(pageNumber);
        if (page && !pagesByElement.has(page.element)) pagesByElement.set(page.element, page);
      } catch {
        // The host can be halfway through a PDF.js page rebuild.
      }
    }
    const pages = [...pagesByElement.values()];
    const topPageElement = this.closestPdfPageElement(topHit);
    const geometricPage = (topPageElement
      ? pages.find((page) => page.element === topPageElement && containsClientPoint(page.element, event.clientX, event.clientY))
      : undefined)
      ?? pages.find((page) => page.element.isConnected && containsClientPoint(page.element, event.clientX, event.clientY))
      ?? null;
    const topBelongsToPage = Boolean(topHit && geometricPage?.element.contains(topHit));
    const firstInteractiveHit = hitEntries.find((element) => !isNonInteractiveHit(element)) ?? null;
    const firstInteractiveHitBelongsToPage = Boolean(
      firstInteractiveHit && geometricPage?.element.contains(firstInteractiveHit),
    );
    const firstInteractiveHitOutsideViewer = Boolean(
      firstInteractiveHit && !this.options.adapter.host.contains(firstInteractiveHit),
    );
    const pageOccludedByUi = Boolean(
      geometricPage
      && firstInteractiveHit
      && firstInteractiveHitOutsideViewer
      && !firstInteractiveHitBelongsToPage
      && isObsidianUiOccluder(
        firstInteractiveHit,
        this.options.adapter.host,
        event.clientX,
        event.clientY
      ),
    );
    const staleOutsideHit = Boolean(
      geometricPage
      && firstInteractiveHit
      && firstInteractiveHitOutsideViewer
      && !firstInteractiveHitBelongsToPage
      && isIgnorableStaleOutsideHit(
        firstInteractiveHit,
        this.options.adapter.host,
        event.clientX,
        event.clientY
      ),
    );
    const topIsChrome = isInputChromeTarget(topHit) || isAnnotationChromeTarget(topHit);
    const safeRecoveryPage = geometricPage && !topIsChrome && !pageOccludedByUi && (
      topBelongsToPage
      || firstInteractiveHitBelongsToPage
      || !firstInteractiveHit
      || staleOutsideHit
      || (!topHit && targetWithin && targetPage === geometricPage.element)
    )
      ? geometricPage
      : null;
    const path = typeof event.composedPath === "function" ? event.composedPath().slice(0, 8) : [];
    const visiblePages = pages.filter((page) => {
      if (!page.element.isConnected) return false;
      const rect = page.element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).slice(0, 24);
    const mountedOverlays = [...this.surfaces.values()]
      .map((surface) => ({ page: surface.page.pageNumber, id: getDebugNodeId(surface.overlay), connected: surface.overlay.isConnected, rect: rectDetails(surface.overlay) }))
      .slice(0, 24);
    const scrollRoot = this.options.adapter.scrollElement();
    const occluderShell = describeObsidianUiShell(
      firstInteractiveHit,
      event.clientX,
      event.clientY
    );
    const pageIntersectsHit = Boolean(
      geometricPage && containsClientPoint(geometricPage.element, event.clientX, event.clientY)
    );
    const targetSurface = [...this.surfaces.values()].find((surface) => surface.page.element === targetPage);
    return {
      targetPage,
      geometricPage,
      safeRecoveryPage,
      firstInteractiveHit,
      firstInteractiveHitBelongsToPage,
      pageOccludedByUi,
      details: {
        targetWithinViewer: targetWithin,
        targetWithinPage: Boolean(targetPage && isElement(event.target) && targetPage.contains(event.target)),
        targetWithinOverlay: Boolean(targetSurface?.overlay && isElement(event.target) && targetSurface.overlay.contains(event.target)),
        targetPageId: getDebugNodeId(targetPage),
        targetPageConnected: Boolean(targetPage?.isConnected),
        topHit: hitElementDetails(topHit),
        topHitIsPdfPage: topBelongsToPage,
        topHitIsNonInteractive: isNonInteractiveHit(topHit),
        hitStack: hitEntries.slice(0, 12).map((element) => hitElementDetails(element)),
        elementFromPoint: hitElementDetails(topHit),
        firstInteractiveHit: hitElementDetails(firstInteractiveHit),
        firstInteractiveHitBelongsToPage,
        pageOccludedByUi,
        occluderShell,
        staleOutsideHit,
        pageIntersectsHit,
        msSinceUiShellMutation: this.lastUiShellMutationAt > 0
          ? Date.now() - this.lastUiShellMutationAt
          : null,
        composedPath: path.map((entry) => isElement(entry) ? hitElementDetails(entry) : Object.prototype.toString.call(entry)),
        adapterHostRect: rectDetails(this.options.adapter.host),
        viewerRootRect: rectDetails(this.options.adapter.root),
        scrollRootRect: rectDetails(scrollRoot),
        pageElementRect: rectDetails(geometricPage?.element ?? null),
        handwritingOverlayRect: rectDetails(
          geometricPage ? this.surfaces.get(geometricPage.pageNumber)?.overlay ?? null : null
        ),
        visiblePageRects: visiblePages.map((page) => ({
          page: page.pageNumber,
          id: getDebugNodeId(page.element),
          connected: page.element.isConnected,
          rect: rectDetails(page.element)
        })),
        overlayRects: mountedOverlays,
        geometricPageNumber: geometricPage?.pageNumber ?? null,
        geometricPageId: getDebugNodeId(geometricPage?.element),
        safeRecoveryPageNumber: safeRecoveryPage?.pageNumber ?? null,
        safeRecoveryPageId: getDebugNodeId(safeRecoveryPage?.element ?? null),
        pageInComposedPath: Boolean(geometricPage && path.includes(geometricPage.element)),
        adapterRootInComposedPath: path.includes(this.options.adapter.root),
        viewerHostInComposedPath: path.includes(this.options.adapter.host)
      }
    };
  }

  private shouldFallbackRoutePointer(event: PointerEvent): boolean {
    if (this.destroyed) return false;
    if (event.pointerType === "touch") return false;
    return this.canAnnotatePointerEvent(event);
  }

  /**
   * Resolve PDF page index for a hit shell. Mobile often mounts `.page` before
   * `data-page-number` is stamped; fall back to surface identity + ensure stamp.
   */
  private resolveHitPageNumber(hitPage: HTMLElement): number | null {
    const stamped = Number(hitPage.dataset.pageNumber);
    if (Number.isFinite(stamped) && stamped >= 1) return stamped;
    for (const [pageNumber, surface] of this.surfaces) {
      if (surface.page.element === hitPage) return pageNumber;
    }
    ensurePdfPageNumbers(this.options.adapter.root);
    const after = Number(hitPage.dataset.pageNumber);
    if (Number.isFinite(after) && after >= 1) return after;
    return null;
  }

  private logFallbackSkip(
    reason: string,
    event: PointerEvent,
    extra: Record<string, unknown> = {}
  ): void {
    if (event.pointerType === "pen") {
      this.recordPostUiProbeStage(event, "fallback", {
        fallbackConsidered: true,
        fallbackEligible: false,
        fallbackRejected: true,
        fallbackRejectedReason: reason,
        ...extra
      });
    }
    this.logger.pageRouter("fallback", {
      phase: "skip",
      reason,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      targetId: getDebugNodeId(event.target),
      ...this.inputPolicyLogFields(),
      ...extra
    });
  }

  private logInkInputAnomaly(
    event: PointerEvent,
    hitTest: PointerHitTest,
    reason: string,
    surface?: PageSurface
  ): void {
    if (event.pointerType === "pen") {
      this.recordPostUiProbeStage(event, "fallback", {
        fallbackConsidered: true,
        fallbackEligible: false,
        fallbackRejected: true,
        fallbackRejectedReason: reason,
        anomalyReason: reason
      });
    }
    const view = this.options.adapter.getViewState();
    const resolvedSurface = surface ?? (hitTest.geometricPage
      ? this.surfaces.get(hitTest.geometricPage.pageNumber)
      : undefined);
    const pageElement = hitTest.geometricPage?.element ?? resolvedSurface?.page.element ?? null;
    const router = resolvedSurface?.router ?? null;
    this.logger.inputAnomaly({
      reason,
      sessionId: this.identity.id,
      attached: this.isAttached(),
      documentPath: this.options.documentPath,
      currentPdfPage: view.pageNumber,
      currentScale: view.scale,
      mountedPages: [...this.surfaces.keys()].sort((a, b) => a - b),
      surfaceCount: this.surfaces.size,
      page: hitTest.geometricPage?.pageNumber ?? resolvedSurface?.page.pageNumber ?? null,
      pageId: getDebugNodeId(pageElement),
      pageConnected: Boolean(pageElement?.isConnected),
      pageRect: rectDetails(pageElement),
      overlayId: resolvedSurface ? getDebugNodeId(resolvedSurface.overlay) : null,
      overlayConnected: Boolean(resolvedSurface?.overlay.isConnected),
      routerGeneration: router?.generation ?? null,
      routerAlive: Boolean(router?.isAlive()),
      routerBindsToPage: Boolean(router && pageElement && router.bindsTo(pageElement)),
      inputOwnerIsThisSession: Boolean(pageElement && inputOwners(pageElement).get(pageElement) === this),
      activeTool: this.activeTool(),
      ...this.inputPolicyLogFields(),
      pointerType: event.pointerType || "(empty)",
      pointerId: event.pointerId,
      pressure: event.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      clientX: Math.round(event.clientX),
      clientY: Math.round(event.clientY),
      activePenIds: router?.activePenIds() ?? [],
      pointerCaptureTarget: router?.hasPointerCapture(event.pointerId) ? getDebugNodeId(pageElement) : null,
      ...hitTest.details
    });
  }

  private skipOccludedPointer(event: PointerEvent, hitTest: PointerHitTest): boolean {
    if (!hitTest.pageOccludedByUi) return false;
    this.logFallbackSkip("ui-occluded", event, {
      page: hitTest.geometricPage?.pageNumber ?? null,
      pageOccludedByUi: true,
      firstInteractiveHit: hitTest.details.firstInteractiveHit ?? null,
      occluderShell: hitTest.details.occluderShell ?? null
    });
    if (event.pointerType === "pen" && hitTest.geometricPage) {
      this.recordPostUiProbeStage(event, "hit-test", {
        page: hitTest.geometricPage.pageNumber,
        pageOccludedByUi: true,
        occluded: true,
        occluderShell: hitTest.details.occluderShell ?? null
      });
      this.finishPostUiProbeWithOutcome(event, "post-ui-pen-ui-occluded", {
        page: hitTest.geometricPage.pageNumber,
        pageOccludedByUi: true,
        occluded: true,
        occluderShell: hitTest.details.occluderShell ?? null
      });
      this.logPenOcclusionAnomaly(event, hitTest);
    }
    return true;
  }

  /**
   * One summarized pen-occlusion anomaly per failed attempt/burst. Keeps the
   * rich elementsFromPoint stack out of the hot path for mouse / repeat spam.
   */
  private logPenOcclusionAnomaly(event: PointerEvent, hitTest: PointerHitTest): void {
    const hit = hitTest.details.firstInteractiveHit as Record<string, unknown> | null | undefined;
    const classes = Array.isArray(hit?.classes) ? (hit.classes as string[]).join(".") : "";
    const key = [
      hitTest.geometricPage?.pageNumber ?? "?",
      Math.round(event.clientX / 8),
      Math.round(event.clientY / 8),
      typeof hit?.tag === "string" ? hit.tag : "",
      classes
    ].join("|");
    const now = Date.now();
    if (key === this.lastPenOcclusionAnomalyKey && now - this.lastPenOcclusionAnomalyAt < 750) {
      return;
    }
    this.lastPenOcclusionAnomalyKey = key;
    this.lastPenOcclusionAnomalyAt = now;
    this.logInkInputAnomaly(event, hitTest, "pen-occlusion-anomaly");
  }

  private pageInfoForHitElement(hitPage: HTMLElement, pageNumber: number, surface: PageSurface): AnnotationPageInfo {
    const fromAdapter = this.options.adapter.page(pageNumber);
    if (fromAdapter && fromAdapter.element === hitPage) return fromAdapter;
    // Keep stored metrics; only the shell identity changes for this remount.
    return {
      pageNumber,
      width: surface.page.width,
      height: surface.page.height,
      scale: surface.page.scale,
      rotation: surface.page.rotation,
      ...(surface.page.coordinateOrigin ? { coordinateOrigin: surface.page.coordinateOrigin } : {}),
      element: hitPage
    };
  }

  /**
   * Document capture: route pen/mouse draw here. Do not trust binds/alive alone —
   * page capture can stay silent after zoom while health checks still pass.
   */
  private captureDrawPointerFallback(
    event: PointerEvent,
    within: (target: EventTarget | null) => boolean,
    hitTest = this.inspectPointerHit(event, this.closestPdfPageElement(event.target), within(event.target))
  ): void {
    if (!this.shouldFallbackRoutePointer(event)) return;
    const targetWithin = within(event.target);
    if (isInputChromeTarget(event.target)) {
      this.logFallbackSkip("input-chrome", event, { via: "capture" });
      return;
    }
    if (this.skipOccludedPointer(event, hitTest)) return;
    let hitPage = this.closestPdfPageElement(event.target);
    const penPage = event.pointerType === "pen" && !hitTest.pageOccludedByUi
      ? hitTest.geometricPage?.element ?? null
      : null;
    if ((!targetWithin || !hitPage) && hitTest.safeRecoveryPage) {
      hitPage = hitTest.safeRecoveryPage.element;
    } else if ((!targetWithin || !hitPage) && penPage) {
      hitPage = penPage;
    }
    if (hitPage && hitTest.geometricPage && hitTest.details.topHit && !hitTest.safeRecoveryPage && hitPage !== penPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-covered-by-nonviewer-hit");
      }
      return;
    }
    if (!targetWithin && !hitTest.safeRecoveryPage && hitPage !== penPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "pen-over-visible-page-not-routed");
      }
      return;
    }
    if (!hitPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-target-unresolved");
      }
      return;
    }
    const pageNumber = this.resolveHitPageNumber(hitPage);
    if (pageNumber === null) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-number-unresolved");
      }
      this.logFallbackSkip("missing-page-number", event, {
        hitPageId: getDebugNodeId(hitPage),
        hasDataPageNumber: hitPage.hasAttribute("data-page-number"),
        dataPageNumber: hitPage.dataset.pageNumber ?? null
      });
      return;
    }
    const surface = this.surfaces.get(pageNumber);
    if (!surface) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-surface-missing");
      }
      this.logFallbackSkip("no-surface", event, {
        page: pageNumber,
        hitPageId: getDebugNodeId(hitPage)
      });
      return;
    }
    const activeInputOwner = inputOwners(hitPage).get(hitPage);
    if (activeInputOwner && activeInputOwner !== this) {
      this.logFallbackSkip("inactive-input-owner", event, {
        page: pageNumber,
        activeInputOwner: true,
        hitPageId: getDebugNodeId(hitPage)
      });
      return;
    }
    const binds = Boolean(surface.router?.bindsTo(hitPage));
    const alive = Boolean(surface.router?.isAlive());
    const boundOk = binds && alive;
    let fallbackPhase: "capture-sync" | "capture-repair" = "capture-sync";
    if (!boundOk || surface.page.element !== hitPage) {
      fallbackPhase = "capture-repair";
      const info = this.pageInfoForHitElement(hitPage, pageNumber, surface);
      if (surface.page.element !== hitPage) {
        this.remountSurfaceOnPageReplacement(surface, info);
      } else {
        this.ensurePageRouter(surface, { force: true, reason: "document-hit-mismatch" });
      }
    }
    this.logger.pageRouter("fallback", {
      phase: fallbackPhase,
      page: pageNumber,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      hitPageId: getDebugNodeId(hitPage),
      boundPageId: getDebugNodeId(surface.page.element),
      targetId: getDebugNodeId(event.target),
      binds,
      alive,
      listenerGeneration: surface.router?.generation ?? null
    });
    const route = surface.router?.acceptPointerDown(event) ?? null;
    if (event.pointerType === "pen") {
      this.recordPostUiProbeStage(event, "fallback", {
        fallbackConsidered: true,
        fallbackEligible: true,
        fallbackAccepted: route === "draw" || route === "edit" || route === "text",
        fallbackRoute: route,
        fallbackRejected: route === null || (route !== "draw" && route !== "edit" && route !== "text"),
        fallbackRejectedReason: route === null ? "router-unavailable" : route,
        page: pageNumber,
        routerGeneration: surface.router?.generation ?? null,
        recoveredAfterRouterRebind: fallbackPhase === "capture-repair"
      });
    }
    if (event.pointerType === "pen" && hitTest.geometricPage && route !== "draw" && route !== "edit" && route !== "text"
      && !isAnnotationChromeTarget(event.target)) {
      this.logInkInputAnomaly(event, hitTest, "pen-over-visible-page-not-started", surface);
    }
  }

  /**
   * Document bubble: page capture never marked this pointer — route it now.
   * Prefer bubble over microtask so preventDefault still applies in-dispatch.
   */
  private bubbleDrawPointerFallback(
    event: PointerEvent,
    within: (target: EventTarget | null) => boolean,
    hitTest = this.inspectPointerHit(event, this.closestPdfPageElement(event.target), within(event.target))
  ): void {
    if (!this.shouldFallbackRoutePointer(event)) return;
    const fallbackPage = this.closestPdfPageElement(event.target);
    const fallbackSurface = fallbackPage
      ? [...this.surfaces.values()].find((surface) => surface.page.element === fallbackPage)
      : undefined;
    const liveGeneration = fallbackSurface?.router?.generation;
    if (liveGeneration !== undefined) {
      if (this.wasDrawPointerHandled(event.pointerId, liveGeneration)) return;
    } else if (this.wasDrawPointerHandled(event.pointerId)) return;
    const targetWithin = within(event.target);
    if (isInputChromeTarget(event.target)) {
      this.logFallbackSkip("input-chrome", event, { via: "bubble" });
      return;
    }
    if (this.skipOccludedPointer(event, hitTest)) return;
    let hitPage = this.closestPdfPageElement(event.target);
    const penPage = event.pointerType === "pen" && !hitTest.pageOccludedByUi
      ? hitTest.geometricPage?.element ?? null
      : null;
    if ((!targetWithin || !hitPage) && hitTest.safeRecoveryPage) {
      hitPage = hitTest.safeRecoveryPage.element;
    } else if ((!targetWithin || !hitPage) && penPage) {
      hitPage = penPage;
    }
    if (hitPage && hitTest.geometricPage && hitTest.details.topHit && !hitTest.safeRecoveryPage && hitPage !== penPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-covered-by-nonviewer-hit");
      }
      return;
    }
    if (!targetWithin && !hitTest.safeRecoveryPage && hitPage !== penPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "pen-over-visible-page-not-routed", undefined);
      }
      return;
    }
    if (!hitPage) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-target-unresolved");
      }
      return;
    }
    const pageNumber = this.resolveHitPageNumber(hitPage);
    if (pageNumber === null) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-number-unresolved");
      }
      this.logFallbackSkip("missing-page-number", event, {
        via: "bubble",
        hitPageId: getDebugNodeId(hitPage),
        hasDataPageNumber: hitPage.hasAttribute("data-page-number"),
        dataPageNumber: hitPage.dataset.pageNumber ?? null
      });
      return;
    }
    const surface = this.surfaces.get(pageNumber);
    if (!surface) {
      if (event.pointerType === "pen" && hitTest.geometricPage) {
        this.logInkInputAnomaly(event, hitTest, "visible-page-surface-missing");
      }
      this.logFallbackSkip("no-surface", event, {
        via: "bubble",
        page: pageNumber,
        hitPageId: getDebugNodeId(hitPage)
      });
      return;
    }
    const activeInputOwner = inputOwners(hitPage).get(hitPage);
    if (activeInputOwner && activeInputOwner !== this) {
      this.logFallbackSkip("inactive-input-owner", event, {
        via: "bubble",
        page: pageNumber,
        activeInputOwner: true,
        hitPageId: getDebugNodeId(hitPage)
      });
      return;
    }
    if (!(surface.router?.bindsTo(hitPage) && surface.router.isAlive())) {
      const info = this.pageInfoForHitElement(hitPage, pageNumber, surface);
      if (surface.page.element !== hitPage) {
        this.remountSurfaceOnPageReplacement(surface, info);
      } else {
        this.ensurePageRouter(surface, { force: true, reason: "document-bubble-mismatch" });
      }
    }
    this.logger.pageRouter("fallback", {
      phase: "bubble",
      page: pageNumber,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      hitPageId: getDebugNodeId(hitPage),
      boundPageId: getDebugNodeId(surface.page.element),
      targetId: getDebugNodeId(event.target),
      listenerGeneration: surface.router?.generation ?? null
    });
    const route = surface.router?.acceptPointerDown(event) ?? null;
    if (event.pointerType === "pen") {
      this.recordPostUiProbeStage(event, "fallback", {
        fallbackConsidered: true,
        fallbackEligible: true,
        fallbackAccepted: route === "draw" || route === "edit" || route === "text",
        fallbackRoute: route,
        fallbackRejected: route === null || (route !== "draw" && route !== "edit" && route !== "text"),
        fallbackRejectedReason: route === null ? "router-unavailable" : route,
        page: pageNumber,
        routerGeneration: surface.router?.generation ?? null,
        via: "bubble"
      });
    }
    if (event.pointerType === "pen" && hitTest.geometricPage && route !== "draw" && route !== "edit" && route !== "text"
      && !isAnnotationChromeTarget(event.target)) {
      this.logInkInputAnomaly(event, hitTest, "pen-over-visible-page-not-started", surface);
    }
  }

  private ensurePageRouter(surface: PageSurface, options?: { force?: boolean; reason?: string }): void {
    const pageElement = surface.page.element;
    const reason = options?.reason ?? "ensure-page-router";
    const force = options?.force === true;
    const binds = Boolean(surface.router?.bindsTo(pageElement));
    const alive = Boolean(surface.router?.isAlive());
    const pdfCanvas = pdfRenderCanvas(pageElement);
    const hasPdfCanvas = Boolean(pdfCanvas);
    // Early PDF.js paints may lack a canvas briefly; do not thrash routers on that.
    // Callers pass force after zoom handoff / page remount when rebinding is required.
    if (!force && binds && alive) return;
    if (surface.router) {
      if (this.zoomProfile) this.zoomProfile.routerDestroys += 1;
      this.logger.inputLifecycleEvent("router-destroy", {
        source: "session-input",
        page: surface.page.pageNumber,
        reason,
        listenerGeneration: surface.router.generation,
        zoomBurstId: this.postZoomTrace.currentBurstId(),
        binds,
        alive,
        activePenCount: surface.router.activePenIds().length,
        activeTouchCount: surface.router.activeTouchPointerIds().length,
        captureLost: true,
        cleanupReason: reason
      });
      this.postZoomTrace.remember("router-destroy", {
        page: surface.page.pageNumber,
        reason,
        listenerGeneration: surface.router.generation
      });
    }
    surface.router?.destroy();
    if (!pageElement.isConnected) {
      surface.router = null;
      this.logger.pageRouter("unavailable", {
        page: surface.page.pageNumber,
        reason,
        force,
        binds,
        alive,
        hasPdfCanvas,
        connected: false,
        pageId: getDebugNodeId(pageElement),
        pdfCanvasId: getDebugNodeId(pdfCanvas),
        inkCanvasId: getDebugNodeId(surface.canvas)
      });
      return;
    }
    this.claimInputOwner(pageElement, surface.page.pageNumber);
    surface.router = this.createPageRouter(surface);
    if (this.zoomProfile) this.zoomProfile.routerRebinds += 1;
    if (surface.strokePerformance) surface.strokePerformance.routerRebinds += 1;
    this.logger.inputLifecycleEvent("router-rebind", {
      source: "session-input",
      page: surface.page.pageNumber,
      reason,
      listenerGeneration: surface.router.generation,
      zoomBurstId: this.postZoomTrace.currentBurstId(),
      pageId: getDebugNodeId(pageElement),
      ownerBefore: "none",
      ownerAfter: "this-session",
      cleanupReason: reason
    });
    this.postZoomTrace.remember("router-rebind", {
      page: surface.page.pageNumber,
      reason,
      listenerGeneration: surface.router.generation,
      pageId: getDebugNodeId(pageElement)
    });
    this.logger.pageRouter("rebind", {
      page: surface.page.pageNumber,
      reason,
      force,
      binds,
      alive,
      hasPdfCanvas,
      rebound: true,
      postBindAlive: surface.router.isAlive(),
      connected: pageElement.isConnected,
      listenerGeneration: surface.router.generation,
      pageId: getDebugNodeId(pageElement),
      pdfCanvasId: getDebugNodeId(pdfCanvas),
      inkCanvasId: getDebugNodeId(surface.canvas),
      pdfCanvasConnected: Boolean(pdfCanvas?.isConnected),
      inkCanvasConnected: surface.canvas.isConnected,
      inputTargetId: getDebugNodeId(pageElement)
    });
    this.logger.inputOwner("claim", {
      page: surface.page.pageNumber,
      reason,
      rebound: true,
      listenerGeneration: surface.router.generation
    });
  }

  private startInteractionLongTaskObserver(): void {
    if (!this.logger.isEnabled() || this.interactionLongTaskObserver || typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((entries) => {
        const longest = entries.getEntries().reduce((max, entry) => Math.max(max, entry.duration), 0);
        for (const surface of this.surfaces.values()) {
          if (surface.strokePerformance) surface.strokePerformance.longTaskMaxMs = Math.max(surface.strokePerformance.longTaskMaxMs, longest);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      this.interactionLongTaskObserver = observer;
    } catch {
      this.interactionLongTaskObserver = null;
    }
  }

  private stopInteractionLongTaskObserver(): void {
    if ([...this.surfaces.values()].some((surface) => surface.strokePerformance)) return;
    this.interactionLongTaskObserver?.disconnect();
    this.interactionLongTaskObserver = null;
  }

  private clearPointerPerformanceTiming(pointerId: number): void {
    this.pointerDownPerformanceAt.delete(pointerId);
    this.pointerInputAt.delete(pointerId);
    this.pointerRouteReceivedAt.delete(pointerId);
  }

  private startStrokePerformance(surface: PageSurface, event: PointerEvent, sampleCount: number): void {
    if (!this.logger.isEnabled()) {
      surface.strokePerformance = null;
      return;
    }
    // A delayed acknowledgement from the previous stroke must not block the
    // next stroke's one-per-surface acknowledgement slot. It is diagnostic
    // only, so canceling the stale sample is safer than attributing it to the
    // new stroke or allowing it to delay live-paint bookkeeping.
    this.cancelPaintAcknowledgement(surface);
    const startedAt = performance.now();
    const routeReceivedAt = this.pointerRouteReceivedAt.get(event.pointerId) ?? startedAt;
    const inputAt = this.pointerInputAt.get(event.pointerId) ?? routeReceivedAt;
    this.startInteractionLongTaskObserver();
    surface.strokePerformance = {
      startedAt,
      pointerDownAt: this.pointerDownPerformanceAt.get(event.pointerId) ?? startedAt,
      pointerId: event.pointerId,
      physicalContactId: this.physicalContactIdsByPointer.get(event.pointerId) ?? null,
      strokeId: null,
      firstCanvasCommitAt: null,
      firstInputAt: inputAt,
      modelStartedAt: null,
      pointerUpAt: null,
      page: surface.page.pageNumber,
      tool: this.activeTool(),
      pointerType: event.pointerType || "unknown",
      pointerEvents: sampleCount,
      renderUpdates: 0,
      inputToRender: new BoundedTiming(),
      routing: new BoundedTiming(),
      geometry: new BoundedTiming(),
      model: new BoundedTiming(),
      scheduling: new BoundedTiming(),
      canvasCommit: new BoundedTiming(),
      paintAcknowledgement: new BoundedTiming(),
      frameIntervals: this.frameTimingAccumulator(),
      renderTotalMs: 0,
      maxPluginCallbackMs: 0,
      lastRenderAt: null,
      longTaskMaxMs: 0,
      routerRebinds: 0,
      canvasResizes: 0,
      vectorRepaints: 0,
      mutationRefreshes: 0,
      hqUpgrades: 0
    };
    surface.strokePerformance.routing.add(Math.max(0, startedAt - routeReceivedAt));
  }

  private noteStrokeCanvasCommit(surface: PageSurface, at: number, startedAt?: number): void {
    const profile = surface.strokePerformance;
    if (!profile) return;
    if (profile.firstCanvasCommitAt === null) profile.firstCanvasCommitAt = at;
    if (startedAt !== undefined) profile.canvasCommit.add(Math.max(0, at - startedAt));
    // A terminal pointerup can cancel the queued wet frame. Preserve an
    // end-to-end input sample for that synchronous commit rather than losing
    // the stroke from the threshold-gated latency trace.
    if (profile.inputToRender.count === 0 && profile.firstInputAt !== null) {
      profile.inputToRender.add(Math.max(0, at - profile.firstInputAt));
    }
  }

  private recordStrokeLifecycleStart(surface: PageSurface, event: PointerEvent): void {
    const builder = surface.builder;
    if (!builder || surface.laserDraft) return;
    const penContactId = event.pointerType === "pen"
      ? this.postUiInputProbe.handoffCorrelationId(event.pointerId)
      : null;
    this.rememberStrokePenContact(builder.id, penContactId);
    this.logger.strokeLifecycle("stroke-route-start", {
      strokeId: builder.id,
      penContactId,
      page: surface.page.pageNumber,
      tool: builder.style.tool,
      inputType: event.pointerType || "(empty)"
    });
    this.logger.strokeLifecycle("stroke-create", {
      strokeId: builder.id,
      penContactId,
      page: surface.page.pageNumber,
      tool: builder.style.tool,
      inputType: event.pointerType || "(empty)"
    });
  }

  private rememberStrokePenContact(strokeId: string, penContactId: string | null): void {
    while (this.strokePenContactIds.size >= 128 && !this.strokePenContactIds.has(strokeId)) {
      const oldest = this.strokePenContactIds.keys().next().value;
      if (typeof oldest !== "string") break;
      this.strokePenContactIds.delete(oldest);
    }
    this.strokePenContactIds.set(strokeId, penContactId);
  }

  private recordInkLifecycle(event: InkLifecycleEvent): void {
    if (event.phase === "stroke-model-insert") {
      const profile = this.surfaces.get(event.stroke.page)?.strokePerformance;
      if (profile?.strokeId === event.stroke.id && profile.modelStartedAt !== null) {
        profile.model.add(Math.max(0, performance.now() - profile.modelStartedAt));
        profile.modelStartedAt = null;
      }
    }
    const penContactId = this.strokePenContactIds.get(event.stroke.id) ?? null;
    this.logger.strokeLifecycle(event.phase, {
      strokeId: event.stroke.id,
      penContactId,
      page: event.stroke.page,
      tool: event.stroke.tool,
      strokeCountBefore: event.strokeCountBefore,
      strokeCountAfter: event.strokeCountAfter,
      modelPresent: event.modelPresent,
      ...(event.reason ? { reason: event.reason } : {})
    });
    pdfSurfaceExtensions(this.options.adapter)?.refreshInkPreviews?.([event.stroke.page]);
  }

  private recordStrokeReloadRestoration(stroke: InkStroke, source: string, reason: string): void {
    this.strokePersistenceState(stroke.id);
    this.logger.strokeLifecycle("stroke-reload-restoration", {
      strokeId: stroke.id,
      penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
      page: stroke.page,
      tool: stroke.tool,
      modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id),
      restored: true,
      source,
      reason
    });
  }

  private recordStrokeSerialization(snapshot: SidecarSchemaV1, store: "recovery" | "sidecar", reason: string): void {
    const revision = `${store}:${snapshot.updatedAt}`;
    const serializedIds = new Set<string>();
    for (const page of snapshot.pages) {
      for (const stroke of page.strokes) {
        serializedIds.add(stroke.id);
        const state = this.strokePersistenceState(stroke.id);
        if (state.lastSerializationRevision === revision) continue;
        state.lastSerializationRevision = revision;
        this.logger.strokeLifecycle("stroke-serialization-included", {
          strokeId: stroke.id,
          penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
          page: stroke.page,
          tool: stroke.tool,
          modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id),
          serializationIncluded: true,
          serializedStrokeCount: page.strokes.length,
          store,
          reason,
          snapshotUpdatedAt: snapshot.updatedAt
        });
      }
    }
    for (const stroke of this.ink.all()) {
      if (serializedIds.has(stroke.id)) continue;
      const state = this.strokePersistenceState(stroke.id);
      if (state.lastSerializationOmissionRevision === revision) continue;
      state.lastSerializationOmissionRevision = revision;
      this.logger.strokeLifecycle("stroke-serialization-omitted", {
        strokeId: stroke.id,
        penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
        page: stroke.page,
        tool: stroke.tool,
        modelPresent: true,
        serializationIncluded: false,
        store,
        reason: "missing-from-snapshot",
        persistenceReason: reason,
        snapshotUpdatedAt: snapshot.updatedAt
      });
    }
  }

  private recordStrokePersisted(snapshot: SidecarSchemaV1, reason: string): void {
    for (const page of snapshot.pages) {
      for (const stroke of page.strokes) {
        const state = this.strokePersistenceState(stroke.id);
        if (state.lastPersistedRevision === snapshot.updatedAt) continue;
        state.lastPersistedRevision = snapshot.updatedAt;
        this.logger.strokeLifecycle("stroke-persisted", {
          strokeId: stroke.id,
          penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
          page: stroke.page,
          tool: stroke.tool,
          modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id),
          serializationIncluded: true,
          persisted: true,
          persistenceStore: "sidecar-and-recovery",
          reason,
          snapshotUpdatedAt: snapshot.updatedAt
        });
      }
    }
  }

  private strokePersistenceState(strokeId: string): StrokePersistenceLifecycleState {
    const existing = this.strokePersistenceStates.get(strokeId);
    if (existing) return existing;
    while (this.strokePersistenceStates.size >= 256) {
      const oldest = this.strokePersistenceStates.keys().next().value;
      if (typeof oldest !== "string") break;
      this.strokePersistenceStates.delete(oldest);
    }
    const state: StrokePersistenceLifecycleState = {
      strokeId,
      lastSerializationRevision: null,
      lastSerializationOmissionRevision: null,
      lastPersistedRevision: null
    };
    this.strokePersistenceStates.set(strokeId, state);
    return state;
  }

  private strokePixelEvidenceState(strokeId: string): StrokePixelEvidenceState {
    const existing = this.strokePixelEvidenceStates.get(strokeId);
    if (existing) return existing;
    while (this.strokePixelEvidenceStates.size >= 256) {
      const oldest = this.strokePixelEvidenceStates.keys().next().value;
      if (typeof oldest !== "string") break;
      this.strokePixelEvidenceStates.delete(oldest);
    }
    const state: StrokePixelEvidenceState = {
      strokeId,
      paintGeneration: null,
      canvasGeneration: null,
      region: null,
      before: null,
      lastDelayedPaintGeneration: null
    };
    this.strokePixelEvidenceStates.set(strokeId, state);
    return state;
  }

  private pixelEvidenceRegion(surface: PageSurface, stroke: InkStroke, canvas: HTMLCanvasElement): PixelEvidenceRegion | null {
    if (!canvas.width || !canvas.height || !stroke.points.length) return null;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const zoom = this.mobilePdfCssZoomFactor();
    const cssWidth = Math.max(1, rect.width >= 8 ? rect.width / zoom : layout.contentWidth || 1);
    const cssHeight = Math.max(1, rect.height >= 8 ? rect.height / zoom : layout.contentHeight || 1);
    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;
    const mapper = this.mapper(surface);
    const points = stroke.points.map((point) => mapper.toViewport(point));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const padding = Math.max(2, stroke.width * this.displayScale(surface) + 2);
    const rawLeft = Math.floor((minX - padding) * scaleX);
    const rawTop = Math.floor((minY - padding) * scaleY);
    const rawRight = Math.ceil((maxX + padding) * scaleX);
    const rawBottom = Math.ceil((maxY + padding) * scaleY);
    const clamp = (value: number, lower: number, upper: number): number => Math.max(lower, Math.min(upper, value));
    const left = clamp(rawLeft, 0, Math.max(0, canvas.width - 1));
    const top = clamp(rawTop, 0, Math.max(0, canvas.height - 1));
    const right = clamp(rawRight, left + 1, canvas.width);
    const bottom = clamp(rawBottom, top + 1, canvas.height);
    const cap = ViewerInkSession.PIXEL_EVIDENCE_MAX_EDGE;
    const width = Math.min(cap, Math.max(1, right - left));
    const height = Math.min(cap, Math.max(1, bottom - top));
    const centeredLeft = clamp(Math.floor((left + right - width) / 2), 0, Math.max(0, canvas.width - width));
    const centeredTop = clamp(Math.floor((top + bottom - height) / 2), 0, Math.max(0, canvas.height - height));
    return { x: centeredLeft, y: centeredTop, width, height };
  }

  private readPixelEvidence(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, region: PixelEvidenceRegion | null): PixelEvidenceSample {
    if (!region || !canvas.width || !canvas.height) {
      return { available: false, pixelCount: 0, nonTransparentPixels: 0, alphaSum: 0, reason: "affected-region-unavailable" };
    }
    try {
      const data = context.getImageData(region.x, region.y, region.width, region.height).data;
      let nonTransparentPixels = 0;
      let alphaSum = 0;
      for (let index = 3; index < data.length; index += 4) {
        const alpha = data[index] ?? 0;
        alphaSum += alpha;
        if (alpha > 0) nonTransparentPixels += 1;
      }
      return {
        available: true,
        pixelCount: region.width * region.height,
        nonTransparentPixels,
        alphaSum
      };
    } catch (error) {
      return {
        available: false,
        pixelCount: region.width * region.height,
        nonTransparentPixels: 0,
        alphaSum: 0,
        reason: this.errorMessage(error)
      };
    }
  }

  private strokeCachePixelEvidence(surface: PageSurface, stroke: InkStroke): {
    inkLayer: PixelEvidenceSample;
    canvas: PixelEvidenceSample;
  } {
    const unavailable = (reason: string): PixelEvidenceSample => ({
      available: false,
      pixelCount: 0,
      nonTransparentPixels: 0,
      alphaSum: 0,
      reason
    });
    if (!this.logger.isEnabled()) {
      return { inkLayer: unavailable("diagnostics-disabled"), canvas: unavailable("diagnostics-disabled") };
    }
    const canvasRegion = this.pixelEvidenceRegion(surface, stroke, surface.canvas);
    const canvas = this.readPixelEvidence(surface.context, surface.canvas, canvasRegion);
    const inkLayer = surface.inkLayer && surface.inkLayerContext
      ? this.readPixelEvidence(
        surface.inkLayerContext,
        surface.inkLayer,
        this.pixelEvidenceRegion(surface, stroke, surface.inkLayer)
      )
      : unavailable("ink-layer-unavailable");
    return { inkLayer, canvas };
  }

  private recordStrokeCacheHandoff(
    surface: PageSurface,
    stroke: InkStroke,
    phase: "before" | "after",
    pageRevision: number,
    expectedLayerRevision: number,
    evidence: { inkLayer: PixelEvidenceSample; canvas: PixelEvidenceSample }
  ): void {
    if (!this.logger.isEnabled()) return;
    const pageStrokes = this.ink.page(surface.page.pageNumber);
    const previous = pageStrokes.slice(Math.max(0, pageStrokes.length - 3), -1);
    this.logger.strokeLifecycle("stroke-cache-handoff", {
      phase,
      page: surface.page.pageNumber,
      strokeId: stroke.id,
      previousStrokeIds: previous.map((candidate) => candidate.id),
      previousModelPresent: previous.map((candidate) => this.ink.page(surface.page.pageNumber).some((item) => item.id === candidate.id)),
      pageRevision,
      expectedLayerRevision,
      cachedLayerRevision: surface.inkLayerRevision,
      inkLayerValid: surface.inkLayerValid,
      inkLayerBurstCapture: surface.inkLayerBurstCapture,
      canvasGeneration: surface.canvasGeneration,
      paintGeneration: surface.paintGeneration,
      committedCanvasWetHidden: surface.canvas.classList.contains("is-wet-hidden"),
      wetPreviewActive: surface.wetPreviewActive,
      inkLayerPixelEvidence: evidence.inkLayer.nonTransparentPixels,
      committedCanvasPixelEvidence: evidence.canvas.nonTransparentPixels,
      pixelEvidenceAvailable: evidence.inkLayer.available && evidence.canvas.available
    });
  }

  private pixelEvidenceDetails(
    stroke: InkStroke,
    surface: PageSurface,
    region: PixelEvidenceRegion | null,
    sample: PixelEvidenceSample,
    target: string
  ): Record<string, unknown> {
    return {
      strokeId: stroke.id,
      penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
      page: stroke.page,
      tool: stroke.tool,
      modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id),
      canvasGeneration: surface.canvasGeneration,
      paintGeneration: surface.paintGeneration,
      pixelEvidenceAvailable: sample.available,
      pixelSampleTarget: target,
      pixelSampleCount: sample.pixelCount,
      nonTransparentPixels: sample.nonTransparentPixels,
      alphaSum: sample.alphaSum,
      affectedRegionWidth: region?.width ?? 0,
      affectedRegionHeight: region?.height ?? 0,
      ...(sample.reason ? { reason: sample.reason } : {})
    };
  }

  private beginStrokePixelEvidence(surface: PageSurface, stroke: InkStroke, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    if (!this.logger.isEnabled()) return;
    const state = this.strokePixelEvidenceState(stroke.id);
    // Evidence is diagnostic only. One bounded sample per canvas generation is
    // enough; sampling every incremental paint generation performs synchronous
    // getImageData calls on the pointer-release path.
    if (state.canvasGeneration === surface.canvasGeneration && state.region) return;
    const region = this.pixelEvidenceRegion(surface, stroke, canvas);
    const before = this.readPixelEvidence(context, canvas, region);
    state.paintGeneration = surface.paintGeneration;
    state.canvasGeneration = surface.canvasGeneration;
    state.region = region;
    state.before = before;
    this.logger.strokeLifecycle("stroke-pixel-region-pre", {
      ...this.pixelEvidenceDetails(stroke, surface, region, before, canvas === surface.canvas ? "committed-canvas" : "ink-layer"),
      samplePhase: "before",
      pixelVisibilityVerified: false
    });
  }

  private finishStrokePixelEvidence(surface: PageSurface, stroke: InkStroke, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    if (!this.logger.isEnabled()) return;
    const state = this.strokePixelEvidenceState(stroke.id);
    if (state.paintGeneration !== surface.paintGeneration || !state.region) return;
    const after = this.readPixelEvidence(context, canvas, state.region);
    const before = state.before;
    const positiveDelta = Boolean(before?.available && after.available)
      && (after.alphaSum > (before?.alphaSum ?? 0) || after.nonTransparentPixels > (before?.nonTransparentPixels ?? 0));
    const visibleTarget = canvas === surface.canvas && canvas.isConnected;
    const verified = visibleTarget && after.available && after.nonTransparentPixels > 0 && positiveDelta;
    this.logger.strokeLifecycle("stroke-pixel-region-post", {
      ...this.pixelEvidenceDetails(stroke, surface, state.region, after, visibleTarget ? "committed-canvas" : "ink-layer"),
      samplePhase: "after",
      beforePixelEvidenceAvailable: before?.available ?? false,
      beforeNonTransparentPixels: before?.nonTransparentPixels ?? 0,
      beforeAlphaSum: before?.alphaSum ?? 0,
      pixelPresenceObserved: after.available && after.nonTransparentPixels > 0,
      pixelVisibilityVerified: verified,
      ...(verified ? {} : {
        reason: !before?.available ? "pre-sample-unavailable"
          : !after.available ? "post-sample-unavailable"
            : !visibleTarget ? "render-target-not-connected"
              : after.nonTransparentPixels === 0 ? "no-pixels-present"
                : "no-positive-pixel-delta"
      })
    });
    this.scheduleStrokePixelPresenceVerification(stroke.id, stroke.page);
  }

  private scheduleStrokePixelPresenceVerification(strokeId: string, page: number): void {
    if (!this.logger.isEnabled()) return;
    const existing = this.strokePixelVerificationTimers.get(strokeId);
    if (existing !== undefined) window.clearTimeout(existing);
    const state = this.strokePixelEvidenceStates.get(strokeId);
    if (!state || state.lastDelayedPaintGeneration === state.paintGeneration) return;
    const paintGeneration = state.paintGeneration;
    if (paintGeneration === null) return;
    state.lastDelayedPaintGeneration = paintGeneration;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const timer = view.setTimeout(() => {
      this.strokePixelVerificationTimers.delete(strokeId);
      if (this.destroyed) return;
      const stroke = this.ink.page(page).find((candidate) => candidate.id === strokeId);
      const surface = this.surfaces.get(page);
      if (!stroke || !surface || !surface.canvas.width || !surface.canvas.height) {
        this.logger.strokeLifecycle("stroke-pixel-presence-check", {
          strokeId,
          penContactId: this.strokePenContactIds.get(strokeId) ?? null,
          page,
          modelPresent: Boolean(stroke),
          canvasGeneration: surface?.canvasGeneration ?? -1,
          paintGeneration: surface?.paintGeneration ?? -1,
          pixelEvidenceAvailable: false,
          pixelVisibilityVerified: false,
          reason: !stroke ? "stroke-model-absent" : !surface ? "surface-unavailable" : "canvas-unavailable",
          verification: "delayed"
        });
        return;
      }
      const region = this.pixelEvidenceRegion(surface, stroke, surface.canvas);
      const sample = this.readPixelEvidence(surface.context, surface.canvas, region);
      const verified = Boolean(surface.canvas.isConnected && sample.available && sample.nonTransparentPixels > 0);
      this.logger.strokeLifecycle("stroke-pixel-presence-check", {
        ...this.pixelEvidenceDetails(stroke, surface, region, sample, "committed-canvas"),
        pixelVisibilityVerified: verified,
        verification: "delayed",
        ...(verified ? {} : { reason: !sample.available ? "delayed-sample-unavailable" : !surface.canvas.isConnected ? "canvas-not-connected" : "no-pixels-present" })
      });
    }, 180);
    this.strokePixelVerificationTimers.set(strokeId, timer);
  }

  private strokeRenderState(stroke: InkStroke): StrokeRenderLifecycleState {
    const existing = this.strokeRenderStates.get(stroke.id);
    if (existing) return existing;
    while (this.strokeRenderStates.size >= 256) {
      const oldest = this.strokeRenderStates.keys().next().value;
      if (typeof oldest !== "string") break;
      this.strokeRenderStates.delete(oldest);
    }
    const state: StrokeRenderLifecycleState = {
      strokeId: stroke.id,
      page: stroke.page,
      firstRendered: false,
      lastPaintGeneration: null,
      lastCanvasGeneration: null,
      lastRenderedAt: null,
      lastAcknowledgedPaintGeneration: null,
      lastOmittedPaintGeneration: null,
      lastZoomSettlePaintGeneration: null
    };
    this.strokeRenderStates.set(stroke.id, state);
    return state;
  }

  private strokeRenderDetails(
    stroke: InkStroke,
    surface: Pick<PageSurface, "canvasGeneration" | "paintGeneration">
  ): Record<string, unknown> {
    const state = this.strokeRenderState(stroke);
    return {
      strokeId: stroke.id,
      penContactId: this.strokePenContactIds.get(stroke.id) ?? null,
      page: stroke.page,
      tool: stroke.tool,
      modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id),
      canvasGeneration: surface.canvasGeneration,
      paintGeneration: surface.paintGeneration,
      firstRendered: state.firstRendered,
      lastPaintGeneration: state.lastPaintGeneration,
      lastCanvasGeneration: state.lastCanvasGeneration
    };
  }

  private recordStrokeRendered(surface: PageSurface, stroke: InkStroke): void {
    const state = this.strokeRenderState(stroke);
    const details = this.strokeRenderDetails(stroke, surface);
    const previousCanvasGeneration = state.lastCanvasGeneration;
    const rebuilt = previousCanvasGeneration !== null && previousCanvasGeneration !== surface.canvasGeneration;
    if (!state.firstRendered) {
      this.logger.strokeLifecycle("stroke-first-render", {
        ...details,
        renderExecuted: true,
        expectedVisible: true
      });
      state.firstRendered = true;
    } else if (rebuilt) {
      this.logger.strokeLifecycle("stroke-vector-repaint-included", {
        ...details,
        previousCanvasGeneration,
        renderExecuted: true,
        expectedVisible: true
      });
    }
    state.lastPaintGeneration = surface.paintGeneration;
    state.lastCanvasGeneration = surface.canvasGeneration;
    state.lastRenderedAt = performance.now();
    if (state.lastAcknowledgedPaintGeneration !== surface.paintGeneration) {
      this.logger.strokeLifecycle("stroke-render-ack", {
        ...this.strokeRenderDetails(stroke, surface),
        renderExecuted: true,
        expectedVisible: true,
        verification: "paint"
      });
      state.lastAcknowledgedPaintGeneration = surface.paintGeneration;
    }
  }

  private recordStrokeRenderOmissions(
    surface: PageSurface,
    storedStrokes: readonly InkStroke[],
    visibleStrokes: readonly InkStroke[],
    reason: string,
    expectedVisible = true
  ): void {
    const visibleIds = new Set(visibleStrokes.map((stroke) => stroke.id));
    for (const stroke of storedStrokes) {
      if (visibleIds.has(stroke.id)) continue;
      const state = this.strokeRenderState(stroke);
      if (state.lastOmittedPaintGeneration === surface.paintGeneration) continue;
      state.lastOmittedPaintGeneration = surface.paintGeneration;
      this.logger.strokeLifecycle("stroke-vector-repaint-missing", {
        ...this.strokeRenderDetails(stroke, surface),
        renderExecuted: false,
        expectedVisible,
        includedInLatestPaint: false,
        reason
      });
    }
  }

  private recordStrokeCanvasRebuild(surface: PageSurface, reason: string): void {
    const strokes = this.ink.page(surface.page.pageNumber);
    for (const stroke of strokes) {
      this.logger.strokeLifecycle("stroke-canvas-rebuild-before", {
        ...this.strokeRenderDetails(stroke, surface),
        reason,
        expectedVisible: true
      });
    }
    const previousGeneration = surface.canvasGeneration;
    surface.canvasGeneration += 1;
    for (const stroke of strokes) {
      this.logger.strokeLifecycle("stroke-canvas-rebuild-after", {
        ...this.strokeRenderDetails(stroke, surface),
        previousCanvasGeneration: previousGeneration,
        reason,
        redrawnAfterRebuild: false,
        expectedVisible: true
      });
    }
  }

  private recordStrokeZoomSettleCheck(
    surface: PageSurface,
    strokes: readonly InkStroke[],
    visibleStrokes: readonly InkStroke[],
    reason: string
  ): void {
    if (!reason.includes("settle")) return;
    const visibleIds = new Set(visibleStrokes.map((stroke) => stroke.id));
    for (const stroke of strokes) {
      const state = this.strokeRenderState(stroke);
      if (state.lastZoomSettlePaintGeneration === surface.paintGeneration) continue;
      state.lastZoomSettlePaintGeneration = surface.paintGeneration;
      this.logger.strokeLifecycle("stroke-zoom-settle-check", {
        ...this.strokeRenderDetails(stroke, surface),
        expectedVisible: true,
        includedInLatestPaint: visibleIds.has(stroke.id),
        redrawnAfterRebuild: state.lastCanvasGeneration === surface.canvasGeneration,
        reason
      });
    }
  }

  private scheduleStrokeRenderVerification(strokeId: string, page: number): void {
    const existing = this.strokeRenderVerificationTimers.get(strokeId);
    if (existing !== undefined) window.clearTimeout(existing);
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const timer = view.setTimeout(() => {
      this.strokeRenderVerificationTimers.delete(strokeId);
      if (this.destroyed) return;
      const stroke = this.ink.page(page).find((candidate) => candidate.id === strokeId);
      if (!stroke) return;
      const surface = this.surfaces.get(page);
      const state = this.strokeRenderState(stroke);
      if (!surface || !state.firstRendered) {
        this.logger.strokeLifecycle("stroke-lifecycle-regression", {
          ...this.strokeRenderDetails(stroke, surface ?? {
            canvasGeneration: -1,
            paintGeneration: -1
          }),
          reason: "missing-from-repaint",
          modelPresent: true,
          renderExecuted: false,
          expectedVisible: true,
          verification: "delayed"
        });
        return;
      }
      if (state.lastCanvasGeneration !== surface.canvasGeneration) {
        this.logger.strokeLifecycle("stroke-lifecycle-regression", {
          ...this.strokeRenderDetails(stroke, surface),
          reason: "not-redrawn-after-canvas-rebuild",
          modelPresent: true,
          renderExecuted: false,
          expectedVisible: true,
          verification: "delayed"
        });
        return;
      }
      this.logger.strokeLifecycle("stroke-render-ack", {
        ...this.strokeRenderDetails(stroke, surface),
        renderExecuted: true,
        expectedVisible: true,
        verification: "delayed"
      });
    }, 180);
    this.strokeRenderVerificationTimers.set(strokeId, timer);
  }

  private finishStrokePerformance(surface: PageSurface, outcome: string): void {
    const profile = surface.strokePerformance;
    if (!profile) return;
    const input = profile.inputToRender.summary();
    const frames = profile.frameIntervals.summary();
    const completedAt = performance.now();
    const pointerDownToStrokeStartMs = Math.max(0, profile.startedAt - profile.pointerDownAt);
    const strokeStartToFirstCanvasCommitMs = profile.firstCanvasCommitAt === null
      ? null
      : Math.max(0, profile.firstCanvasCommitAt - profile.startedAt);
    const totalPointerDownToFirstCanvasCommitMs = profile.firstCanvasCommitAt === null
      ? null
      : Math.max(0, profile.firstCanvasCommitAt - profile.pointerDownAt);
    const pointerUpToCommitMs = profile.pointerUpAt === null
      ? null
      : Math.max(0, completedAt - profile.pointerUpAt);
    const strokeDurationMs = Math.max(0.001, completedAt - profile.startedAt);
    const frameRateHz = frames.averageMs > 0 ? 1000 / frames.averageMs : null;
    const inputRateHz = profile.pointerEvents > 0 ? (profile.pointerEvents * 1000) / strokeDurationMs : null;
    const latency: InkLatencyBreakdown = {
      inputMs: input.count ? roundMetric(input.maxMs) : null,
      routingMs: profile.routing.count ? roundMetric(profile.routing.maxMs) : null,
      geometryMs: profile.geometry.count ? roundMetric(profile.geometry.maxMs) : null,
      modelMs: profile.model.count ? roundMetric(profile.model.maxMs) : null,
      schedulingMs: profile.scheduling.count ? roundMetric(profile.scheduling.maxMs) : null,
      canvasCommitMs: profile.canvasCommit.count ? roundMetric(profile.canvasCommit.maxMs) : null,
      paintAcknowledgementMs: profile.paintAcknowledgement.count ? roundMetric(profile.paintAcknowledgement.maxMs) : null
    };
    const committedStrokeId = outcome === "pointercancel" ? null : profile.strokeId;
    const correlationId = profile.physicalContactId
      ?? committedStrokeId
      ?? (profile.pointerId === null ? null : `pointer:${profile.pointerId}`);
    const slowStroke = profile.pointerType === "pen"
      ? this.slowSpans.recordInkStroke({
        pointerId: profile.pointerId,
        physicalContactId: profile.physicalContactId,
        strokeId: committedStrokeId,
        correlationId,
        page: profile.page,
        tool: profile.tool,
        outcome,
        pointerDownToStrokeStartMs,
        strokeStartToFirstCanvasCommitMs,
        totalPointerDownToFirstCanvasCommitMs,
        maxInputToRenderMs: input.maxMs,
        p95InputToRenderMs: input.p95Ms,
        maxPluginCallbackMs: profile.maxPluginCallbackMs,
        longestLongTaskMs: profile.longTaskMaxMs,
        p95FrameMs: frames.p95Ms,
        maxFrameMs: frames.maxMs,
        frameGapThresholdMs: this.frameTimingProfile().lateFrameThresholdMs,
        pointerUpToCommitMs,
        latency
      })
      : null;
    if (slowStroke) this.logger.perfSlowInteraction({ ...slowStroke });
    this.logger.inkStrokeProfile({
      page: profile.page,
      tool: profile.tool,
      pointerType: profile.pointerType,
      pointerId: profile.pointerId,
      physicalContactId: profile.physicalContactId,
      strokeId: committedStrokeId,
      correlationId,
      outcome,
      durationMs: roundMetric(strokeDurationMs),
      frameRateHz: frameRateHz === null ? null : roundMetric(frameRateHz),
      inputRateHz: inputRateHz === null ? null : roundMetric(inputRateHz),
      pointerDownToStrokeStartMs: roundMetric(pointerDownToStrokeStartMs),
      strokeStartToFirstCanvasCommitMs: strokeStartToFirstCanvasCommitMs === null ? null : roundMetric(strokeStartToFirstCanvasCommitMs),
      totalPointerDownToFirstCanvasCommitMs: totalPointerDownToFirstCanvasCommitMs === null ? null : roundMetric(totalPointerDownToFirstCanvasCommitMs),
      pointerUpToCommitMs: pointerUpToCommitMs === null ? null : roundMetric(pointerUpToCommitMs),
      latencyStages: latency,
      pointerEvents: profile.pointerEvents,
      renderUpdates: profile.renderUpdates,
      avgInputToRenderMs: roundMetric(input.averageMs),
      p50InputToRenderMs: roundMetric(input.p50Ms),
      p95InputToRenderMs: roundMetric(input.p95Ms),
      maxInputToRenderMs: roundMetric(input.maxMs),
      avgFrameMs: roundMetric(frames.averageMs),
      p95FrameMs: roundMetric(frames.p95Ms),
      maxFrameMs: roundMetric(frames.maxMs),
      lateFrameCount: frames.lateFrameCount,
      droppedFrameEstimate: frames.droppedFrameEstimate,
      frameIntervalHistogram: frames.histogram,
      frameTiming: this.frameTimingProfile(),
      renderTotalMs: roundMetric(profile.renderTotalMs),
      maxPluginCallbackMs: roundMetric(profile.maxPluginCallbackMs),
      longestLongTaskMs: roundMetric(profile.longTaskMaxMs),
      routerRebinds: profile.routerRebinds,
      canvasResizes: profile.canvasResizes,
      vectorRepaints: profile.vectorRepaints,
      mutationRefreshes: profile.mutationRefreshes,
      hqUpgrades: profile.hqUpgrades,
      strokeCountOnPage: this.ink.page(profile.page).length,
      visiblePageCount: this.surfaces.size
    });
    surface.strokePerformance = null;
    this.stopInteractionLongTaskObserver();
  }

  /** Coalesce visual work to display rate without dropping any input samples. */
  private scheduleLivePaint(
    surface: PageSurface,
    kind: "draw" | "edit",
    sampleCount: number,
    event?: PointerEvent,
    syncText = false
  ): void {
    if (this.destroyed) return;
    const pending = surface.pendingLivePaint;
    const pendingEvent = event ?? pending?.event;
    const nextPaint = {
      kind: pending?.kind === "edit" ? "edit" : kind,
      syncText: Boolean(pending?.syncText || syncText),
      sampleCount: (pending?.sampleCount ?? 0) + sampleCount
    };
    if (kind === "draw" && surface.strokePerformance) {
      const scheduledAt = performance.now();
      surface.strokePerformance.pointerEvents += sampleCount;
      surface.pendingLivePaintAt ??= scheduledAt;
      const inputAt = event ? normalizedPointerEventTime(event, scheduledAt) : scheduledAt;
      surface.pendingLiveInputAt = surface.pendingLiveInputAt === null
        ? inputAt
        : Math.min(surface.pendingLiveInputAt, inputAt);
    }
    surface.pendingLivePaint = pendingEvent ? { ...nextPaint, event: pendingEvent } : nextPaint;
    if (surface.livePaintFrame !== null) return;
    const view = surface.overlay.ownerDocument.defaultView;
    if (!view) {
      this.paintScheduledLiveWork(surface);
      return;
    }
    surface.livePaintFrame = view.requestAnimationFrame((timestamp) => {
      if (surface.livePaintFallbackTimer !== null) {
        view.clearTimeout(surface.livePaintFallbackTimer);
        surface.livePaintFallbackTimer = null;
      }
      surface.livePaintFrame = null;
      this.frameBudget.observeRaf(timestamp, surface.overlay.ownerDocument.hidden);
      this.paintScheduledLiveWork(surface);
    });
    // WKWebView can miss several presentation callbacks while PDF/native work
    // is active even though the event loop becomes available again. Keep the
    // normal rAF coalescing path, but give visible wet ink one bounded fallback
    // so a missed frame cannot strand the pending preview for many frames.
    if (!surface.overlay.ownerDocument.hidden && typeof view.setTimeout === "function") {
      const fallbackDelayMs = Math.max(8, this.frameTimingProfile().frameBudgetMs + 4);
      surface.livePaintFallbackTimer = view.setTimeout(() => {
        surface.livePaintFallbackTimer = null;
        if (surface.livePaintFrame !== null) {
          view.cancelAnimationFrame(surface.livePaintFrame);
          surface.livePaintFrame = null;
        }
        this.paintScheduledLiveWork(surface);
      }, fallbackDelayMs);
    }
  }

  private paintScheduledLiveWork(surface: PageSurface): void {
    const pending = surface.pendingLivePaint;
    const pendingAt = surface.pendingLivePaintAt;
    const pendingInputAt = surface.pendingLiveInputAt;
    surface.pendingLivePaint = null;
    surface.pendingLivePaintAt = null;
    surface.pendingLiveInputAt = null;
    if (!pending || this.destroyed) return;
    const startedAt = performance.now();
    let draftPoints: number | undefined;
    let incremental: boolean | undefined;
    let compositeMatched: boolean | undefined;
    let stabilization: string | undefined;
    let draftResized: boolean | undefined;
    let eraserPreview: ReturnType<ViewerInkSession["renderLiveEraserPreview"]> = null;
    if (pending.kind === "draw") {
      const painted = this.renderLiveDrawPreview(surface);
      draftPoints = painted.draftPoints;
      incremental = painted.incremental;
      compositeMatched = painted.compositeMatched;
      stabilization = painted.stabilization;
      draftResized = painted.draftResized;
    } else if (surface.editTool === "eraser") eraserPreview = this.renderLiveEraserPreview(surface);
    else if (this.moveDrag?.page === surface.page.pageNumber) {
      // Moving an existing selection needs the translated ink preview; unlike
      // a fresh lasso outline it cannot be represented by chrome alone.
      this.renderPage(surface.page.pageNumber, undefined, "live-edit", pending.syncText);
    } else {
      // Lasso chrome has its own canvas. Updating it avoids blitting/repainting
      // every committed stroke for each high-rate pointermove.
      this.renderLiveLassoPreview(surface);
    }
    const completedAt = performance.now();
    if (pending.kind === "draw") {
      const profile = surface.strokePerformance;
      if (profile && pendingInputAt !== null) profile.inputToRender.add(Math.max(0, completedAt - pendingInputAt));
      this.noteStrokeCanvasCommit(surface, completedAt, startedAt);
      if (profile) {
        if (pendingAt !== null) profile.scheduling.add(Math.max(0, startedAt - pendingAt));
        this.schedulePaintAcknowledgement(surface, completedAt, profile);
      }
      const interaction = this.slowSpans.finishFirstPen(completedAt);
      if (interaction) this.logger.perfSlowInteraction({ ...interaction });
    }
    if (pending.kind === "draw" && surface.strokePerformance) {
      const profile = surface.strokePerformance;
      const duration = Math.max(0, completedAt - startedAt);
      profile.renderUpdates += 1;
      profile.renderTotalMs += duration;
      profile.maxPluginCallbackMs = Math.max(profile.maxPluginCallbackMs, duration);
      if (profile.lastRenderAt !== null) profile.frameIntervals.add(Math.max(0, completedAt - profile.lastRenderAt));
      profile.lastRenderAt = completedAt;
    }
    this.logger.inputPaint(surface.page.pageNumber, completedAt - startedAt, pending.kind, pending.sampleCount, {
      ...(draftPoints !== undefined ? { draftPoints } : {}),
      ...(incremental !== undefined ? { incremental } : {}),
      ...(compositeMatched !== undefined ? { compositeMatched } : {}),
      ...(stabilization !== undefined ? { stabilization } : {}),
      ...(draftResized !== undefined ? { draftResized } : {}),
      ...(pending.event ? {
        pointerId: pending.event.pointerId,
        ...(pending.kind === "edit" ? { editTool: surface.editTool ?? null } : {})
      } : {}),
      ...(eraserPreview ? {
        eraserPathPoints: eraserPreview.pathPoints,
        eraserPendingPoints: eraserPreview.pendingPoints,
        eraserDirectCanvas: eraserPreview.directCanvas,
        eraserDamageArea: roundMetric(eraserPreview.damageArea),
        eraserBackingScale: roundMetric(eraserPreview.backingScale)
      } : {})
    });
    const paintSpan = this.slowSpans.record({
      kind: "sync",
      category: "ink",
      stage: pending.kind === "draw" ? "live-draw-paint" : "live-edit-paint",
      durationMs: completedAt - startedAt,
      activeWorkMs: completedAt - startedAt,
      waitMs: 0,
      reason: this.zoomCompositing ? "zoom-compositing" : null,
      correlationId: pending.kind === "draw" && surface.strokePerformance
        ? surface.strokePerformance.physicalContactId
          ?? surface.strokePerformance.strokeId
          ?? (surface.strokePerformance.pointerId === null ? null : `pointer:${surface.strokePerformance.pointerId}`)
        : pending.event ? `pointer:${pending.event.pointerId}` : null,
      zoomBurstId: this.zoomCorrelationId
    });
    if (paintSpan) this.logger.perfSlowSpan({ ...paintSpan });
    if (pending.event && this.logger.isEnabled()) this.updateDebug(surface, pending.event);
  }

  /**
   * A rAF after the canvas write is the local paint acknowledgement. It is an
   * approximation of compositor visibility, intentionally sampled once per
   * active surface rather than once per pointer sample.
   */
  private schedulePaintAcknowledgement(
    surface: PageSurface,
    committedAt: number,
    profile: StrokePerformanceState
  ): void {
    if (!this.logger.isEnabled() || surface.paintAcknowledgementFrame !== null) return;
    const view = surface.overlay.ownerDocument.defaultView;
    if (!view) return;
    const strokeId = profile.strokeId;
    const correlationId = profile.physicalContactId
      ?? strokeId
      ?? (profile.pointerId === null ? null : `pointer:${profile.pointerId}`);
    const acknowledge = (): void => {
      surface.paintAcknowledgementFrame = null;
      surface.paintAcknowledgementCancel = null;
      if (this.destroyed) return;
      const acknowledgedAt = performance.now();
      const durationMs = Math.max(0, acknowledgedAt - committedAt);
      profile.paintAcknowledgement.add(durationMs);
      const span = this.slowSpans.record({
        kind: "async",
        category: "ink-latency",
        stage: "paint-acknowledgement",
        durationMs,
        activeWorkMs: 0,
        waitMs: durationMs,
        correlationId,
        zoomBurstId: this.zoomCorrelationId
      });
      if (span) this.logger.perfSlowSpan({ ...span, strokeId });
    };
    if (typeof view.requestAnimationFrame === "function") {
      const frame = view.requestAnimationFrame(acknowledge);
      surface.paintAcknowledgementFrame = frame;
      surface.paintAcknowledgementCancel = () => view.cancelAnimationFrame(frame);
    } else {
      const timer = view.setTimeout(acknowledge, 0);
      surface.paintAcknowledgementFrame = timer;
      surface.paintAcknowledgementCancel = () => view.clearTimeout(timer);
    }
  }

  private cancelPaintAcknowledgement(surface: PageSurface): void {
    surface.paintAcknowledgementCancel?.();
    surface.paintAcknowledgementCancel = null;
    surface.paintAcknowledgementFrame = null;
  }

  /** A terminal input event owns the final synchronous paint, never a stale frame callback. */
  private cancelLivePaint(surface: PageSurface): void {
    const view = surface.overlay.ownerDocument.defaultView;
    if (surface.livePaintFrame !== null) {
      view?.cancelAnimationFrame(surface.livePaintFrame);
      surface.livePaintFrame = null;
    }
    if (surface.livePaintFallbackTimer !== null) {
      view?.clearTimeout(surface.livePaintFallbackTimer);
      surface.livePaintFallbackTimer = null;
    }
    surface.pendingLivePaint = null;
    surface.pendingLivePaintAt = null;
    surface.pendingLiveInputAt = null;
  }

  private clearLiveDrawPreview(
    surface: PageSurface,
    regions?: readonly Bounds[],
    backingScale?: number
  ): void {
    const { draftCanvas, draftContext, predictionCanvas, predictionContext } = surface;
    const hadDrawPreview = surface.liveDrawPreviewStrokeId !== null;
    const hadPrediction = surface.predictedPreviewPainted;
    this.endWetPreview(surface);
    surface.liveDrawPaintedPoints = 0;
    surface.liveDrawPageBounds = null;
    surface.liveDrawPreviewStrokeId = null;
    surface.predictedPreview = [];
    surface.predictedPreviewPainted = false;
    const canClearDraftRegions = Boolean(regions?.length && backingScale && hadDrawPreview && !hadPrediction);
    if (draftCanvas.width && draftCanvas.height && canClearDraftRegions) {
      draftContext.setTransform(1, 0, 0, 1, 0, 0);
      for (const region of regions!) {
        const left = Math.max(0, Math.floor(region.minX * backingScale!) - 2);
        const top = Math.max(0, Math.floor(region.minY * backingScale!) - 2);
        const right = Math.min(draftCanvas.width, Math.ceil(region.maxX * backingScale!) + 2);
        const bottom = Math.min(draftCanvas.height, Math.ceil(region.maxY * backingScale!) + 2);
        if (right > left && bottom > top) draftContext.clearRect(left, top, right - left, bottom - top);
      }
    } else if (draftCanvas.width && draftCanvas.height && (hadDrawPreview || !regions)) {
      draftContext.setTransform(1, 0, 0, 1, 0, 0);
      draftContext.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
    }
    if (predictionCanvas.width && predictionCanvas.height && (hadPrediction || !regions)) {
      predictionContext.setTransform(1, 0, 0, 1, 0, 0);
      predictionContext.clearRect(0, 0, predictionCanvas.width, predictionCanvas.height);
    }
  }

  /** Drop detached page bitmaps and their scheduled work promptly. */
  private releaseSurfaceBuffers(surface: PageSurface): void {
    this.cancelLivePaint(surface);
    this.cancelPaintAcknowledgement(surface);
    if (surface.deferredCanonicalPaintFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(surface.deferredCanonicalPaintFrame);
      surface.deferredCanonicalPaintFrame = null;
    }
    surface.deferredCanonicalPaint = null;
    this.endWetPreview(surface);
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    surface.draftCanvas.width = 0;
    surface.draftCanvas.height = 0;
    surface.predictionCanvas.width = 0;
    surface.predictionCanvas.height = 0;
    surface.selectionCanvas.width = 0;
    surface.selectionCanvas.height = 0;
    surface.liveDrawPageBounds = null;
    surface.liveDrawPreviewStrokeId = null;
    if (surface.inkLayer) {
      surface.inkLayer.width = 0;
      surface.inkLayer.height = 0;
    }
    surface.inkLayer = null;
    surface.inkLayerContext = null;
    surface.inkLayerValid = false;
    surface.inkLayerRevision = null;
    surface.rasterFallbackReady = false;
    surface.liveEraserPaintedPoints = 0;
    surface.predictedPreview = [];
    surface.predictedPreviewPainted = false;
    surface.wetDamage.clear();
    surface.wetPreviewUsesCommittedCanvas = false;
  }

  /** Restore the committed layer after a wet preview is committed or cancelled. */
  private endWetPreview(surface: PageSurface): void {
    if (!surface.wetPreviewActive) {
      surface.wetDamage.clear();
      surface.wetPreviewUsesCommittedCanvas = false;
      surface.canvas.classList.remove("is-wet-hidden");
      return;
    }
    if (surface.wetPreviewUsesCommittedCanvas) {
      const damage = surface.wetDamage.drain();
      const layout = this.pageLayout(surface);
      const width = Math.max(1, layout.contentWidth || 1);
      const height = Math.max(1, layout.contentHeight || 1);
      const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
      if (
        damage.length > 0
        && surface.inkLayerValid
        && surface.inkLayer
        && surface.inkLayer.width === pixelWidth
        && surface.inkLayer.height === pixelHeight
      ) {
        this.blitInkLayerRegionsToCanvas(surface, damage, pixelWidth, pixelHeight, backingScale);
      }
    } else {
      this.wetRenderer.end(surface.draftCanvas);
      surface.wetDamage.clear();
    }
    surface.wetPreviewActive = false;
    surface.wetPreviewUsesCommittedCanvas = false;
    surface.canvas.classList.remove("is-wet-hidden");
  }

  /**
   * Paint the active stroke into a disposable layer. This keeps the committed
   * canvas cache, text boxes, and full-stroke renderer out of the pointer path.
   *
   * Freehand: stamp only new segments (like live eraser). Full clear+redraw is
   * O(path)×huge draft backing and slows long strokes (~10ms→45ms in logs).
   * Shape preview still morphs as a whole, so it keeps the full redraw path.
   */
  private renderLiveDrawPreview(surface: PageSurface): {
    draftPoints: number;
    incremental: boolean;
    compositeMatched: boolean;
    stabilization: string;
    draftResized: boolean;
  } {
    const builder = surface.builder;
    if (!builder || surface.laserDraft) {
      return {
        draftPoints: 0,
        incremental: false,
        compositeMatched: false,
        stabilization: "off",
        draftResized: false
      };
    }
    const stabilization = builder.stabilization;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    let { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);

    // While zoom CSS compositing holds the committed canvas at pre-burst pixels
    // (renderPage gated), paint the draft into that same backing so tip ink and
    // soft committed ink share one CSS stretch. New-res draft under stretched old
    // canvas was the residual mid-drag dual-scale glitch after settle-defer.
    const compositeMatched = this.zoomCompositing
      && surface.canvas.width > 0
      && surface.canvas.height > 0;
    if (compositeMatched) {
      pixelWidth = surface.canvas.width;
      pixelHeight = surface.canvas.height;
      backingScale = pixelWidth / width;
    } else if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
      // A viewport change is uncommon while drawing. Let the canonical renderer
      // rebuild committed ink once, then keep the active stroke isolated in its
      // draft layer rather than painting it twice.
      this.renderPage(surface.page.pageNumber, undefined, "live-draw-rebase", false, false);
    }
    let draftResized = false;
    if (surface.draftCanvas.width !== pixelWidth || surface.draftCanvas.height !== pixelHeight) {
      surface.draftCanvas.width = pixelWidth;
      surface.draftCanvas.height = pixelHeight;
      surface.liveDrawPaintedPoints = 0;
      draftResized = true;
    }
    if (surface.predictionCanvas.width !== pixelWidth || surface.predictionCanvas.height !== pixelHeight) {
      surface.predictionCanvas.width = pixelWidth;
      surface.predictionCanvas.height = pixelHeight;
    }

    const points = surface.shapePreview ?? builder.preview(this.simplifyStrokesEnabled());
    if (!points.length) {
      surface.liveDrawPaintedPoints = 0;
      surface.liveDrawPreviewStrokeId = null;
      surface.predictedPreviewPainted = false;
      surface.predictionContext.setTransform(1, 0, 0, 1, 0, 0);
      surface.predictionContext.clearRect(0, 0, pixelWidth, pixelHeight);
      return { draftPoints: 0, incremental: false, compositeMatched, stabilization, draftResized };
    }
    const style = builder.style;
    // Live and committed pencil paint use the same final-quality renderer. The
    // draft canvas is incremental, so texture work is distributed over the
    // gesture instead of being paid as one full-path spike on pointer-up.
    const context = surface.draftContext;
    const predictionContext = surface.predictionContext;
    const shapeMorph = surface.shapePreview !== null;
    const predicted = surface.predictedPreview;
    const hasPredicted = predicted.length > 0 && !shapeMorph;

    const updatePredictionLayer = (): void => {
      if (!hasPredicted && !surface.predictedPreviewPainted) return;
      predictionContext.setTransform(1, 0, 0, 1, 0, 0);
      predictionContext.clearRect(0, 0, pixelWidth, pixelHeight);
      if (!hasPredicted) {
        surface.predictedPreviewPainted = false;
        return;
      }
      const anchor = points.at(-1);
      const predictedPoints = anchor ? [anchor, ...predicted] : predicted;
      predictionContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.drawPoints(
        surface,
        predictedPoints,
        style.color,
        style.width,
        Math.max(0, style.opacity * 0.42),
        style.tool,
        false,
        builder.id,
        predictionContext
      );
      surface.predictedPreviewPainted = true;
    };
    updatePredictionLayer();
    // Shape preview replaces geometry each frame — never incremental.
    // After a shape frame, force the next freehand paint through the full path.
    if (shapeMorph) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.drawPoints(
        surface,
        points,
        style.color,
        style.width,
        style.opacity,
        style.tool,
        false,
        builder.id,
        context
      );
      surface.liveDrawPaintedPoints = 0;
      surface.liveDrawPreviewStrokeId = builder.id;
      return { draftPoints: points.length, incremental: false, compositeMatched, stabilization, draftResized };
    }

    // Causal preview (StrokeBuilder.smoothedPoints) keeps prior indices fixed —
    // incremental stamps are safe for opaque pen/pencil strokes. Brush ribbons
    // are not incremental: velocity shaping and endpoint taper depend on the
    // complete path, so fragmenting them would make release repaint the stroke.
    // Highlighter alpha is not idempotent either: overlapping the prior capsule
    // darkens the live preview, then the single final pass becomes visibly
    // lighter on release. Redraw these disposable previews as whole paths so
    // preview and commit match.
    const brushWholePreview = style.tool === "pen" && style.penType === "brush";
    const canIncremental = style.tool !== "highlighter"
      && !brushWholePreview
      && !draftResized
      && surface.liveDrawPaintedPoints > 0
      && surface.liveDrawPaintedPoints <= points.length;

    if (canIncremental) {
      if (surface.liveDrawPaintedPoints === points.length) {
        surface.liveDrawPreviewStrokeId = builder.id;
        return { draftPoints: points.length, incremental: true, compositeMatched, stabilization, draftResized };
      }
      // Overlap one prior point so stamp capsules join without a gap.
      const pending = points.slice(Math.max(0, surface.liveDrawPaintedPoints - 1));
      context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.drawPoints(
        surface,
        pending,
        style.color,
        style.width,
        style.opacity,
        style.tool,
        false,
        builder.id,
        context
      );
      surface.liveDrawPaintedPoints = points.length;
      surface.liveDrawPreviewStrokeId = builder.id;
      return { draftPoints: points.length, incremental: true, compositeMatched, stabilization, draftResized };
    }

    // Setting canvas width/height already clears pixels — skip redundant clearRect
    // on the first frame after a huge backing alloc (stroke-start hitch).
    if (!draftResized) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
    }
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    this.drawPoints(
      surface,
      points,
      style.color,
      style.width,
      style.opacity,
      style.tool,
      false,
      builder.id,
      context
    );
    surface.liveDrawPaintedPoints = points.length;
    surface.liveDrawPreviewStrokeId = builder.id;
    return { draftPoints: points.length, incremental: false, compositeMatched, stabilization, draftResized };
  }

  /**
   * Erasing the disposable wet bitmap is O(new input samples), while exact
   * stroke fragmentation is O(stroke segments × full eraser path). The exact
   * model update still happens once at pointer-up; cancel/repaint restores the
   * untouched committed canvas immediately.
   */
  private renderLiveEraserPreview(surface: PageSurface): {
    pathPoints: number;
    pendingPoints: number;
    directCanvas: boolean;
    damageArea: number;
    backingScale: number;
  } | null {
    const eraserSize = surface.eraserSize;
    if (eraserSize === undefined || surface.editPath.length === 0) return null;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    let { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    if (this.zoomCompositing && surface.canvas.width > 0 && surface.canvas.height > 0) {
      pixelWidth = surface.canvas.width;
      pixelHeight = surface.canvas.height;
      backingScale = pixelWidth / width;
    } else if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
      this.endWetPreview(surface);
      this.renderPage(surface.page.pageNumber, undefined, "live-eraser-rebase", false, false);
      surface.liveEraserPaintedPoints = 0;
    }

    if (!surface.wetPreviewActive) {
      const canEraseCommittedCanvas = Boolean(
        surface.inkLayerValid
        && surface.inkLayer
        && !surface.inkLayerBurstCapture
        && surface.inkLayer.width === pixelWidth
        && surface.inkLayer.height === pixelHeight
        && surface.canvas.width === pixelWidth
        && surface.canvas.height === pixelHeight
      );
      if (canEraseCommittedCanvas) {
        surface.wetPreviewActive = true;
        surface.wetPreviewUsesCommittedCanvas = true;
      } else {
        if (!this.wetRenderer.begin(surface.canvas, surface.draftCanvas)) return null;
        surface.wetPreviewActive = true;
        surface.wetPreviewUsesCommittedCanvas = false;
        surface.canvas.classList.add("is-wet-hidden");
      }
    }

    if (surface.liveEraserPaintedPoints >= surface.editPath.length) {
      return {
        pathPoints: surface.editPath.length,
        pendingPoints: 0,
        directCanvas: surface.wetPreviewUsesCommittedCanvas,
        damageArea: surface.wetDamage.totalArea(),
        backingScale
      };
    }
    // Continue from the prior endpoint so each new packet erases the capsule
    // between frames instead of leaving a visible gap at the frame boundary.
    const pending = surface.editPath.slice(Math.max(0, surface.liveEraserPaintedPoints - 1));
    const mapper = this.mapper(surface);
    const points = pending.map((point) => mapper.toViewport(point));
    const lineWidth = Math.max(1, eraserSize * this.displayScale(surface));
    const target = surface.wetPreviewUsesCommittedCanvas ? surface.canvas : surface.draftCanvas;
    this.wetRenderer.erase(target, points, lineWidth, backingScale, surface.wetDamage);
    surface.liveEraserPaintedPoints = surface.editPath.length;
    return {
      pathPoints: surface.editPath.length,
      pendingPoints: pending.length,
      directCanvas: surface.wetPreviewUsesCommittedCanvas,
      damageArea: surface.wetDamage.totalArea(),
      backingScale
    };
  }

  private extendLiveDrawPageBounds(surface: PageSurface, points: readonly PagePoint[]): void {
    if (points.length === 0) return;
    const existing = surface.liveDrawPageBounds;
    let minX = existing?.minX ?? Infinity;
    let minY = existing?.minY ?? Infinity;
    let maxX = existing?.maxX ?? -Infinity;
    let maxY = existing?.maxY ?? -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    surface.liveDrawPageBounds = { minX, minY, maxX, maxY };
  }

  private pointerStart(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    const preferences = this.options.settings.toolPreferences;
    const activeTool = this.activeTool();
    // Keep the existing one-click close behavior for a live editor before
    // considering persisted annotation selection.
    if (route === "text" && this.activeTextEditor) {
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    // Content clicks always edit text. Moving a selected text box is reserved
    // for its NPDE-style frame edge, so a click on the selected words cannot
    // be mistaken for a zero-distance selection drag. On touch, the native host
    // can retarget a follow-up tap to the page after a long-press rerender;
    // resolve that case by the same committed-text geometry hit test.
    if (
      route === "text"
      && (
        (event.target instanceof Element && event.target.closest(".native-pdf-handwriting-text-box"))
        || (event.pointerType === "touch" && this.isTouchTextTarget(surface, event))
      )
    ) {
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    // Selected annotations take priority over the current tool. Otherwise, the
    // text tool turns a drag in an existing selection into a new-text intent.
    if (this.tryStartSelectionMove(surface, samples[0]!)) {
      this.scheduleLivePaint(surface, "edit", samples.length, event, true);
      return;
    }
    if (route === "text") {
      if (this.selected.length || this.selectedTexts.length) {
        const point = this.toPagePoint(surface, samples[0]!, true);
        this.logger.textTool("selection-clear-click-away", {
          page: surface.page.pageNumber,
          selectedPage: this.selectionPage,
          textCount: this.selectedTexts.length,
          strokeCount: this.selected.length,
          x: round(point.x),
          y: round(point.y)
        });
        this.clearSelection();
        return;
      }
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    if (route === "draw") {
      surface.predictedPreview = [];
      surface.predictedPreviewPainted = false;
      this.startStrokePerformance(surface, event, samples.length);
      const laser = activeTool === "laser";
      if (laser) {
        surface.pressureConditioner = undefined;
        surface.pressureLastPagePoint = undefined;
        surface.simulateMousePressure = false;
        const laserPrefs = preferences.laser;
        surface.laserDraft = true;
        surface.laserDiscardedPoints = 0;
        surface.liveDrawPageBounds = null;
        surface.builder = new StrokeBuilder({
          id: this.id(),
          page: surface.page.pageNumber,
          tool: "pen",
          color: laserPrefs.color,
          width: laserPrefs.width,
          opacity: laserPrefs.opacity,
          inputType: inkInputType(samples[0]?.pointerType ?? event.pointerType),
          stabilization: "medium"
        });
        for (const point of this.toPagePoints(surface, samples, false)) surface.builder.add(point);
        this.trimLaserDraft(surface, performance.now());
        const first = surface.builder.preview(true)[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", "laser", [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
        this.ensureLaserFadeLoop();
      } else {
        surface.laserDraft = false;
        surface.liveDrawPageBounds = null;
        const tool = resolveDrawingTool(activeTool);
        const drawing = preferences[tool];
        // Capture the profile once per stroke. Settings changed midway through
        // a line must not change its width or stored pressure values.
        surface.pressureConditioner = new PressureConditioner(
          this.pressureProfile(),
          {
            ...pressureConditionerOptionsForCalibration(this.pressureCalibration()),
            strokeSize: drawing.width
          }
        );
        surface.pressureLastPagePoint = undefined;
        surface.simulateMousePressure = drawing.simulateMousePressure;
        surface.builder = new StrokeBuilder({
          id: this.id(),
          page: surface.page.pageNumber,
          tool,
          color: drawing.color,
          width: drawing.width,
          opacity: drawing.opacity,
          inputType: inkInputType(samples[0]?.pointerType ?? event.pointerType),
          ...(tool === "pen" ? { penType: drawing.penType ?? "fountain" as const } : {}),
          stabilization: drawing.stabilization
        });
        const startPoints = this.toPagePoints(surface, samples, surface.simulateMousePressure, surface.pressureConditioner);
        for (const point of startPoints) surface.builder.add(point);
        this.extendLiveDrawPageBounds(surface, startPoints);
        const first = surface.builder.preview(this.simplifyStrokesEnabled())[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", tool, [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
        if (isDrawingTool(activeTool)) this.scheduleHeldShape(surface);
        if (event.pointerType === "pen") this.slowSpans.noteStrokeStart(performance.now());
      }
      if (surface.strokePerformance && surface.builder && !surface.laserDraft) {
        surface.strokePerformance.strokeId = surface.builder.id;
      }
      if (event.pointerType === "pen" && surface.builder) this.beginInkStrokeGeometry(event, samples);
    } else {
      if (activeTool === "lasso" && (this.selected.length > 0 || this.selectedTexts.length > 0)) {
        const point = this.toPagePoint(surface, samples[0]!, true);
        if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !shapeContainsPoint(this.selectionShape, point)) {
          const clearedPage = this.selectionPage;
          // Caller always renderPage(surface) below — only paint a different page here.
          this.clearSelection({ refresh: false });
          if (clearedPage != null && clearedPage !== surface.page.pageNumber) {
            this.paintAfterClearSelection(clearedPage);
          }
        }
      }
      surface.editTool = activeTool === "eraser" ? "eraser" : "lasso";
      surface.eraserSize = surface.editTool === "eraser" ? preferences.eraser.size : undefined;
      surface.eraserWholeStrokes = surface.editTool === "eraser" ? preferences.eraser.eraseWholeStrokes : undefined;
      surface.editPath = this.toPagePoints(surface, samples, true);
      surface.liveEraserPaintedPoints = 0;
      if (surface.editPath[0]) this.lastPointerPdf = { x: surface.editPath[0].x, y: surface.editPath[0].y };
    }
    if (route === "draw" && !surface.laserDraft) this.scheduleLivePaint(surface, "draw", samples.length, event);
    else if (route === "edit") this.scheduleLivePaint(surface, "edit", samples.length, event);
  }

  private pointerMove(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPagePoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      this.movePreview = translateStrokes(this.moveDrag.before, dx, dy);
      this.moveTextPreview = this.translateTextAnnotations(this.moveDrag.beforeTexts, dx, dy);
      this.moveShapePreview = translateShape(this.moveDrag.beforeShape, dx, dy);
      this.scheduleLivePaint(surface, "edit", samples.length, event, true);
      return;
    }
    if (route === "text") {
      this.updateTextIntent(surface, samples.at(-1)!, event);
      return;
    }
    if (route === "draw" && surface.builder) {
      if (surface.laserDraft && surface.strokePerformance) surface.strokePerformance.pointerEvents += samples.length;
      const simulate = surface.laserDraft ? false : surface.simulateMousePressure;
      const points = this.toPagePoints(surface, samples, simulate, surface.laserDraft ? undefined : surface.pressureConditioner);
      for (const point of points) surface.builder.add(point);
      if (!surface.laserDraft) this.extendLiveDrawPageBounds(surface, points);
      const lastPoint = points.at(-1);
      if (lastPoint) this.resizeLockedShape(surface, lastPoint);
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "move");
      if (event.pointerType === "pen") this.noteInkStrokeMove(event, samples);
      if (surface.laserDraft) {
        this.trimLaserDraft(surface, performance.now());
        this.ensureLaserFadeLoop();
      }
      if (isDrawingTool(this.activeTool()) && !surface.shapeResize) this.scheduleHeldShape(surface);
    } else if (route === "edit") {
      surface.editPath.push(...this.toPagePoints(surface, samples, true));
    }
    // The laser fade loop owns live laser painting. Rendering each pointer event
    // duplicates full-canvas work and falls behind high-rate stylus input.
    if (!surface.laserDraft) this.scheduleLivePaint(surface, route === "draw" ? "draw" : "edit", samples.length, event);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    if (route === "draw" && surface.strokePerformance) surface.strokePerformance.pointerUpAt = performance.now();
    this.cancelLivePaint(surface);
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPagePoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      const drag = this.moveDrag;
      if (dx !== 0 || dy !== 0) {
        const afterStrokes = translateStrokes(drag.before, dx, dy);
        const afterTexts = this.translateTextAnnotations(drag.beforeTexts, dx, dy);
        this.executeHistory(new ReplaceAnnotationSelectionCommand(
          this.ink,
          drag.before,
          afterStrokes,
          this.texts,
          drag.beforeTexts,
          afterTexts
        ), surface.page.pageNumber);
        this.selected = afterStrokes;
        this.selectedTexts = afterTexts;
        this.selectionShape = translateShape(drag.beforeShape, dx, dy);
        this.logText(surface, "selection-move-commit", {
          strokeCount: afterStrokes.length,
          textCount: afterTexts.length,
          dx: round(dx),
          dy: round(dy)
        });
      }
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      this.updateDebug(surface, event);
      if (this.needsPagePaint(surface.page.pageNumber)) this.renderPage(surface.page.pageNumber);
      this.scheduleZoomSettleResume();
      return;
    }
    if (route === "text") {
      this.finishTextIntent(surface, samples.at(-1)!, event);
      this.scheduleZoomSettleResume();
      return;
    }
    const ephemeralLaser = route === "draw" && surface.laserDraft;
    if (route === "draw" && surface.builder) {
      if (event.pointerType === "pen") this.finishInkStrokeGeometry(event, samples, "pointerup");
      this.commitActiveDraw(surface, samples, "pointerup");
    } else if (route === "edit") {
      surface.editPath.push(...this.toPagePoints(surface, samples, true));
      const tool = this.options.settings.toolPreferences.activeTool;
      const phase = tool === "eraser" ? "eraser" : "lasso";
      const path = [...surface.editPath];
      this.finishEdit(surface);
      this.logDraw(surface, phase, tool, path);
      surface.editPath = [];
      surface.liveEraserPaintedPoints = 0;
    }
    this.updateDebug(surface, event);
    if (ephemeralLaser) this.repaintLaserOverlay(surface.page.pageNumber);
    else if (this.needsPagePaint(surface.page.pageNumber)) this.renderPage(surface.page.pageNumber);
    this.scheduleZoomSettleResume();
  }

  /** Commit a completed draw gesture, including one interrupted by page virtualization. */
  private commitActiveDraw(
    surface: PageSurface,
    samples: PointerSample[],
    termination: "pointerup" | "surface-unmount",
    terminalDetail?: string
  ): void {
    const builder = surface.builder;
    if (!builder) {
      this.finishStrokePerformance(surface, termination);
      return;
    }
    surface.predictedPreview = [];
    // Leave the painted flag set until renderLiveDrawPreview clears the separate
    // prediction layer; resetting it here would strand stale predicted pixels.
    this.cancelHeldShape(surface);
    const laserDraft = surface.laserDraft;
    const simulate = laserDraft ? false : surface.simulateMousePressure;
    const points = this.toPagePoints(surface, samples, simulate, laserDraft ? undefined : surface.pressureConditioner);
    for (const point of points) builder.add(point);
    if (!laserDraft) this.extendLiveDrawPageBounds(surface, points);
    const lastPoint = points.at(-1);
    if (lastPoint) this.resizeLockedShape(surface, lastPoint);
    if (laserDraft) this.trimLaserDraft(surface, performance.now());
    // Finish any samples that arrived after the last rAF before transferring
    // the final-quality draft. This is incremental when the draft is warm, not
    // a second full-path reconstruction.
    if (!laserDraft) this.renderLiveDrawPreview(surface);
    // Match live preview geometry — finish()+simplify reshapes the path → visible snap.
    const stroke = builder.finishMatchingPreview(laserDraft ? true : this.simplifyStrokesEnabled());
    if (surface.shapePreview?.length) stroke.points = surface.shapePreview;
    const shapeResize = surface.shapeResize;
    const terminal: Pick<DrawPositionLog, "termination" | "terminalDetail"> = {
      termination,
      ...(terminalDetail === undefined ? {} : { terminalDetail })
    };
    surface.builder = undefined;
    surface.pressureConditioner = undefined;
    surface.pressureLastPagePoint = undefined;
    surface.simulateMousePressure = false;
    surface.laserDraft = false;
    surface.shapePreview = null;
    surface.shapeResize = null;
    if (shapeResize) {
      this.logger.shapeTool("commit", {
        page: surface.page.pageNumber,
        shape: shapeResize.recognition.kind,
        pointCount: stroke.points.length
      });
    }
    if (laserDraft) {
      const laser = this.options.settings.toolPreferences.laser;
      this.laserTrails.push({
        id: stroke.id,
        page: stroke.page,
        points: stroke.points,
        color: laser.color,
        width: laser.width,
        opacity: laser.opacity,
        holdMs: laser.holdMs,
        fadeMs: laser.fadeMs
      });
      this.logger.laserDraft(
        surface.page.pageNumber,
        stroke.points.length,
        surface.laserDiscardedPoints,
        laser.holdMs + laser.fadeMs
      );
      this.lastPointerPdf = stroke.points.at(-1)
        ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y }
        : this.lastPointerPdf;
      this.logDraw(surface, "end", "laser", stroke.points, terminal);
      this.ensureLaserFadeLoop();
    } else {
      const tool = resolveDrawingTool(this.activeTool());
      const penContactId = this.strokePenContactIds.get(stroke.id) ?? null;
      this.logger.strokeLifecycle("stroke-pointerup", {
        strokeId: stroke.id,
        penContactId,
        page: stroke.page,
        tool,
        termination,
        terminalDetail: terminalDetail ?? null
      });
      this.logger.inkRenderer(surface.page.pageNumber, {
        tool,
        pointCount: stroke.points.length,
        width: stroke.width,
        opacity: stroke.opacity,
        previewRenderer: "tool-renderer",
        committedRenderer: "tool-renderer"
      });
      if (surface.strokePerformance?.strokeId === stroke.id) {
        surface.strokePerformance.modelStartedAt = performance.now();
      }
      this.executeHistory(new AddStrokeCommand(this.ink, stroke), stroke.page);
      this.logger.strokeLifecycle("stroke-commit", {
        strokeId: stroke.id,
        penContactId,
        page: stroke.page,
        tool,
        termination,
        modelPresent: this.ink.page(stroke.page).some((candidate) => candidate.id === stroke.id)
      });
      this.scheduleStrokeRenderVerification(stroke.id, stroke.page);
      this.lastPointerPdf = stroke.points.at(-1)
        ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y }
        : this.lastPointerPdf;
      this.logDraw(surface, "end", tool, stroke.points, terminal);
    }
    const last = samples.at(-1);
    if (last) this.logPositionAlign(surface, last, "end");
    this.finishStrokePerformance(surface, termination);
  }

  /** Save an in-progress real-ink draft before mobile/PDF.js replaces its page. */
  private commitActiveDrawBeforeSurfaceLoss(surface: PageSurface, reason: string): void {
    // Laser trails are intentionally ephemeral; only saved ink must survive a remount.
    if (!surface.builder || surface.laserDraft) {
      this.finishStrokePerformance(surface, "surface-unmount");
      return;
    }
    surface.pendingRouterHandoff = null;
    this.cancelLivePaint(surface);
    this.commitActiveDraw(surface, [], "surface-unmount", reason);
  }

  private pointerCancel(surface: PageSurface, route: "draw" | "edit" | "text", event: PointerEvent): void {
    this.cancelLivePaint(surface);
    if (route === "text") {
      this.logText(surface, "pointer-cancel", {
        annotationId: this.textMoveDrag?.before.id ?? surface.textIntent?.hit?.id ?? null,
        hadIntent: Boolean(surface.textIntent),
        hadMove: Boolean(this.textMoveDrag)
      });
    }
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    if (route === "draw" && event.pointerType === "pen") this.finishInkStrokeGeometry(event, [], "pointercancel");
    if (route === "draw") this.finishStrokePerformance(surface, "pointercancel");
    surface.builder = undefined;
    surface.liveDrawPageBounds = null;
    surface.predictedPreview = [];
    surface.predictedPreviewPainted = false;
    surface.pressureConditioner = undefined;
    surface.pressureLastPagePoint = undefined;
    surface.simulateMousePressure = false;
    this.cancelHeldShape(surface);
    if (surface.shapeResize) {
      this.logger.shapeTool("cancel", { page: surface.page.pageNumber, shape: surface.shapeResize.recognition.kind });
    }
    surface.shapePreview = null;
    surface.shapeResize = null;
    surface.laserDraft = false;
    surface.laserDiscardedPoints = 0;
    surface.editPath = [];
    surface.liveEraserPaintedPoints = 0;
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    surface.eraserWholeStrokes = undefined;
    if (surface.textIntent) this.clearTextIntentTimer(surface.textIntent);
    surface.textIntent = null;
    if (event.pointerType === "touch" && this.textContextMenu.isOpen("text-context")) {
      this.textContextMenu.close(false);
      this.textContextMenuTargetId = null;
    }
    this.textMoveDrag = null;
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
    this.scheduleZoomSettleResume();
  }

  private finishEdit(surface: PageSurface): void {
    const preferences = this.options.settings.toolPreferences;
    const editTool = surface.editTool;
    const eraserSize = surface.eraserSize;
    const eraserWholeStrokes = surface.eraserWholeStrokes;
    surface.editTool = undefined;
    if (editTool !== "eraser") {
      surface.eraserSize = undefined;
      surface.eraserWholeStrokes = undefined;
    }
    if (editTool === "eraser" && eraserSize !== undefined) {
      const startedAt = performance.now();
      const hadWetPreview = surface.wetPreviewActive;
      const erase = eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes;
      const strokes = this.ink.page(surface.page.pageNumber);
      const candidateStartedAt = performance.now();
      const candidates = this.ink.pageIntersecting(
        surface.page.pageNumber,
        pathBoundsWithPadding(surface.editPath, eraserSize / 2)
      );
      const candidateMs = performance.now() - candidateStartedAt;
      const geometryStartedAt = performance.now();
      const result = erase(strokes, surface.editPath, eraserSize, {
        candidateIds: new Set(candidates.map((stroke) => stroke.id)),
        createFragmentId: () => this.id()
      });
      const geometryMs = performance.now() - geometryStartedAt;
      let historyPaintMs = 0;
      if (result.erased.length) {
        this.clearSelection();
        const historyStartedAt = performance.now();
        this.executeHistory(
          new ReplacePageStrokesCommand(this.ink, surface.page.pageNumber, this.ink.page(surface.page.pageNumber), result.kept),
          surface.page.pageNumber
        );
        historyPaintMs = performance.now() - historyStartedAt;
      }
      surface.eraserSize = undefined;
      surface.eraserWholeStrokes = undefined;
      this.logger.renderProfile({
        page: surface.page.pageNumber,
        operation: "erase-finalize",
        reason: "pointerup",
        durationMs: performance.now() - startedAt,
        candidateMs,
        geometryMs,
        historyPaintMs,
        wholeStroke: eraserWholeStrokes,
        pathPointCount: surface.editPath.length,
        candidateCount: candidates.length,
        beforeStrokeCount: strokes.length,
        changedStrokeCount: result.erased.length,
        fragmentCount: result.fragments.length,
        afterStrokeCount: result.kept.length,
        wetPreviewActive: hadWetPreview
      });
      return;
    }
    if (editTool !== "lasso" || surface.editPath.length < 2) return;
    const lassoType = preferences.lasso.type;
    const editPath = lassoType === "freeform" && surface.editPath.length > 24
      ? simplifyPoints(surface.editPath, 0.75)
      : surface.editPath;
    const xs = editPath.map((point) => point.x);
    const ys = editPath.map((point) => point.y);
    const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    const shape: SelectionShape = lassoType === "freeform"
      ? { type: "freeform", points: editPath }
      : { type: lassoType, bounds };
    if (selectionShapeArea(shape) < 16) {
      this.clearSelection();
      return;
    }
    const layout = this.pageLayout(surface);
    const mapper = this.mapper(surface);
    const matched = selectStrokes(this.ink.pageIntersecting(surface.page.pageNumber, shapeBounds(shape)), shape);
    this.selected = filterSelectableStrokes(
      matched,
      layout.pdfWidth,
      layout.pdfHeight,
      layout.scale,
      layout.contentWidth,
      layout.contentHeight,
      (point) => mapper.toViewport(point)
    );
    if (matched.length && !this.selected.length) {
      this.logger.lassoSelectionFiltered(surface.page.pageNumber, matched.length, {
        pdfWidth: layout.pdfWidth,
        pdfHeight: layout.pdfHeight,
        contentWidth: layout.contentWidth,
        contentHeight: layout.contentHeight,
        livePageWidth: surface.page.width,
        livePageHeight: surface.page.height
      });
    }
    this.selectedTexts = this.texts.page(surface.page.pageNumber).filter((text) =>
      shapeContainsPoint(shape, { x: text.x + text.width / 2, y: text.y - text.height / 2 })
    );
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logText(surface, "lasso-selection-empty", {
        shape: shape.type,
        pathPoints: editPath.length,
        strokeMatchCount: matched.length
      });
      this.clearSelection();
      return;
    }
    this.selectionShape = shape;
    this.selectionPage = surface.page.pageNumber;
    this.invalidateInkLayer(surface, { preserveDeferredRaster: true });
    this.logger.lassoSelection(surface.page.pageNumber, this.selected.length + this.selectedTexts.length, editPath.length, shape.type);
    this.logText(surface, "lasso-selection", {
      shape: shape.type,
      pathPoints: editPath.length,
      textSelectedCount: this.selectedTexts.length,
      strokeSelectedCount: this.selected.length
    });
    this.ensureSelectionToolbar({ resetPlacement: true });
  }

  private scheduleHeldShape(surface: PageSurface): void {
    this.cancelHeldShape(surface);
    if (!this.options.settings.toolPreferences.shape.holdToRecognize || !surface.builder || surface.shapeResize) return;
    surface.shapeHoldTimer = window.setTimeout(() => {
      surface.shapeHoldTimer = null;
      if (!this.options.settings.toolPreferences.shape.holdToRecognize || !surface.builder || !isDrawingTool(this.activeTool()) || surface.shapeResize) return;
      const input = surface.builder.preview(this.simplifyStrokesEnabled());
      const recognized = recognizeHeldShape(input);
      if (!recognized) return;
      const pointer = input.at(-1);
      if (!pointer) return;
      const handle = shapeResizeHandle(recognized.points, pointer);
      surface.shapePreview = recognized.points;
      surface.shapeResize = {
        recognition: recognized,
        anchor: structuredClone(shapeResizeAnchor(recognized.points, handle)),
        handle: structuredClone(handle)
      };
      this.logger.refresh("shape-recognized", { page: surface.page.pageNumber, shape: recognized.kind });
      this.logger.shapeTool("recognized", {
        page: surface.page.pageNumber,
        shape: recognized.kind,
        holdMs: SHAPE_RECOGNITION_HOLD_MS,
        pointCount: recognized.points.length,
        anchorX: round(surface.shapeResize.anchor.x),
        anchorY: round(surface.shapeResize.anchor.y),
        handleX: round(handle.x),
        handleY: round(handle.y)
      });
      this.renderPage(surface.page.pageNumber);
    }, SHAPE_RECOGNITION_HOLD_MS);
  }

  private resizeLockedShape(surface: PageSurface, target: PagePoint): void {
    const resize = surface.shapeResize;
    if (!resize) return;
    surface.shapePreview = resizeShapePoints(resize.recognition.points, resize.anchor, resize.handle, target);
    this.logger.shapeTool("resize", {
      page: surface.page.pageNumber,
      shape: resize.recognition.kind,
      targetX: round(target.x),
      targetY: round(target.y),
      pointCount: surface.shapePreview.length
    });
  }

  private cancelHeldShape(surface: PageSurface): void {
    if (surface.shapeHoldTimer !== null) {
      window.clearTimeout(surface.shapeHoldTimer);
      surface.shapeHoldTimer = null;
    }
  }

  private beginTextIntent(surface: PageSurface, sample: PointerSample, event: PointerEvent): void {
    const point = this.toPagePoint(surface, sample, true);
    const activeEditor = this.activeTextEditor;
    if (activeEditor) {
      this.logText(activeEditor.surface, "outside-click-close", {
        annotationId: activeEditor.draft.id,
        existing: Boolean(activeEditor.existing),
        targetPage: surface.page.pageNumber,
        targetX: round(point.x),
        targetY: round(point.y)
      });
      this.commitActiveTextEditor("outside-click");
      surface.textIntent = null;
      return;
    }
    const hit = this.textAt(surface.page.pageNumber, point);
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".native-pdf-handwriting-text-box")
      : null;
    const intent: NonNullable<PageSurface["textIntent"]> = {
      start: point,
      hit,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      target,
      longPressTimer: null,
      longPressTriggered: false
    };
    surface.textIntent = intent;
    this.logText(surface, "intent", {
      pointerType: event.pointerType || "(empty)", pointerId: event.pointerId,
      x: round(point.x), y: round(point.y), committedPrevious: false
    });
    this.logText(surface, "hit-test", {
      hit: Boolean(hit), annotationId: hit?.id ?? null,
      x: round(point.x), y: round(point.y),
      ...(hit ? this.textGeometry(hit) : {})
    });
    if (event.pointerType === "touch" && hit) {
      intent.longPressTimer = window.setTimeout(() => {
        intent.longPressTimer = null;
        if (surface.textIntent !== intent || this.destroyed || this.activeTextEditor) return;
        intent.longPressTriggered = true;
        this.logText(surface, "touch-long-press", {
          annotationId: hit.id,
          holdMs: TEXT_TOUCH_HOLD_MS,
          pointerId: intent.pointerId
        });
        this.openTextContextMenu(surface, intent);
      }, TEXT_TOUCH_HOLD_MS);
    }
  }

  private updateTextIntent(surface: PageSurface, sample: PointerSample, event: PointerEvent): void {
    const point = this.toPagePoint(surface, sample, true);
    if (this.textMoveDrag?.page === surface.page.pageNumber) {
      const dx = point.x - this.textMoveDrag.start.x;
      const dy = point.y - this.textMoveDrag.start.y;
      this.textMoveDrag.preview = {
        ...this.textMoveDrag.before,
        x: this.textMoveDrag.before.x + dx,
        y: this.textMoveDrag.before.y + dy,
        updatedAt: new Date().toISOString()
      };
      this.logText(surface, "move", {
        annotationId: this.textMoveDrag.preview.id,
        dx: round(dx), dy: round(dy),
        x: round(this.textMoveDrag.preview.x), y: round(this.textMoveDrag.preview.y)
      });
      this.renderTextAnnotations(surface);
      return;
    }
    const intent = surface.textIntent;
    if (!intent) return;
    if (intent.pointerType === "touch") {
      if (intent.longPressTriggered) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const threshold = Math.max(TEXT_TOUCH_MOVE_THRESHOLD_PX / Math.max(this.displayScale(surface), 0.1), 6);
      if (Math.hypot(point.x - intent.start.x, point.y - intent.start.y) < threshold) return;
      this.clearTextIntentTimer(intent);
      surface.textIntent = null;
      this.logText(surface, "touch-long-press-cancel", {
        annotationId: intent.hit?.id ?? null,
        pointerId: intent.pointerId,
        threshold: round(threshold),
        startX: round(intent.start.x), startY: round(intent.start.y),
        currentX: round(point.x), currentY: round(point.y)
      });
      return;
    }
    if (!intent.hit || intent.pointerType !== "pen") return;
    const threshold = Math.max(3 / Math.max(this.displayScale(surface), 0.1), 2);
    if (Math.hypot(point.x - intent.start.x, point.y - intent.start.y) < threshold) return;
    this.textMoveDrag = {
      page: surface.page.pageNumber,
      start: intent.start,
      before: structuredClone(intent.hit),
      preview: structuredClone(intent.hit)
    };
    this.logText(surface, "move-start", {
      annotationId: intent.hit.id, threshold: round(threshold),
      startX: round(intent.start.x), startY: round(intent.start.y),
      currentX: round(point.x), currentY: round(point.y)
    });
    surface.textIntent = null;
    this.updateTextIntent(surface, sample, event);
  }

  private finishTextIntent(surface: PageSurface, sample: PointerSample, _event: PointerEvent): void {
    if (this.textMoveDrag?.page === surface.page.pageNumber) {
      const drag = this.textMoveDrag;
      this.textMoveDrag = null;
      if (drag.before.x !== drag.preview.x || drag.before.y !== drag.preview.y) {
        this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, drag.before, drag.preview), surface.page.pageNumber);
        this.selectedTexts = [drag.preview];
        this.selected = [];
        this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
        this.selectionPage = surface.page.pageNumber;
        this.logText(surface, "move-commit", {
          annotationId: drag.preview.id,
          fromX: round(drag.before.x), fromY: round(drag.before.y),
          toX: round(drag.preview.x), toY: round(drag.preview.y)
        });
      } else {
        this.logText(surface, "move-cancel", { annotationId: drag.before.id, reason: "no-position-change" });
      }
      this.renderTextAnnotations(surface);
      return;
    }
    const intent = surface.textIntent;
    surface.textIntent = null;
    if (!intent) return;
    this.clearTextIntentTimer(intent);
    if (intent.longPressTriggered) {
      _event.preventDefault();
      _event.stopImmediatePropagation();
      this.logText(surface, "touch-long-press-end", {
        annotationId: intent.hit?.id ?? null,
        pointerId: intent.pointerId
      });
      return;
    }
    if (intent.hit) {
      this.logText(surface, "edit-request", { annotationId: intent.hit.id, ...this.textGeometry(intent.hit) });
      this.openTextEditor(surface, intent.hit);
    } else {
      this.logText(surface, "create-request", { x: round(intent.start.x), y: round(intent.start.y) });
      this.openTextEditor(surface, null, intent.start);
    }
    this.renderTextAnnotations(surface);
  }

  private clearTextIntentTimer(intent: NonNullable<PageSurface["textIntent"]>): void {
    if (intent.longPressTimer === null) return;
    window.clearTimeout(intent.longPressTimer);
    intent.longPressTimer = null;
  }

  private openTextContextMenu(surface: PageSurface, intent: NonNullable<PageSurface["textIntent"]>): void {
    const annotation = intent.hit;
    if (!annotation) return;
    this.clearSelection({ refresh: false });
    this.selected = [];
    this.selectedTexts = [annotation];
    this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
    this.selectionPage = surface.page.pageNumber;
    this.selectionToolbar.hide();
    this.renderTextAnnotations(surface);
    const target = [...surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")]
      .find((box) => box.dataset.annotationId === annotation.id);
    if (!target) return;
    this.textContextMenuTargetId = annotation.id;
    if (this.textContextMenuSuppressTimer !== null) window.clearTimeout(this.textContextMenuSuppressTimer);
    this.textContextMenuSuppressTimer = window.setTimeout(() => {
      this.textContextMenuSuppressTimer = null;
      this.textContextMenuTargetId = null;
    }, TEXT_TOUCH_HOLD_MS * 3);
    const content = textMenu(
      target.ownerDocument,
      this.textStyle(annotation),
      (change) => this.applyTextStyleToSelection(change),
      this.pointerProbeAbort.signal
    );
    this.textContextMenu.open("text-context", target, {
      label: "Text box actions",
      options: [
        { id: "delete", label: "Delete", onSelect: () => this.deleteSelection() },
        { id: "copy", label: "Copy", onSelect: () => this.copySelection() },
        { id: "cut", label: "Cut", onSelect: () => this.cutSelection() }
      ],
      content,
      focusFirst: false
    });
    this.logText(surface, "touch-context-menu", {
      annotationId: annotation.id,
      options: ["delete", "copy", "cut", "size"]
    });
  }

  private handleTextBoxContextMenu(event: MouseEvent, annotationId: string): void {
    if (this.textContextMenuTargetId !== annotationId && !this.textContextMenu.isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.logger.textTool("context-menu-suppressed", { annotationId });
  }

  private textAt(page: number, point: Pick<PagePoint, "x" | "y">): TextAnnotation | null {
    const pageTexts = this.texts.page(page);
    for (let i = pageTexts.length - 1; i >= 0; i--) {
      const text = pageTexts[i];
      if (text && point.x >= text.x && point.x <= text.x + text.width
          && point.y <= text.y && point.y >= text.y - text.height) {
        return text;
      }
    }
    return null;
  }

  private logText(surface: PageSurface, phase: string, details: Record<string, unknown> = {}): void {
    this.logger.textTool(phase, {
      page: surface.page.pageNumber,
      displayScale: Number(this.displayScale(surface).toFixed(4)),
      ...details
    });
  }

  private textGeometry(text: Pick<TextAnnotation, "x" | "y" | "width" | "height" | "fontSize" | "fontFamily" | "bold" | "italic" | "strikethrough">): Record<string, unknown> {
    return {
      x: round(text.x), y: round(text.y), width: round(text.width), height: round(text.height),
      fontSize: text.fontSize, fontFamily: text.fontFamily,
      bold: text.bold, italic: text.italic, strikethrough: text.strikethrough
    };
  }

  private editorSelectionMetrics(element: HTMLElement): {
    selectedCharacters: number;
    collapsed: boolean;
    anchorOffset: number | null;
    focusOffset: number | null;
  } {
    const selection = element.ownerDocument.getSelection();
    if (!selection?.rangeCount || !element.contains(selection.anchorNode)) {
      return { selectedCharacters: 0, collapsed: true, anchorOffset: null, focusOffset: null };
    }
    return {
      selectedCharacters: selection.toString().length,
      collapsed: selection.isCollapsed,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset
    };
  }

  private openTextEditor(surface: PageSurface, existing: TextAnnotation | null, at?: Pick<PagePoint, "x" | "y">): void {
    this.commitActiveTextEditor();
    const clearedSelection = this.selected.length > 0 || this.selectedTexts.length > 0;
    // Editing has its own dotted DOM boundary. Suspend the canvas selection
    // first so a text box can never render two competing outlines.
    // Page-local paint (not refresh:false) — otherwise canvas outline/z-index linger.
    this.clearSelection();
    const preferences = this.options.settings.toolPreferences.text;
    const style: TextStyle = existing
      ? this.textStyle(existing)
      : { ...preferences };
    const metrics = this.metricsFor(surface);
    const annotation = existing ?? {
      id: this.id(),
      page: surface.page.pageNumber,
      text: "",
      x: at?.x ?? metrics.width * 0.1,
      y: at?.y ?? metrics.height * 0.9,
      width: Math.min(260, Math.max(150, metrics.width * 0.4)),
      height: style.fontSize * 1.6,
      ...style,
      runs: [],
      sourceRuns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const storedRuns = normalizeTextRuns(annotation.runs);
    const runs = storedRuns.length && plainTextFromRuns(storedRuns) === annotation.text
      ? storedRuns
      : plainTextToRuns(annotation.text, style);
    const insertionStyle = { ...(styleAtTextOffset(runs, runs.reduce((length, run) => length + run.text.length, 0)) ?? style) };
    const element = createDetachedDiv(surface.overlay.ownerDocument);
    const abort = new AbortController();
    element.className = "native-pdf-handwriting-text-input";
    element.contentEditable = "true";
    // contenteditable is programmatically focusable, but an explicit tab stop
    // gives Obsidian's embedded PDF host a stable, native focus target.
    element.tabIndex = 0;
    element.spellcheck = true;
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-multiline", "true");
    element.setAttribute("aria-label", "Text annotation");
    const listenerOptions = { signal: abort.signal };
    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.logText(surface, "editor-pointer", {
        annotationId: annotation.id, pointerType: event.pointerType || "(empty)", pointerId: event.pointerId,
        ...this.editorSelectionMetrics(element)
      });
    }, listenerOptions);
    element.addEventListener("keydown", (event) => {
      // Direct editors in pop-outs/embeds may not be the workspace's active
      // session. Claim Select All here as a fallback to the window shortcut
      // router so the next native keystroke replaces this editor's full text.
      if (this.handleActiveTextEditorSelectAll(event)) return;
      if (event.isComposing || (this.activeTextEditor?.element === element && this.activeTextEditor.composing)) {
        this.logText(surface, "keydown-composition", { annotationId: annotation.id, key: event.key });
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.logText(surface, "escape", { annotationId: annotation.id, ...this.editorSelectionMetrics(element) });
      this.commitActiveTextEditor("escape");
    }, listenerOptions);
    element.addEventListener("beforeinput", (event) => {
      this.logText(surface, "beforeinput", {
        annotationId: annotation.id,
        inputType: event.inputType || "(empty)",
        dataLength: event.data?.length ?? 0,
        isComposing: event.isComposing,
        ...this.editorSelectionMetrics(element)
      });
      const editor = this.activeTextEditor;
      if (editor?.element !== element || editor.composing || event.isComposing || !editor.pendingInsertionStyle) return;
      if ((event.inputType === "insertText" && event.data) || event.inputType === "insertParagraph") {
        event.preventDefault();
        this.insertTextWithActiveStyle(editor, event.inputType === "insertParagraph" ? "\n" : event.data!);
      }
    }, listenerOptions);
    element.addEventListener("input", () => {
      const editor = this.activeTextEditor;
      if (editor?.element === element && !editor.composing) this.syncActiveTextRuns(editor);
      const value = editor?.element === element ? plainTextFromRuns(editor.runs) : "";
      this.logText(surface, "input", {
        annotationId: annotation.id,
        characterCount: value.length,
        lineCount: value ? value.split("\n").length : 0,
        runCount: editor?.runs.length ?? 0
      });
    }, listenerOptions);
    element.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.logText(surface, "paste", {
        annotationId: annotation.id,
        characterCount: text.length,
        lineCount: text ? text.replace(/\r\n?/g, "\n").split("\n").length : 0,
        ...this.editorSelectionMetrics(element)
      });
      const editor = this.activeTextEditor;
      if (editor?.element !== element) return;
      this.insertTextWithActiveStyle(editor, text.replace(/\r\n?/g, "\n"));
    }, listenerOptions);
    for (const type of ["copy", "cut"] as const) {
      element.addEventListener(type, () => this.logText(surface, type, {
        annotationId: annotation.id,
        ...this.editorSelectionMetrics(element)
      }), listenerOptions);
    }
    for (const type of ["compositionstart", "compositionupdate", "compositionend"] as const) {
      element.addEventListener(type, (event) => {
        if (this.activeTextEditor?.element === element) {
          if (type === "compositionstart") this.activeTextEditor.composing = true;
          if (type === "compositionend") {
            this.activeTextEditor.composing = false;
            const deferred = this.activeTextEditor.deferredStyleChange;
            void Promise.resolve().then(() => {
              const active = this.activeTextEditor;
              if (active?.element !== element || active.composing) return;
              this.syncActiveTextRuns(active);
              if (!deferred) return;
              active.deferredStyleChange = null;
              this.applyTextStyleToActiveEditor(deferred);
            }).catch((error) => {
              this.logger.textTool("composition-style-error", {
                annotationId: annotation.id,
                error: this.errorMessage(error)
              });
            });
          }
        }
        this.logText(surface, type, {
          annotationId: annotation.id,
          dataLength: event.data?.length ?? 0,
          ...this.editorSelectionMetrics(element)
        });
      }, listenerOptions);
    }
    element.addEventListener("focus", () => this.logText(surface, "focus", { annotationId: annotation.id }), listenerOptions);
    element.addEventListener("blur", () => this.logText(surface, "blur", { annotationId: annotation.id }), listenerOptions);
    element.addEventListener("keyup", () => this.logText(surface, "selection", {
      annotationId: annotation.id,
      ...this.editorSelectionMetrics(element)
    }), listenerOptions);
    this.activeTextEditor = {
      surface, existing, draft: annotation, style: { ...style }, runs, selection: null,
      insertionStyle, pendingInsertionStyle: false, deferredStyleChange: null,
      element, resizeObserver: null, abort, composing: false
    };
    element.ownerDocument.addEventListener("selectionchange", () => {
      if (this.activeTextEditor?.element !== element) return;
      // captureActiveTextSelection logs selection-snapshot — do not also emit selectionchange.
      this.captureActiveTextSelection("selectionchange");
    }, { signal: abort.signal });
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        const rect = element.getBoundingClientRect();
        this.logText(surface, "resize", {
          annotationId: annotation.id,
          widthPx: round(rect.width), heightPx: round(rect.height),
          width: round(rect.width / Math.max(this.displayScale(surface), 0.1)),
          height: round(rect.height / Math.max(this.displayScale(surface), 0.1))
        });
      });
      resizeObserver.observe(element);
      this.activeTextEditor.resizeObserver = resizeObserver;
    }
    this.applyTextElementStyle(surface, element, annotation, style);
    renderTextRuns(element, runs, this.displayScale(surface));
    // Keep the live, focusable editor out of the non-interactive static-text
    // layer. Obsidian/PDF viewers may restyle or replace their text layers;
    // the overlay is the stable annotation owner and mirrors the working PR.
    surface.overlay.append(element);
    // Leave other committed annotations visible, but do not paint the edited
    // annotation underneath its live contenteditable copy.
    if (existing) {
      for (const box of surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
        if (box.dataset.annotationId === existing.id) box.remove();
      }
    }
    this.logText(surface, existing ? "editor-open-existing" : "editor-open-new", {
      annotationId: annotation.id,
      characterCount: plainTextFromRuns(runs).length,
      runCount: runs.length,
      mount: "overlay",
      clearedSelection,
      ...this.textGeometry(annotation)
    });
    const focusNativeCaret = (phase: "initial" | "fallback"): void => {
      if (this.activeTextEditor?.element !== element) return;
      element.focus({ preventScroll: true });
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.captureActiveTextSelection("focus-ready");
      this.logText(surface, "focus-ready", {
        annotationId: annotation.id,
        phase,
        activeElementIsEditor: element.ownerDocument.activeElement === element,
        isConnected: element.isConnected,
        ...this.editorSelectionMetrics(element)
      });
      const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
      this.logText(surface, "editor-visual-style", {
        annotationId: annotation.id,
        backgroundColor: computed?.backgroundColor ?? null,
        borderColor: computed?.borderColor ?? null,
        borderStyle: computed?.borderStyle ?? null,
        borderWidth: computed?.borderWidth ?? null,
        boxShadow: computed?.boxShadow ?? null,
        caretColor: computed?.caretColor ?? null,
        color: computed?.color ?? null,
        cursor: computed?.cursor ?? null
      });
    };
    focusNativeCaret("initial");
    window.requestAnimationFrame(() => {
      // Do not steal focus from another control. This only covers an embedded
      // viewer that has returned focus to the document body during mounting.
      if (element.ownerDocument.activeElement !== element && element.ownerDocument.activeElement === element.ownerDocument.body) {
        focusNativeCaret("fallback");
      }
    });
  }

  private commitActiveTextEditor(reason = "switch"): void {
    const editor = this.activeTextEditor;
    if (!editor) return;
    if (editor.composing) {
      this.logText(editor.surface, "commit-deferred-composition", { annotationId: editor.draft.id, reason });
      return;
    }
    this.activeTextEditor = null;
    // DOM is the live editing surface; runs are canonical persistence. Read it
    // once at commit so contenteditable keeps its native caret/IME behavior.
    editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    const runs = normalizeTextRuns(editor.runs);
    const text = plainTextFromRuns(runs);
    const rect = editor.element.getBoundingClientRect();
    editor.resizeObserver?.disconnect();
    editor.abort.abort();
    editor.element.remove();
    if (!text.trim()) {
      if (editor.existing) {
        this.executeHistory(new DeleteTextAnnotationsCommand(this.texts, [editor.existing]), editor.surface.page.pageNumber);
        this.logText(editor.surface, "delete-empty", { annotationId: editor.existing.id, reason });
      } else this.logText(editor.surface, "discard-empty", { annotationId: editor.draft.id, reason });
      if (this.needsPagePaint(editor.surface.page.pageNumber)) this.renderTextAnnotations(editor.surface);
      return;
    }
    const scale = Math.max(this.displayScale(editor.surface), 0.1);
    const before = editor.existing;
    const now = new Date().toISOString();
    const base = before ?? editor.draft;
    const displayStyle = styleAtTextOffset(runs, 0) ?? editor.insertionStyle;
    const largestFontSize = Math.max(displayStyle.fontSize, ...runs.map((run) => run.fontSize));
    const annotation: TextAnnotation = {
      ...base,
      ...displayStyle,
      text,
      width: Math.max(24, rect.width / scale || base.width),
      height: Math.max(largestFontSize * 1.4, rect.height / scale || base.height),
      runs,
      sourceRuns: runs.map((run) => ({ ...run })),
      updatedAt: now
    };
    if (before) this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, before, annotation), annotation.page);
    else this.executeHistory(new AddTextAnnotationCommand(this.texts, annotation), annotation.page);
    this.logText(editor.surface, before ? "commit-update" : "commit-create", {
      annotationId: annotation.id, reason,
      characterCount: text.length, lineCount: text.split("\n").length, runCount: runs.length,
      widthPx: round(rect.width), heightPx: round(rect.height),
      ...this.textGeometry(annotation)
    });
    if (this.needsPagePaint(annotation.page)) this.renderTextAnnotations(editor.surface);
  }

  private textStyle(text: TextAnnotation): TextStyle {
    return {
      color: text.color, fontSize: text.fontSize, fontFamily: text.fontFamily,
      bold: text.bold, italic: text.italic, strikethrough: text.strikethrough
    };
  }

  private applyTextStyleToActiveEditor(change: TextStyleChange): void {
    const editor = this.activeTextEditor;
    this.logger.textTool("style-preference", {
      property: change.property,
      value: change.value,
      source: change.source,
      editorActive: Boolean(editor),
      defaultColor: this.options.settings.toolPreferences.text.color,
      defaultFontSize: this.options.settings.toolPreferences.text.fontSize,
      defaultFontFamily: this.options.settings.toolPreferences.text.fontFamily
    });
    if (!editor) {
      this.applyTextStyleToSelection(change);
      return;
    }
    if (editor.composing) {
      editor.deferredStyleChange = change;
      this.logText(editor.surface, "style-deferred-composition", {
        annotationId: editor.draft.id, property: change.property
      });
      return;
    }
    this.syncActiveTextRuns(editor);
    const offsets = editor.selection ?? selectionOffsets(editor.element) ?? {
      start: plainTextFromRuns(editor.runs).length,
      end: plainTextFromRuns(editor.runs).length
    };
    if (offsets.start === offsets.end) {
      const current = styleAtTextOffset(editor.runs, offsets.start) ?? editor.insertionStyle;
      editor.insertionStyle = this.patchTextStyle(current, change);
      editor.style = { ...editor.insertionStyle };
      editor.pendingInsertionStyle = true;
      this.applyTextElementStyle(editor.surface, editor.element, editor.existing ?? editor.draft, editor.insertionStyle);
      this.logText(editor.surface, "style-insertion", {
        annotationId: editor.draft.id, property: change.property,
        offset: offsets.start,
        color: editor.insertionStyle.color, fontSize: editor.insertionStyle.fontSize,
        fontFamily: editor.insertionStyle.fontFamily, bold: editor.insertionStyle.bold,
        italic: editor.insertionStyle.italic, strikethrough: editor.insertionStyle.strikethrough
      });
      return;
    }
    editor.runs = patchTextRunRange(editor.runs, offsets.start, offsets.end, this.textStylePatch(change));
    renderTextRuns(editor.element, editor.runs, this.displayScale(editor.surface));
    restoreSelection(editor.element, offsets);
    editor.selection = offsets;
    editor.style = { ...(styleAtTextOffset(editor.runs, offsets.start) ?? editor.insertionStyle) };
    this.applyTextElementStyle(editor.surface, editor.element, editor.existing ?? editor.draft, editor.style);
    this.logText(editor.surface, "style-apply", {
      annotationId: editor.draft.id,
      property: change.property,
      source: change.source,
      selectionStart: offsets.start, selectionEnd: offsets.end, runCount: editor.runs.length,
      color: editor.style.color, fontSize: editor.style.fontSize, fontFamily: editor.style.fontFamily,
      bold: editor.style.bold, italic: editor.style.italic, strikethrough: editor.style.strikethrough
    });
  }

  /** Serialize live DOM without replacing it; replacement would lose the caret. */
  private syncActiveTextRuns(editor: ActiveTextEditor): void {
    if (!editor.composing) editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    const offsets = selectionOffsets(editor.element);
    if (offsets) editor.selection = offsets;
  }

  /** Capture selection before toolbar controls move focus away from contenteditable. */
  private captureActiveTextSelection(phase: string): void {
    const editor = this.activeTextEditor;
    if (!editor) return;
    const offsets = selectionOffsets(editor.element);
    if (!offsets) return;
    editor.selection = offsets;
    if (!editor.composing) editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    this.logText(editor.surface, "selection-snapshot", {
      annotationId: editor.draft.id, phase,
      start: offsets.start, end: offsets.end, collapsed: offsets.start === offsets.end
    });
  }

  private activeTextStyle(): TextStyle | undefined {
    const editor = this.activeTextEditor;
    if (!editor) return undefined;
    const offsets = editor.selection ?? selectionOffsets(editor.element);
    const style = offsets
      ? styleAtTextOffset(editor.runs, offsets.start)
      : editor.insertionStyle;
    return { ...(style ?? editor.insertionStyle) };
  }

  private insertTextWithActiveStyle(editor: ActiveTextEditor, text: string): void {
    if (!text) return;
    const style = editor.pendingInsertionStyle
      ? editor.insertionStyle
      : styleAtTextOffset(editor.runs, editor.selection?.start ?? 0) ?? editor.insertionStyle;
    if (!selectionOffsets(editor.element)) {
      const range = editor.element.ownerDocument.createRange();
      range.selectNodeContents(editor.element);
      range.collapse(false);
      const selection = editor.element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const inserted = insertStyledText(editor.element, text, style, this.displayScale(editor.surface));
    if (!inserted) return;
    editor.pendingInsertionStyle = false;
    this.syncActiveTextRuns(editor);
    editor.selection = { start: inserted.end, end: inserted.end };
  }

  private patchTextStyle(style: TextStyle, change: TextStyleChange): TextStyle {
    return { ...style, ...this.textStylePatch(change) };
  }

  private textStylePatch(change: TextStyleChange): Partial<TextStyle> {
    switch (change.property) {
      case "fontFamily": return { fontFamily: change.value as string };
      case "color": return { color: change.value as string };
      case "fontSize": return { fontSize: change.value as number };
      case "bold": return { bold: change.value as boolean };
      case "italic": return { italic: change.value as boolean };
      case "strikethrough": return { strikethrough: change.value as boolean };
    }
  }

  private applyTextStyleToSelection(change: TextStyleChange): void {
    this.reconcileSelection();
    if (!this.selectedTexts.length) return;
    const before = [...this.selectedTexts];
    const now = new Date().toISOString();
    const after = before.map((text) => ({
      ...text,
      ...this.patchTextStyle(this.textStyle(text), change),
      runs: text.runs.map((run) => ({ ...run, ...this.patchTextStyle(run, change) })),
      sourceRuns: text.sourceRuns.map((run) => ({ ...run, ...this.patchTextStyle(run, change) })),
      updatedAt: now
    }));
    this.executeHistory({
      label: "Style text annotations",
      execute: () => after.forEach((text) => this.texts.replace(text)),
      undo: () => before.forEach((text) => this.texts.replace(text))
    }, this.selectionPage);
    this.selectedTexts = after;
    this.logger.textTool("selection-style", {
      page: this.selectionPage,
      property: change.property,
      textCount: after.length
    });
    this.refresh("text-style-selection");
  }

  private applyTextElementStyle(
    surface: PageSurface,
    element: HTMLElement,
    annotation: Pick<TextAnnotation, "x" | "y" | "width" | "height">,
    style: TextStyle
  ): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const scale = this.displayScale(surface);
    Object.assign(element.style, {
      left: `${origin.x}px`, top: `${origin.y}px`, width: `${Math.max(24, annotation.width * scale)}px`,
      minHeight: `${Math.max(style.fontSize * scale * 1.4, annotation.height * scale)}px`,
      color: style.color, fontFamily: style.fontFamily, fontSize: `${style.fontSize * scale}px`,
      fontWeight: style.bold ? "700" : "400", fontStyle: style.italic ? "italic" : "normal",
      textDecoration: style.strikethrough ? "line-through" : "none"
    });
  }

  private renderTextAnnotations(surface: PageSurface): void {
    // Replacing a focused contenteditable loses selection. It remains positioned
    // until it is committed; all normal renders resume once editing finishes.
    if (this.activeTextEditor?.surface === surface) {
      this.logText(surface, "render-skipped-active-editor", { annotationId: this.activeTextEditor.draft.id });
      return;
    }
    // Repainting the page while a control is held used to replaceChildren() on
    // the frame being moved. Keep that exact DOM node alive until release so
    // its outline remains visibly attached to the pointer.
    if (this.textBoxTransformDrag?.surface === surface) return;
    const preview = this.textMoveDrag?.page === surface.page.pageNumber ? this.textMoveDrag.preview : null;
    const selectionPreviews = this.moveDrag?.page === surface.page.pageNumber
      ? new Map((this.moveTextPreview ?? []).map((text) => [text.id, text]))
      : null;
    const annotations = this.texts.page(surface.page.pageNumber).map((text) =>
      preview?.id === text.id ? preview : selectionPreviews?.get(text.id) ?? text
    );
    if (
      !annotations.length
      && !preview
      && !selectionPreviews?.size
      && !surface.textLayer.childElementCount
    ) {
      this.syncFindBridgePage(surface.page.pageNumber);
      return;
    }
    const selected = new Set(
      this.activeTool() === "lasso" || this.activeTool() === "text"
        ? this.selectedTexts.map((text) => text.id)
        : []
    );
    if (this.syncCurrentTextBoxes(surface, annotations, selected)) return;
    const boxes = annotations.map((annotation) => {
      const box = createDetachedDiv(surface.overlay.ownerDocument);
      box.className = "native-pdf-handwriting-text-box";
      box.dataset.annotationId = annotation.id;
      box.dataset.annotationSignature = this.textBoxRenderSignature(annotation, selected.has(annotation.id));
      box.addEventListener("contextmenu", (event) => this.handleTextBoxContextMenu(event, annotation.id), {
        signal: this.pointerProbeAbort.signal
      });
      if (this.textBoxesInteractable()) box.classList.add("is-editable");
      if (selected.has(annotation.id)) box.classList.add("is-selected");
      this.positionTextBox(surface, box, annotation);
      const runs = normalizeTextRuns(annotation.runs);
      renderTextRuns(
        box,
        runs.length && plainTextFromRuns(runs) === annotation.text ? runs : plainTextToRuns(annotation.text, this.textStyle(annotation)),
        this.displayScale(surface)
      );
      this.attachTextBoxOutline(surface, box, annotation);
      return box;
    });
    surface.textLayer.replaceChildren(...boxes);
    this.logText(surface, "render", {
      annotationCount: annotations.length,
      selectedCount: selected.size,
      previewAnnotationId: preview?.id ?? null
    });
    this.syncFindBridgePage(surface.page.pageNumber);
  }

  /** Reuse unchanged text DOM so zoom settles do not remove/reinsert visible words. */
  private syncCurrentTextBoxes(
    surface: PageSurface,
    annotations: readonly TextAnnotation[],
    selected: ReadonlySet<string>
  ): boolean {
    const boxes = [...surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")];
    if (boxes.length !== annotations.length) return false;
    const byId = new Map(boxes.map((box) => [box.dataset.annotationId, box]));
    if (!annotations.every((annotation) => {
      const box = byId.get(annotation.id);
      return box?.dataset.annotationSignature === this.textBoxRenderSignature(annotation, selected.has(annotation.id));
    })) return false;
    for (const annotation of annotations) {
      const box = byId.get(annotation.id);
      if (!box) return false;
      this.positionTextBox(surface, box, annotation);
      rescaleTextRuns(box, this.displayScale(surface));
      const outline = box.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
      if (outline) this.layoutTextBoxOutline(surface, outline, annotation, annotation);
    }
    this.syncFindBridgePage(surface.page.pageNumber);
    return true;
  }

  /** Geometry/state identity only — never store document text in a DOM data attribute. */
  private textBoxRenderSignature(annotation: TextAnnotation, selected: boolean): string {
    return [
      annotation.updatedAt, annotation.x, annotation.y, annotation.width, annotation.height,
      annotation.color, annotation.fontSize, annotation.fontFamily, annotation.bold, annotation.italic,
      annotation.strikethrough, annotation.text.length, annotation.runs.length, selected,
      this.textBoxesInteractable()
    ].join("|");
  }

  private positionTextBox(surface: PageSurface, box: HTMLElement, annotation: TextAnnotation): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const scale = this.displayScale(surface);
    Object.assign(box.style, {
      left: `${origin.x}px`, top: `${origin.y}px`, width: `${Math.max(24, annotation.width * scale)}px`,
      minHeight: `${Math.max(annotation.fontSize * scale * 1.4, annotation.height * scale)}px`,
      color: annotation.color, fontFamily: annotation.fontFamily, fontSize: `${annotation.fontSize * scale}px`,
      fontWeight: annotation.bold ? "700" : "400", fontStyle: annotation.italic ? "italic" : "normal",
      textDecoration: annotation.strikethrough ? "line-through" : "none"
    });
  }

  /**
   * Canvas ink is deliberately composited during a zoom burst, but text is DOM
   * content. Reproject it immediately so it stays anchored to its PDF-space
   * coordinates instead of retaining the previous scale until settle.
   */
  private syncTextLayoutDuringZoom(surface: PageSurface, layout?: PageCoordinateLayout): void {
    const storedAnnotations = this.texts.page(surface.page.pageNumber);
    const activeEditor = this.activeTextEditor?.surface === surface ? this.activeTextEditor : null;
    if (!storedAnnotations.length && !activeEditor) return;

    const movingPreview = this.textMoveDrag?.page === surface.page.pageNumber ? this.textMoveDrag.preview : null;
    const selectionPreviews = this.moveDrag?.page === surface.page.pageNumber
      ? new Map((this.moveTextPreview ?? []).map((annotation) => [annotation.id, annotation]))
      : null;
    const annotations = storedAnnotations.map((annotation) =>
      movingPreview?.id === annotation.id ? movingPreview : selectionPreviews?.get(annotation.id) ?? annotation
    );

    const annotationsById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    const scale = this.displayScale(surface);
    const transforming = this.textBoxTransformDrag?.surface === surface;
    if (!transforming) {
      for (const box of surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
        const annotation = box.dataset.annotationId ? annotationsById.get(box.dataset.annotationId) : undefined;
        if (!annotation) continue;
        this.positionTextBox(surface, box, annotation);
        rescaleTextRuns(box, scale);
        const outline = box.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
        if (outline) this.layoutTextBoxOutline(surface, outline, annotation, annotation);
      }
    }
    if (activeEditor) {
      const annotation = activeEditor.existing ?? activeEditor.draft;
      this.applyTextElementStyle(surface, activeEditor.element, annotation, activeEditor.style);
      // Do not replace the contenteditable children: that would lose its caret.
      rescaleTextRuns(activeEditor.element, scale);
    }

    if (this.zoomTextLayoutLoggedPages.has(surface.page.pageNumber)) return;
    this.zoomTextLayoutLoggedPages.add(surface.page.pageNumber);
    const layoutSnapshot = layout ?? this.pageLayout(surface);
    const first = annotations[0];
    const origin = first ? this.mapper(surface).toViewport({ x: first.x, y: first.y }) : null;
    this.logger.textTool("zoom-layout", {
      page: surface.page.pageNumber,
      annotationCount: annotations.length,
      activeEditor: Boolean(activeEditor),
      transforming,
      scale: round(scale),
      offsetX: round(layoutSnapshot.offsetX),
      offsetY: round(layoutSnapshot.offsetY),
      contentWidth: round(layoutSnapshot.contentWidth),
      contentHeight: round(layoutSnapshot.contentHeight),
      ...(first && origin ? {
        annotationId: first.id,
        pdfX: round(first.x),
        pdfY: round(first.y),
        viewportX: round(origin.x),
        viewportY: round(origin.y)
      } : {})
    });
  }

  /** NPDE-style frame: edge strips move, circular dots resize. */
  private attachTextBoxOutline(surface: PageSurface, box: HTMLElement, annotation: TextAnnotation): void {
    if (!this.textBoxesInteractable()) return;
    const outline = createDetachedDiv(box.ownerDocument);
    outline.className = "native-pdf-handwriting-text-selection-frame native-pdf-handwriting-selection-control";
    outline.dataset.annotationId = annotation.id;
    outline.setAttribute("aria-hidden", "true");
    this.layoutTextBoxOutline(surface, outline, annotation, annotation);

    const addControl = (kind: "move" | "resize", handle: TextBoxHandle): void => {
      const control = createDetachedDiv(box.ownerDocument);
      control.className = `native-pdf-handwriting-text-${kind}-${handle} native-pdf-handwriting-selection-control`;
      control.dataset.handle = handle;
      control.setAttribute("aria-label", kind === "move" ? "Move text box" : `Resize text box ${handle}`);
      control.addEventListener("pointerdown", (event) => this.startTextBoxTransform(surface, annotation, kind, handle, outline, event), { signal: this.pointerProbeAbort.signal });
      outline.append(control);
    };
    for (const handle of ["n", "e", "s", "w"] as const) addControl("move", handle);
    for (const handle of ["n", "e", "s", "w", "nw", "ne", "sw", "se"] as const) addControl("resize", handle);
    box.append(outline);
  }

  private startTextBoxTransform(
    surface: PageSurface,
    rendered: TextAnnotation,
    mode: "move" | "resize",
    handle: TextBoxHandle,
    outline: HTMLElement,
    event: PointerEvent
  ): void {
    if (!this.textBoxesInteractable() || event.button !== 0) return;
    const annotation = this.texts.page(surface.page.pageNumber).find((text) => text.id === rendered.id);
    if (!annotation) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelTextBoxTransform("superseded", false);
    const box = outline.parentElement;
    if (!box) return;
    const abort = new AbortController();
    const drag: TextBoxTransformDrag = {
      surface,
      pointerId: event.pointerId,
      start: this.textPointerToPagePoint(surface, event),
      before: structuredClone(annotation),
      preview: structuredClone(annotation),
      mode,
      handle,
      box,
      outline,
      abort
    };
    this.textBoxTransformDrag = drag;
    box.classList.add("is-selected", "is-transforming");
    this.selected = [];
    this.selectedTexts = [annotation];
    this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
    this.selectionPage = surface.page.pageNumber;
    if (isElementInDocument(event.currentTarget, outline.ownerDocument)) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const options = { capture: true, signal: abort.signal };
    surface.overlay.ownerDocument.addEventListener("pointermove", (move) => this.updateTextBoxTransform(move), options);
    surface.overlay.ownerDocument.addEventListener("pointerup", (up) => this.finishTextBoxTransform(up), options);
    surface.overlay.ownerDocument.addEventListener("pointercancel", (cancel) => this.cancelTextBoxTransform("pointer-cancel", true, cancel), options);
    this.logText(surface, "box-transform-start", {
      annotationId: annotation.id, mode, handle,
      ...this.textGeometry(annotation)
    });
  }

  private updateTextBoxTransform(event: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.textPointerToPagePoint(drag.surface, event);
    if (drag.mode === "move") {
      drag.preview = {
        ...drag.before,
        x: drag.before.x + point.x - drag.start.x,
        y: drag.before.y + point.y - drag.start.y
      };
      const origin = this.mapper(drag.surface).toViewport({ x: drag.preview.x, y: drag.preview.y });
      const beforeOrigin = this.mapper(drag.surface).toViewport({ x: drag.before.x, y: drag.before.y });
      setElementCssProps(drag.box, {
        transform: `translate(${origin.x - beforeOrigin.x}px, ${origin.y - beforeOrigin.y}px)`
      });
      // The outline is a child of the translated static box, so it follows
      // exactly without adding the move delta a second time.
      this.layoutTextBoxOutline(drag.surface, drag.outline, drag.before, drag.before);
    } else {
      drag.preview = this.resizeTextAnnotation(drag.before, drag.handle, point);
      this.layoutTextBoxOutline(drag.surface, drag.outline, drag.preview, drag.before);
    }
  }

  private finishTextBoxTransform(event: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.abort.abort();
    this.textBoxTransformDrag = null;
    setElementCssProps(drag.box, { transform: "none" });
    drag.box.classList.remove("is-transforming");
    const changed = drag.before.x !== drag.preview.x || drag.before.y !== drag.preview.y
      || drag.before.width !== drag.preview.width || drag.before.height !== drag.preview.height;
    if (changed) {
      const after = { ...drag.preview, updatedAt: new Date().toISOString() };
      // executeHistory paints synchronously. Give that paint the committed
      // selection geometry first, otherwise its canvas marquee remains at the
      // pre-move box position while the DOM text has already moved.
      this.selectedTexts = [after];
      this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
      this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, drag.before, after), drag.surface.page.pageNumber);
      this.logText(drag.surface, "box-transform-commit", {
        annotationId: after.id, mode: drag.mode, handle: drag.handle,
        from: this.textGeometry(drag.before), to: this.textGeometry(after)
      });
    } else {
      this.logText(drag.surface, "box-transform-cancel", { annotationId: drag.before.id, mode: drag.mode, handle: drag.handle, reason: "unchanged" });
    }
    if (this.needsPagePaint(drag.surface.page.pageNumber)) this.renderPage(drag.surface.page.pageNumber);
  }

  private cancelTextBoxTransform(reason: string, render = true, event?: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag) return;
    drag.abort.abort();
    this.textBoxTransformDrag = null;
    setElementCssProps(drag.box, { transform: "none" });
    drag.box.classList.remove("is-transforming");
    this.logText(drag.surface, "box-transform-cancel", { annotationId: drag.before.id, mode: drag.mode, handle: drag.handle, reason });
    if (render && !this.destroyed) this.renderPage(drag.surface.page.pageNumber);
    event?.preventDefault();
  }

  private textPointerToPagePoint(surface: PageSurface, event: PointerEvent): Pick<PagePoint, "x" | "y"> {
    const viewport = this.overlayViewportFromClient(surface, event.clientX, event.clientY);
    return this.mapper(surface).toPage(viewport);
  }

  private resizeTextAnnotation(before: TextAnnotation, handle: TextBoxHandle, point: Pick<PagePoint, "x" | "y">): TextAnnotation {
    const minimumWidth = 24;
    const minimumHeight = Math.max(12, before.fontSize * 1.35);
    let left = before.x;
    let right = before.x + before.width;
    let top = before.y;
    let bottom = before.y - before.height;
    if (handle.includes("w")) left = Math.min(point.x, right - minimumWidth);
    if (handle.includes("e")) right = Math.max(point.x, left + minimumWidth);
    if (handle.includes("n")) top = Math.max(point.y, bottom + minimumHeight);
    if (handle.includes("s")) bottom = Math.min(point.y, top - minimumHeight);
    return { ...before, x: left, y: top, width: right - left, height: top - bottom };
  }

  /** Move/resize frame only; text itself reflows after the pointer is released. */
  private layoutTextBoxOutline(
    surface: PageSurface,
    outline: HTMLElement,
    annotation: TextAnnotation,
    reference: TextAnnotation
  ): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const referenceOrigin = this.mapper(surface).toViewport({ x: reference.x, y: reference.y });
    const scale = this.displayScale(surface);
    const height = Math.max(annotation.fontSize * scale * 1.4, annotation.height * scale);
    Object.assign(outline.style, {
      left: `${origin.x - referenceOrigin.x - 3}px`,
      top: `${origin.y - referenceOrigin.y - 3}px`,
      width: `${Math.max(24, annotation.width * scale) + 6}px`,
      height: `${height + 6}px`
    });
  }

  private tryStartSelectionMove(surface: PageSurface, sample: PointerSample): boolean {
    if (
      !this.selectionShape
      || this.selectionPage !== surface.page.pageNumber
      || (!this.selected.length && !this.selectedTexts.length)
    ) return false;
    const point = this.toPagePoint(surface, sample, true);
    if (!shapeContainsPoint(this.selectionShape, point)) return false;
    this.moveDrag = {
      page: surface.page.pageNumber,
      start: point,
      before: this.selected.map((stroke) => structuredClone(stroke)),
      beforeTexts: this.selectedTexts.map((text) => structuredClone(text)),
      beforeShape: structuredClone(this.selectionShape)
    };
    this.movePreview = this.moveDrag.before;
    this.moveTextPreview = this.moveDrag.beforeTexts;
    this.moveShapePreview = this.moveDrag.beforeShape;
    this.logText(surface, "selection-move-start", {
      strokeCount: this.moveDrag.before.length,
      textCount: this.moveDrag.beforeTexts.length
    });
    return true;
  }

  private translateTextAnnotations(
    texts: readonly TextAnnotation[],
    dx: number,
    dy: number,
    now = new Date().toISOString()
  ): TextAnnotation[] {
    return texts.map((text) => ({ ...text, x: text.x + dx, y: text.y + dy, updatedAt: now }));
  }

  private deleteSelection(): void {
    this.reconcileSelection();
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-delete-skipped", { reason: "empty-selection" });
      return;
    }
    const strokes = [...this.selected];
    const texts = [...this.selectedTexts];
    const page = this.selectionPage;
    this.logger.textTool("selection-delete", {
      page,
      textCount: texts.length,
      strokeCount: strokes.length
    });
    // Clear chrome state before history paint so one page-local paint has no outlines.
    this.clearSelection({ refresh: false });
    this.executeHistory({
      label: "Delete annotations",
      execute: () => {
        strokes.forEach((stroke) => this.ink.remove(stroke.id, "selection-delete"));
        texts.forEach((text) => this.texts.remove(text.id));
      },
      undo: () => {
        strokes.forEach((stroke) => this.ink.add(stroke));
        texts.forEach((text) => this.texts.add(text));
      }
    }, page);
  }

  private copySelection(): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-copy-skipped", { reason: "empty-selection" });
      return;
    }
    const sourcePage = this.selectionPage ?? this.options.adapter.getViewState().pageNumber;
    StrokeClipboard.store(this.selected, sourcePage, this.selectedTexts);
    this.pasteGeneration = 0;
    this.logger.textTool("selection-copy", {
      page: sourcePage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
  }

  private cutSelection(): void {
    this.logger.textTool("selection-cut", {
      page: this.selectionPage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
    this.copySelection();
    this.deleteSelection();
  }

  private pasteSelection(): void {
    const clipboard = StrokeClipboard.peek();
    if (!clipboard?.strokes.length && !clipboard?.texts.length) {
      this.logger.textTool("selection-paste-skipped", { reason: "empty-clipboard" });
      return;
    }
    this.pasteGeneration += 1;
    const targetPage = this.selectionPage ?? this.options.adapter.getViewState().pageNumber;
    const dx = 10 * this.pasteGeneration;
    const dy = -10 * this.pasteGeneration;
    const now = new Date().toISOString();
    const pasted = translateStrokes(clipboard.strokes, dx, dy, now).map((stroke) => ({
      ...stroke,
      id: this.id(),
      page: targetPage,
      createdAt: now
    }));
    const pastedTexts = clipboard.texts.map((text) => ({
      ...text, id: this.id(), page: targetPage, x: text.x + dx, y: text.y + dy,
      createdAt: now, updatedAt: now
    }));
    this.executeHistory({
      label: "Paste annotations",
      execute: () => { pasted.forEach((stroke) => this.ink.add(stroke)); pastedTexts.forEach((text) => this.texts.add(text)); },
      undo: () => { pasted.forEach((stroke) => this.ink.remove(stroke.id, "history-undo-paste")); pastedTexts.forEach((text) => this.texts.remove(text.id)); }
    }, targetPage);
    this.selected = pasted;
    this.selectedTexts = pastedTexts;
    this.selectionPage = targetPage;
    this.selectionShape = boundingShapeFromSelection(pasted, pastedTexts);
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.logger.textTool("selection-paste", {
      sourcePage: clipboard.sourcePage,
      targetPage,
      textCount: pastedTexts.length,
      strokeCount: pasted.length,
      generation: this.pasteGeneration,
      dx,
      dy
    });
    this.refresh("paste-selection");
  }

  private duplicateSelection(): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-duplicate-skipped", { reason: "empty-selection" });
      return;
    }
    const duplicates = translateStrokes(this.selected, 10, -10).map((stroke) => ({ ...stroke, id: this.id() }));
    const now = new Date().toISOString();
    const textDuplicates = this.selectedTexts.map((text) => ({ ...text, id: this.id(), x: text.x + 10, y: text.y - 10, createdAt: now, updatedAt: now }));
    const command: Command = {
      label: "Duplicate annotations",
      execute: () => { duplicates.forEach((stroke) => this.ink.add(stroke)); textDuplicates.forEach((text) => this.texts.add(text)); },
      undo: () => { duplicates.forEach((stroke) => this.ink.remove(stroke.id, "history-undo-duplicate")); textDuplicates.forEach((text) => this.texts.remove(text.id)); }
    };
    this.executeHistory(command, this.selectionPage);
    this.selected = duplicates;
    this.selectedTexts = textDuplicates;
    this.selectionShape = boundingShapeFromSelection(duplicates, textDuplicates);
    this.ensureSelectionToolbar();
    this.logger.textTool("selection-duplicate", {
      page: this.selectionPage,
      textCount: textDuplicates.length,
      strokeCount: duplicates.length,
      dx: 10,
      dy: -10
    });
  }

  private recolorSelection(color: string): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-recolor-skipped", { reason: "empty-selection", color });
      return;
    }
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, color, updatedAt: now }));
    const textAfter = this.selectedTexts.map((text) => ({
      ...text,
      color,
      runs: text.runs.map((run) => ({ ...run, color })),
      sourceRuns: text.sourceRuns.map((run) => ({ ...run, color })),
      updatedAt: now
    }));
    const beforeStrokes = [...this.selected];
    const beforeTexts = [...this.selectedTexts];
    this.executeHistory({
      label: "Recolor annotations",
      execute: () => { after.forEach((stroke) => this.ink.replace(stroke)); textAfter.forEach((text) => this.texts.replace(text)); },
      undo: () => { beforeStrokes.forEach((stroke) => this.ink.replace(stroke)); beforeTexts.forEach((text) => this.texts.replace(text)); }
    }, this.selectionPage);
    this.selected = after;
    this.selectedTexts = textAfter;
    this.logger.textTool("selection-recolor", {
      page: this.selectionPage,
      color,
      textCount: textAfter.length,
      strokeCount: after.length
    });
  }

  private selectAllOnCurrentPage(): void {
    const pageNumber = this.options.adapter.getViewState().pageNumber;
    const surface = this.surfaces.get(pageNumber);
    const pageStrokes = this.ink.page(pageNumber);
    const pageTexts = this.texts.page(pageNumber);
    if (!surface || (!pageStrokes.length && !pageTexts.length)) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, empty: true });
      this.logger.textTool("selection-select-all-empty", { page: pageNumber, reason: "page-empty-or-unavailable" });
      return;
    }
    const layout = this.pageLayout(surface);
    const mapper = this.mapper(surface);
    const selected = filterSelectableStrokes(
      pageStrokes,
      layout.pdfWidth,
      layout.pdfHeight,
      layout.scale,
      layout.contentWidth,
      layout.contentHeight,
      (point) => mapper.toViewport(point)
    );
    if (!selected.length && !pageTexts.length) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, filtered: true });
      this.logger.textTool("selection-select-all-empty", { page: pageNumber, reason: "strokes-filtered" });
      return;
    }
    this.selected = selected;
    this.selectedTexts = [...pageTexts];
    this.selectionShape = boundingShapeFromSelection(selected, pageTexts);
    this.selectionPage = pageNumber;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.logger.textTool("selection-select-all", {
      page: pageNumber,
      textCount: pageTexts.length,
      strokeCount: selected.length,
      availableStrokeCount: pageStrokes.length
    });
    this.refresh("select-all");
  }

  private clearSelection(options: { refresh?: boolean } = {}): void {
    const textCount = this.selectedTexts.length;
    const strokeCount = this.selected.length;
    const page = this.selectionPage;
    this.selected = [];
    this.selectedTexts = [];
    this.selectionShape = null;
    this.selectionPage = null;
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.selectionToolbar.hide();
    if (textCount) this.logger.textTool("selection-clear", { page, textCount, strokeCount });
    if (options.refresh !== false) this.paintAfterClearSelection(page);
  }

  /** Drop selection chrome without a full multipage ink invalidate. */
  private paintAfterClearSelection(page: number | null): void {
    this.logger.refresh("clear-selection", {
      selected: 0,
      surfaces: this.surfaces.size,
      page,
      pages: page != null && this.surfaces.has(page) ? 1 : 0,
      pageLocal: true
    });
    if (page != null) {
      const surface = this.surfaces.get(page);
      if (surface) {
        this.invalidateInkLayer(surface, { preserveDeferredRaster: true });
        this.renderPage(page);
        this.renderTextAnnotations(surface);
      }
    }
    this.syncAnnotationCursorMode();
    this.refreshSurfaceCursors();
  }

  private reconcileSelection(): void {
    if ((!this.selected.length && !this.selectedTexts.length) || this.selectionPage === null) return;
    const pageStrokes = this.ink.page(this.selectionPage);
    const byId = new Map(pageStrokes.map((stroke) => [stroke.id, stroke]));
    const synced = this.selected
      .map((stroke) => byId.get(stroke.id))
      .filter((stroke): stroke is InkStroke => stroke !== undefined);
    const textById = new Map(this.texts.page(this.selectionPage).map((text) => [text.id, text]));
    const syncedTexts = this.selectedTexts
      .map((text) => textById.get(text.id))
      .filter((text): text is TextAnnotation => text !== undefined);
    if (!synced.length && !syncedTexts.length) {
      const selectedTextCount = this.selectedTexts.length;
      const selectedStrokeCount = this.selected.length;
      const page = this.selectionPage;
      this.selected = [];
      this.selectedTexts = [];
      this.selectionShape = null;
      this.selectionPage = null;
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      this.selectionToolbar.hide();
      if (selectedTextCount) {
        this.logger.textTool("selection-reconciled-empty", {
          page,
          previousTextCount: selectedTextCount,
          previousStrokeCount: selectedStrokeCount
        });
      }
      return;
    }
    const strokesChanged = synced.length !== this.selected.length || synced.some((stroke, index) => stroke !== this.selected[index]);
    if (strokesChanged) this.selected = synced;
    if (syncedTexts.length !== this.selectedTexts.length || syncedTexts.some((text, index) => text !== this.selectedTexts[index])) {
      this.logger.textTool("selection-reconciled", {
        page: this.selectionPage,
        previousTextCount: this.selectedTexts.length,
        textCount: syncedTexts.length
      });
    }
    this.selectedTexts = syncedTexts;
    if (!this.selectionShape || this.selectionShape.type === "rectangle") {
      this.selectionShape = boundingShapeFromSelection(this.selected, this.selectedTexts);
    }
  }

  private invalidateInkLayer(surface: PageSurface, options: { preserveDeferredRaster?: boolean } = {}): void {
    const preserveDeferredRaster = options.preserveDeferredRaster === true
      && Boolean(surface.inkLayer && surface.inkLayer.width > 0 && surface.inkLayer.height > 0)
      && (surface.rasterFallbackReady || surface.inkLayerBurstCapture);
    if (surface.deferredCanonicalPaintFrame !== null && !preserveDeferredRaster) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(surface.deferredCanonicalPaintFrame);
      surface.deferredCanonicalPaintFrame = null;
    }
    if (!preserveDeferredRaster) surface.deferredCanonicalPaint = null;
    surface.inkLayerValid = false;
    surface.inkLayerBackingScale = null;
    surface.inkLayerBurstCapture = preserveDeferredRaster;
    surface.inkLayerRevision = null;
    surface.rasterFallbackReady = preserveDeferredRaster;
    if (preserveDeferredRaster) surface.settleUpgradePending = true;
    this.renderEpoch += 1;
  }

  private invalidateInkLayers(): void {
    for (const surface of this.surfaces.values()) this.invalidateInkLayer(surface);
  }

  private ensureInkLayer(
    surface: PageSurface,
    pixelWidth: number,
    pixelHeight: number,
    backingScale: number
  ): CanvasRenderingContext2D {
    if (!surface.inkLayer || !surface.inkLayerContext) {
      surface.inkLayer = createDetachedEl(surface.overlay.ownerDocument, 'canvas');
      surface.inkLayerContext = surface.inkLayer.getContext("2d");
      if (!surface.inkLayerContext) throw new Error("Canvas 2D rendering is unavailable");
      surface.inkLayerValid = false;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = false;
    }
    if (surface.inkLayer.width !== pixelWidth || surface.inkLayer.height !== pixelHeight) {
      surface.inkLayer.width = pixelWidth;
      surface.inkLayer.height = pixelHeight;
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = false;
    }
    surface.inkLayerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    return surface.inkLayerContext;
  }

  /** Warm inkLayer from main canvas before zoom burst CSS-stretch. */
  private captureInkLayerFromCanvas(surface: PageSurface, layoutOverride?: PageCoordinateLayout): void {
    const pageRevision = this.ink.pageRevision(surface.page.pageNumber);
    if (
      surface.inkLayerValid
      && surface.inkLayer
      && surface.inkLayer.width === surface.canvas.width
      && surface.inkLayer.height === surface.canvas.height
      && surface.inkLayerRevision === pageRevision
    ) return;
    if (!surface.canvas.width || !surface.canvas.height) return;
    const traceStartedAt = this.zoomPipelineTrace.isActive() ? performance.now() : null;
    const layout = layoutOverride ?? this.pageLayout(surface);
    const width = Math.max(1, layout.contentWidth || 1);
    const height = Math.max(1, layout.contentHeight || 1);
    const { backingScale } = this.resolveInkBacking(width, height);
    const layerContext = this.ensureInkLayer(surface, surface.canvas.width, surface.canvas.height, backingScale);
    layerContext.setTransform(1, 0, 0, 1, 0, 0);
    layerContext.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    layerContext.imageSmoothingEnabled = false;
    layerContext.drawImage(surface.canvas, 0, 0);
    if (this.zoomProfile) {
      this.zoomProfile.bitmapBlits += 1;
      this.zoomProfile.inkLayerCaptures += 1;
    }
    layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    surface.inkLayerValid = true;
    surface.inkLayerRevision = pageRevision;
    // Raster warm — must not satisfy blit-only settle (needs vector restamp).
    surface.inkLayerBurstCapture = true;
    surface.rasterFallbackReady = false;
    surface.inkLayerBackingScale = null;
    if (traceStartedAt !== null) {
      this.zoomPipelineTrace.noteStage("ink-capture", performance.now() - traceStartedAt, 1, "ink-layer-capture");
    }
  }

  /** Copy committed bitmap before canvas/layer resize clears pixels. */
  private snapshotCommittedBitmap(surface: PageSurface): HTMLCanvasElement | null {
    const src = surface.inkLayerValid && surface.inkLayer
      ? surface.inkLayer
      : surface.canvas;
    if (!src.width || !src.height) return null;
    const snap = createDetachedEl(surface.overlay.ownerDocument, 'canvas');
    snap.width = src.width;
    snap.height = src.height;
    const ctx = snap.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0);
    return snap;
  }

  private blitInkLayerToCanvas(
    surface: PageSurface,
    pixelWidth: number,
    pixelHeight: number,
    backingScale: number
  ): void {
    if (!surface.inkLayer) return;
    const traceStartedAt = this.zoomPipelineTrace.isActive() ? performance.now() : null;
    if (this.zoomProfile) {
      this.zoomProfile.bitmapBlits += 1;
      this.zoomProfile.inkLayerBlits += 1;
    }
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, pixelWidth, pixelHeight);
    surface.context.imageSmoothingEnabled = false;
    surface.context.drawImage(
      surface.inkLayer,
      0,
      0,
      surface.inkLayer.width,
      surface.inkLayer.height,
      0,
      0,
      pixelWidth,
      pixelHeight
    );
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    if (traceStartedAt !== null) {
      this.zoomPipelineTrace.noteStage("ink-blit", performance.now() - traceStartedAt, 1, "ink-layer-blit");
    }
  }

  /** Copy only changed canonical pixels into the visible canvas. */
  private blitInkLayerRegionsToCanvas(
    surface: PageSurface,
    regions: readonly Bounds[],
    pixelWidth: number,
    pixelHeight: number,
    backingScale: number
  ): number {
    if (!surface.inkLayer || regions.length === 0) return 0;
    const context = surface.context;
    const maxWidth = Math.max(0, pixelWidth);
    const maxHeight = Math.max(0, pixelHeight);
    let copiedPixels = 0;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    for (const region of regions) {
      const left = Math.max(0, Math.floor(region.minX * backingScale) - 2);
      const top = Math.max(0, Math.floor(region.minY * backingScale) - 2);
      const right = Math.min(maxWidth, Math.ceil(region.maxX * backingScale) + 2);
      const bottom = Math.min(maxHeight, Math.ceil(region.maxY * backingScale) + 2);
      if (right <= left || bottom <= top) continue;
      const width = right - left;
      const height = bottom - top;
      context.clearRect(left, top, width, height);
      context.drawImage(surface.inkLayer, left, top, width, height, left, top, width, height);
      copiedPixels += width * height;
    }
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    return copiedPixels;
  }

  private strokeDamageBounds(surface: PageSurface, stroke: InkStroke): Bounds {
    // The active stroke has already accumulated raw page bounds as pointer
    // samples arrived. Reusing them avoids another full-path scan (and the
    // spread-based Math.min/Math.max stack cost) on pointer-up.
    const rawBounds = surface.liveDrawPageBounds;
    const halfWidth = stroke.width / 2;
    const bounds = rawBounds
      ? {
        minX: rawBounds.minX - halfWidth,
        minY: rawBounds.minY - halfWidth,
        maxX: rawBounds.maxX + halfWidth,
        maxY: rawBounds.maxY + halfWidth
      }
      : strokeBounds(stroke);
    const mapper = this.mapper(surface);
    const corners = [
      mapper.toViewport({ x: bounds.minX, y: bounds.minY }),
      mapper.toViewport({ x: bounds.maxX, y: bounds.minY }),
      mapper.toViewport({ x: bounds.minX, y: bounds.maxY }),
      mapper.toViewport({ x: bounds.maxX, y: bounds.maxY })
    ];
    const padding = Math.max(2, stroke.width * this.displayScale(surface) / 2 + 2);
    return {
      minX: Math.min(...corners.map((point) => point.x)) - padding,
      minY: Math.min(...corners.map((point) => point.y)) - padding,
      maxX: Math.max(...corners.map((point) => point.x)) + padding,
      maxY: Math.max(...corners.map((point) => point.y)) + padding
    };
  }

  /** Durable proof that the final zoom surface is canonical, PDF-space ink. */
  private logZoomInkRenderer(
    pageNumber: number,
    phase: "settle-canonical",
    renderer: "canonical-pdf-space",
    strokes: readonly InkStroke[]
  ): void {
    const tools: Record<string, number> = {};
    for (const stroke of strokes) tools[stroke.tool] = (tools[stroke.tool] ?? 0) + 1;
    this.logger.inkRenderer(pageNumber, {
      phase: `zoom-${phase}`,
      renderer,
      strokeCount: strokes.length,
      tools,
      coordinateSpace: renderer === "canonical-pdf-space" ? "pdf" : "viewport-bitmap"
    });
  }

  private paintCommittedStrokes(
    surface: PageSurface,
    context: CanvasRenderingContext2D,
    strokes: readonly InkStroke[],
    stats?: { strokesRedrawn: number }
  ): void {
    if (this.zoomProfile) this.zoomProfile.vectorRepaints += 1;
    if (surface.strokePerformance) surface.strokePerformance.vectorRepaints += 1;
    const previous = surface.context;
    surface.context = context;
    const targetCanvas = context === surface.inkLayerContext && surface.inkLayer ? surface.inkLayer : surface.canvas;
    try {
      for (const stroke of strokes) {
        const drawn = this.movePreview?.find((item) => item.id === stroke.id) ?? stroke;
        this.beginStrokePixelEvidence(surface, stroke, targetCanvas, context);
        // Selection chrome is painted on its disposable overlay. Keeping the
        // canonical layer free of blue selection pixels lets a tool change
        // clear chrome without repainting every committed stroke.
        this.drawStroke(surface, drawn, false);
        this.recordStrokeRendered(surface, stroke);
        this.finishStrokePixelEvidence(surface, stroke, targetCanvas, context);
      }
    } finally {
      surface.context = previous;
    }
    if (stats) stats.strokesRedrawn += strokes.length;
  }

  private renderPage(
    pageNumber: number,
    stats?: {
      canvasesResized: number;
      strokesRedrawn: number;
      skippedBlitOnly?: number;
    },
    reason = "",
    syncText = true,
    includeActivePreview = true,
    rootRect?: DOMRect
  ): boolean {
    const surface = this.surfaces.get(pageNumber);
    if (!surface || (this.zoomCompositing && !reason.startsWith("post-zoom"))) return false;
    if (surface.wetPreviewUsesCommittedCanvas) this.endWetPreview(surface);
    if (reason.includes("settle-upgrade") && surface.strokePerformance) surface.strokePerformance.hqUpgrades += 1;
    const preserveLiveDraft = this.surfaceHasLiveInkInput(surface);
    // Keep tip draft visible through resize/paint — clearing first caused a blank
    // flash between tip-up and settle-paint (draft gone, committed still building).
    const layout = this.pageLayout(surface);
    const marginMode = ViewerInkSession.isZoomPaintReason(reason) ? "strict" : "idle";
    if (this.shouldCullPagePaint(surface, includeActivePreview, marginMode, rootRect)) {
      surface.viewportCullPending = true;
      return false;
    }
    // The viewport decision is a read phase. Apply the cached layout only
    // after culling so the next geometry read cannot follow this write.
    this.syncOverlayLayout(surface, layout);
    const width = Math.max(1, layout.contentWidth || 1);
    const height = Math.max(1, layout.contentHeight || 1);
    if (width < 2 || height < 2) return false;
    const settleNeighbor = reason.includes("settle-neighbor");
    const settleFocusFast = reason.includes("settle-focus-fast");
    const settleCheap = settleNeighbor || settleFocusFast;
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(
      width,
      height,
      settleNeighbor ? "neighbor" : "full"
    );
    const paintGeneration = ++this.nextPaintGeneration;
    surface.paintGeneration = paintGeneration;
    const needsResize = surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight;
    if (needsResize && surface.strokePerformance) surface.strokePerformance.canvasResizes += 1;
    const canBlit = typeof surface.context.drawImage === "function";
    const zoomish = ViewerInkSession.isZoomPaintReason(reason);
    const erasingLive = includeActivePreview
      && surface.editTool === "eraser"
      && surface.eraserSize !== undefined
      && surface.editPath.length > 0;
    const movingSelection = Boolean(this.movePreview?.length);
    const livePreview = includeActivePreview && (Boolean(surface.builder?.preview().length)
      || (surface.editTool === "lasso" && surface.editPath.length > 0)
      || Boolean(this.selectionShape && this.selectionPage === pageNumber));
    const canUseBurstRasterPreview = !needsResize
      && canBlit
      && surface.inkLayerBurstCapture
      && surface.inkLayer
      && surface.inkLayer.width === pixelWidth
      && surface.inkLayer.height === pixelHeight
      && surface.settleUpgradePending
      && !erasingLive
      && !movingSelection;
    const shouldPaintBurstRasterPreview = canUseBurstRasterPreview
      && ((reason === "live-edit" && livePreview)
        || (reason === "render" && !livePreview)
        || (reason.includes("settle-focus") && !reason.includes("settle-focus-fast") && !livePreview));
    if (shouldPaintBurstRasterPreview) {
      const previewStartedAt = performance.now();
      surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
      const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
      if (drawingLasso) this.renderLiveLassoPreview(surface);
      else this.renderSelectionChrome(surface);
      this.paintLaserTrails(surface, pageNumber);
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: "burst-raster-preview" });
      this.logger.renderProfile({
        page: pageNumber,
        operation: "page-raster-preview",
        reason,
        durationMs: roundMetric(performance.now() - previewStartedAt),
        strokeCount: this.ink.page(pageNumber).length,
        deferredCanonicalUpgrade: true,
        rasterSource: "burst-ink-layer",
        useLayerCache: true,
        visiblePageCount: this.surfaces.size
      });
      return true;
    }
    // Focus-fast and neighbor settle stay on the compositor stretch while the
    // handoff is held. Reuse the captured layer at the existing backing size
    // and defer the one required final-resolution resize to the queued upgrade.
    const cssStretchSettle = settleCheap
      && surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")
      && this.isZoomHandoffActive()
      && surface.canvas.width > 0
      && surface.canvas.height > 0
      && surface.inkLayerValid
      && Boolean(surface.inkLayer)
      && !erasingLive
      && !movingSelection
      && !livePreview
      && (needsResize || surface.inkLayerBurstCapture || surface.inkLayerBackingScale === null);
    if (cssStretchSettle) {
      // Resize the visible backing at settle so the first frame tracks the
      // native PDF canvas. The captured ink layer remains the source while
      // the queued focus upgrade restores canonical PDF-space pixels.
      if (needsResize) {
        surface.canvas.width = pixelWidth;
        surface.canvas.height = pixelHeight;
        surface.liveDrawPaintedPoints = 0;
        if (this.zoomProfile) this.zoomProfile.canvasResizes += 1;
        if (surface.strokePerformance) surface.strokePerformance.canvasResizes += 1;
        if (stats) stats.canvasesResized += 1;
      }
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
      surface.settleUpgradePending = true;
      surface.viewportCullPending = false;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      return true;
    }
    // pages-dom storms + idle zoomed pages: layout sync only — skip giant canvas blit.
    if (
      !needsResize
      && surface.inkLayerValid
      && !erasingLive
      && !movingSelection
      && !livePreview
      && (
        reason.includes("pages-sync")
        || reason.includes("pages-reattach")
        || reason.includes("native-content-reattach")
      )
    ) {
      return false;
    }

    // Zoom settle with unchanged backing + canonical layer: blit only (no stroke restamp).
    // Never for handoff-final or burst-captured raster layers (backingScale must match).
    const blitOnlySettle = zoomish
      && !reason.includes("handoff-final")
      && !settleNeighbor
      && !needsResize
      && canBlit
      && surface.inkLayerValid
      && Boolean(surface.inkLayer)
      && surface.inkLayer!.width === pixelWidth
      && surface.inkLayer!.height === pixelHeight
      && surface.inkLayerBackingScale !== null
      && Math.abs(surface.inkLayerBackingScale - backingScale) < 1e-6
      && !surface.inkLayerBurstCapture
      && !erasingLive
      && !movingSelection
      && !livePreview;
    if (blitOnlySettle) {
      surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      surface.settleUpgradePending = false;
      if (stats && stats.skippedBlitOnly !== undefined) stats.skippedBlitOnly += 1;
      if (reason.includes("settle")) {
        const settledStrokes = this.ink.pageIntersecting(pageNumber, this.pageInkBounds(surface));
        this.recordStrokeZoomSettleCheck(surface, settledStrokes, settledStrokes, reason);
      }
      const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
      if (drawingLasso) this.renderLiveLassoPreview(surface);
      else this.renderSelectionChrome(surface);
      this.paintLaserTrails(surface, pageNumber);
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      return true;
    }

    // Focus-fast with unchanged backing but non-canonical layer: keep pixels, queue HQ.
    if (
      settleFocusFast
      && !needsResize
      && !erasingLive
      && !movingSelection
      && !livePreview
    ) {
      surface.settleUpgradePending = !surface.inkLayerValid || surface.inkLayerBurstCapture
        || surface.inkLayerBackingScale === null
        || Math.abs((surface.inkLayerBackingScale ?? 0) - backingScale) >= 1e-6;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      return true;
    }

    const paintStarted = performance.now();
    const renderPhaseDurations: Record<string, number> = {};
    const recordRenderPhase = (phase: string, startedAt: number): void => {
      renderPhaseDurations[phase] = roundMetric(performance.now() - startedAt);
    };
    const previousPaint = this.lastPagePaintAt.get(pageNumber);
    if (
      previousPaint
      && paintStarted - previousPaint.at < ViewerInkSession.FLASH_DOUBLE_PAINT_MS
      && this.isZoomHandoffActive()
    ) {
      this.logger.zoomFlashProxy("double-paint-window", {
        page: pageNumber,
        reasons: [previousPaint.reason, reason || "render"],
        gapMs: roundMs(paintStarted - previousPaint.at)
      });
    }

    let scaledBlit: HTMLCanvasElement | null = null;
    // Focus HQ / handoff: vector-restamp. Focus-fast already resized the canvas, so HQ
    // must still count as canonical even when needsResize is false on the deferred frame.
    const settleFocusHq = reason.includes("settle-focus") && !settleFocusFast;
    const canonicalZoomSettle = zoomish
      && (needsResize || reason.includes("handoff-final") || settleFocusHq)
      && !settleCheap;
    const largeZoomRasterFallback = canonicalZoomSettle
      && surface.inkLayerValid
      && !surface.inkLayerBurstCapture
      && this.ink.page(pageNumber).length >= ViewerInkSession.LARGE_ZOOM_RASTER_FALLBACK_STROKES;
    if (needsResize && canBlit && (!canonicalZoomSettle || largeZoomRasterFallback)) {
      const snapshotStartedAt = performance.now();
      scaledBlit = this.snapshotCommittedBitmap(surface);
      recordRenderPhase("bitmap-snapshot", snapshotStartedAt);
    }

    if (needsResize) {
      const resizeStartedAt = performance.now();
      this.recordStrokeCanvasRebuild(surface, reason || "render");
      if (this.zoomProfile) this.zoomProfile.canvasResizes += 1;
      surface.canvas.width = pixelWidth;
      surface.canvas.height = pixelHeight;
      // Cheap settle skips draft warm (~45MP alloc). HQ / normal paints warm it.
      if (!settleCheap) {
        if (surface.draftCanvas.width !== pixelWidth || surface.draftCanvas.height !== pixelHeight) {
          surface.draftCanvas.width = pixelWidth;
          surface.draftCanvas.height = pixelHeight;
          surface.liveDrawPaintedPoints = 0;
        }
      } else {
        surface.liveDrawPaintedPoints = 0;
      }
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = false;
      if (stats) stats.canvasesResized += 1;
      recordRenderPhase("canvas-resize", resizeStartedAt);
    }
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);

    // Non-zoom resize keeps a bitmap fallback. Large zoom settles may also use
    // the captured layer for the release frame; the existing settle-upgrade
    // queue then restores canonical vector ink without blocking pointer release.
    const rasterZoomFallback = canonicalZoomSettle && largeZoomRasterFallback && Boolean(scaledBlit);
    if (scaledBlit && (!canonicalZoomSettle || rasterZoomFallback)) {
      const fallbackBlitStartedAt = performance.now();
      surface.context.setTransform(1, 0, 0, 1, 0, 0);
      surface.context.clearRect(0, 0, pixelWidth, pixelHeight);
      surface.context.imageSmoothingEnabled = false;
      surface.context.drawImage(
        scaledBlit,
        0,
        0,
        scaledBlit.width,
        scaledBlit.height,
        0,
        0,
        pixelWidth,
        pixelHeight
      );
      surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      recordRenderPhase("bitmap-blit", fallbackBlitStartedAt);
    }

    if (rasterZoomFallback && scaledBlit) {
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = true;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = true;
      surface.settleUpgradePending = true;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      this.logger.renderProfile({
        page: pageNumber,
        operation: "page-raster-fallback",
        reason: reason || "render",
        durationMs: roundMetric(performance.now() - paintStarted),
        pageRevision: this.ink.pageRevision(pageNumber),
        cachedLayerRevision: null,
        strokeCount: this.ink.page(pageNumber).length,
        canvasResized: needsResize,
        canvasResizeCount: needsResize ? 1 : 0,
        vectorRepaintCount: 0,
        useLayerCache: true,
        includeActivePreview,
        zoomCompositing: this.zoomCompositing,
        visiblePageCount: this.surfaces.size,
        deferredCanonicalUpgrade: true
      });
      return true;
    }

    // A scale change can require a canonical settle even when the backing
    // dimensions stay the same. Keep the already-captured dense raster for the
    // release frame in that case; the queued settle upgrade restores vector
    // pixels after the compositor is no longer holding the interaction.
    const sameSizeRasterZoomFallback = shouldUseDenseZoomRasterFallback({
      canonicalZoomSettle,
      strokeCount: this.ink.page(pageNumber).length,
      needsResize,
      canBlit,
      layerValid: surface.inkLayerValid,
      layerMatchesBacking: Boolean(
        surface.inkLayer
        && surface.inkLayer.width === pixelWidth
        && surface.inkLayer.height === pixelHeight
      ),
      erasingLive,
      movingSelection,
      livePreview
    });
    if (sameSizeRasterZoomFallback) {
      const cachedLayerRevision = surface.inkLayerRevision;
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = true;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = true;
      surface.settleUpgradePending = true;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      this.logger.renderProfile({
        page: pageNumber,
        operation: "page-raster-fallback",
        reason: reason || "render",
        durationMs: roundMetric(performance.now() - paintStarted),
        pageRevision: this.ink.pageRevision(pageNumber),
        cachedLayerRevision,
        strokeCount: this.ink.page(pageNumber).length,
        canvasResized: false,
        canvasResizeCount: 0,
        vectorRepaintCount: 0,
        useLayerCache: true,
        includeActivePreview,
        zoomCompositing: this.zoomCompositing,
        visiblePageCount: this.surfaces.size,
        deferredCanonicalUpgrade: true
      });
      return true;
    }

    // Cheap settle under CSS mask: keep blit-stretch only; HQ upgrades on later rAF/idle.
    if (settleCheap && scaledBlit) {
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = true;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = true;
      surface.settleUpgradePending = true;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      const drawingLassoNeighbor = surface.editTool === "lasso" && surface.editPath.length > 0;
      if (drawingLassoNeighbor) this.renderLiveLassoPreview(surface);
      else this.renderSelectionChrome(surface);
      this.paintLaserTrails(surface, pageNumber);
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      return true;
    }

    const strokeQueryStartedAt = performance.now();
    const storedStrokes = this.ink.pageIntersecting(pageNumber, this.pageInkBounds(surface));
    const visibleStrokes = erasingLive
      ? (surface.eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes)(storedStrokes, surface.editPath, surface.eraserSize!).kept
      : storedStrokes;
    recordRenderPhase("stroke-query", strokeQueryStartedAt);
    this.recordStrokeRenderOmissions(
      surface,
      storedStrokes,
      visibleStrokes,
      erasingLive ? "live-eraser-filter" : "page-paint-set",
      !erasingLive
    );
    this.recordStrokeZoomSettleCheck(surface, storedStrokes, visibleStrokes, reason);

    const useLayerCache = canBlit && !erasingLive && !movingSelection;
    if (useLayerCache) {
      const layerContext = this.ensureInkLayer(surface, pixelWidth, pixelHeight, backingScale);
      const pageRevision = this.ink.pageRevision(pageNumber);
      const canonicalLayerRepaint = canonicalZoomSettle
        && (surface.inkLayerBurstCapture || surface.inkLayerRevision !== pageRevision);
      if (surface.deferredCanonicalPaint && reason === "settle-upgrade") {
        this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: "settle-upgrade-deferred" });
        return true;
      }
      const canChunkCanonicalUpgrade = reason === "settle-upgrade"
        && surface.rasterFallbackReady
        && surface.settleUpgradePending
        && surface.inkLayerBurstCapture
        && visibleStrokes.length >= ViewerInkSession.DEFERRED_CANONICAL_CHUNK_STROKES;
      if (canChunkCanonicalUpgrade) {
        layerContext.clearRect(0, 0, width, height);
        surface.inkLayerValid = false;
        surface.inkLayerBackingScale = backingScale;
        surface.inkLayerBurstCapture = true;
        surface.inkLayerRevision = pageRevision;
        surface.deferredCanonicalPaint = {
          strokes: visibleStrokes,
          nextIndex: 0,
          pageRevision,
          backingScale,
          pixelWidth,
          pixelHeight,
          width,
          height,
          startedAt: performance.now()
        };
        this.scheduleDeferredCanonicalPaint(surface);
        this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: "settle-upgrade-deferred" });
        surface.viewportCullPending = false;
        if (syncText) this.renderTextAnnotations(surface);
        return true;
      }
      if (!surface.inkLayerValid || canonicalLayerRepaint) {
        const layerPaintStartedAt = performance.now();
        layerContext.clearRect(0, 0, width, height);
        this.paintCommittedStrokes(surface, layerContext, visibleStrokes, stats);
        recordRenderPhase("layer-paint", layerPaintStartedAt);
        surface.inkLayerValid = true;
        surface.inkLayerBackingScale = backingScale;
        surface.inkLayerBurstCapture = false;
        surface.inkLayerRevision = pageRevision;
        surface.rasterFallbackReady = false;
        if (canonicalZoomSettle) {
          this.logZoomInkRenderer(pageNumber, "settle-canonical", "canonical-pdf-space", visibleStrokes);
        }
      }
      const layerBlitStartedAt = performance.now();
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
      recordRenderPhase("layer-blit", layerBlitStartedAt);
    } else {
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
      surface.inkLayerRevision = null;
      surface.rasterFallbackReady = false;
      const directPaintStartedAt = performance.now();
      surface.context.clearRect(0, 0, width, height);
      this.paintCommittedStrokes(surface, surface.context, visibleStrokes, stats);
      recordRenderPhase("direct-paint", directPaintStartedAt);
      if (canonicalZoomSettle) {
        this.logZoomInkRenderer(pageNumber, "settle-canonical", "canonical-pdf-space", visibleStrokes);
      }
    }

    this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
    surface.viewportCullPending = false;
    surface.settleUpgradePending = false;

    // Lasso/selection chrome is painted on the ink canvas (under the text layer
    // by default). Selection/lasso chrome lives on its disposable canvas so a
    // tool change can hide the blue overlay without repainting committed ink.
    const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
    if (drawingLasso) this.renderLiveLassoPreview(surface);
    else this.renderSelectionChrome(surface);
    if (includeActivePreview && surface.builder?.preview().length) {
      if (surface.laserDraft) {
        const laser = this.options.settings.toolPreferences.laser;
        this.paintLaserPoints(
          surface,
          surface.builder.preview(true),
          laser.color,
          laser.width,
          laser.opacity,
          laser.holdMs,
          laser.fadeMs
        );
      } else if (!preserveLiveDraft) {
        // Live freehand already owns draftCanvas — drawing onto the committed
        // canvas here doubles ink and fights incremental draft stamps.
        const draft = surface.builder.style;
        const draftId = surface.builder.id;
        this.drawPoints(
          surface,
          surface.shapePreview ?? surface.builder.preview(this.simplifyStrokesEnabled()),
          draft.color,
          draft.width,
          draft.opacity,
          draft.tool,
          false,
          draftId
        );
      } else {
        // Canvas/backing may have changed under the tip — rebuild draft once.
        surface.liveDrawPaintedPoints = 0;
        this.renderLiveDrawPreview(surface);
      }
    }
    const laserStartedAt = performance.now();
    this.paintLaserTrails(surface, pageNumber);
    recordRenderPhase("laser-trails", laserStartedAt);
    const textStartedAt = performance.now();
    if (syncText) this.renderTextAnnotations(surface);
    recordRenderPhase("text-layout", textStartedAt);
    const clearPreviewStartedAt = performance.now();
    if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
    recordRenderPhase("preview-clear", clearPreviewStartedAt);
    const renderCompletedAt = performance.now();
    const profile = surface.strokePerformance;
    this.noteStrokeCanvasCommit(surface, renderCompletedAt, paintStarted);
    if (profile) this.schedulePaintAcknowledgement(surface, renderCompletedAt, profile);
    const renderDurationMs = roundMetric(renderCompletedAt - paintStarted);
    this.logger.renderProfile({
      page: pageNumber,
      operation: "page-render",
      reason: reason || "render",
      operationCount: 1,
      totalMs: renderDurationMs,
      maxDurationMs: renderDurationMs,
      durationMs: renderDurationMs,
      pageRevision: this.ink.pageRevision(pageNumber),
      cachedLayerRevision: surface.inkLayerRevision,
      committedCanvasWetHidden: surface.canvas.classList.contains("is-wet-hidden"),
      wetPreviewActive: surface.wetPreviewActive,
      strokeCount: visibleStrokes.length,
      canvasResized: needsResize,
      canvasResizeCount: needsResize ? 1 : 0,
      vectorRepaintCount: useLayerCache ? 0 : 1,
      hqUpgradeCount: reason.includes("settle-upgrade") ? 1 : 0,
      backingScale: roundMetric(backingScale),
      width: roundMetric(width),
      height: roundMetric(height),
      useLayerCache,
      includeActivePreview,
      zoomCompositing: this.zoomCompositing,
      visiblePageCount: this.surfaces.size,
      phaseDurations: renderPhaseDurations
    });
    return true;
  }

  /** HN paints whole PDF-page canvases; cull pages, never partial canvas regions. */
  private shouldCullPagePaint(
    surface: PageSurface,
    includeActivePreview: boolean,
    marginMode: "idle" | "strict" = "idle",
    rootRect?: DOMRect
  ): boolean {
    if (includeActivePreview && (surface.builder || surface.editPath.length > 0)) return false;
    if (this.selectionPage === surface.page.pageNumber) return false;
    return !this.surfaceNearViewport(surface, marginMode, rootRect);
  }

  /**
   * Pages eligible for active pinch work: the current viewport plus the
   * existing idle-margin policy. Page replacement recovery, selection chrome,
   * and live input remain explicit safety exceptions; all other pages are
   * deferred to the post-handoff viewport painter.
   */
  private zoomWorkingSurfaces(
    rootRect?: DOMRect,
    pages?: ReadonlyMap<number, AnnotationPageInfo>
  ): PageSurface[] {
    const root = rootRect ?? this.options.adapter.root.getBoundingClientRect();
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const working: PageSurface[] = [];
    for (const surface of this.surfaces.values()) {
      const livePage = pages?.get(surface.page.pageNumber);
      const needsRecovery = Boolean(
        livePage?.element.isConnected
        && (
          surface.page.element !== livePage.element
          || !surface.overlay.isConnected
          || !livePage.element.contains(surface.overlay)
        )
      );
      const nearViewport = surface.overlay.isConnected
        && surface.page.element.isConnected
        && this.surfaceNearViewport(surface, "idle", root);
      const admitted = surface.page.pageNumber === currentPage
        || this.selectionPage === surface.page.pageNumber
        || this.surfaceHasLiveInkInput(surface)
        || needsRecovery
        || nearViewport;
      if (admitted) working.push(surface);
      else surface.viewportCullPending = true;
    }
    return working;
  }

  /**
   * @param marginMode `idle` prefetches with a large pad; `strict` is root intersection
   * only (zoom settle — off-screen quality is deferred via viewportCullPending).
   */
  private surfaceNearViewport(surface: PageSurface, marginMode: "idle" | "strict" = "idle", rootRect?: DOMRect): boolean {
    const root = rootRect ?? this.options.adapter.root.getBoundingClientRect();
    const page = surface.overlay.getBoundingClientRect();
    // JSDOM and detached/pdf-loading DOMs do not expose useful geometry.
    // Paint normally until the real viewer provides stable rectangles.
    if (root.width < 8 || root.height < 8 || page.width < 2 || page.height < 2) return true;
    const margin = marginMode === "strict"
      ? 0
      : Math.max(160, Math.min(720, Math.max(root.width, root.height) * 0.75));
    return page.right >= root.left - margin && page.left <= root.right + margin
      && page.bottom >= root.top - margin && page.top <= root.bottom + margin;
  }

  private paintLaserPoints(
    surface: PageSurface,
    points: readonly PagePoint[],
    color: string,
    width: number,
    opacity: number,
    holdMs: number,
    fadeMs: number
  ): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const scale = this.displayScale(surface);
    drawLaserStroke(surface.context, mapLaserPoints(points, (point) => mapper.toViewport(point)), {
      color,
      width: Math.max(1, width * scale),
      opacity,
      nowMs: performance.now(),
      holdMs,
      fadeMs
    });
    this.lastLaserPaintAt = performance.now();
  }

  private trimLaserDraft(surface: PageSurface, now: number): void {
    if (!surface.laserDraft || !surface.builder) return;
    const laser = this.options.settings.toolPreferences.laser;
    const retentionMs = Math.max(0, laser.holdMs) + Math.max(1, laser.fadeMs);
    surface.laserDiscardedPoints += surface.builder.discardBefore(now - retentionMs);
    surface.laserDiscardedPoints += surface.builder.discardToMaxPoints(ViewerInkSession.MAX_LASER_DRAFT_POINTS);
  }

  private paintLaserTrails(surface: PageSurface, pageNumber: number): void {
    for (const trail of this.laserTrails) {
      if (trail.page !== pageNumber) continue;
      this.paintLaserPoints(
        surface,
        trail.points,
        trail.color,
        trail.width,
        trail.opacity,
        trail.holdMs,
        trail.fadeMs
      );
    }
  }

  /** Blit cached ink + lasers only — avoids full committed-stroke rebuild every fade tick. */
  private repaintLaserOverlay(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    const rect = surface.overlay.getBoundingClientRect();
    const layout = this.pageLayout(surface);
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
    const deferredRaster = !surface.inkLayerValid
      && Boolean(surface.inkLayer)
      && (surface.inkLayerBurstCapture || surface.rasterFallbackReady)
      && surface.settleUpgradePending
      && surface.inkLayer!.width === pixelWidth
      && surface.inkLayer!.height === pixelHeight;
    if ((!surface.inkLayerValid || !surface.inkLayer) && !deferredRaster) {
      this.renderPage(pageNumber);
      return;
    }
    // Must restore CSS-pixel transform after the identity blit — same as blitInkLayerToCanvas.
    const startedAt = performance.now();
    this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
    const laserDraftPoints = surface.laserDraft ? surface.builder?.preview(true) ?? [] : [];
    if (laserDraftPoints.length) {
      const laser = this.options.settings.toolPreferences.laser;
      this.paintLaserPoints(
        surface,
        laserDraftPoints,
        laser.color,
        laser.width,
        laser.opacity,
        laser.holdMs,
        laser.fadeMs
      );
    } else if (surface.builder?.preview().length && !surface.laserDraft) {
      this.renderPage(pageNumber);
      return;
    }
    this.paintLaserTrails(surface, pageNumber);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_SPAN_SYNC_MS) {
      this.logger.laserRepaintSlow(pageNumber, durationMs, laserDraftPoints.length, this.laserTrails.length);
    }
  }

  private ensureLaserFadeLoop(): void {
    if (this.destroyed || this.laserFadeFrame !== null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const tick = (now: number): void => {
      this.laserFadeFrame = null;
      if (this.destroyed) return;

      const dirtyPages = new Set<number>();
      for (const trail of this.laserTrails) dirtyPages.add(trail.page);
      let visibleDraft = false;
      for (const surface of this.surfaces.values()) {
        if (!surface.laserDraft) continue;
        this.trimLaserDraft(surface, now);
        const laser = this.options.settings.toolPreferences.laser;
        const points = surface.builder?.preview(true) ?? [];
        if (!laserTrailStillVisible(points, now, laser.holdMs, laser.fadeMs)) continue;
        visibleDraft = true;
        dirtyPages.add(surface.page.pageNumber);
      }

      this.laserTrails = this.laserTrails.filter((trail) => {
        dirtyPages.add(trail.page);
        return laserTrailStillVisible(trail.points, now, trail.holdMs, trail.fadeMs);
      });

      // Skip if pointermove just painted (avoids double full-canvas work while dragging).
      const recentlyPainted = now - this.lastLaserPaintAt < ViewerInkSession.LASER_FADE_MIN_MS;
      if (!recentlyPainted) {
        for (const page of dirtyPages) this.repaintLaserOverlay(page);
      }

      const stillActive = this.laserTrails.length > 0 || visibleDraft;
      if (stillActive) {
        this.laserFadeFrame = view.requestAnimationFrame(tick);
      }
    };
    this.laserFadeFrame = view.requestAnimationFrame(tick);
  }

  private lassoShape(surface: PageSurface): SelectionShape | null {
    const points = surface.editPath;
    if (!points.length) return null;
    const lassoType = this.options.settings.toolPreferences.lasso.type;
    if (lassoType === "freeform") return { type: "freeform", points };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      type: lassoType,
      bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
    };
  }

  private prepareSelectionCanvas(surface: PageSurface): number {
    const layout = this.pageLayout(surface);
    const fallbackWidth = Math.max(1, Math.round(layout.contentWidth));
    const fallbackHeight = Math.max(1, Math.round(layout.contentHeight));
    const width = surface.canvas.width || fallbackWidth;
    const height = surface.canvas.height || fallbackHeight;
    if (surface.selectionCanvas.width !== width) surface.selectionCanvas.width = width;
    if (surface.selectionCanvas.height !== height) surface.selectionCanvas.height = height;
    return width / Math.max(1, layout.contentWidth);
  }

  private clearSelectionChrome(surface: PageSurface): void {
    const context = surface.selectionContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, surface.selectionCanvas.width, surface.selectionCanvas.height);
    surface.canvas.classList.remove("is-selection-chrome-raised");
  }

  private drawStrokeSelectionChrome(surface: PageSurface, stroke: InkStroke, context: CanvasRenderingContext2D): void {
    const mapper = this.mapper(surface);
    const scale = this.displayScale(surface);
    const segments = stroke.tool === "highlighter"
      ? visibleStrokeSegments(stroke.points, stroke.eraseMasks)
      : stroke.points.length ? [stroke.points] : [];
    context.save();
    context.globalAlpha = 0.9;
    context.strokeStyle = "#2563eb";
    context.lineWidth = Math.max(0.5, stroke.width * scale) + 4;
    context.setLineDash([4, 3]);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const segment of segments) {
      if (!segment.length) continue;
      const first = mapper.toViewport(segment[0]!);
      context.beginPath();
      if (segment.length === 1) {
        context.arc(first.x, first.y, Math.max(2, context.lineWidth / 2), 0, Math.PI * 2);
      } else {
        context.moveTo(first.x, first.y);
        for (const point of segment.slice(1)) {
          const view = mapper.toViewport(point);
          context.lineTo(view.x, view.y);
        }
        context.stroke();
      }
      if (segment.length === 1) context.stroke();
    }
    context.restore();
  }

  private renderSelectionChrome(surface: PageSurface): void {
    this.clearSelectionChrome(surface);
    const tool = this.activeTool();
    if ((tool !== "lasso" && tool !== "text")
      || this.selectionPage !== surface.page.pageNumber
      || !this.selectionShape) return;
    const shape = this.moveShapePreview ?? this.selectionShape;
    if (tool === "text") {
      // Keep the text transform marquee on the committed canvas for the
      // text-layer interaction contract; lasso chrome uses the disposable
      // canvas below so drawing-tool changes are cheap and clean.
      this.drawSelectionShape(surface, shape, { closeFreeform: true });
      surface.canvas.classList.add("is-selection-chrome-raised");
      return;
    }
    const scale = this.prepareSelectionCanvas(surface);
    const context = surface.selectionContext;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    this.drawSelectionShape(surface, shape, { closeFreeform: true }, context);
    for (const stroke of this.selected) {
      if (stroke.page !== surface.page.pageNumber) continue;
      const preview = this.movePreview?.find((item) => item.id === stroke.id) ?? stroke;
      this.drawStrokeSelectionChrome(surface, preview, context);
    }
    surface.canvas.classList.add("is-selection-chrome-raised");
  }

  private drawLassoPreview(surface: PageSurface, context = surface.context): void {
    const shape = this.lassoShape(surface);
    if (shape) this.drawSelectionShape(surface, shape, { closeFreeform: false }, context);
  }

  private renderLiveLassoPreview(surface: PageSurface): void {
    this.clearSelectionChrome(surface);
    if (this.activeTool() !== "lasso") return;
    const scale = this.prepareSelectionCanvas(surface);
    const context = surface.selectionContext;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    this.drawLassoPreview(surface, context);
    surface.canvas.classList.add("is-selection-chrome-raised");
  }

  private drawSelectionShape(
    surface: PageSurface,
    shape: SelectionShape,
    options: { closeFreeform: boolean },
    targetContext = surface.context
  ): void {
    const mapper = this.mapper(surface);
    const context = targetContext;
    context.save();
    context.strokeStyle = "#2563eb";
    context.fillStyle = "rgba(37, 99, 235, 0.12)";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.globalAlpha = 0.95;

    if (shape.type === "freeform") {
      const points = shape.points;
      if (!points.length) {
        context.restore();
        return;
      }
      const first = mapper.toViewport(points[0]!);
      context.beginPath();
      if (points.length === 1) {
        context.arc(first.x, first.y, 3, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(first.x, first.y);
        for (const point of points.slice(1)) {
          const view = mapper.toViewport(point);
          context.lineTo(view.x, view.y);
        }
        if (options.closeFreeform && points.length >= 3) {
          context.closePath();
          context.fill();
        }
        context.stroke();
      }
      context.restore();
      return;
    }

    const bounds = shape.bounds;
    const topLeft = mapper.toViewport({ x: bounds.minX, y: bounds.maxY });
    const bottomRight = mapper.toViewport({ x: bounds.maxX, y: bounds.minY });
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    context.beginPath();
    context.rect(topLeft.x, topLeft.y, width, height);
    context.fill();
    context.stroke();
    context.restore();
  }

  private renderImageAnnotations(target: ImageRasterRenderTarget, page: AnnotationPageInfo): void {
    const scale = Math.min(target.scaleX, target.scaleY);
    const mapper = new PageCoordinateMapper({
      width: page.width,
      height: page.height,
      scale,
      scaleX: target.scaleX,
      scaleY: target.scaleY,
      rotation: normalizeRotation(page.rotation),
      origin: page.coordinateOrigin ?? "bottom-left"
    });
    for (const stroke of this.ink.page(1)) {
      this.drawPointsForMapper(
        target.context,
        mapper,
        scale,
        stroke.points,
        stroke.color,
        stroke.width,
        stroke.opacity,
        stroke.tool,
        false,
        stroke.id,
        stroke.eraseMasks,
        stroke.penType
      );
    }
    this.drawImageTextAnnotations(target.context, mapper, target.scaleX, target.scaleY, this.texts.page(1));
  }

  private drawPointsForMapper(
    context: CanvasRenderingContext2D,
    mapper: PageCoordinateMapper,
    scale: number,
    points: readonly PagePoint[],
    color: string,
    width: number,
    opacity: number,
    tool: DrawingTool,
    selected = false,
    strokeId?: string,
    eraseMasks?: InkStroke["eraseMasks"],
    penType?: InkStroke["penType"]
  ): void {
    if (!points.length) return;
    context.save();
    if (tool === "pencil") {
      const prefs = this.options.settings.toolPreferences.pencil;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure, tiltX: point.tiltX, tiltY: point.tiltY, time: point.time };
      });
      drawGraphiteStroke(context, viewPoints, {
        color,
        width: Math.max(0.5 * scale, width * scale),
        opacity,
        textureStrength: prefs.textureStrength,
        pressureSensitivity: prefs.pressureSensitivity,
        tiltSensitivity: prefs.tiltSensitivity,
        thinning: prefs.thinning,
        seed: strokeId ? seedFromId(strokeId) : seedFromId(`${viewPoints[0]!.x}:${viewPoints[0]!.y}`),
        coordinateScale: scale
      });
    } else if (tool === "highlighter") {
      const prefs = this.options.settings.toolPreferences.highlighter;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure };
      });
      const highlighterOptions = {
        color,
        width: Math.max(2 * scale, width * scale),
        opacity,
        pressureSensitivity: prefs.pressureSensitivity,
        thinning: prefs.thinning,
        coordinateScale: scale
      };
      if (eraseMasks?.length) {
        drawHighlighterStrokeWithMasks(context, viewPoints, highlighterOptions, eraseMasks.map((mask) => ({
          radius: Math.max(0.5, mask.radius * scale),
          points: mask.points.map((point) => {
            const view = mapper.toViewport(point);
            return { x: view.x, y: view.y };
          })
        })));
      } else {
        drawHighlighterStroke(context, viewPoints, highlighterOptions);
      }
    } else {
      const prefs = this.options.settings.toolPreferences.pen;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure, time: point.time };
      });
      drawPenStroke(context, viewPoints, {
        color,
        width: Math.max(0.5 * scale, width * scale),
        opacity,
        pressureSensitivity: prefs.pressureSensitivity,
        thinning: prefs.thinning,
        penType: penType ?? prefs.penType ?? "fountain",
        coordinateScale: scale
      });
    }
    if (selected) {
      context.globalAlpha = 0.9;
      context.strokeStyle = "#2563eb";
      context.lineWidth = Math.max(0.5, width * scale) + 4;
      context.setLineDash([4, 3]);
      context.lineCap = "round";
      context.lineJoin = "round";
      const segments = tool === "highlighter"
        ? visibleStrokeSegments(points, eraseMasks)
        : points.length ? [points] : [];
      for (const segment of segments) {
        const first = mapper.toViewport(segment[0]!);
        context.beginPath();
        context.moveTo(first.x, first.y);
        for (const point of segment.slice(1)) {
          const view = mapper.toViewport(point);
          context.lineTo(view.x, view.y);
        }
        context.stroke();
      }
    }
    context.restore();
  }

  private drawImageTextAnnotations(
    context: CanvasRenderingContext2D,
    mapper: PageCoordinateMapper,
    scaleX: number,
    scaleY: number,
    annotations: readonly TextAnnotation[]
  ): void {
    for (const annotation of annotations) {
      const origin = mapper.toViewport({ x: annotation.x, y: annotation.y });
      const maxWidth = Math.max(24 * scaleX, annotation.width * scaleX);
      const paddingX = 3 * scaleX;
      const paddingY = 2 * scaleY;
      const fallbackRuns = plainTextToRuns(annotation.text, this.textStyle(annotation));
      const runs = normalizeTextRuns(annotation.runs);
      const source = runs.length && plainTextFromRuns(runs) === annotation.text ? runs : fallbackRuns;
      let x = origin.x + paddingX;
      let y = origin.y + paddingY;
      const lineStart = x;
      let lineHeight = Math.max(1, annotation.fontSize * scaleY * 1.35);
      for (const run of source) {
        const fontSize = Math.max(1, run.fontSize * scaleY);
        lineHeight = Math.max(lineHeight, fontSize * 1.35);
        context.fillStyle = run.color;
        context.font = `${run.italic ? "italic " : ""}${run.bold ? "700" : "400"} ${fontSize}px ${run.fontFamily}`;
        for (const character of run.text) {
          if (character === "\\n") {
            x = lineStart;
            y += lineHeight;
            continue;
          }
          const measured = typeof context.measureText === "function" ? context.measureText(character).width : fontSize * 0.6;
          if (x > lineStart && x + measured > origin.x + maxWidth) {
            x = lineStart;
            y += lineHeight;
          }
          context.fillText(character, x, y + fontSize);
          if (run.strikethrough) {
            context.save();
            context.strokeStyle = run.color;
            context.lineWidth = Math.max(1, scaleY);
            context.beginPath();
            context.moveTo(x, y + fontSize * 0.62);
            context.lineTo(x + measured, y + fontSize * 0.62);
            context.stroke();
            context.restore();
          }
          x += measured;
        }
      }
    }
  }

  private drawStroke(
    surface: PageSurface,
    stroke: InkStroke,
    selected: boolean
  ): void {
    this.drawPoints(
      surface,
      stroke.points,
      stroke.color,
      stroke.width,
      stroke.opacity,
      stroke.tool,
      selected,
      stroke.id,
      surface.context,
      stroke.eraseMasks,
      stroke.penType
    );
  }

  private drawPoints(
    surface: PageSurface,
    points: readonly PagePoint[],
    color: string,
    width: number,
    opacity: number,
    tool: DrawingTool,
    selected = false,
    strokeId?: string,
    context: CanvasRenderingContext2D = surface.context,
    eraseMasks?: InkStroke["eraseMasks"],
    penType?: InkStroke["penType"]
  ): void {
    this.drawPointsForMapper(
      context,
      this.mapper(surface),
      this.displayScale(surface),
      points,
      color,
      width,
      opacity,
      tool,
      selected,
      strokeId,
      eraseMasks,
      penType ?? surface.builder?.style.penType
    );
  }

  private toPagePoints(
    surface: PageSurface,
    samples: readonly PointerSample[],
    simulateMousePressure: boolean,
    pressureConditioner?: PressureConditioner
  ): PagePoint[] {
    const geometryStartedAt = surface.strokePerformance ? performance.now() : null;
    const overlayRect = surface.overlay.getBoundingClientRect();
    const mapper = this.mapper(surface);
    let previous = pressureConditioner ? surface.pressureLastPagePoint : undefined;
    const points = samples.map((sample) => {
      const viewport = this.overlayViewportFromClient(surface, sample.clientX, sample.clientY, overlayRect);
      const point = mapper.toPage(viewport);
      // Pen zero on pointerdown is meaningful (conditioner floor). Move-path hover
      // (pressure ≤ PEN_HOVER_PRESSURE_EPSILON) is filtered in PointerRouter.
      // Non-pen keeps simulated-pressure fallback before profile choice.
      const rawPressure = sample.pointerType === "pen"
        ? sample.pressure
        : sample.pressure > 0 ? sample.pressure : simulateMousePressure ? 0.5 : 1;
      const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
      const pressure = pressureConditioner
        ? pressureConditioner.condition({ pointerType: sample.pointerType, pressure: rawPressure, distance })
        : rawPressure;
      previous = { x: point.x, y: point.y };
      return { x: point.x, y: point.y, pressure, tiltX: sample.tiltX, tiltY: sample.tiltY, time: sample.timeStamp };
    });
    if (pressureConditioner) surface.pressureLastPagePoint = previous;
    if (geometryStartedAt !== null && surface.strokePerformance) {
      surface.strokePerformance.geometry.add(Math.max(0, performance.now() - geometryStartedAt));
    }
    return points;
  }

  private toPagePoint(surface: PageSurface, sample: PointerSample, simulateMousePressure: boolean): PagePoint {
    return this.toPagePoints(surface, [sample], simulateMousePressure)[0]!;
  }

  private projectInkScreenPoint(surface: PageSurface, clientX: number, clientY: number): { x: number; y: number } {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const viewport = this.overlayViewportFromClient(surface, clientX, clientY, overlayRect);
    const mapper = this.mapper(surface);
    const projected = mapper.toViewport(mapper.toPage(viewport));
    return this.overlayClientFromViewport(surface, projected, overlayRect);
  }

  private logPositionAlign(
    surface: PageSurface,
    sample: PointerSample,
    phase: "move" | "start" | "end"
  ): void {
    if (!this.logger.shouldLogPositionAlign(phase)) return;
    const pageRect = surface.page.element.getBoundingClientRect();
    const overlayRect = surface.overlay.getBoundingClientRect();
    const layout = this.pageLayout(surface);
    const contentRect = pdfRenderCanvas(surface.page.element)?.getBoundingClientRect();
    const viewport = this.overlayViewportFromClient(surface, sample.clientX, sample.clientY, overlayRect);
    const mapper = this.mapper(surface);
    const pdf = mapper.toPage(viewport);
    const inkScreen = this.projectInkScreenPoint(surface, sample.clientX, sample.clientY);
    this.logger.positionAlign({
      phase,
      page: surface.page.pageNumber,
      clientX: round(sample.clientX),
      clientY: round(sample.clientY),
      host: {
        left: round(pageRect.left),
        top: round(pageRect.top),
        width: round(pageRect.width),
        height: round(pageRect.height)
      },
      content: contentRect ? {
        left: round(contentRect.left),
        top: round(contentRect.top),
        width: round(contentRect.width),
        height: round(contentRect.height)
      } : null,
      overlay: {
        left: round(overlayRect.left),
        top: round(overlayRect.top),
        width: round(overlayRect.width),
        height: round(overlayRect.height)
      },
      layout: {
        offsetX: round(layout.offsetX),
        offsetY: round(layout.offsetY),
        scale: round(layout.scale),
        scaleX: round(layout.scaleX),
        scaleY: round(layout.scaleY),
        pdfWidth: round(layout.pdfWidth),
        pdfHeight: round(layout.pdfHeight)
      },
      viewport: { x: round(viewport.x), y: round(viewport.y) },
      pdf: { x: round(pdf.x), y: round(pdf.y) },
      inkScreen: { x: round(inkScreen.x), y: round(inkScreen.y) },
      delta: {
        x: round(sample.clientX - inkScreen.x),
        y: round(sample.clientY - inkScreen.y)
      }
    });
  }

  private ensurePagePositioning(pageElement: HTMLElement): void {
    if (pageElement.ownerDocument.defaultView?.getComputedStyle(pageElement).position === "static") {
      pageElement.classList.add("native-pdf-handwriting-relative");
    }
  }

  private syncOverlayLayout(surface: PageSurface, layout = this.pageLayout(surface)): void {
    if (layout.contentWidth < 8 || layout.contentHeight < 8) return;
    const overlay = surface.overlay;
    if (overlay.parentElement !== surface.page.element) {
      this.ensurePagePositioning(surface.page.element);
      surface.page.element.append(overlay);
      this.ensurePageRouter(surface);
    }
    setElementCssProps(overlay, {
      left: `${layout.offsetX}px`,
      top: `${layout.offsetY}px`,
      width: `${layout.contentWidth}px`,
      height: `${layout.contentHeight}px`
    });
  }

  /**
   * One burst and one settle record per page. The normalized anchor must match
   * the PDF-space expectation at both phases; any mismatch identifies whether
   * the PDF canvas and ink overlay disagree on an axis or origin.
   */
  private logZoomInkLayout(
    surface: PageSurface,
    phase: "burst" | "settle" | "native-content" | "handoff-final",
    layoutOverride?: PageCoordinateLayout,
    geometry?: ZoomGeometrySnapshot
  ): void {
    if (!this.logger.isEnabled()) return;
    const key = `${surface.page.pageNumber}:${phase}`;
    if (this.zoomInkLayoutLoggedPhases.has(key)) return;
    this.zoomInkLayoutLoggedPhases.add(key);

    const layout = layoutOverride ?? this.pageLayout(surface);
    const metrics = this.metricsFor(surface);
    const contentRect = geometry?.contentRect ?? null;
    const overlayRect = geometry?.overlayRect ?? {
      left: layout.offsetX,
      top: layout.offsetY,
      width: layout.contentWidth,
      height: layout.contentHeight
    };
    const zoom = this.mobilePdfCssZoomFactor();
    const overlayWidth = overlayRect.width >= 8 ? overlayRect.width / zoom : layout.contentWidth;
    const overlayHeight = overlayRect.height >= 8 ? overlayRect.height / zoom : layout.contentHeight;
    const firstStroke = this.ink.page(surface.page.pageNumber)[0];
    const anchorPoint = firstStroke?.points[0];
    const mapped = anchorPoint ? this.mapper(surface, layout).toViewport(anchorPoint) : null;
    const normalized = mapped && overlayWidth > 0 && overlayHeight > 0
      ? { x: mapped.x / overlayWidth, y: mapped.y / overlayHeight }
      : null;
    const expected = anchorPoint ? this.expectedAnchorNormalized(anchorPoint, metrics, this.rotation(surface.page.rotation)) : null;
    const prior = this.zoomInkAnchorByPage.get(surface.page.pageNumber);

    this.logger.zoomInkLayout(surface.page.pageNumber, phase, {
      content: contentRect ? {
        left: roundCoordinate(contentRect.left),
        top: roundCoordinate(contentRect.top),
        width: roundCoordinate(contentRect.width),
        height: roundCoordinate(contentRect.height)
      } : null,
      overlay: {
        left: roundCoordinate(overlayRect.left),
        top: roundCoordinate(overlayRect.top),
        width: roundCoordinate(overlayRect.width),
        height: roundCoordinate(overlayRect.height)
      },
      layout: {
        offsetX: roundCoordinate(layout.offsetX),
        offsetY: roundCoordinate(layout.offsetY),
        contentWidth: roundCoordinate(layout.contentWidth),
        contentHeight: roundCoordinate(layout.contentHeight),
        scaleX: roundCoordinate(layout.scaleX),
        scaleY: roundCoordinate(layout.scaleY),
        rotation: this.rotation(surface.page.rotation)
      },
      strokeCount: this.ink.page(surface.page.pageNumber).length,
      anchor: normalized && expected ? {
        normalizedX: roundCoordinate(normalized.x),
        normalizedY: roundCoordinate(normalized.y),
        expectedX: roundCoordinate(expected.x),
        expectedY: roundCoordinate(expected.y),
        errorX: roundCoordinate(normalized.x - expected.x),
        errorY: roundCoordinate(normalized.y - expected.y),
        ...(prior ? {
          deltaFromBurstX: roundCoordinate(normalized.x - prior.normalizedX),
          deltaFromBurstY: roundCoordinate(normalized.y - prior.normalizedY)
        } : {})
      } : null
    });
    if (normalized && phase === "burst") {
      this.zoomInkAnchorByPage.set(surface.page.pageNumber, { normalizedX: normalized.x, normalizedY: normalized.y });
    }
  }

  private syncFindBridgePage(pageNumber: number): void {
    if (this.destroyed) return;
    this.findBridge?.syncPage(pageNumber, this.texts.page(pageNumber));
  }

  private findLayoutForAnnotation(
    pageNumber: number,
    annotation: TextAnnotation
  ): AnnotationFindPageLayout | null {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return null;
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const scale = this.displayScale(surface);
    return {
      left: origin.x,
      top: origin.y,
      width: Math.max(24, annotation.width * scale),
      height: Math.max(annotation.fontSize * scale * 1.4, annotation.height * scale),
      fontSize: annotation.fontSize * scale,
      fontFamily: annotation.fontFamily
    };
  }

  private expectedAnchorNormalized(point: PagePoint, metrics: { width: number; height: number }, rotation: PageRotation): { x: number; y: number } {
    switch (rotation) {
      case 0: return { x: point.x / metrics.width, y: (metrics.height - point.y) / metrics.height };
      case 90: return { x: point.y / metrics.height, y: point.x / metrics.width };
      case 180: return { x: (metrics.width - point.x) / metrics.width, y: point.y / metrics.height };
      case 270: return { x: (metrics.height - point.y) / metrics.height, y: (metrics.width - point.x) / metrics.width };
    }
  }

  private mapper(surface: PageSurface, layoutOverride?: PageCoordinateLayout): PageCoordinateMapper {
    const layout = layoutOverride ?? this.pageLayout(surface);
    const metrics = this.metricsFor(surface);
    return new PageCoordinateMapper({
      width: metrics.width,
      height: metrics.height,
      scale: layout.scale,
      scaleX: layout.scaleX,
      scaleY: layout.scaleY,
      rotation: this.rotation(surface.page.rotation),
      origin: surface.page.coordinateOrigin ?? "bottom-left",
      offsetX: 0,
      offsetY: 0
    });
  }

  private displayScale(surface: PageSurface): number {
    return this.pageLayout(surface).scale;
  }

  /** Full css×dpr until the platform ink budget; neighbors settle cheaper until idle HQ. */
  private resolveInkBacking(
    cssWidth: number,
    cssHeight: number,
    tier: "full" | "neighbor" = "full"
  ): ReturnType<typeof inkBackingSize> {
    const budget = inkBackingBudget(this.runtimePlatform().mobile);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    if (tier === "neighbor") {
      return inkBackingSize(
        cssWidth,
        cssHeight,
        Math.max(0.5, dpr * 0.5),
        Math.max(512, Math.floor(budget.maxEdge / 2)),
        Math.max(512 * 512, Math.floor(budget.maxPixels / 4))
      );
    }
    return inkBackingSize(
      cssWidth,
      cssHeight,
      dpr,
      budget.maxEdge,
      budget.maxPixels
    );
  }

  private pageLayout(surface: PageSurface): PageCoordinateLayout {
    const cached = this.zoomLayoutCache?.get(surface.page.pageNumber);
    if (cached) return this.unscalePageLayoutForMobileCssZoom(cached);
    const metrics = this.metricsFor(surface);
    return this.unscalePageLayoutForMobileCssZoom(resolvePageCoordinateLayout({
      ...surface.page,
      width: metrics.width,
      height: metrics.height
    }));
  }

  private unscalePageLayoutForMobileCssZoom(layout: PageCoordinateLayout): PageCoordinateLayout {
    const zoom = this.mobilePdfCssZoomFactor();
    if (zoom === 1) return layout;
    return {
      ...layout,
      offsetX: layout.offsetX / zoom,
      offsetY: layout.offsetY / zoom,
      contentWidth: layout.contentWidth / zoom,
      contentHeight: layout.contentHeight / zoom,
      scale: layout.scale / zoom,
      scaleX: layout.scaleX / zoom,
      scaleY: layout.scaleY / zoom,
      hostWidth: layout.hostWidth / zoom,
      hostHeight: layout.hostHeight / zoom
    };
  }

  /** Canonical PDF-space page bounds for indexed paint queries. */
  private pageInkBounds(surface: PageSurface): Bounds {
    const metrics = this.metricsFor(surface);
    return { minX: 0, minY: 0, maxX: metrics.width, maxY: metrics.height };
  }

  private metricsFor(surface: PageSurface): { width: number; height: number } {
    const pinned = this.pageMetrics.get(surface.page.pageNumber);
    if (pinned) return pinned;
    this.rememberPageMetrics(surface.page);
    return this.pageMetrics.get(surface.page.pageNumber) ?? {
      width: surface.page.width,
      height: surface.page.height
    };
  }

  private rememberPageMetrics(page: AnnotationPageInfo): void {
    if (!(page.width > 1 && page.height > 1)) return;
    const existing = this.pageMetrics.get(page.pageNumber);
    // Prefer first trusted sidecar/live size; only replace placeholder or clearly wrong CSS-pixel sizes.
    if (!existing || existing.width <= 1 || existing.height <= 1) {
      this.pageMetrics.set(page.pageNumber, { width: page.width, height: page.height });
      return;
    }
    const looksLikeCssPixels = page.width > 1800 || page.height > 2400;
    const existingLooksPdf = existing.width <= 1800 && existing.height <= 2400;
    if (looksLikeCssPixels && existingLooksPdf) return;
    if (!existingLooksPdf && page.width <= 1800 && page.height <= 2400) {
      this.pageMetrics.set(page.pageNumber, { width: page.width, height: page.height });
    }
  }

  private rotation(value: number): PageRotation {
    return normalizeRotation(value);
  }

  private unsafeSnapshotPage(snapshot: SidecarSchemaV1): { page: number; reason: string } | null {
    for (const stored of snapshot.pages) {
      const current = this.options.adapter.page(stored.page);
      if (!current) continue;
      const reason = this.pageEvidenceReason(current);
      if (reason) return { page: stored.page, reason };
    }
    return null;
  }

  private snapshot(): SidecarSchemaV1 {
    const now = new Date().toISOString();
    const stored = new Map<number, InkStroke[]>();
    const storedTexts = new Map<number, TextAnnotation[]>();
    for (const stroke of this.ink.all()) stored.set(stroke.page, [...(stored.get(stroke.page) ?? []), stroke]);
    for (const text of this.texts.all()) storedTexts.set(text.page, [...(storedTexts.get(text.page) ?? []), text]);
    const known = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    return {
      schemaVersion: 1,
      document: this.identity,
      pages: [...new Set([...stored.keys(), ...storedTexts.keys()])].map((pageNumber) => {
        const strokes = stored.get(pageNumber) ?? [];
        const texts = storedTexts.get(pageNumber) ?? [];
        const page = known.get(pageNumber);
        const metrics = this.pageMetrics.get(pageNumber) ?? {
          width: page?.width ?? 1,
          height: page?.height ?? 1
        };
        return {
          page: pageNumber,
          width: metrics.width,
          height: metrics.height,
          rotation: this.rotation(page?.rotation ?? 0),
          strokes,
          ...(texts.length ? { texts } : {})
        };
      }),
      createdAt: this.createdAt,
      updatedAt: now
    };
  }

  private stillOwnsPersist(): boolean {
    if (this.writesAbandoned || this.destroyed) return false;
    const liveEpoch = this.options.livePersistEpoch?.(this.identity.id);
    if (liveEpoch !== undefined && liveEpoch !== this.persistEpoch) {
      this.abandonWrites(`stale-epoch:${this.persistEpoch}<${liveEpoch}`);
      return false;
    }
    return true;
  }

  private persist(snapshot: SidecarSchemaV1, reason = "autosave"): Promise<void> {
    const operation = this.persistTail
      .catch(() => undefined)
      .then(() => this.persistNow(snapshot, reason));
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  private async persistNow(snapshot: SidecarSchemaV1, reason = "autosave"): Promise<void> {
    const strokeCount = countSidecarStrokes(snapshot);
    const textCount = countSidecarTexts(snapshot);
    const started = performance.now();
    const profilePersistence = this.logger.isEnabled();
    const serializeStarted = performance.now();
    const serialized = profilePersistence ? JSON.stringify(snapshot) : "";
    const serializedBytes = profilePersistence
      ? typeof TextEncoder === "undefined" ? serialized.length : new TextEncoder().encode(serialized).byteLength
      : 0;
    const serializeMs = profilePersistence ? roundMs(performance.now() - serializeStarted) : 0;
    const overlappedActiveGesture = this.hasAnyLiveInkInput();
    let recoveryWriteMs: number | null = null;
    let sidecarWriteMs: number | null = null;
    let recoveryClearMs: number | null = null;
    const reportPersist = (outcome: string): void => {
      const totalMs = roundMs(performance.now() - started);
      this.logger.persistProfile({
        reason,
        outcome,
        strokeCount,
        textCount,
        serializedBytes,
        serializeMs,
        recoveryWriteMs,
        sidecarWriteMs,
        recoveryClearMs,
        writeMs: sidecarWriteMs ?? recoveryWriteMs,
        maxSynchronousBlockingMs: serializeMs,
        totalMs,
        overlappedActiveGesture
      });
      this.reportDevProbe("sidecar-persist", {
        reason,
        outcome,
        durationMs: totalMs,
        recoveryWriteMs,
        sidecarWriteMs,
        recoveryClearMs,
        strokeCount,
        textCount
      });
      const pendingProbe = this.postUiPendingPersistence;
      if (pendingProbe) {
        const persisted = outcome === "saved";
        const persistedStrokePoints = persisted
          ? snapshot.pages
            .filter((page) => pendingProbe.page === null || page.page === pendingProbe.page)
            .reduce((total, page) => total + page.strokes.reduce((pageTotal, stroke) => pageTotal + stroke.points.length, 0), 0)
          : 0;
        this.logger.postUiProbe("persisted", {
          correlationId: pendingProbe.correlationId,
          persisted,
          persistedStrokePoints,
          persistenceOutcome: outcome
        });
        this.postUiPendingPersistence = null;
      }
    };
    if (!this.stillOwnsPersist()) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: false,
        updatedAt: snapshot.updatedAt,
        skipped: this.writesAbandoned ? "abandoned-writer" : "destroyed"
      });
      reportPersist(this.writesAbandoned ? "skipped-abandoned" : "skipped-destroyed");
      return;
    }
    const unsafe = this.unsafeSnapshotPage(snapshot);
    if (unsafe) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: this.isDirty(),
        updatedAt: snapshot.updatedAt,
        skipped: `unsafe-page:${unsafe.page}:${unsafe.reason}`
      });
      reportPersist("skipped-unsafe-page");
      return;
    }
    try {
      // Re-check after each await so emergency sync from another session cannot be overwritten.
      if (!this.stillOwnsPersist()) {
        reportPersist("skipped-before-recovery");
        return;
      }
      const recoveryWriteStarted = performance.now();
      await this.options.recovery.save(snapshot);
      recoveryWriteMs = roundMs(performance.now() - recoveryWriteStarted);
      this.recordStrokeSerialization(snapshot, "recovery", reason);
      if (!this.stillOwnsPersist()) {
        const recoveryClearStarted = performance.now();
        await this.options.recovery.clear(this.identity.id, snapshot).catch(() => undefined);
        recoveryClearMs = roundMs(performance.now() - recoveryClearStarted);
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          textCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-recovery"
        });
        reportPersist("skipped-after-recovery");
        return;
      }
      const sidecarWriteStarted = performance.now();
      await this.options.sidecars.save(snapshot);
      sidecarWriteMs = roundMs(performance.now() - sidecarWriteStarted);
      this.recordStrokeSerialization(snapshot, "sidecar", reason);
      if (!this.stillOwnsPersist()) {
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          textCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-sidecar"
        });
        reportPersist("skipped-after-sidecar");
        return;
      }
      const recoveryClearStarted = performance.now();
      await this.options.recovery.clear(this.identity.id, snapshot);
      recoveryClearMs = roundMs(performance.now() - recoveryClearStarted);
      this.recordStrokePersisted(snapshot, reason);
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
      reportPersist("saved");
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: this.isDirty(),
        updatedAt: snapshot.updatedAt,
        error: this.errorMessage(error)
      });
      reportPersist("error");
      throw error;
    }
  }

  private exportPageMetrics(): Array<{ page: number; width: number; height: number }> {
    const fromPinned = [...this.pageMetrics.entries()].map(([page, metrics]) => ({
      page,
      width: metrics.width,
      height: metrics.height
    }));
    if (fromPinned.length) return fromPinned;
    return this.options.adapter.pages().map((page) => ({
      page: page.pageNumber,
      width: page.width,
      height: page.height
    }));
  }

  remountToolbar(): void {
    if (this.destroyed) return;
    this.reconcileToolbarMount("settings");
    this.scheduleUiIntegrityCheck("settings");
  }

  /** False after PDF++ (or Obsidian) tears down the PDF DOM under this session. */
  isAttached(): boolean {
    if (this.destroyed || this.detachNotified) return false;
    const { adapter } = this.options;
    if (!adapter.host.isConnected || !adapter.root.isConnected) return false;
    const pages = adapter.pages();
    if (!pages.length) return false;
    if (!this.surfaces.size) return true;
    return [...this.surfaces.values()].some((surface) => surface.overlay.isConnected);
  }

  private currentToolbarPlacement(): ToolbarPlacement {
    const configured = this.options.toolbarPlacement?.() ?? this.options.settings.toolbarPlacement;
    return resolveToolbarPlacement(configured);
  }

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "import-page") {
      await this.importPagesAfter(this.options.adapter.getViewState().pageNumber);
      return;
    }
    if (action === "scan-document") {
      await this.scanDocument();
      return;
    }
    if (action === "export") {
      await this.exportCopy().catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "export-image") {
      await this.exportImageCopy().catch((error) => this.options.notice(`Image export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "export-editable") {
      await this.exportCopy("editable").catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "toolbar-main" || action === "toolbar-left" || action === "toolbar-right") {
      const placement = action.replace("toolbar-", "") as ToolbarPlacement;
      const previousPlacement = this.currentToolbarPlacement();
      this.logger.toolbarPlacement("request", { previousPlacement, requestedPlacement: placement });
      // Prefer savePluginSettings (assigns via saveSettings + remounts open leaves). Local mutate is fallback only.
      try {
        if (this.options.savePluginSettings) await this.options.savePluginSettings({ toolbarPlacement: placement });
        else this.options.settings.toolbarPlacement = placement;
        this.remountToolbar();
        this.logger.toolbarPlacement("applied", {
          previousPlacement,
          requestedPlacement: placement,
          resolvedPlacement: this.currentToolbarPlacement()
        });
      } catch (error) {
        this.logger.toolbarPlacement("error", {
          previousPlacement,
          requestedPlacement: placement,
          error: this.errorMessage(error)
        });
        throw error;
      }
    }
  }

  private updateDebug(surface?: PageSurface, event?: PointerEvent): void {
    const view = this.options.adapter.getViewState();
    this.debugState = {
      ...(event ? {
        pointerType: event.pointerType,
        pressure: event.pressure,
        tiltX: event.tiltX,
        tiltY: event.tiltY
      } : {}),
      page: surface?.page.pageNumber ?? view.pageNumber,
      ...(this.lastPointerPdf ? { pdfX: this.lastPointerPdf.x, pdfY: this.lastPointerPdf.y } : {}),
      scale: surface ? this.displayScale(surface) : view.scale,
      rotation: surface?.page.rotation ?? view.rotation,
      tool: this.options.settings.toolPreferences.activeTool,
      dirty: this.isDirty(),
      autosave: this.options.settings.autosave,
      pending: this.autosave.isDirty(this.identity.id)
    };
  }

  private logDraw(
    surface: PageSurface,
    phase: DrawPositionLog["phase"],
    tool: string,
    points: readonly PagePoint[],
    terminal: Pick<DrawPositionLog, "termination" | "terminalDetail"> = {}
  ): void {
    if (!points.length) return;
    const sampled = samplePoints(points, 24);
    this.logger.draw({
      phase,
      page: surface.page.pageNumber,
      tool,
      ...terminal,
      displayScale: Number(this.displayScale(surface).toFixed(4)),
      pointCount: points.length,
      bounds: drawBounds(points),
      points: sampled.map((point) => ({
        x: Number(point.x.toFixed(2)),
        y: Number(point.y.toFixed(2)),
        ...(point.pressure !== undefined ? { pressure: Number(point.pressure.toFixed(3)) } : {})
      }))
    });
  }

  private simplifyStrokesEnabled(): boolean {
    return this.options.simplifyStrokesEnabled?.() ?? this.options.settings.simplifyStrokes;
  }

  private pressureProfile(): PressureProfile {
    return this.options.pressureProfile?.() ?? this.options.settings.pressureProfile;
  }

  private pressureCalibration(): PressureCalibration {
    return this.options.pressureCalibration?.() ?? this.options.settings.pressureCalibration;
  }

  private id(): string {
    const cryptoObj = window.crypto;
    if (cryptoObj?.randomUUID) {
      return cryptoObj.randomUUID();
    }
    if (cryptoObj?.getRandomValues) {
      const array = new Uint32Array(4);
      cryptoObj.getRandomValues(array);
      return `stroke-${Date.now()}-${Array.from(array, dec => dec.toString(16).padStart(8, '0')).join('')}`;
    }
    // Fail secure if no cryptographic PRNG is available
    throw new Error("Secure random number generation is not supported by this browser.");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function inkInputType(pointerType: string): InkStroke["inputType"] {
  return pointerType === "pen" || pointerType === "touch" ? pointerType : "mouse";
}

function samplePoints<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return [...points];
  const sampled: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round((index * (points.length - 1)) / (maxPoints - 1))]!);
  }
  return sampled;
}

function rectDelta(previous: RectSnapshot | null, next: RectSnapshot): number {
  if (!previous) return 0;
  return Math.max(
    Math.abs(next.left - previous.left),
    Math.abs(next.top - previous.top),
    Math.abs(next.width - previous.width),
    Math.abs(next.height - previous.height)
  );
}

function rectMismatch(pdf: RectSnapshot, ink: RectSnapshot): number {
  return Math.max(
    Math.abs(pdf.left - ink.left),
    Math.abs(pdf.top - ink.top),
    Math.abs(pdf.width - ink.width),
    Math.abs(pdf.height - ink.height)
  );
}

function drawBounds(points: readonly PagePoint[]): NonNullable<DrawPositionLog["bounds"]> {
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) };
}

function pathBoundsWithPadding(points: readonly Pick<PagePoint, "x" | "y">[], padding: number): Bounds {
  const safePadding = Number.isFinite(padding) && padding > 0 ? padding : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: minX - safePadding,
    minY: minY - safePadding,
    maxX: maxX + safePadding,
    maxY: maxY + safePadding
  };
}

function normalizedPointerEventTime(event: Pick<PointerEvent, "timeStamp">, receivedAt: number): number {
  let timestamp = event.timeStamp;
  if (!Number.isFinite(timestamp)) return receivedAt;
  // WebKit historically used epoch milliseconds while Chromium uses the
  // performance time origin. Normalize epoch values before measuring input.
  if (timestamp > 1_000_000_000_000) {
    timestamp -= performance.timeOrigin;
  }
  // Synthetic/jsdom events commonly use timestamp 1; treating that as a real
  // page-load event would manufacture a slow span in every test and trace.
  if (timestamp <= 10 && receivedAt > 100) return receivedAt;
  if (timestamp < 0 || timestamp > receivedAt + 2 || receivedAt - timestamp > 10_000) return receivedAt;
  return timestamp;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
