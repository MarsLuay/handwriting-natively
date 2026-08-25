import type { DrawingTool, InkStroke, PdfPoint, PdfTextAnnotation, PdfTextRun, PluginSettings, PressureCalibration, PressureProfile, TextStyle, ToolId, ToolbarPlacement, ToolPreferences } from "../model";
import { isDrawingTool, isInkDrawTool, resolveDrawingTool } from "../model";
import type { ObsidianPdfAdapter } from "../integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../integration/PdfPageLocator";
import { AnnotationFindBridge, type AnnotationFindPageLayout } from "../integration/AnnotationFindBridge";
import { PdfThumbnailSidebarActions } from "../integration/PdfThumbnailDeleteMenu";
import { captureNativePdfMutationScreenshot } from "../integration/NativePdfMutationScreenshot";
import { resolveToolbarPlacement } from "./resolveToolbarPlacement";
import { PointerRouter } from "../input/PointerRouter";
import { ViewerMousePan, type MousePanPhase } from "../input/ViewerMousePan";
import { PullToAddPageGesture } from "../input/PullToAddPageGesture";
import { shouldIgnoreSelectionShortcut, parseSelectionShortcut, parseHistoryShortcut, type SelectionShortcutAction } from "../input/SelectionShortcuts";
import type { PointerSample } from "../input/PointerCapabilities";
import { PressureConditioner, pressureConditionerOptionsForCalibration } from "../input/PressureProfile";
import { InkSession } from "../ink/InkSession";
import type { Bounds } from "../ink/StrokeHitTesting";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeClipboard } from "../ink/StrokeClipboard";
import { simplifyPoints } from "../ink/StrokeStabilizer";
import { PdfCoordinateMapper, type PageRotation } from "../pdf/PdfCoordinateMapper";
import { normalizeRotation, pdfRenderCanvas, resolvePageCoordinateLayout, type PageCoordinateLayout } from "../pdf/PageCoordinateLayout";
import { createDetachedDiv, createDetachedEl } from "../vendor/createDetached";
import { getDebugNodeId } from "../dom/debugNodeId";
import { isElement, isElementInDocument, isHTMLElement, setElementCssProps } from "../dom/typeGuards";
import { ensurePdfPageNumbers, isHandwritingPageChrome } from "../integration/pdfPageSelectors";
import { PdfExportService, annotatedFilename, editableAnnotatedFilename } from "../pdf/PdfExportService";
import { exportInkStrokesToSvg } from "../pdf/SvgInkExportService";
import { AddStrokeCommand, ReplaceAnnotationSelectionCommand, ReplacePageStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command } from "../history/CommandHistory";
import { eraseStrokes, eraseWholeStrokes } from "../tools/EraserTool";
import { recognizeHeldShape, resizeShapePoints, shapeResizeAnchor, shapeResizeHandle, SHAPE_RECOGNITION_HOLD_MS, type ShapeRecognition } from "../tools/ShapeRecognizer";
import { boundingShapeFromSelection, filterSelectableStrokes, selectStrokes, selectionShapeArea, shapeBounds, shapeContainsPoint, translateShape, type SelectionShape } from "../tools/LassoTool";
import { drawHighlighterStroke, drawHighlighterStrokeWithMasks } from "../tools/HighlighterTool";
import {
  drawLaserStroke,
  laserTrailStillVisible,
  mapLaserPoints
} from "../tools/LaserTool";
import { drawGraphiteStroke, seedFromId } from "../tools/PencilTool";
import { drawPenStroke } from "../tools/PenTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import { insertPageIntoSidecar, removePageFromSidecar } from "../storage/SidecarPageRemoval";
import { pickNewerSidecar, serializeSidecar, countSidecarStrokes, countSidecarTexts, type SidecarSchemaV1 } from "../storage/SidecarSchema";
import type { VaultSyncWriter } from "../storage/VaultSyncWriter";
import { AnnotationToolbar, type MoreAction } from "../ui/AnnotationToolbar";
import { inkBackingBudget, inkBackingSize } from "./inkBackingSize";
import type { DebugState } from "../ui/DebugPanel";
import { SelectionToolbar, type ViewportPoint } from "../ui/SelectionToolbar";
import { SessionLogger, type DrawPositionLog, type ViewStateSource } from "../logging/SessionLogger";
import type { VaultLogSink } from "../logging/VaultLogSink";
import type { PdfViewState } from "../integration/ObsidianPdfAdapter";
import { describeScrollElement, scrollPdfByDetailed } from "../integration/PdfScrollRoot";
import { TextAnnotationSession } from "../text/TextAnnotationSession";
import { AddTextAnnotationCommand, DeleteTextAnnotationsCommand, ReplaceTextAnnotationCommand } from "../text/TextAnnotationCommands";
import type { TextStyleChange } from "../ui/TextDropdown";
import { insertStyledText, readTextRuns, renderTextRuns, rescaleTextRuns, restoreSelection, selectionOffsets, type TextSelectionOffsets } from "../text/RichTextDom";
import { normalizeTextRuns, patchTextRunRange, plainTextFromRuns, plainTextToRuns, styleAtTextOffset } from "../text/RichTextRuns";
import {
  emitHnDevProbeDiagnostic,
  isHnDevProbeActive,
  type HnDevProbeDiagnostic,
  type HnDevProbeMetric
} from "./DevProbeDiagnostics";

const INPUT_OWNER_REGISTRY_KEY = "__nativePdfHandwritingInputOwners";
const detachedInputOwners = new WeakMap<HTMLElement, ViewerInkSession>();
const wheelPanReplayDepth = new WeakMap<Document, number>();

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

export interface SessionDiagnostics {
  pdfPath: string;
  compatibility: { errors: string[]; warnings: string[] };
  debug: DebugState;
}

export interface ViewerInkSessionOptions {
  adapter: ObsidianPdfAdapter;
  pdfPath: string;
  settings: PluginSettings;
  sidecars: SidecarRepository;
  recovery: RecoveryRepository;
  saveSettings(preferences: ToolPreferences): Promise<void>;
  savePluginSettings?(patch: Partial<PluginSettings>): Promise<void>;
  readSourcePdf(): Promise<Uint8Array>;
  writeExport(name: string, bytes: Uint8Array): Promise<string | void>;
  /** Writes a separate selected-ink SVG beside the source PDF. */
  writeSvgExport?(this: void, name: string, svg: string): Promise<string | void>;
  /** Inserts a blank page at the requested one-indexed PDF position. */
  onInsertPage?(requestedPageNumber: number): Promise<number>;
  /** Removes one source-PDF page and remaps its persisted annotations. */
  onDeletePage?(pageNumber: number): Promise<void>;
  /** Removes multiple source-PDF pages and remaps persisted annotations once. */
  onDeletePages?(pageNumbers: readonly number[]): Promise<void>;
  notice(message: string): void;
  decideUnsaved?(): Promise<CloseChoice>;
  mouseDragScrollEnabled?(): boolean;
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
  runtimePlatform?: () => { mobile: boolean; phone: boolean };
}

interface LaserTrail {
  id: string;
  page: number;
  points: PdfPoint[];
  color: string;
  width: number;
  opacity: number;
  holdMs: number;
  fadeMs: number;
}

interface PageSurface {
  page: PdfPageInfo;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Ephemeral active-stroke layer. The committed ink canvas stays untouched while drawing. */
  draftCanvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  context: CanvasRenderingContext2D;
  draftContext: CanvasRenderingContext2D;
  /** Committed-stroke cache — blit for live draw + zoom settle before HQ rebuild. */
  inkLayer: HTMLCanvasElement | null;
  inkLayerContext: CanvasRenderingContext2D | null;
  inkLayerValid: boolean;
  /** BackingScale used when inkLayer was last filled by vector paint (not burst bitmap capture). */
  inkLayerBackingScale: number | null;
  /** True if inkLayer was warmed by zoom-burst canvas capture (raster, not canonical). */
  inkLayerBurstCapture: boolean;
  /** Off-viewport page skipped a canonical paint and must redraw before display. */
  viewportCullPending: boolean;
  /** Neighbor zoom settle used blit-stretch / lower backing; needs idle HQ upgrade. */
  settleUpgradePending: boolean;
  router: PointerRouter | null;
  livePaintFrame: number | null;
  pendingLivePaint: { kind: "draw" | "edit"; syncText: boolean; sampleCount: number; event?: PointerEvent } | null;
  /** Prefix of editPath already represented by the destructive live eraser preview. */
  liveEraserPaintedPoints: number;
  /** Prefix of live stroke preview already stamped on draftCanvas (incremental paint). */
  liveDrawPaintedPoints: number;
  builder: StrokeBuilder | undefined;
  /** Stroke-local input conditioning; never changes already-captured ink. */
  pressureConditioner: PressureConditioner | undefined;
  /** Previous canonical point used for distance-aware pressure conditioning. */
  pressureLastPdfPoint: Pick<PdfPoint, "x" | "y"> | undefined;
  /** Mouse fallback captured with the drawing style at pointer-down. */
  simulateMousePressure: boolean;
  /** True while the live StrokeBuilder is a non-persisted laser draft. */
  laserDraft: boolean;
  /** Samples dropped from the current ephemeral laser draft. */
  laserDiscardedPoints: number;
  shapeHoldTimer: number | null;
  shapePreview: PdfPoint[] | null;
  shapeResize: ShapeResize | null;
  editPath: PdfPoint[];
  editTool: "eraser" | "lasso" | undefined;
  eraserSize: number | undefined;
  eraserWholeStrokes: boolean | undefined;
  textIntent: { start: PdfPoint; hit: PdfTextAnnotation | null; pointerType: string } | null;
}

/** A one-shot bitmap cover kept alive while Obsidian replaces a source PDF. */
interface PageMutationShield {
  element: HTMLElement;
  action: "delete" | "insert";
  pageNumber: number;
  capturedPages: number;
  timeout: number | null;
}

interface ActiveTextEditor {
  surface: PageSurface;
  existing: PdfTextAnnotation | null;
  draft: PdfTextAnnotation;
  style: TextStyle;
  /** Canonical text formatting; DOM is synchronized after input but not re-rendered. */
  runs: PdfTextRun[];
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
  start: PdfPoint;
  before: PdfTextAnnotation;
  preview: PdfTextAnnotation;
}

type TextBoxHandle = "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

/** A selection-frame drag; the committed text DOM does not reflow until release. */
interface TextBoxTransformDrag {
  surface: PageSurface;
  pointerId: number;
  start: Pick<PdfPoint, "x" | "y">;
  before: PdfTextAnnotation;
  preview: PdfTextAnnotation;
  mode: "move" | "resize";
  handle: TextBoxHandle;
  /** Static box translated live for Move; resize keeps its text stationary. */
  box: HTMLElement;
  outline: HTMLElement;
  abort: AbortController;
}

interface ShapeResize {
  recognition: ShapeRecognition;
  anchor: PdfPoint;
  handle: PdfPoint;
}

export class ViewerInkSession {
  private readonly ink = new InkSession();
  private readonly texts = new TextAnnotationSession();
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly ownedInputPages = new Set<HTMLElement>();
  private readonly exporter = new PdfExportService();
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  private readonly selectionToolbar: SelectionToolbar;
  private readonly history: CommandHistory;
  /** Pages dirtied by the next history.execute — avoids full multi-page refresh. */
  private readonly historyDirtyPages = new Set<number>();
  /** Pages already painted by the history callback in this turn. */
  private readonly historyPaintedPages = new Set<number>();
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  private selected: InkStroke[] = [];
  private selectedTexts: PdfTextAnnotation[] = [];
  private selectionShape: SelectionShape | null = null;
  private selectionPage: number | null = null;
  private moveDrag: { page: number; start: PdfPoint; before: InkStroke[]; beforeTexts: PdfTextAnnotation[]; beforeShape: SelectionShape } | null = null;
  private movePreview: InkStroke[] | null = null;
  private moveTextPreview: PdfTextAnnotation[] | null = null;
  private moveShapePreview: SelectionShape | null = null;
  private activeTextEditor: ActiveTextEditor | null = null;
  private textMoveDrag: TextMoveDrag | null = null;
  private textBoxTransformDrag: TextBoxTransformDrag | null = null;
  private textToolActive = false;
  private temporaryStylusEraserPointers = 0;
  /** Hold Cmd/Ctrl while drawing to route the next gesture through Eraser. */
  private readonly temporaryModifierEraserKeys = new Set<"Control" | "Meta">();
  private drawEnabled = false;
  private debugState: DebugState = {};
  private destroyed = false;
  private detachNotified = false;
  private persistEpoch = 0;
  private alreadyEmergencyPersisted = false;
  private writesAbandoned = false;
  private detachCheckTimer: number | null = null;
  private refreshDepth = 0;
  private resizeFrame: number | null = null;
  private viewportPaintFrame: number | null = null;
  private pendingScheduledRefresh: { reason: string; repaintOnly: boolean } | null = null;
  /** Trailing debounce for mobile scroll remounts (rAF alone still storms every frame). */
  private mobileScrollRefreshTimer: number | null = null;
  /** Remount after zoom/handoff if scroll/pagechanging arrived while compositing. */
  private pendingMobileScrollRemount = false;
  private zoomSettleTimer: number | null = null;
  private zoomBurstStartedAt = 0;
  private zoomTickCount = 0;
  private zoomBurstScaleStart: number | null = null;
  private zoomBurstScaleEnd: number | null = null;
  /** Last observed PDF.js scale — burst baseline for single-tick delta coalesce. */
  private lastKnownViewScale: number | null = null;
  private zoomBurstReason = "view-scalechanging";
  /** Delayed release avoids exposing an ink redraw before PDF.js finishes its own render. */
  private zoomCompositeReleaseFrame: number | null = null;
  private zoomCompositeReleaseTimer: number | null = null;
  private zoomCompositeSettledAt = 0;
  private zoomNativeContentMutations = 0;
  private lastZoomNativeContentAt = 0;
  /** Native PDF.js can change page geometry after our first zoom settle. */
  private zoomHandoffNeedsFinalRebase = false;
  /** One durable coordinate breadcrumb per page for each text-bearing zoom burst. */
  private readonly zoomTextLayoutLoggedPages = new Set<number>();
  /** First and final ink-anchor snapshots expose zoom coordinate drift without stroke data. */
  private readonly zoomInkLayoutLoggedPhases = new Set<string>();
  private readonly zoomInkAnchorByPage = new Map<number, { normalizedX: number; normalizedY: number }>();
  private laserTrails: LaserTrail[] = [];
  private laserFadeFrame: number | null = null;
  private lastLaserPaintAt = 0;
  /** Laser fade loop caps ~30fps — full page repaint every frame is too heavy. */
  private static readonly LASER_FADE_MIN_MS = 32;
  /** Bound CPU, allocations, and canvas commands for high-rate stylus input. */
  private static readonly MAX_LASER_DRAFT_POINTS = 1024;
  private lastZoomSignalAt = 0;
  private zoomCompositing = false;
  /** Visible pages still needing settle paint (one page per rAF). */
  private zoomSettleQueue: Array<{ page: number; tier: "focus" | "neighbor" }> = [];
  private zoomSettleSliceFrame: number | null = null;
  private zoomSettleSliceStartedAt = 0;
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
  /** Absolute PDF.js scale delta treated as a micro-nudge (below ~one wheel notch). */
  private static readonly ZOOM_SETTLE_TINY_SCALE_DELTA = 0.02;
  /** Relative scale delta gate paired with {@link ZOOM_SETTLE_TINY_SCALE_DELTA}. */
  private static readonly ZOOM_SETTLE_TINY_RELATIVE = 0.015;
  /** Must cover ZOOM_SETTLE_MS so gesture-active / handoff guards hold through coalesce. */
  private static readonly ZOOM_ACTIVE_MS = 600;
  /** Retry settle while a live stroke/edit is in progress (avoid wiping draft mid-drag). */
  private static readonly ZOOM_SETTLE_LIVE_INK_RETRY_MS = 120;
  private static readonly MOBILE_SCROLL_REFRESH_MS = 200;
  /** PDF.js usually swaps canvas/text layers hundreds of ms after scalechanging. */
  private static readonly ZOOM_NATIVE_RENDER_GRACE_MS = 500;
  /** Do not release during the tail of a native page-content replacement burst. */
  private static readonly ZOOM_NATIVE_RENDER_QUIET_MS = 120;
  /** Detect back-to-back page paints during handoff (flash proxy). */
  private static readonly FLASH_DOUBLE_PAINT_MS = 50;
  private readonly lastPagePaintAt = new Map<number, { at: number; reason: string }>();
  private pasteGeneration = 0;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly logger: SessionLogger;
  private readonly viewerMousePan: ViewerMousePan;
  private readonly pullToAddPage: PullToAddPageGesture | null;
  private readonly thumbnailSidebarActions: PdfThumbnailSidebarActions | null;
  private pageMutationInFlight = false;
  private readonly findBridge: AnnotationFindBridge;
  /** Last applied browser direct-manipulation policy for mounted PDF pages. */
  private touchDrawPolicyEnabled: boolean | null = null;
  private readonly pointerProbeAbort = new AbortController();
  /** Dedup document fallback vs page-router handleDown for the same pointerId. */
  private readonly handledDrawPointers = new Set<number>();
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
    this.identity = createDocumentIdentity({ vaultPath: options.pdfPath });
    this.logger = new SessionLogger(options.pdfPath, options.vaultLog, options.debugEnabled);
    this.textToolActive = options.settings.toolPreferences.activeTool === "text";
    this.logger.textTool("tool-initial", {
      active: this.textToolActive,
      drawEnabled: this.drawEnabled,
      fontSize: options.settings.toolPreferences.text.fontSize,
      fontFamily: options.settings.toolPreferences.text.fontFamily
    });
    this.toolbar = new AnnotationToolbar({
      ownerDocument: options.adapter.host.ownerDocument,
      preferences: options.settings.toolPreferences,
      autosave: options.settings.autosave,
      drawEnabled: this.drawEnabled,
      supportedMoreActions: (options.runtimePlatform?.().mobile ?? false)
        ? ["export", "export-editable", "toolbar-left", "toolbar-right"]
        : ["export", "export-editable", "toolbar-main", "toolbar-left", "toolbar-right"],
      callbacks: {
        onPreferencesChange: (preferences, reason = "general") => {
          const wasTextToolActive = this.textToolActive;
          this.textToolActive = preferences.activeTool === "text";
          if (wasTextToolActive !== this.textToolActive) {
            this.logger.textTool(this.textToolActive ? "tool-activate" : "tool-deactivate", {
              activeTool: preferences.activeTool,
              drawEnabled: this.drawEnabled,
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
        onTextStyleChange: (change) => this.applyTextStyleToActiveEditor(change),
        onTextFormatPointerDown: () => this.captureActiveTextSelection("toolbar-pointerdown"),
        activeTextStyle: () => this.activeTextStyle(),
        onDrawModeChange: (enabled) => {
          this.drawEnabled = enabled;
          if (!enabled) {
            this.clearSelection();
            this.clearTemporaryEraserModifier();
          }
          this.logMousePanConfig("draw-mode");
          // Chrome/cursors only — full refresh invalidates ink and flashes after zoom blit.
          this.refreshToolChrome("draw-mode");
        },
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
    this.autosave = new AutosaveQueue<SidecarSchemaV1>({
      delayMs: options.settings.autosaveDelayMs,
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
      }
    });
    this.saveCoordinator = new SaveCoordinator({
      autosave: options.settings.autosave,
      saveWhenClosing: options.settings.saveWhenClosing,
      save: () => this.persist(this.snapshot(), "manual"),
      scheduleAutosave: () => this.autosave.schedule(this.identity.id, this.snapshot())
    });
    this.history = new CommandHistory(() => {
      this.saveCoordinator.completedCommand();
      this.toolbar.setSaveStatus("dirty");
      this.paintAfterHistory();
    });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.handleRootResize());
    this.resizeObserver?.observe(options.adapter.root);
    const adapter = options.adapter;
    this.viewerMousePan = new ViewerMousePan(adapter.host.ownerDocument, {
      enabled: () => !this.drawEnabled && (this.options.mouseDragScrollEnabled?.() ?? this.options.settings.mouseDragScroll),
      // Fingers: native PDF viewer only. Custom touch pan fights pinch/scroll remounts on phone.
      touchPanEnabled: () => false,
      scrollRoot: () => adapter.scrollElement(),
      withinTarget: (target) => {
        if (!(target instanceof Element)) return false;
        if (target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar")) return false;
        // The native PDF sidebar and its resize handle share the leaf host but
        // must keep their own pointer handling. Only pan from the PDF viewport.
        return adapter.root.contains(target);
      },
      captureElement: () => adapter.root,
      onPan: (phase, event, details) => {
        this.logMousePan(phase, event, details);
        this.feedPullToAddFromPan(phase, details);
      }
    });
    this.pullToAddPage = options.onInsertPage
      ? new PullToAddPageGesture(adapter.host.ownerDocument, {
        enabled: () => !this.destroyed && typeof this.options.onInsertPage === "function",
        isBusy: () => Boolean(this.pageMutationShield) || this.pendingInsertedPageFocus !== null,
        isDrawing: () => this.drawEnabled,
        scrollRoot: () => adapter.scrollElement(),
        host: () => adapter.root,
        withinTarget: (target) => {
          if (!(target instanceof Element)) return false;
          if (target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar")) {
            return false;
          }
          return adapter.root.contains(target);
        },
        onCommit: () => this.addPageAt(Number.MAX_SAFE_INTEGER),
        onLog: (phase, details) => this.logger.pullToAdd(phase, details)
      })
      : null;
    this.thumbnailSidebarActions = options.onDeletePage && options.onInsertPage
      ? new PdfThumbnailSidebarActions(adapter.host, {
        onAddPage: (pageNumber) => this.addPageAt(pageNumber),
        onDeletePage: (pageNumber) => this.deletePage(pageNumber),
        ...(options.onDeletePages
          ? { onDeletePages: (pageNumbers: readonly number[]) => this.deletePages(pageNumbers) }
          : {}),
        onMenuEvent: (phase, details) => this.logger.thumbnailMenu(phase, details)
      })
      : null;
    this.findBridge = new AnnotationFindBridge({
      getFindController: () => adapter.findController?.() ?? null,
      getEventBus: () => adapter.eventBus?.() ?? null,
      getPageElement: (pageNumber) => adapter.page(pageNumber)?.element ?? null,
      getNativeTextLayer: (pageNumber) => adapter.nativeTextLayer?.(pageNumber) ?? null,
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
    });
    this.installPointerProbe(adapter);
  }

  private installPointerProbe(adapter: ViewerInkSessionOptions["adapter"]): void {
    const doc = adapter.host.ownerDocument;
    const options = { capture: true, signal: this.pointerProbeAbort.signal };
    let wheelPinchCount = 0;
    let lastWheelLogAt = 0;
    let wheelPanCount = 0;
    let lastWheelPanLogAt = 0;
    const within = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return adapter.host.contains(target) || adapter.root.contains(target);
    };
    const withinNativePdfSidebar = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest(
        ".pdf-sidebar-container, .pdf-sidebar, .pdf-thumbnail-view, .pdf-outline-view"
      ));
    };
    const targetLabel = (target: EventTarget | null): string => {
      if (target === null) return "null";
      if (!(target instanceof Element)) return Object.prototype.toString.call(target);
      const tag = target.tagName.toLowerCase();
      const classes = [...target.classList].slice(0, 3).join(".");
      return classes ? `${tag}.${classes}` : tag;
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
      phase: "in-view" | "sidebar" | "outside-viewer" | "no-scroll-root",
      details: Record<string, unknown>
    ): void => {
      const now = performance.now();
      wheelPanCount += 1;
      if (wheelPanCount > 1 && now - lastWheelPanLogAt < 80) return;
      lastWheelPanLogAt = now;
      this.logger.pointerSeen({
        source: "wheel-pan",
        pointerType: "wheel",
        phase,
        ...details,
        burstIndex: wheelPanCount
      });
    };
    doc.addEventListener("pointerdown", (e: PointerEvent) => {
      const hitPage = this.closestPdfPageElement(e.target);
      this.logger.pointerSeen({
        source: "pointerdown",
        pointerType: e.pointerType || "(empty)",
        pointerId: e.pointerId,
        isPrimary: e.isPrimary,
        button: e.button,
        buttons: e.buttons,
        width: e.width,
        height: e.height,
        pressure: e.pressure,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        within: within(e.target),
        target: targetLabel(e.target),
        targetId: getDebugNodeId(e.target),
        hitPageId: getDebugNodeId(hitPage),
        hasDataPageNumber: Boolean(hitPage?.hasAttribute("data-page-number")),
        dataPageNumber: hitPage?.dataset.pageNumber ?? null,
        drawEnabled: this.drawEnabled
      });
      // Capture: own pen/mouse draw sync here. Page capture can stay deaf after
      // zoom while binds/alive still look healthy; bubble never runs if something
      // stops the event mid-descent. Microtask is too late for preventDefault.
      this.captureDrawPointerFallback(e, within);
    }, { ...options, passive: false });
    // Bubble: if the page router never marked the pointer, own the stroke here.
    doc.addEventListener("pointerdown", (e: PointerEvent) => {
      this.bubbleDrawPointerFallback(e, within);
    }, { capture: false, signal: this.pointerProbeAbort.signal, passive: false });
    const clearHandled = (e: PointerEvent): void => {
      this.handledDrawPointers.delete(e.pointerId);
    };
    doc.addEventListener("pointerup", clearHandled, options);
    doc.addEventListener("pointercancel", clearHandled, options);
    doc.addEventListener("touchstart", (e: TouchEvent) => {
      const touches = [...e.changedTouches].map((touch) => ({
        identifier: touch.identifier,
        clientX: Math.round(touch.clientX),
        clientY: Math.round(touch.clientY),
        radiusX: touch.radiusX,
        radiusY: touch.radiusY,
        force: touch.force
      }));
      this.logger.pointerSeen({
        source: "touchstart",
        pointerType: "touch",
        touchCount: e.touches.length,
        changedCount: e.changedTouches.length,
        within: within(e.target),
        target: targetLabel(e.target),
        touches
      });
    }, { ...options, passive: true });
    // Mac trackpad pinch = wheel+ctrl in Chromium/Electron — not pointerType "touch".
    // MockTab two-finger pan = plain continuous wheel. This document-capture
    // listener sees every Obsidian pane, so only own events in the PDF view;
    // native thumbnail/outline sidebars must retain their own scrolling.
    doc.addEventListener("wheel", (e: WheelEvent) => {
      if (isReplayingWheelPan(doc)) return;
      if (e.ctrlKey || e.metaKey) {
        const now = performance.now();
        wheelPinchCount += 1;
        if (wheelPinchCount > 1 && now - lastWheelLogAt < 80) return;
        lastWheelLogAt = now;
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
          target: targetLabel(e.target),
          burstIndex: wheelPinchCount
        });
        return;
      }
      if (e.deltaX === 0 && e.deltaY === 0) return;
      if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
      const root = adapter.scrollElement();
      const inViewer = within(e.target);
      const target = targetLabel(e.target);
      if (withinNativePdfSidebar(e.target)) {
        logWheelPan("sidebar", { deltaX: e.deltaX, deltaY: e.deltaY, within: inViewer, target });
        return;
      }
      if (!inViewer) {
        logWheelPan("outside-viewer", { deltaX: e.deltaX, deltaY: e.deltaY, within: false, target });
        return;
      }
      if (!root) {
        logWheelPan("no-scroll-root", { deltaX: e.deltaX, deltaY: e.deltaY, within: inViewer, target });
        return;
      }
      e.preventDefault();
      const changed = applyWheelPan(root, e.deltaX, e.deltaY, e.clientX, e.clientY);
      logWheelPan("in-view", { deltaX: e.deltaX, deltaY: e.deltaY, within: true, target, changed });
    }, { ...options, passive: false });
    // Safari / some WebKit builds expose gesture* for pinch.
    for (const name of ["gesturestart", "gesturechange", "gestureend"] as const) {
      doc.addEventListener(name, (event) => {
        const e = event as Event & { scale?: number; rotation?: number };
        this.logger.pointerSeen({
          source: name,
          pointerType: "gesture",
          scale: e.scale,
          rotation: e.rotation,
          within: within(e.target),
          target: targetLabel(e.target)
        });
      }, options);
    }
  }


  /** Paint pages deferred by viewport culling / cheap neighbor settle once handoff ends. */
  private scheduleViewportPaint(): void {
    if (this.destroyed || this.viewportPaintFrame !== null || this.isZoomHandoffActive()) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    this.viewportPaintFrame = view.requestAnimationFrame(() => {
      this.viewportPaintFrame = null;
      if (this.destroyed || this.isZoomHandoffActive()) return;
      for (const surface of this.surfaces.values()) {
        const needsUpgrade = surface.viewportCullPending || surface.settleUpgradePending;
        if (!needsUpgrade || !this.surfaceNearViewport(surface)) continue;
        const reason = surface.settleUpgradePending && !surface.viewportCullPending
          ? "settle-upgrade"
          : "viewport-enter";
        this.renderPage(surface.page.pageNumber, undefined, reason);
      }
    });
  }

  private scheduleRefresh(reason: string, repaintOnly = false): void {
    if (this.destroyed) return;
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
        this.pendingMobileScrollRemount = true;
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
      if (pending.repaintOnly) this.repaintSurfaces(pending.reason);
      else this.refresh(pending.reason);
    });
  }

  /** Coalesce mobile scroll/pagechanging remounts; skip while zoom/handoff active. */
  private scheduleMobileScrollRefresh(): void {
    if (this.destroyed || !this.runtimePlatform().mobile) return;
    if (this.isZoomGestureActive() || this.isZoomHandoffActive()) {
      this.pendingMobileScrollRemount = true;
      this.scheduleZoomRepaint("view-scroll-mobile", this.options.adapter.getViewState().scale);
      return;
    }
    if (this.mobileScrollRefreshTimer !== null) {
      window.clearTimeout(this.mobileScrollRefreshTimer);
    }
    this.mobileScrollRefreshTimer = window.setTimeout(() => {
      this.mobileScrollRefreshTimer = null;
      if (this.destroyed) return;
      if (this.isZoomGestureActive() || this.isZoomHandoffActive()) {
        this.pendingMobileScrollRemount = true;
        return;
      }
      this.refresh("view-scroll-mobile");
    }, ViewerInkSession.MOBILE_SCROLL_REFRESH_MS);
  }

  private flushPendingMobileScrollRemount(): void {
    if (!this.pendingMobileScrollRemount || this.destroyed) return;
    this.pendingMobileScrollRemount = false;
    if (!this.runtimePlatform().mobile) return;
    this.scheduleMobileScrollRefresh();
  }

  private mobileMountSetUnchanged(pages: PdfPageInfo[]): boolean {
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

  private scheduleZoomRepaint(reason: string, scale?: number): void {
    if (this.destroyed) return;
    const now = performance.now();
    this.lastZoomSignalAt = now;
    if (!this.zoomBurstStartedAt || now - this.zoomBurstStartedAt > ViewerInkSession.ZOOM_ACTIVE_MS) {
      this.zoomBurstStartedAt = now;
      this.zoomTickCount = 0;
      // Prefer pre-burst scale so a single large jump is not treated as delta=0.
      this.zoomBurstScaleStart = this.lastKnownViewScale ?? scale ?? null;
      this.zoomTextLayoutLoggedPages.clear();
      this.zoomInkLayoutLoggedPhases.clear();
      this.zoomInkAnchorByPage.clear();
      this.zoomHandoffNeedsFinalRebase = false;
      this.reportDevProbe("zoom-burst-start", {
        reason,
        scale: scale ?? null,
        surfaces: this.surfaces.size
      });
    }
    this.zoomTickCount += 1;
    this.zoomBurstReason = reason;
    // Only freeze ink bitmap during real zoom/rotation — pages-dom storms must keep repainting.
    if (ViewerInkSession.shouldCompositeDuring(reason) && !this.zoomCompositing) {
      this.beginZoomCompositing();
    }
    // Burst: keep overlay box glued to PDF canvas content box; skip stroke redraw.
    if (this.zoomCompositing) this.syncZoomOverlayLayouts();
    this.refreshSurfaceCursors();
    if (scale !== undefined) {
      if (this.zoomBurstScaleStart === null) this.zoomBurstScaleStart = scale;
      this.zoomBurstScaleEnd = scale;
      this.lastKnownViewScale = scale;
    }
    const settleMs = this.zoomSettleCoalesceMs(scale);
    this.logger.zoomTick({
      reason,
      tick: this.zoomTickCount,
      settleMs,
      ...(scale !== undefined ? { scale: Number(scale.toFixed(4)) } : {})
    });
    if (this.zoomSettleTimer !== null) window.clearTimeout(this.zoomSettleTimer);
    this.zoomSettleTimer = window.setTimeout(() => {
      this.zoomSettleTimer = null;
      this.runZoomSettlePaint();
    }, settleMs);
  }

  /**
   * Long coalesce covers stepped trackpad gaps (~200–500ms). Tiny absolute+relative
   * scale deltas use the short quiet window so micro-nudges feel instant.
   * Baseline is the pre-burst scale (`zoomBurstScaleStart`), never the first tick
   * alone (that would make every single-tick jump look like delta 0).
   */
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
    return false;
  }

  private hasAnyLiveInkInput(): boolean {
    for (const surface of this.surfaces.values()) {
      if (this.surfaceHasLiveInkInput(surface)) return true;
    }
    return false;
  }

  private runZoomSettlePaint(): void {
    if (this.destroyed) return;
    // Keep CSS compositing + draft canvas intact until the tip lifts. Mid-drag
    // settle was clearing the live draft and force-rebinding routers (log proof).
    if (this.hasAnyLiveInkInput()) {
      this.lastZoomSignalAt = performance.now();
      this.logger.zoomComposite("settle-deferred", {
        reason: "live-ink",
        pages: this.surfaces.size,
        retryMs: ViewerInkSession.ZOOM_SETTLE_LIVE_INK_RETRY_MS
      });
      this.zoomSettleTimer = window.setTimeout(() => {
        this.zoomSettleTimer = null;
        this.runZoomSettlePaint();
      }, ViewerInkSession.ZOOM_SETTLE_LIVE_INK_RETRY_MS);
      return;
    }
    const burstTicks = this.zoomTickCount;
    const burstDurationMs = roundMs(performance.now() - this.zoomBurstStartedAt);
    const scaleStart = this.zoomBurstScaleStart;
    const scaleEnd = this.zoomBurstScaleEnd;
    this.zoomBurstStartedAt = 0;
    this.zoomTickCount = 0;
    this.zoomBurstScaleStart = null;
    this.zoomBurstScaleEnd = null;
    this.lastZoomSignalAt = 0;
    this.cancelZoomSettleSlice();
    this.endZoomCompositing();
    this.zoomCompositeSettledAt = performance.now();
    this.zoomSettleSliceStartedAt = this.zoomCompositeSettledAt;
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
      for (const item of this.zoomSettleQueue) {
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
   * Remaining surfaces settle as cheap neighbors under the CSS mask.
   */
  private zoomSettlePageOrder(): { focus: number | null; neighbors: number[] } {
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const ranked = [...this.surfaces.entries()].map(([pageNumber, surface]) => ({
      pageNumber,
      area: this.surfaceViewportIntersectionArea(surface)
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

  private surfaceViewportIntersectionArea(surface: PageSurface): number {
    const view = this.options.adapter.host.getBoundingClientRect();
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
      this.logger.zoomComposite("settle-deferred", {
        reason: "live-ink-slice",
        remaining: this.zoomSettleQueue.length,
        retryMs: ViewerInkSession.ZOOM_SETTLE_LIVE_INK_RETRY_MS
      });
      this.zoomSettleTimer = window.setTimeout(() => {
        this.zoomSettleTimer = null;
        this.paintZoomSettleSlice();
      }, ViewerInkSession.ZOOM_SETTLE_LIVE_INK_RETRY_MS);
      return;
    }
    if (this.zoomSettleQueue.length === 0) {
      this.finishZoomSettleSlices();
      return;
    }

    const item = this.zoomSettleQueue.shift()!;
    this.paintOneZoomSettlePage(item.page, item.tier);

    if (this.zoomSettleQueue.length === 0) {
      this.finishZoomSettleSlices();
      return;
    }
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      for (const next of this.zoomSettleQueue) {
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
        if (!this.surfaceHasLiveInkInput(surface)) {
          this.ensurePageRouter(surface, { force: true, reason });
        } else {
          this.ensurePageRouter(surface, { reason: `${reason}-live-ink` });
        }
        const upgradeBefore = surface.settleUpgradePending;
        const painted = this.renderPage(pageNumber, this.zoomSettleStats, reason);
        this.logZoomInkLayout(surface, "settle");
        if (painted) this.zoomSettleStats.pagesRepainted += 1;
        else if (surface.viewportCullPending) {
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
    this.logger.zoomComposite("settle-slice", {
      page: pageNumber,
      tier,
      path: paintPath,
      durationMs: roundMs(performance.now() - started),
      remaining: this.zoomSettleQueue.length,
      pagesRepainted: this.zoomSettleStats.pagesRepainted,
      strokesRedrawn: this.zoomSettleStats.strokesRedrawn - strokesBefore,
      canvasesResized: this.zoomSettleStats.canvasesResized - resizedBefore,
      skippedBlitOnly: this.zoomSettleStats.skippedBlitOnly - blitBefore
    });
  }

  private finishZoomSettleSlices(): void {
    const burst = this.zoomSettleBurst;
    const stats = this.zoomSettleStats;
    const durationMs = roundMs(performance.now() - this.zoomSettleSliceStartedAt);
    this.ensureSelectionToolbar();
    this.refreshSurfaceCursors();
    const view = this.options.adapter.getViewState();
    if (durationMs >= 16 && this.isZoomHandoffActive()) {
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

  private beginZoomCompositing(): void {
    this.cancelZoomCompositeRelease();
    this.cancelZoomSettleSlice();
    this.zoomCompositeSettledAt = 0;
    this.zoomNativeContentMutations = 0;
    this.lastZoomNativeContentAt = 0;
    this.zoomHandoffNeedsFinalRebase = false;
    this.zoomCompositing = true;
    for (const surface of this.surfaces.values()) {
      this.captureInkLayerFromCanvas(surface);
      surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
    }
    this.logger.zoomComposite("begin", { pages: this.surfaces.size });
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

  private hasZoomCompositingClass(): boolean {
    for (const surface of this.surfaces.values()) {
      if (surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) return true;
    }
    return false;
  }

  /**
   * PDF.js asynchronously replaces its canvas/text layers after scalechanging.
   * Keep our already-positioned layer over that native transition, then allow
   * two browser paints only after the native replacement has gone quiet.
   */
  private releaseZoomCompositeAfterNativeRender(): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.releaseZoomCompositeLayers();
      return;
    }
    this.cancelZoomCompositeRelease();
    const now = performance.now();
    const settledAt = this.zoomCompositeSettledAt || now;
    const nativeRenderReadyAt = settledAt + ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS;
    const nativeContentQuietAt = this.lastZoomNativeContentAt > 0
      ? this.lastZoomNativeContentAt + ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS
      : nativeRenderReadyAt;
    const releaseAt = Math.max(nativeRenderReadyAt, nativeContentQuietAt);
    const delayMs = Math.max(0, releaseAt - now);
    this.logger.zoomComposite("release-scheduled", {
      pages: this.surfaces.size,
      delayMs: roundMs(delayMs),
      nativeContentMutations: this.zoomNativeContentMutations,
      sinceSettleMs: roundMs(now - settledAt)
    });
    this.zoomCompositeReleaseTimer = window.setTimeout(() => {
      this.zoomCompositeReleaseTimer = null;
      this.zoomCompositeReleaseFrame = view.requestAnimationFrame(() => {
        this.zoomCompositeReleaseFrame = view.requestAnimationFrame(() => {
          this.zoomCompositeReleaseFrame = null;
          if (this.destroyed || this.zoomCompositing) return;
          this.releaseZoomCompositeLayers();
        });
      });
    }, delayMs);
  }

  /** Adapter breadcrumb for the native PDF.js canvas/text layer replacement. */
  onPdfPageContentMutation(recordCount: number): void {
    if (this.destroyed) return;
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
    const releasePending = this.zoomCompositing
      || this.zoomCompositeReleaseTimer !== null
      || this.zoomCompositeReleaseFrame !== null;
    const handoffGuard = releasePending || settleSlicesPending || this.hasZoomCompositingClass();
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
    if (!handoffGuard && !reattached) return;
    const now = performance.now();
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

    if (handoffGuard && this.isZoomHandoffActive()) {
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
    this.rebaseZoomAfterNativeRender();
    const now = performance.now();
    if (this.lastZoomNativeContentAt > 0) {
      const msSinceNative = now - this.lastZoomNativeContentAt;
      if (msSinceNative < ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS) {
        this.logger.zoomFlashProxy("release-while-native-mutating", {
          msSinceNative: roundMs(msSinceNative),
          nativeContentMutations: this.zoomNativeContentMutations
        });
      }
    }
    for (const surface of this.surfaces.values()) {
      surface.overlay.classList.remove("native-pdf-handwriting-zoom-compositing");
    }
    this.logger.zoomComposite("release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null
    });
    this.reportDevProbe("zoom-composite-release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null
    });
    this.zoomCompositeSettledAt = 0;
    this.zoomHandoffNeedsFinalRebase = false;
    // Scroll/pagechanging during pinch deferred remount until CSS handoff ends.
    this.flushPendingMobileScrollRemount();
    // Strict settle may have deferred off-screen pages; idle-margin prefetch once handoff ends.
    this.scheduleViewportPaint();
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
  private syncZoomOverlayLayouts(phase: "burst" | "native-content" = "burst"): void {
    const pages = this.options.adapter.pages();
    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = byNumber.get(pageNumber);
      if (!current) continue;
      if (!this.reattachSurface(surface, current)) {
        // Page node replaced while the overlay stayed on the old node — move
        // both overlay and page-bound PointerRouter onto the live page.
        if (current.element.isConnected) {
          this.remountSurfaceOnPageReplacement(surface, current);
        } else {
          continue;
        }
      }
      this.ensurePageRouter(surface);
      surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
      this.syncOverlayLayout(surface);
      this.syncTextLayoutDuringZoom(surface);
      this.logZoomInkLayout(surface, phase);
    }
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
      canvasesResized: 0,
      strokesRedrawn: 0,
      skippedDisconnected: 0,
      skippedCulled: 0,
      skippedBlitOnly: 0
    };
    const pages = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = pages.get(pageNumber);
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
      if (!this.surfaceHasLiveInkInput(surface)) {
        this.ensurePageRouter(surface, { force: true, reason: "zoom-handoff-final" });
      } else {
        this.ensurePageRouter(surface, { reason: "zoom-handoff-final-live-ink" });
      }
      // A capped backing canvas can keep the same pixel dimensions while its
      // CSS geometry changes. Invalidating forces a canonical PDF-space paint
      // at the final scale in either case.
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
      const painted = this.renderPage(pageNumber, stats, "zoom-handoff-final");
      this.logZoomInkLayout(surface, "handoff-final");
      if (painted) stats.pagesRepainted += 1;
      else if (surface.viewportCullPending) stats.skippedCulled += 1;
    }
    this.logger.zoomComposite("final-canonical", {
      pagesRepainted: stats.pagesRepainted,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      skippedCulled: stats.skippedCulled,
      durationMs: roundMs(performance.now() - started)
    });
  }

  private handleRootResize(): void {
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
    if (durationMs >= 16 && this.isZoomHandoffActive()) {
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
    const domPageCount = options.adapter.pages().length;
    await urgent("session create begin", {
      document: options.pdfPath,
      mobile: platform.mobile,
      phone: platform.phone,
      domPageCount,
      toolbarPlacement: resolveToolbarPlacement(
        options.toolbarPlacement?.() ?? options.settings.toolbarPlacement,
        platform.mobile
      ),
      boostedPdfZoom: options.settings.boostedPdfZoom
    });
    const session = new ViewerInkSession(options);
    await urgent("session create constructor ok", {
      document: options.pdfPath,
      mobile: platform.mobile
    });
    options.adapter.setBoostedZoom?.(options.settings.boostedPdfZoom);
    session.persistEpoch = options.claimPersistEpoch?.(session.identity.id) ?? 1;
    await urgent("session create sidecar begin", {
      document: options.pdfPath,
      documentId: session.identity.id
    });
    const sidecarResult = await options.sidecars.loadWithStatus(session.identity.id);
    const recoveryResult = await options.recovery.loadWithStatus(session.identity.id);
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
    for (const result of quarantined) {
      // Keep this warning available even when optional vault debug logging is off.
      console.warn("[Handwriting Natively] annotation file quarantined", {
        document: options.pdfPath,
        documentId: session.identity.id,
        ...result
      });
      session.logger.sidecarQuarantined({ documentId: session.identity.id, ...result });
    }
    if (quarantined.length) {
      const paths = quarantined.map((result) => result.quarantinePath).join(", ");
      const outcome = stored ? "A valid remaining annotation snapshot was kept." : "Opened with empty annotations.";
      options.notice(`Malformed annotation data moved to ${paths}. ${outcome}`);
    }
    await urgent("session create sidecar ok", {
      document: options.pdfPath,
      documentId: session.identity.id,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
      loadedStrokes,
      loadedTexts,
      hasSidecar: Boolean(sidecar),
      hasRecovery: Boolean(recovery),
      quarantined: quarantined.map((result) => ({
        store: result.store,
        sourcePath: result.sourcePath,
        quarantinePath: result.quarantinePath,
        error: result.error
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
    for (const page of stored?.pages ?? []) {
      if (page.width > 1 && page.height > 1) {
        session.pageMetrics.set(page.page, { width: page.width, height: page.height });
      }
      for (const stroke of page.strokes) session.ink.add(stroke);
      for (const text of page.texts ?? []) session.texts.add(text);
    }
    await urgent("session create hydrate ok", {
      document: options.pdfPath,
      loadedStrokes,
      loadedTexts,
      pagesWithInk: stored?.pages?.length ?? 0
    });
    options.adapter.mountToolbar(session.toolbar.element, session.currentToolbarPlacement());
    await urgent("session create toolbar ok", {
      document: options.pdfPath,
      toolbarPlacement: session.currentToolbarPlacement()
    });
    session.logger.sessionAttach({
      scrollRoot: describeScrollElement(options.adapter.scrollElement()),
      panCapture: "document-capture",
      panBoundary: describeScrollElement(options.adapter.host),
      drawEnabled: session.drawEnabled,
      mouseDragScroll: options.settings.mouseDragScroll,
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
      document: options.pdfPath,
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
      document: options.pdfPath,
      surfaces: session.surfaces.size,
      mountPages: [...session.surfaces.keys()].sort((a, b) => a - b),
      toolbarPlacement: session.currentToolbarPlacement(),
      mobile: platform.mobile
    });
    session.lastKnownViewScale = options.adapter.getViewState().scale;
    return session;
  }

  refresh(reason = "manual"): void {
    if (this.destroyed) return;
    if (
      reason !== "create"
      && (this.isZoomGestureActive() || this.isZoomHandoffActive())
      && (reason.startsWith("pages-") || reason.startsWith("view-"))
    ) {
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      if (reason.includes("scroll") || reason.includes("pagechanging")) {
        this.pendingMobileScrollRemount = true;
      }
      return;
    }
    if (this.isZoomGestureActive() && reason !== "create") {
      this.logger.zoomRepaintInterrupt(reason, { kind: "full-refresh-during-zoom" });
    }
    if (this.isZoomHandoffActive() && reason !== "create") {
      this.logger.zoomFlashProxy("full-refresh-during-handoff", { reason });
    }

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
    this.invalidateInkLayers();
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
   * Desktop: every DOM page. Mobile: currentPage ± 1 via O(1) `adapter.page`
   * (never scan all 900+ page rects on scroll).
   */
  private pagesForInkMount(): PdfPageInfo[] {
    if (!this.runtimePlatform().mobile) {
      return this.options.adapter.pages();
    }
    const pad = 1;
    const currentPage = this.options.adapter.getViewState().pageNumber;
    const resolved: PdfPageInfo[] = [];
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

  private paintAfterHistory(): void {
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
    for (const page of pages) {
      const surface = this.surfaces.get(page);
      if (!surface) continue;
      this.invalidateInkLayer(surface);
      this.renderPage(page);
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
    const overlayRect = surface.overlay.getBoundingClientRect();
    const clientCenterX = overlayRect.left + topCenterView.x;
    const clientTopY = overlayRect.top + topCenterView.y;
    const visible = clientCenterX >= rootRect.left && clientCenterX <= rootRect.right
      && clientTopY >= rootRect.top && clientTopY <= rootRect.bottom;
    if (!visible) return defaultAnchor;

    return {
      x: clientCenterX - rootRect.left - 140,
      y: clientTopY - rootRect.top - 56
    };
  }

  onViewStateChange(state: PdfViewState, source: ViewStateSource): void {
    this.logger.viewState(state, source);
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

  onPagesChanged(reason: string): void {
    const pages = this.options.adapter.pages();
    const overlayConnected = Object.fromEntries(
      [...this.surfaces.entries()].map(([pageNumber, surface]) => [pageNumber, surface.overlay.isConnected])
    );
    this.logger.pagesChanged(reason, pages.length, overlayConnected);

    // A source-PDF rewrite temporarily removes every native page. Release the
    // snapshot only after replacement canvases are present for two paints.
    if (reason === "pages-settled") this.releasePageMutationShieldAfterSettled();

    // PDF++ reload often replaces the viewer tree — root disconnects and MutationObserver dies.
    if (!this.options.adapter.host.isConnected || !this.options.adapter.root.isConnected) {
      this.notifyDetached("root-disconnected");
      return;
    }

    if (!pages.length) {
      // Transient empty during rebuild — wait, then detach so plugin re-attaches to the new viewer.
      this.scheduleDetachCheck();
      return;
    }

    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }

    this.focusInsertedPageIfReady(reason, pages);

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

  /**
   * Obsidian has no in-place PDF.js document replacement API: modifyBinary
   * destroys its page DOM before the replacement document is ready. Preserve
   * the visible native canvas plus committed ink in a document-level layer so
   * that mandatory reload looks like a stable page transition instead of a
   * full-view white flash.
   */
  private async armPageMutationShield(action: "delete" | "insert", pageNumber: number): Promise<void> {
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

    if (!capturedPages) {
      this.logger.pdfPageAction("page-shield-skipped", { action, pageNumber, reason: "no-visible-native-canvas" });
      return;
    }
    ownerDocument.body.append(shield);
    this.pageMutationShield = {
      element: shield,
      action,
      pageNumber,
      capturedPages,
      timeout: view.setTimeout(() => this.releasePageMutationShield("timeout"), ViewerInkSession.PAGE_MUTATION_SHIELD_TIMEOUT_MS)
    };
    this.logger.pdfPageAction("page-shield-captured", { action, pageNumber, capturedPages });
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

  private reattachSurface(surface: PageSurface, page: PdfPageInfo): boolean {
    if (!page.element.isConnected || surface.page.element !== page.element) return false;
    if (surface.overlay.isConnected) {
      if (!page.element.contains(surface.overlay)) return false;
      this.rememberPageMetrics(page);
      this.applyTouchDrawPolicy(page.element);
      this.syncOverlayLayout(surface);
      this.ensurePageRouter(surface);
      return true;
    }
    this.ensurePagePositioning(page.element);
    page.element.append(surface.overlay);
    this.rememberPageMetrics(page);
    this.applyTouchDrawPolicy(page.element);
    this.syncOverlayLayout(surface);
    this.ensurePageRouter(surface);
    return true;
  }

  private remountSurfaceOnPageReplacement(surface: PageSurface, page: PdfPageInfo): void {
    const previousPage = surface.page.element;
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
    this.applyTouchDrawPolicy(page.element);
    this.syncOverlayLayout(surface);
    surface.router = this.createPageRouter(surface);
  }

  private tryReattachDisconnectedSurfaces(pages: PdfPageInfo[]): boolean {
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

  private canSyncPagesWithoutRefresh(pages: PdfPageInfo[]): boolean {
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

  async addPageAt(requestedPageNumber: number): Promise<void> {
    if (!this.options.onInsertPage) return;
    if (this.pageMutationInFlight) {
      this.logger.pdfPageAction("insert-cancel", { requestedPageNumber, reason: "page-mutation-in-flight" });
      return;
    }
    this.pageMutationInFlight = true;
    this.logger.pdfPageAction("insert-start", { requestedPageNumber, dirty: this.isDirty() });
    try {
      // The source PDF is replaced in place. Flush first so its sidecar has
      // the just-finished stroke/text edit before PDF.js reloads the document.
      if (this.isDirty()) await this.manualSave();
      const before = this.snapshot();
      this.pendingInsertedPageFocus = {
        pageNumber: requestedPageNumber,
        expectedPageCount: this.options.adapter.pages().length + 1
      };
      await this.armPageMutationShield("insert", requestedPageNumber);
      const insertedPage = await this.options.onInsertPage(requestedPageNumber);
      if (this.pendingInsertedPageFocus) this.pendingInsertedPageFocus.pageNumber = insertedPage;
      this.applyInsertedPageToSession(before, insertedPage);
      this.focusInsertedPageIfReady("insert-complete", this.options.adapter.pages());
      this.logger.pdfPageAction("insert-complete", { requestedPageNumber, insertedPage });
      this.options.notice(`Added page ${insertedPage}.`);
    } catch (error) {
      this.pendingInsertedPageFocus = null;
      this.releasePageMutationShield("insert-error");
      this.logger.pdfPageAction("insert-error", {
        requestedPageNumber,
        error: this.errorMessage(error)
      });
      this.options.notice(`Could not add a page: ${this.errorMessage(error)}`);
    } finally {
      this.pageMutationInFlight = false;
    }
  }

  /** Focus only once native PDF.js has published the post-insert page count. */
  private focusInsertedPageIfReady(reason: string, pages: PdfPageInfo[]): void {
    const pending = this.pendingInsertedPageFocus;
    if (!pending || pages.length < pending.expectedPageCount) return;
    if (!this.options.adapter.focusPage(pending.pageNumber)) return;
    this.pendingInsertedPageFocus = null;
    this.logger.pdfPageAction("insert-focus", { pageNumber: pending.pageNumber, reason, pageCount: pages.length });
  }

  /** Keep live ink/text state synchronized with the remapped on-disk sidecar. */
  private applyInsertedPageToSession(before: SidecarSchemaV1, insertedPage: number): void {
    this.commitActiveTextEditor("page-insert");
    this.cancelTextBoxTransform("page-insert", false);
    const remapped = insertPageIntoSidecar(before, insertedPage);
    this.ink.clear();
    this.texts.clear();
    for (const page of remapped.pages) {
      for (const stroke of page.strokes) this.ink.add(stroke);
      for (const text of page.texts ?? []) this.texts.add(text);
    }
    const metrics = [...this.pageMetrics.entries()];
    this.pageMetrics.clear();
    for (const [page, value] of metrics) this.pageMetrics.set(page >= insertedPage ? page + 1 : page, value);
    this.history.clear();
    this.historyDirtyPages.clear();
    this.historyPaintedPages.clear();
    this.clearSelection({ refresh: false });
    this.autosave.markClean(this.identity.id);
    this.saveCoordinator.markSaved();
    this.toolbar.setSaveStatus("saved", new Date());
    this.scheduleRefresh("page-insert", true);
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

  getDiagnostics(): SessionDiagnostics {
    return {
      pdfPath: this.options.pdfPath,
      compatibility: this.options.adapter.compatibilityReport(),
      debug: this.debugState
    };
  }

  refreshDiagnostics(): void {
    this.updateDebug();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    // A native contenteditable owns every editor shortcut while it is open. The
    // window-level listener may receive a retargeted event from Obsidian, so
    // checking event.target alone is not sufficient here. Cmd/Ctrl+A is the
    // exception: claim it before Obsidian's document shortcuts can move the
    // selection outside this editor.
    if (this.destroyed) return false;
    if (this.beginTemporaryEraserModifier(event)) return true;
    if (this.handleActiveTextEditorSelectAll(event)) return true;
    if (this.activeTextEditor || shouldIgnoreSelectionShortcut(event.target)) return false;
    const historyAction = parseHistoryShortcut(event);
    if (historyAction) {
      const ok = historyAction === "undo" ? this.history.undo() : this.history.redo();
      if (!ok) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const action = parseSelectionShortcut(event);
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
    if (!action || !this.canSelectionShortcut(action)) return false;
    this.applySelectionShortcut(action);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    if (this.destroyed) return false;
    const key = temporaryEraserModifierKey(event);
    if (!key || !this.temporaryModifierEraserKeys.delete(key)) return false;
    this.refreshTemporaryEraserChrome();
    return true;
  }

  /** Window blur has no guaranteed modifier keyup; never leave the eraser stuck on. */
  clearTemporaryEraserModifier(): void {
    if (this.temporaryModifierEraserKeys.size === 0) return;
    this.temporaryModifierEraserKeys.clear();
    this.refreshTemporaryEraserChrome();
  }

  private beginTemporaryEraserModifier(event: KeyboardEvent): boolean {
    const key = temporaryEraserModifierKey(event);
    if (!key || !this.drawEnabled || this.activeTextEditor || shouldIgnoreSelectionShortcut(event.target)) return false;
    const wasActive = this.temporaryModifierEraserKeys.size > 0;
    this.temporaryModifierEraserKeys.add(key);
    if (!wasActive) this.refreshTemporaryEraserChrome();
    return true;
  }

  private refreshTemporaryEraserChrome(): void {
    const active = this.temporaryModifierEraserKeys.size > 0;
    this.toolbar.element.classList.toggle("native-pdf-handwriting-temporary-eraser", active);
    this.toolbar.element.dataset.temporaryTool = active ? "eraser" : "";
    this.syncAnnotationCursorMode();
    this.refreshSurfaceCursors();
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
    if (action === "selectAll") return this.drawEnabled;
    if (action === "paste") {
      const clipboard = StrokeClipboard.peek();
      return this.drawEnabled && Boolean(clipboard?.strokes.length || clipboard?.texts.length);
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
        for (const stroke of strokes) this.ink.remove(stroke.id);
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
      const bytes = await this.exporter.export({
        sourceBytes: await this.options.readSourcePdf(),
        getStrokes: () => this.ink.all(),
        getTexts: () => this.texts.all(),
        mode,
        pageMetrics: this.exportPageMetrics()
      });
      const sourceName = this.options.pdfPath.split("/").pop() ?? "document.pdf";
      const name = mode === "editable" ? editableAnnotatedFilename(sourceName) : annotatedFilename(sourceName);
      const path = await this.options.writeExport(name, bytes);
      this.options.notice(`Exported ${typeof path === "string" ? path : name}. Original PDF unchanged.`);
      this.logger.textTool("export-complete", { mode, textCount: this.texts.all().length, byteCount: bytes.length });
    } catch (error) {
      this.logger.textTool("export-error", { mode, textCount: this.texts.all().length, error: this.errorMessage(error) });
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
    const sourceName = this.options.pdfPath.split("/").pop() ?? "document.pdf";
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
    this.releasePageMutationShield("session-destroy");
    this.commitActiveTextEditor("destroy");
    this.cancelTextBoxTransform("destroy");
    // Emergency persistence snapshots below must include a line that is still
    // held when the PDF view closes or replaces its pages.
    for (const surface of this.surfaces.values()) {
      this.commitActiveDrawBeforeSurfaceLoss(surface, "session-destroy");
    }
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
    if (this.viewportPaintFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.viewportPaintFrame);
      this.viewportPaintFrame = null;
    }
    if (this.mobileScrollRefreshTimer !== null) {
      window.clearTimeout(this.mobileScrollRefreshTimer);
      this.mobileScrollRefreshTimer = null;
    }
    this.pendingMobileScrollRemount = false;
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    this.cancelZoomSettleSlice();
    this.cancelZoomCompositeRelease();
    this.endZoomCompositing();
    this.releaseZoomCompositeLayers();
    this.syncAnnotationCursorMode(false);
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) {
      surface.router?.destroy();
      this.clearTouchDrawPolicy(surface.page.element);
      this.releaseInputOwner(surface.page.element);
      this.releaseSurfaceBuffers(surface);
    }
    this.surfaces.clear();
    this.selectionToolbar.destroy();
    this.viewerMousePan.destroy();
    this.pullToAddPage?.destroy();
    this.thumbnailSidebarActions?.destroy();
    this.findBridge.destroy();
    this.handledDrawPointers.clear();
    this.pointerProbeAbort.abort();
    this.toolbar.destroy();
    this.options.adapter.destroy();
    await this.autosave.close().catch(() => undefined);
    return true;
  }

  private syncAnnotationCursorMode(enabled = this.drawEnabled): void {
    const tool = this.activeTool();
    const hideNativeCursor = enabled
      && (isInkDrawTool(tool) || tool === "eraser");
    this.options.adapter.root.classList.toggle("native-pdf-handwriting-hide-native-cursor", hideNativeCursor);
  }

  /** Apply direct-manipulation policy to the actual PDF.js page, not our overlay. */
  private syncTouchDrawPolicy(reason: string): void {
    const enabled = this.drawEnabled;
    for (const surface of this.surfaces.values()) {
      this.applyTouchDrawPolicy(surface.page.element, enabled);
      if (enabled) this.ensurePageRouter(surface);
      surface.router?.syncToolState();
    }
    if (this.touchDrawPolicyEnabled === enabled) return;
    this.touchDrawPolicyEnabled = enabled;
    this.logger.touchInput("policy", { enabled, reason, surfaces: this.surfaces.size });
  }

  private applyTouchDrawPolicy(pageElement: HTMLElement, enabled = this.drawEnabled): void {
    // Draw mode uses mouse/stylus hit class. Never enable legacy finger-draw class.
    pageElement.classList.toggle("native-pdf-handwriting-draw-hit-page", enabled);
    pageElement.classList.remove("native-pdf-handwriting-touch-draw-page");
    // PDF.js may stamp inline pointer-events on text/annotation layers — set via
    // setCssProps so Draw mode hits reach the ink overlay without CSS !important.
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
      "native-pdf-handwriting-pen-capturing"
    );
    const layers = pageElement.querySelectorAll<HTMLElement>(":scope > .textLayer, :scope > .annotationLayer");
    for (const layer of layers) {
      setElementCssProps(layer, { pointerEvents: "" });
    }
  }

  /** Physical eraser tips temporarily route as Eraser without changing saved tool choice. */
  private activeTool(): ToolPreferences["activeTool"] {
    return this.temporaryStylusEraserPointers > 0 || this.temporaryModifierEraserKeys.size > 0
      ? "eraser"
      : this.options.settings.toolPreferences.activeTool;
  }

  /** Text boxes steal hits only in Text/lasso — pen/eraser/laser must pass through. */
  private textBoxesInteractable(): boolean {
    if (!this.drawEnabled) return false;
    const tool = this.activeTool();
    return tool === "text" || tool === "lasso";
  }

  private refreshSurfaceCursors(): void {
    for (const surface of this.surfaces.values()) surface.router?.refreshCursors();
  }

  private logMousePanConfig(reason: string): void {
    this.logger.mousePan("config", this.mousePanContext(reason));
  }

  private logMousePan(phase: MousePanPhase, event: PointerEvent, details: Record<string, unknown>): void {
    this.logger.mousePan(phase, {
      ...this.mousePanContext(),
      clientX: Math.round(event.clientX),
      clientY: Math.round(event.clientY),
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      buttons: event.buttons,
      width: event.width,
      height: event.height,
      pressure: event.pressure,
      ...details
    });
  }

  /** Grab-pan at the bottom edge feeds the GoodNotes-style pull-to-add-page gesture. */
  private feedPullToAddFromPan(phase: MousePanPhase, details: Record<string, unknown>): void {
    const gesture = this.pullToAddPage;
    if (!gesture) return;
    if (phase === "move") {
      const deltaY = typeof details.deltaY === "number" ? details.deltaY : 0;
      const changed = details.changed === true;
      gesture.feedScrollAttempt(deltaY, changed);
      return;
    }
    if (phase === "end" || phase === "cancel" || phase === "abort") {
      gesture.feedScrollEnd();
    }
  }

  private mousePanContext(reason?: string): Record<string, unknown> {
    const mouseDragScroll = this.options.mouseDragScrollEnabled?.() ?? this.options.settings.mouseDragScroll;
    return {
      drawEnabled: this.drawEnabled,
      mouseDragScroll,
      panEnabled: !this.drawEnabled && mouseDragScroll,
      touchPanEnabled: false,
      scrollRoot: describeScrollElement(this.options.adapter.scrollElement()),
      ...(reason ? { reason } : {})
    };
  }

  private mountPage(page: PdfPageInfo): PageSurface {
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
    const textLayer = createDetachedDiv(overlay.ownerDocument);
    textLayer.className = "native-pdf-handwriting-text-layer";
    overlay.append(textLayer);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    const draftContext = draftCanvas.getContext("2d");
    if (!draftContext) throw new Error("Canvas 2D rendering is unavailable");
    const surface: PageSurface = {
      page,
      overlay,
      canvas,
      draftCanvas,
      textLayer,
      context,
      draftContext,
      inkLayer: null,
      inkLayerContext: null,
      inkLayerValid: false,
      inkLayerBackingScale: null,
      inkLayerBurstCapture: false,
      viewportCullPending: false,
      settleUpgradePending: false,
      router: null,
      livePaintFrame: null,
      pendingLivePaint: null,
      liveEraserPaintedPoints: 0,
      liveDrawPaintedPoints: 0,
      builder: undefined,
      pressureConditioner: undefined,
      pressureLastPdfPoint: undefined,
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
      textIntent: null
    };
    surface.router = this.createPageRouter(surface);
    this.ensurePagePositioning(page.element);
    this.applyTouchDrawPolicy(page.element);
    this.syncOverlayLayout(surface);
    return surface;
  }

  /** Keep exactly one session's page router active for a live PDF page node. */
  private claimInputOwner(pageElement: HTMLElement, page: number): void {
    const owners = inputOwners(pageElement);
    const previous = owners.get(pageElement);
    if (previous && previous !== this) {
      this.logger.inputOwner("supersede", { page });
      void previous.destroy({ silent: true, alreadyPersisted: true });
    }
    owners.set(pageElement, this);
    this.ownedInputPages.add(pageElement);
    this.logger.inputOwner("claim", { page, replaced: Boolean(previous && previous !== this) });
  }

  private releaseInputOwner(pageElement: HTMLElement): void {
    this.ownedInputPages.delete(pageElement);
    const owners = inputOwners(pageElement);
    if (owners.get(pageElement) !== this) return;
    owners.delete(pageElement);
    this.logger.inputOwner("release", { page: pageElement.dataset.pageNumber ?? null });
  }

  private createPageRouter(surface: PageSurface): PointerRouter {
    return new PointerRouter(surface.page.element, {
      activeTool: () => this.activeTool(),
      drawingEnabled: () => this.drawEnabled,
      rightMouseEraserEnabled: () => this.options.settings.toolPreferences.eraser.eraseWithRightMouseButton,
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
      onStart: (samples, route, event) => this.pointerStart(surface, samples, route, event),
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onEnd: (samples, route, event) => this.pointerEnd(surface, samples, route, event),
      onCancel: (route, event) => this.pointerCancel(surface, route, event),
      onRouterReceived: (event, generation) => {
        this.logger.pageRouter("received", {
          page: surface.page.pageNumber,
          listenerGeneration: generation,
          pointerType: event.pointerType || "(empty)",
          pointerId: event.pointerId,
          targetId: getDebugNodeId(event.target),
          currentTargetId: getDebugNodeId(event.currentTarget),
          pageId: getDebugNodeId(surface.page.element),
          pdfCanvasId: getDebugNodeId(pdfRenderCanvas(surface.page.element)),
          inkCanvasId: getDebugNodeId(surface.canvas)
        });
      },
      isPointerHandled: (pointerId) => this.wasDrawPointerHandled(pointerId),
      onPointerHandled: (pointerId) => {
        this.markDrawPointerHandled(pointerId);
      },
      onRoute: (route, event) => {
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
          drawEnabled: this.drawEnabled,
          touchDrawPolicyEnabled: this.drawEnabled,
          ...(route === "draw" ? { pressureProfile: this.pressureProfile() } : {}),
          clientX: Math.round(event.clientX),
          clientY: Math.round(event.clientY)
        });
      },
      onTouchLifecycle: (phase, event, details) => this.logger.touchInput(phase, {
        page: surface.page.pageNumber,
        ...(event instanceof PointerEvent
          ? { pointerId: event.pointerId, isPrimary: event.isPrimary }
          : {}),
        ...details
      }),
      onTouchPan: (phase, _event, details) => this.logger.touchPan(phase, { page: surface.page.pageNumber, ...details })
    });
  }

  /**
   * Zoom / PDF.js page recycling can move the overlay onto a live page node
   * while PointerRouter is still bound to a detached or recycled predecessor.
   * Without a rebind, Draw mode sees no pointer route events.
   * Also rebinds when listeners were aborted but the element reference still matches.
   */

  private markDrawPointerHandled(pointerId: number): void {
    this.handledDrawPointers.add(pointerId);
  }

  private wasDrawPointerHandled(pointerId: number): boolean {
    return this.handledDrawPointers.has(pointerId);
  }

  private closestPdfPageElement(target: EventTarget | null): HTMLElement | null {
    if (!isElement(target)) return null;
    const page = target.closest(".page, .pdf-page-view");
    if (!isHTMLElement(page) || isHandwritingPageChrome(page)) return null;
    return page;
  }

  private shouldFallbackRoutePointer(event: PointerEvent): boolean {
    if (this.destroyed || !this.drawEnabled) return false;
    if (event.pointerType === "touch") return false;
    if (event.pointerType === "pen") return true;
    return event.pointerType === "mouse" && event.button === 0;
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
    this.logger.pageRouter("fallback", {
      phase: "skip",
      reason,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      targetId: getDebugNodeId(event.target),
      drawEnabled: this.drawEnabled,
      ...extra
    });
  }

  private pageInfoForHitElement(hitPage: HTMLElement, pageNumber: number, surface: PageSurface): PdfPageInfo {
    const fromAdapter = this.options.adapter.page(pageNumber);
    if (fromAdapter && fromAdapter.element === hitPage) return fromAdapter;
    // Keep stored metrics; only the shell identity changes for this remount.
    return {
      pageNumber,
      width: surface.page.width,
      height: surface.page.height,
      scale: surface.page.scale,
      rotation: surface.page.rotation,
      element: hitPage
    };
  }

  /**
   * Document capture: route pen/mouse draw here. Do not trust binds/alive alone —
   * page capture can stay silent after zoom while health checks still pass.
   */
  private captureDrawPointerFallback(
    event: PointerEvent,
    within: (target: EventTarget | null) => boolean
  ): void {
    if (!this.shouldFallbackRoutePointer(event)) return;
    if (!within(event.target)) return;
    if (isElement(event.target) && event.target.closest(
      ".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-text-input"
    )) return;
    const hitPage = this.closestPdfPageElement(event.target);
    if (!hitPage) return;
    const pageNumber = this.resolveHitPageNumber(hitPage);
    if (pageNumber === null) {
      this.logFallbackSkip("missing-page-number", event, {
        hitPageId: getDebugNodeId(hitPage),
        hasDataPageNumber: hitPage.hasAttribute("data-page-number"),
        dataPageNumber: hitPage.dataset.pageNumber ?? null
      });
      return;
    }
    const surface = this.surfaces.get(pageNumber);
    if (!surface) {
      this.logFallbackSkip("no-surface", event, {
        page: pageNumber,
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
    surface.router?.acceptPointerDown(event);
  }

  /**
   * Document bubble: page capture never marked this pointer — route it now.
   * Prefer bubble over microtask so preventDefault still applies in-dispatch.
   */
  private bubbleDrawPointerFallback(
    event: PointerEvent,
    within: (target: EventTarget | null) => boolean
  ): void {
    if (!this.shouldFallbackRoutePointer(event)) return;
    if (this.wasDrawPointerHandled(event.pointerId)) return;
    if (!within(event.target)) return;
    if (isElement(event.target) && event.target.closest(
      ".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-text-input"
    )) return;
    const hitPage = this.closestPdfPageElement(event.target);
    if (!hitPage) return;
    const pageNumber = this.resolveHitPageNumber(hitPage);
    if (pageNumber === null) {
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
      this.logFallbackSkip("no-surface", event, {
        via: "bubble",
        page: pageNumber,
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
    surface.router?.acceptPointerDown(event);
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
    surface.pendingLivePaint = pendingEvent ? { ...nextPaint, event: pendingEvent } : nextPaint;
    if (surface.livePaintFrame !== null) return;
    const view = surface.overlay.ownerDocument.defaultView;
    if (!view) {
      this.paintScheduledLiveWork(surface);
      return;
    }
    surface.livePaintFrame = view.requestAnimationFrame(() => {
      surface.livePaintFrame = null;
      this.paintScheduledLiveWork(surface);
    });
  }

  private paintScheduledLiveWork(surface: PageSurface): void {
    const pending = surface.pendingLivePaint;
    surface.pendingLivePaint = null;
    if (!pending || this.destroyed) return;
    const startedAt = performance.now();
    let draftPoints: number | undefined;
    let incremental: boolean | undefined;
    let compositeMatched: boolean | undefined;
    let stabilization: string | undefined;
    let draftResized: boolean | undefined;
    if (pending.kind === "draw") {
      const painted = this.renderLiveDrawPreview(surface);
      draftPoints = painted.draftPoints;
      incremental = painted.incremental;
      compositeMatched = painted.compositeMatched;
      stabilization = painted.stabilization;
      draftResized = painted.draftResized;
    } else if (surface.editTool === "eraser") this.renderLiveEraserPreview(surface);
    else this.renderPage(surface.page.pageNumber, undefined, "live-edit", pending.syncText);
    this.logger.inputPaint(surface.page.pageNumber, performance.now() - startedAt, pending.kind, pending.sampleCount, {
      ...(draftPoints !== undefined ? { draftPoints } : {}),
      ...(incremental !== undefined ? { incremental } : {}),
      ...(compositeMatched !== undefined ? { compositeMatched } : {}),
      ...(stabilization !== undefined ? { stabilization } : {}),
      ...(draftResized !== undefined ? { draftResized } : {})
    });
    if (pending.event && this.logger.isEnabled()) this.updateDebug(surface, pending.event);
  }

  /** A terminal input event owns the final synchronous paint, never a stale frame callback. */
  private cancelLivePaint(surface: PageSurface): void {
    if (surface.livePaintFrame !== null) {
      surface.overlay.ownerDocument.defaultView?.cancelAnimationFrame(surface.livePaintFrame);
      surface.livePaintFrame = null;
    }
    surface.pendingLivePaint = null;
  }

  private clearLiveDrawPreview(surface: PageSurface): void {
    const { draftCanvas, draftContext } = surface;
    surface.liveDrawPaintedPoints = 0;
    if (!draftCanvas.width || !draftCanvas.height) return;
    draftContext.setTransform(1, 0, 0, 1, 0, 0);
    draftContext.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
  }

  /** Drop detached page bitmaps and their scheduled work promptly. */
  private releaseSurfaceBuffers(surface: PageSurface): void {
    this.cancelLivePaint(surface);
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    surface.draftCanvas.width = 0;
    surface.draftCanvas.height = 0;
    if (surface.inkLayer) {
      surface.inkLayer.width = 0;
      surface.inkLayer.height = 0;
    }
    surface.inkLayer = null;
    surface.inkLayerContext = null;
    surface.inkLayerValid = false;
    surface.liveEraserPaintedPoints = 0;
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

    const points = surface.shapePreview ?? builder.preview(this.simplifyStrokesEnabled());
    if (!points.length) {
      surface.liveDrawPaintedPoints = 0;
      return { draftPoints: 0, incremental: false, compositeMatched, stabilization, draftResized };
    }
    const style = builder.style;
    const context = surface.draftContext;
    const shapeMorph = surface.shapePreview !== null;
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
        "full",
        context
      );
      surface.liveDrawPaintedPoints = 0;
      return { draftPoints: points.length, incremental: false, compositeMatched, stabilization, draftResized };
    }

    // Causal preview (StrokeBuilder.smoothedPoints) keeps prior indices fixed —
    // incremental stamps are safe even with medium/high stabilization.
    const canIncremental = !draftResized
      && surface.liveDrawPaintedPoints > 0
      && surface.liveDrawPaintedPoints <= points.length;

    if (canIncremental) {
      if (surface.liveDrawPaintedPoints === points.length) {
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
        "full",
        context
      );
      surface.liveDrawPaintedPoints = points.length;
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
      "full",
      context
    );
    surface.liveDrawPaintedPoints = points.length;
    return { draftPoints: points.length, incremental: false, compositeMatched, stabilization, draftResized };
  }

  /**
   * Erasing the display bitmap is O(new input samples), while exact stroke
   * fragmentation is O(stroke segments × full eraser path). The exact model
   * update still happens once at pointer-up; cancel/repaint restores this
   * disposable bitmap immediately.
   */
  private renderLiveEraserPreview(surface: PageSurface): void {
    const eraserSize = surface.eraserSize;
    if (eraserSize === undefined || surface.editPath.length === 0) return;
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
      this.renderPage(surface.page.pageNumber, undefined, "live-eraser-rebase", false, false);
      surface.liveEraserPaintedPoints = 0;
    }

    if (surface.liveEraserPaintedPoints >= surface.editPath.length) return;
    // Continue from the prior endpoint so each new packet erases the capsule
    // between frames instead of leaving a visible gap at the frame boundary.
    const pending = surface.editPath.slice(Math.max(0, surface.liveEraserPaintedPoints - 1));
    const mapper = this.mapper(surface);
    const points = pending.map((point) => mapper.toViewport(point));
    const context = surface.context;
    context.save();
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, eraserSize * this.displayScale(surface));
    const first = points[0]!;
    context.beginPath();
    if (points.length === 1) {
      context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
    surface.liveEraserPaintedPoints = surface.editPath.length;
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
    // be mistaken for a zero-distance selection drag.
    if (route === "text" && event.target instanceof Element && event.target.closest(".native-pdf-handwriting-text-box")) {
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
        const point = this.toPdfPoint(surface, samples[0]!, true);
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
      const laser = activeTool === "laser";
      if (laser) {
        surface.pressureConditioner = undefined;
        surface.pressureLastPdfPoint = undefined;
        surface.simulateMousePressure = false;
        const laserPrefs = preferences.laser;
        surface.laserDraft = true;
        surface.laserDiscardedPoints = 0;
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
        for (const point of this.toPdfPoints(surface, samples, false)) surface.builder.add(point);
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
        surface.pressureLastPdfPoint = undefined;
        surface.simulateMousePressure = drawing.simulateMousePressure;
        surface.builder = new StrokeBuilder({
          id: this.id(),
          page: surface.page.pageNumber,
          tool,
          color: drawing.color,
          width: drawing.width,
          opacity: drawing.opacity,
          inputType: inkInputType(samples[0]?.pointerType ?? event.pointerType),
          stabilization: drawing.stabilization
        });
        for (const point of this.toPdfPoints(surface, samples, surface.simulateMousePressure, surface.pressureConditioner)) surface.builder.add(point);
        const first = surface.builder.preview(this.simplifyStrokesEnabled())[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", tool, [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
        if (isDrawingTool(activeTool)) this.scheduleHeldShape(surface);
      }
    } else {
      if (activeTool === "lasso" && (this.selected.length > 0 || this.selectedTexts.length > 0)) {
        const point = this.toPdfPoint(surface, samples[0]!, true);
        if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !shapeContainsPoint(this.selectionShape, point)) {
          const clearedPage = this.selectionPage;
          // Caller always renderPage(surface) below — only paint a different page here.
          this.clearSelection({ refresh: false });
          if (clearedPage != null && clearedPage !== surface.page.pageNumber) {
            this.paintAfterClearSelection(clearedPage);
          }
        }
      }
      surface.editTool = activeTool === "eraser" || this.isRightMouseEraser(event) ? "eraser" : "lasso";
      surface.eraserSize = surface.editTool === "eraser" ? preferences.eraser.size : undefined;
      surface.eraserWholeStrokes = surface.editTool === "eraser" ? preferences.eraser.eraseWholeStrokes : undefined;
      surface.editPath = this.toPdfPoints(surface, samples, true);
      surface.liveEraserPaintedPoints = 0;
      if (surface.editPath[0]) this.lastPointerPdf = { x: surface.editPath[0].x, y: surface.editPath[0].y };
    }
    if (route === "draw" && !surface.laserDraft) this.scheduleLivePaint(surface, "draw", samples.length, event);
    else if (route === "edit") this.scheduleLivePaint(surface, "edit", samples.length, event);
  }

  private pointerMove(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
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
      const simulate = surface.laserDraft ? false : surface.simulateMousePressure;
      const points = this.toPdfPoints(surface, samples, simulate, surface.laserDraft ? undefined : surface.pressureConditioner);
      for (const point of points) surface.builder.add(point);
      const lastPoint = points.at(-1);
      if (lastPoint) this.resizeLockedShape(surface, lastPoint);
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "move");
      if (surface.laserDraft) {
        this.trimLaserDraft(surface, performance.now());
        this.ensureLaserFadeLoop();
      }
      if (isDrawingTool(this.activeTool()) && !surface.shapeResize) this.scheduleHeldShape(surface);
    } else if (route === "edit") {
      surface.editPath.push(...this.toPdfPoints(surface, samples, true));
    }
    // The laser fade loop owns live laser painting. Rendering each pointer event
    // duplicates full-canvas work and falls behind high-rate stylus input.
    if (!surface.laserDraft) this.scheduleLivePaint(surface, route === "draw" ? "draw" : "edit", samples.length, event);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    this.cancelLivePaint(surface);
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
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
      return;
    }
    if (route === "text") {
      this.finishTextIntent(surface, samples.at(-1)!, event);
      return;
    }
    if (route === "draw" && surface.builder) {
      this.commitActiveDraw(surface, samples, "pointerup");
    } else if (route === "edit") {
      surface.editPath.push(...this.toPdfPoints(surface, samples, true));
      const tool = this.options.settings.toolPreferences.activeTool;
      const phase = tool === "eraser" ? "eraser" : "lasso";
      const path = [...surface.editPath];
      this.finishEdit(surface);
      this.logDraw(surface, phase, tool, path);
      surface.editPath = [];
      surface.liveEraserPaintedPoints = 0;
    }
    this.updateDebug(surface, event);
    if (this.needsPagePaint(surface.page.pageNumber)) this.renderPage(surface.page.pageNumber);
  }

  /** Commit a completed draw gesture, including one interrupted by page virtualization. */
  private commitActiveDraw(
    surface: PageSurface,
    samples: PointerSample[],
    termination: "pointerup" | "surface-unmount",
    terminalDetail?: string
  ): void {
    const builder = surface.builder;
    if (!builder) return;
    this.cancelHeldShape(surface);
    const laserDraft = surface.laserDraft;
    const simulate = laserDraft ? false : surface.simulateMousePressure;
    const points = this.toPdfPoints(surface, samples, simulate, laserDraft ? undefined : surface.pressureConditioner);
    for (const point of points) builder.add(point);
    const lastPoint = points.at(-1);
    if (lastPoint) this.resizeLockedShape(surface, lastPoint);
    if (laserDraft) this.trimLaserDraft(surface, performance.now());
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
    surface.pressureLastPdfPoint = undefined;
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
      this.logger.inkRenderer(surface.page.pageNumber, {
        tool,
        pointCount: stroke.points.length,
        width: stroke.width,
        opacity: stroke.opacity,
        previewRenderer: "tool-renderer",
        committedRenderer: "tool-renderer"
      });
      this.executeHistory(new AddStrokeCommand(this.ink, stroke), stroke.page);
      this.lastPointerPdf = stroke.points.at(-1)
        ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y }
        : this.lastPointerPdf;
      this.logDraw(surface, "end", tool, stroke.points, terminal);
    }
    const last = samples.at(-1);
    if (last) this.logPositionAlign(surface, last, "end");
  }

  /** Save an in-progress real-ink draft before mobile/PDF.js replaces its page. */
  private commitActiveDrawBeforeSurfaceLoss(surface: PageSurface, reason: string): void {
    // Laser trails are intentionally ephemeral; only saved ink must survive a remount.
    if (!surface.builder || surface.laserDraft) return;
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
    surface.builder = undefined;
    surface.pressureConditioner = undefined;
    surface.pressureLastPdfPoint = undefined;
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
    surface.textIntent = null;
    this.textMoveDrag = null;
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private finishEdit(surface: PageSurface): void {
    const preferences = this.options.settings.toolPreferences;
    const editTool = surface.editTool;
    const eraserSize = surface.eraserSize;
    const eraserWholeStrokes = surface.eraserWholeStrokes;
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    surface.eraserWholeStrokes = undefined;
    if (editTool === "eraser" && eraserSize !== undefined) {
      const erase = eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes;
      const strokes = this.ink.page(surface.page.pageNumber);
      const candidates = this.ink.pageIntersecting(
        surface.page.pageNumber,
        pathBoundsWithPadding(surface.editPath, eraserSize / 2)
      );
      const result = erase(strokes, surface.editPath, eraserSize, {
        candidateIds: new Set(candidates.map((stroke) => stroke.id)),
        createFragmentId: () => this.id()
      });
      if (result.erased.length) {
        this.clearSelection();
        this.executeHistory(
          new ReplacePageStrokesCommand(this.ink, surface.page.pageNumber, this.ink.page(surface.page.pageNumber), result.kept),
          surface.page.pageNumber
        );
      }
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
    this.invalidateInkLayer(surface);
    this.logger.lassoSelection(surface.page.pageNumber, this.selected.length + this.selectedTexts.length, editPath.length, shape.type);
    this.logText(surface, "lasso-selection", {
      shape: shape.type,
      pathPoints: editPath.length,
      textSelectedCount: this.selectedTexts.length,
      strokeSelectedCount: this.selected.length
    });
    this.ensureSelectionToolbar({ resetPlacement: true });
  }

  private isRightMouseEraser(event: PointerEvent): boolean {
    return event.pointerType === "mouse" && event.button === 2
      && this.options.settings.toolPreferences.eraser.eraseWithRightMouseButton;
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

  private resizeLockedShape(surface: PageSurface, target: PdfPoint): void {
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
    const point = this.toPdfPoint(surface, sample, true);
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
    surface.textIntent = { start: point, hit, pointerType: event.pointerType };
    this.logText(surface, "intent", {
      pointerType: event.pointerType || "(empty)", pointerId: event.pointerId,
      x: round(point.x), y: round(point.y), committedPrevious: false
    });
    this.logText(surface, "hit-test", {
      hit: Boolean(hit), annotationId: hit?.id ?? null,
      x: round(point.x), y: round(point.y),
      ...(hit ? this.textGeometry(hit) : {})
    });
  }

  private updateTextIntent(surface: PageSurface, sample: PointerSample, event: PointerEvent): void {
    const point = this.toPdfPoint(surface, sample, true);
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
    if (!intent?.hit || intent.pointerType !== "pen") return;
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
    if (intent.hit) {
      this.logText(surface, "edit-request", { annotationId: intent.hit.id, ...this.textGeometry(intent.hit) });
      this.openTextEditor(surface, intent.hit);
    } else {
      this.logText(surface, "create-request", { x: round(intent.start.x), y: round(intent.start.y) });
      this.openTextEditor(surface, null, intent.start);
    }
    this.renderTextAnnotations(surface);
  }

  private textAt(page: number, point: Pick<PdfPoint, "x" | "y">): PdfTextAnnotation | null {
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

  private textGeometry(text: Pick<PdfTextAnnotation, "x" | "y" | "width" | "height" | "fontSize" | "fontFamily" | "bold" | "italic" | "strikethrough">): Record<string, unknown> {
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

  private openTextEditor(surface: PageSurface, existing: PdfTextAnnotation | null, at?: Pick<PdfPoint, "x" | "y">): void {
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
    const annotation: PdfTextAnnotation = {
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

  private textStyle(text: PdfTextAnnotation): TextStyle {
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
    annotation: Pick<PdfTextAnnotation, "x" | "y" | "width" | "height">,
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
    const selected = new Set(this.selectedTexts.map((text) => text.id));
    if (this.syncCurrentTextBoxes(surface, annotations, selected)) return;
    const boxes = annotations.map((annotation) => {
      const box = createDetachedDiv(surface.overlay.ownerDocument);
      box.className = "native-pdf-handwriting-text-box";
      box.dataset.annotationId = annotation.id;
      box.dataset.annotationSignature = this.textBoxRenderSignature(annotation, selected.has(annotation.id));
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
    annotations: readonly PdfTextAnnotation[],
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
  private textBoxRenderSignature(annotation: PdfTextAnnotation, selected: boolean): string {
    return [
      annotation.updatedAt, annotation.x, annotation.y, annotation.width, annotation.height,
      annotation.color, annotation.fontSize, annotation.fontFamily, annotation.bold, annotation.italic,
      annotation.strikethrough, annotation.text.length, annotation.runs.length, selected,
      this.textBoxesInteractable()
    ].join("|");
  }

  private positionTextBox(surface: PageSurface, box: HTMLElement, annotation: PdfTextAnnotation): void {
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
  private syncTextLayoutDuringZoom(surface: PageSurface): void {
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
    const layout = this.pageLayout(surface);
    const first = annotations[0];
    const origin = first ? this.mapper(surface).toViewport({ x: first.x, y: first.y }) : null;
    this.logger.textTool("zoom-layout", {
      page: surface.page.pageNumber,
      annotationCount: annotations.length,
      activeEditor: Boolean(activeEditor),
      transforming,
      scale: round(scale),
      offsetX: round(layout.offsetX),
      offsetY: round(layout.offsetY),
      contentWidth: round(layout.contentWidth),
      contentHeight: round(layout.contentHeight),
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
  private attachTextBoxOutline(surface: PageSurface, box: HTMLElement, annotation: PdfTextAnnotation): void {
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
    rendered: PdfTextAnnotation,
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
      start: this.textPointerToPdfPoint(surface, event),
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
    const point = this.textPointerToPdfPoint(drag.surface, event);
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

  private textPointerToPdfPoint(surface: PageSurface, event: PointerEvent): Pick<PdfPoint, "x" | "y"> {
    const rect = surface.overlay.getBoundingClientRect();
    return this.mapper(surface).toPdf({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  private resizeTextAnnotation(before: PdfTextAnnotation, handle: TextBoxHandle, point: Pick<PdfPoint, "x" | "y">): PdfTextAnnotation {
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
    annotation: PdfTextAnnotation,
    reference: PdfTextAnnotation
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
    const point = this.toPdfPoint(surface, sample, true);
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
    texts: readonly PdfTextAnnotation[],
    dx: number,
    dy: number,
    now = new Date().toISOString()
  ): PdfTextAnnotation[] {
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
        strokes.forEach((stroke) => this.ink.remove(stroke.id));
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
      undo: () => { pasted.forEach((stroke) => this.ink.remove(stroke.id)); pastedTexts.forEach((text) => this.texts.remove(text.id)); }
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
      undo: () => { duplicates.forEach((stroke) => this.ink.remove(stroke.id)); textDuplicates.forEach((text) => this.texts.remove(text.id)); }
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
        this.invalidateInkLayer(surface);
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
      .filter((text): text is PdfTextAnnotation => text !== undefined);
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

  private invalidateInkLayer(surface: PageSurface): void {
    surface.inkLayerValid = false;
    surface.inkLayerBackingScale = null;
    surface.inkLayerBurstCapture = false;
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
    }
    if (surface.inkLayer.width !== pixelWidth || surface.inkLayer.height !== pixelHeight) {
      surface.inkLayer.width = pixelWidth;
      surface.inkLayer.height = pixelHeight;
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
    }
    surface.inkLayerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    return surface.inkLayerContext;
  }

  /** Warm inkLayer from main canvas before zoom burst CSS-stretch. */
  private captureInkLayerFromCanvas(surface: PageSurface): void {
    if (surface.inkLayerValid && surface.inkLayer) return;
    if (!surface.canvas.width || !surface.canvas.height) return;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { backingScale } = this.resolveInkBacking(width, height);
    const layerContext = this.ensureInkLayer(surface, surface.canvas.width, surface.canvas.height, backingScale);
    layerContext.setTransform(1, 0, 0, 1, 0, 0);
    layerContext.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    layerContext.imageSmoothingEnabled = false;
    layerContext.drawImage(surface.canvas, 0, 0);
    layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    surface.inkLayerValid = true;
    // Raster warm — must not satisfy blit-only settle (needs vector restamp).
    surface.inkLayerBurstCapture = true;
    surface.inkLayerBackingScale = null;
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
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, pixelWidth, pixelHeight);
    surface.context.imageSmoothingEnabled = false;
    surface.context.drawImage(surface.inkLayer, 0, 0);
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
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
    stats?: { strokesRedrawn: number },
    graphiteQuality: "full" | "draft" = "full"
  ): void {
    const previous = surface.context;
    surface.context = context;
    try {
      for (const stroke of strokes) {
        const drawn = this.movePreview?.find((item) => item.id === stroke.id) ?? stroke;
        this.drawStroke(surface, drawn, this.selected.some((item) => item.id === stroke.id), graphiteQuality);
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
    includeActivePreview = true
  ): boolean {
    const surface = this.surfaces.get(pageNumber);
    if (!surface || this.zoomCompositing) return false;
    const preserveLiveDraft = this.surfaceHasLiveInkInput(surface);
    // Keep tip draft visible through resize/paint — clearing first caused a blank
    // flash between tip-up and settle-paint (draft gone, committed still building).
    const layout = this.pageLayout(surface);
    this.syncOverlayLayout(surface);
    const marginMode = ViewerInkSession.isZoomPaintReason(reason) ? "strict" : "idle";
    if (this.shouldCullPagePaint(surface, includeActivePreview, marginMode)) {
      surface.viewportCullPending = true;
      return false;
    }
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    if (width < 2 || height < 2) return false;
    const settleNeighbor = reason.includes("settle-neighbor");
    const settleFocusFast = reason.includes("settle-focus-fast");
    const settleCheap = settleNeighbor || settleFocusFast;
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(
      width,
      height,
      settleNeighbor ? "neighbor" : "full"
    );
    const needsResize = surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight;
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
      const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
      const drawingSelection = Boolean(this.selectionShape && this.selectionPage === pageNumber) && !drawingLasso;
      surface.canvas.classList.toggle("is-selection-chrome-raised", drawingLasso || drawingSelection);
      if (drawingLasso) this.drawLassoPreview(surface);
      else if (drawingSelection && this.selectionShape) {
        this.drawSelectionShape(surface, this.moveShapePreview ?? this.selectionShape, { closeFreeform: true });
      }
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
    if (needsResize && canBlit && !canonicalZoomSettle) {
      scaledBlit = this.snapshotCommittedBitmap(surface);
    }

    if (needsResize) {
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
      if (stats) stats.canvasesResized += 1;
    }
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);

    // Non-zoom resize keeps a bitmap fallback. Zoom itself settles directly to
    // canonical ink: a scaled raster and a later vector upgrade visibly differ
    // in opacity, while this synchronous render is presented atomically.
    if (scaledBlit && !canonicalZoomSettle) {
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
    }

    // Cheap settle under CSS mask: keep blit-stretch only; HQ upgrades on later rAF/idle.
    if (settleCheap && scaledBlit) {
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = true;
      surface.settleUpgradePending = true;
      this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
      surface.viewportCullPending = false;
      const drawingLassoNeighbor = surface.editTool === "lasso" && surface.editPath.length > 0;
      const drawingSelectionNeighbor = Boolean(this.selectionShape && this.selectionPage === pageNumber)
        && !drawingLassoNeighbor;
      surface.canvas.classList.toggle(
        "is-selection-chrome-raised",
        drawingLassoNeighbor || drawingSelectionNeighbor
      );
      if (drawingLassoNeighbor) this.drawLassoPreview(surface);
      else if (drawingSelectionNeighbor && this.selectionShape) {
        this.drawSelectionShape(surface, this.moveShapePreview ?? this.selectionShape, { closeFreeform: true });
      }
      this.paintLaserTrails(surface, pageNumber);
      if (syncText) this.renderTextAnnotations(surface);
      if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
      return true;
    }

    const storedStrokes = this.ink.pageIntersecting(pageNumber, this.pageInkBounds(surface));
    const visibleStrokes = erasingLive
      ? (surface.eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes)(storedStrokes, surface.editPath, surface.eraserSize!).kept
      : storedStrokes;

    const useLayerCache = canBlit && !erasingLive && !movingSelection;
    if (useLayerCache) {
      const layerContext = this.ensureInkLayer(surface, pixelWidth, pixelHeight, backingScale);
      if (!surface.inkLayerValid) {
        layerContext.clearRect(0, 0, width, height);
        this.paintCommittedStrokes(surface, layerContext, visibleStrokes, stats, "full");
        surface.inkLayerValid = true;
        surface.inkLayerBackingScale = backingScale;
        surface.inkLayerBurstCapture = false;
        if (canonicalZoomSettle) {
          this.logZoomInkRenderer(pageNumber, "settle-canonical", "canonical-pdf-space", visibleStrokes);
        }
      }
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
    } else {
      surface.inkLayerValid = false;
      surface.inkLayerBackingScale = null;
      surface.inkLayerBurstCapture = false;
      surface.context.clearRect(0, 0, width, height);
      this.paintCommittedStrokes(surface, surface.context, visibleStrokes, stats, "full");
      if (canonicalZoomSettle) {
        this.logZoomInkRenderer(pageNumber, "settle-canonical", "canonical-pdf-space", visibleStrokes);
      }
    }

    this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });
    surface.viewportCullPending = false;
    surface.settleUpgradePending = false;

    // Lasso/selection chrome is painted on the ink canvas (under the text layer
    // by default). Raise the canvas while that chrome is visible so text boxes
    // do not cover the outline — same look for ink-only and text selections.
    const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
    const drawingSelection = Boolean(this.selectionShape && this.selectionPage === pageNumber) && !drawingLasso;
    surface.canvas.classList.toggle("is-selection-chrome-raised", drawingLasso || drawingSelection);
    if (drawingLasso) {
      this.drawLassoPreview(surface);
    } else if (drawingSelection && this.selectionShape) {
      this.drawSelectionShape(surface, this.moveShapePreview ?? this.selectionShape, { closeFreeform: true });
    }
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
          draftId,
          // Pencil: full grit while dragging so release does not densify/reseed.
          draft.tool === "pencil" ? "full" : "draft"
        );
      } else {
        // Canvas/backing may have changed under the tip — rebuild draft once.
        surface.liveDrawPaintedPoints = 0;
        this.renderLiveDrawPreview(surface);
      }
    }
    this.paintLaserTrails(surface, pageNumber);
    if (syncText) this.renderTextAnnotations(surface);
    if (!preserveLiveDraft) this.clearLiveDrawPreview(surface);
    return true;
  }

  /** HN paints whole PDF-page canvases; cull pages, never partial canvas regions. */
  private shouldCullPagePaint(
    surface: PageSurface,
    includeActivePreview: boolean,
    marginMode: "idle" | "strict" = "idle"
  ): boolean {
    if (includeActivePreview && (surface.builder || surface.editPath.length > 0)) return false;
    if (this.selectionPage === surface.page.pageNumber) return false;
    return !this.surfaceNearViewport(surface, marginMode);
  }

  /**
   * @param marginMode `idle` prefetches with a large pad; `strict` is root intersection
   * only (zoom settle — off-screen quality is deferred via viewportCullPending).
   */
  private surfaceNearViewport(surface: PageSurface, marginMode: "idle" | "strict" = "idle"): boolean {
    const root = this.options.adapter.root.getBoundingClientRect();
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
    points: readonly PdfPoint[],
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
    if (!surface.inkLayerValid || !surface.inkLayer) {
      this.renderPage(pageNumber);
      return;
    }
    const rect = surface.overlay.getBoundingClientRect();
    const layout = this.pageLayout(surface);
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.resolveInkBacking(width, height);
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
    if (durationMs >= 16) {
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

  private drawLassoPreview(surface: PageSurface): void {
    const points = surface.editPath;
    if (!points.length) return;
    const lassoType = this.options.settings.toolPreferences.lasso.type;
    const shape: SelectionShape = lassoType === "freeform"
      ? { type: "freeform", points }
      : (() => {
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        return {
          type: lassoType,
          bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
        };
      })();
    this.drawSelectionShape(surface, shape, { closeFreeform: false });
  }

  private drawSelectionShape(surface: PageSurface, shape: SelectionShape, options: { closeFreeform: boolean }): void {
    const mapper = this.mapper(surface);
    const context = surface.context;
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

  private drawStroke(
    surface: PageSurface,
    stroke: InkStroke,
    selected: boolean,
    graphiteQuality: "full" | "draft" = "full"
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
      graphiteQuality,
      surface.context,
      stroke.eraseMasks
    );
  }

  private drawPoints(
    surface: PageSurface,
    points: readonly PdfPoint[],
    color: string,
    width: number,
    opacity: number,
    tool: DrawingTool,
    selected = false,
    strokeId?: string,
    graphiteQuality: "full" | "draft" = "full",
    context: CanvasRenderingContext2D = surface.context,
    eraseMasks?: InkStroke["eraseMasks"]
  ): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const scale = this.displayScale(surface);
    context.save();
    if (tool === "pencil") {
      const prefs = this.options.settings.toolPreferences.pencil;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return {
          x: view.x,
          y: view.y,
          pressure: point.pressure,
          tiltX: point.tiltX,
          tiltY: point.tiltY
        };
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
        quality: graphiteQuality,
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
        drawHighlighterStrokeWithMasks(
          context,
          viewPoints,
          highlighterOptions,
          eraseMasks.map((mask) => ({
            radius: Math.max(0.5, mask.radius * scale),
            points: mask.points.map((point) => {
              const view = mapper.toViewport(point);
              return { x: view.x, y: view.y };
            })
          }))
        );
      } else {
        drawHighlighterStroke(context, viewPoints, highlighterOptions);
      }
    } else {
      const prefs = this.options.settings.toolPreferences.pen;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure };
      });
      drawPenStroke(context, viewPoints, {
        color,
        width: Math.max(0.5 * scale, width * scale),
        opacity,
        pressureSensitivity: prefs.pressureSensitivity,
        thinning: prefs.thinning,
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
      const first = mapper.toViewport(points[0]!);
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) {
        const view = mapper.toViewport(point);
        context.lineTo(view.x, view.y);
      }
      context.stroke();
    }
    context.restore();
  }

  private toPdfPoints(
    surface: PageSurface,
    samples: readonly PointerSample[],
    simulateMousePressure: boolean,
    pressureConditioner?: PressureConditioner
  ): PdfPoint[] {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const mapper = this.mapper(surface);
    let previous = pressureConditioner ? surface.pressureLastPdfPoint : undefined;
    const points = samples.map((sample) => {
      const viewport = { x: sample.clientX - overlayRect.left, y: sample.clientY - overlayRect.top };
      const point = mapper.toPdf(viewport);
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
    if (pressureConditioner) surface.pressureLastPdfPoint = previous;
    return points;
  }

  private toPdfPoint(surface: PageSurface, sample: PointerSample, simulateMousePressure: boolean): PdfPoint {
    return this.toPdfPoints(surface, [sample], simulateMousePressure)[0]!;
  }

  private projectInkScreenPoint(surface: PageSurface, clientX: number, clientY: number): { x: number; y: number } {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const viewport = { x: clientX - overlayRect.left, y: clientY - overlayRect.top };
    const mapper = this.mapper(surface);
    const projected = mapper.toViewport(mapper.toPdf(viewport));
    return { x: overlayRect.left + projected.x, y: overlayRect.top + projected.y };
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
    const viewport = { x: sample.clientX - overlayRect.left, y: sample.clientY - overlayRect.top };
    const mapper = this.mapper(surface);
    const pdf = mapper.toPdf(viewport);
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

  private syncOverlayLayout(surface: PageSurface): void {
    const layout = this.pageLayout(surface);
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
    phase: "burst" | "settle" | "native-content" | "handoff-final"
  ): void {
    if (!this.logger.isEnabled()) return;
    const key = `${surface.page.pageNumber}:${phase}`;
    if (this.zoomInkLayoutLoggedPhases.has(key)) return;
    this.zoomInkLayoutLoggedPhases.add(key);

    const layout = this.pageLayout(surface);
    const metrics = this.metricsFor(surface);
    const contentRect = pdfRenderCanvas(surface.page.element)?.getBoundingClientRect();
    const overlayRect = surface.overlay.getBoundingClientRect();
    const overlayWidth = overlayRect.width >= 8 ? overlayRect.width : layout.contentWidth;
    const overlayHeight = overlayRect.height >= 8 ? overlayRect.height : layout.contentHeight;
    const firstStroke = this.ink.page(surface.page.pageNumber)[0];
    const anchorPoint = firstStroke?.points[0];
    const mapped = anchorPoint ? this.mapper(surface).toViewport(anchorPoint) : null;
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
    this.findBridge.syncPage(pageNumber, this.texts.page(pageNumber));
  }

  private findLayoutForAnnotation(
    pageNumber: number,
    annotation: PdfTextAnnotation
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

  private expectedAnchorNormalized(point: PdfPoint, metrics: { width: number; height: number }, rotation: PageRotation): { x: number; y: number } {
    switch (rotation) {
      case 0: return { x: point.x / metrics.width, y: (metrics.height - point.y) / metrics.height };
      case 90: return { x: point.y / metrics.height, y: point.x / metrics.width };
      case 180: return { x: (metrics.width - point.x) / metrics.width, y: point.y / metrics.height };
      case 270: return { x: (metrics.height - point.y) / metrics.height, y: (metrics.width - point.x) / metrics.width };
    }
  }

  private mapper(surface: PageSurface): PdfCoordinateMapper {
    const layout = this.pageLayout(surface);
    const metrics = this.metricsFor(surface);
    return new PdfCoordinateMapper({
      width: metrics.width,
      height: metrics.height,
      scale: layout.scale,
      scaleX: layout.scaleX,
      scaleY: layout.scaleY,
      rotation: this.rotation(surface.page.rotation),
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
    const metrics = this.metricsFor(surface);
    return resolvePageCoordinateLayout({
      ...surface.page,
      width: metrics.width,
      height: metrics.height
    });
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

  private rememberPageMetrics(page: PdfPageInfo): void {
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

  private snapshot(): SidecarSchemaV1 {
    const now = new Date().toISOString();
    const stored = new Map<number, InkStroke[]>();
    const storedTexts = new Map<number, PdfTextAnnotation[]>();
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

  private async persist(snapshot: SidecarSchemaV1, reason = "autosave"): Promise<void> {
    const strokeCount = countSidecarStrokes(snapshot);
    const textCount = countSidecarTexts(snapshot);
    const started = performance.now();
    let recoveryWriteMs: number | null = null;
    let sidecarWriteMs: number | null = null;
    let recoveryClearMs: number | null = null;
    const reportPersist = (outcome: string): void => this.reportDevProbe("sidecar-persist", {
      reason,
      outcome,
      durationMs: roundMs(performance.now() - started),
      recoveryWriteMs,
      sidecarWriteMs,
      recoveryClearMs,
      strokeCount,
      textCount
    });
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
    try {
      // Re-check after each await so emergency sync from another session cannot be overwritten.
      if (!this.stillOwnsPersist()) {
        reportPersist("skipped-before-recovery");
        return;
      }
      const recoveryWriteStarted = performance.now();
      await this.options.recovery.save(snapshot);
      recoveryWriteMs = roundMs(performance.now() - recoveryWriteStarted);
      if (!this.stillOwnsPersist()) {
        const recoveryClearStarted = performance.now();
        await this.options.recovery.clear(this.identity.id).catch(() => undefined);
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
      await this.options.recovery.clear(this.identity.id);
      recoveryClearMs = roundMs(performance.now() - recoveryClearStarted);
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
    this.options.adapter.mountToolbar(this.toolbar.element, this.currentToolbarPlacement());
  }

  setBoostedPdfZoom(enabled: boolean): void {
    this.options.adapter.setBoostedZoom?.(enabled);
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
    return resolveToolbarPlacement(configured, this.runtimePlatform().mobile);
  }

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "export") {
      await this.exportCopy().catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
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
    points: readonly PdfPoint[],
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

function temporaryEraserModifierKey(event: KeyboardEvent): "Control" | "Meta" | null {
  return event.key === "Control" || event.key === "Meta" ? event.key : null;
}

function samplePoints<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return [...points];
  const sampled: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round((index * (points.length - 1)) / (maxPoints - 1))]!);
  }
  return sampled;
}

function drawBounds(points: readonly PdfPoint[]): NonNullable<DrawPositionLog["bounds"]> {
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

function pathBoundsWithPadding(points: readonly Pick<PdfPoint, "x" | "y">[], padding: number): Bounds {
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
