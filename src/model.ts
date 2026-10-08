export type DrawingTool = "pen" | "pencil" | "highlighter";
/** Annotation tools. Mouse inking is a separate input setting, not a tool. */
export type ToolId = DrawingTool | "text" | "eraser" | "lasso" | "laser" | "drag";
export type LassoType = "freeform" | "rectangle";
export type ToolbarPlacement = "main" | "left" | "right";
/** Which input source supplies pressure for new ink strokes. */
export type PressureProfile = "auto" | "pen" | "mouse";
/** The physical-style simulation used by the pen tool. */
export type PenType = "fountain" | "ball" | "brush";
export const PEN_TYPES = ["fountain", "ball", "brush"] as const;

export function isPenType(value: unknown): value is PenType {
  return value === "fountain" || value === "ball" || value === "brush";
}

/** Compact, device-agnostic controls applied to future pen strokes. */
export interface PressureCalibration {
  /** Visible start width when a pen reports near-zero pressure. */
  initialFloor: number;
  /** Multiplier before the pen response curve. */
  gain: number;
  /** 0 responds immediately; 1 favours a steadier line. */
  smoothing: number;
}
export type SaveStatus = "saved" | "saving" | "dirty" | "failed";

export const DRAWING_TOOLS = ["pen", "pencil", "highlighter"] as const;

export function isDrawingTool(tool: string): tool is DrawingTool {
  return tool === "pen" || tool === "pencil" || tool === "highlighter";
}

/** Freehand ink routed as draw (persisted tools + ephemeral laser). */
export function isInkDrawTool(tool: string): tool is DrawingTool | "laser" {
  return isDrawingTool(tool) || tool === "laser";
}

export function isToolId(tool: unknown): tool is ToolId {
  return typeof tool === "string" && (isDrawingTool(tool) || tool === "text" || tool === "eraser" || tool === "lasso" || tool === "laser" || tool === "drag");
}

/** Active drawing tool, or pen when a non-drawing tool is selected. */
export function resolveDrawingTool(active: ToolId): DrawingTool {
  return isDrawingTool(active) ? active : "pen";
}

/** Page-local pointer sample; the same geometry works for PDF and image pages. */
export interface PagePoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  time: number;
}

/** Compatibility alias for PDF export and legacy sidecar helpers. */
export type PdfPoint = PagePoint;

export interface InkStroke {
  id: string;
  page: number;
  /** Stable page identifier (UUID) surviving page reordering. */
  pageId?: string;
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: "pen" | "mouse" | "touch";
  points: PagePoint[];
  /** Captured pen style; omitted by legacy strokes, which render as fountain pen. */
  penType?: PenType;
  /** Highlighter-only subtractive eraser paths in page-local coordinates. */
  eraseMasks?: InkEraseMask[];
  createdAt: string;
  updatedAt: string;
}

/** Circular eraser capsule stored on a highlighter stroke. */
export interface InkEraseMask {
  points: Array<Pick<PagePoint, "x" | "y">>;
  /** Eraser radius in page-local units. */
  radius: number;
}

/** Editable text placed by the Text tool; source document content is never changed. */
export interface TextAnnotation {
  id: string;
  page: number;
  /** Stable page identifier (UUID) surviving page reordering. */
  pageId?: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  runs: TextRun[];
  sourceRuns: TextRun[];
  createdAt: string;
  updatedAt: string;
}

export interface TextRun {
  text: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
}

/** Compatibility aliases for PDF export and legacy sidecar helpers. */
export type PdfTextAnnotation = TextAnnotation;
export type PdfTextRun = TextRun;

export interface DrawingToolPreferences {
  color: string;
  width: number;
  opacity: number;
  pressureSensitivity: boolean;
  stabilization: "off" | "low" | "medium" | "high";
  thinning: number;
  textureStrength: number;
  tiltSensitivity: boolean;
  simulateMousePressure: boolean;
  /** Pen-only nib simulation; absent on pencil/highlighter preferences. */
  penType?: PenType;
}

/** Ephemeral laser pointer — never written to sidecar. */
export interface LaserPreferences {
  color: string;
  width: number;
  opacity: number;
  /** Full-opacity linger before fade starts (ms). */
  holdMs: number;
  /** Fade + trail erase duration after hold (ms). */
  fadeMs: number;
}

export interface TextStyle {
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
}

export interface EraserPreferences {
  size: number;
  eraseWholeStrokes: boolean;
}

export interface ShapePreferences {
  /** A half-second stationary hold after drawing asks the recogniser to replace confident shapes. */
  holdToRecognize: boolean;
}

export interface ToolPreferences {
  activeTool: ToolId;
  pen: DrawingToolPreferences;
  pencil: DrawingToolPreferences;
  highlighter: DrawingToolPreferences;
  shape: ShapePreferences;
  text: TextStyle;
  eraser: EraserPreferences;
  lasso: { type: LassoType };
  laser: LaserPreferences;
  recentColors: string[];
}

export interface EnabledSurfaceSettings {
  /** Handwriting integration capability switches; future surfaces stay schema-ready. */
  pdf: boolean;
  image: boolean;
  markdown: boolean;
}

export interface PluginSettings {
  /** Supported-content capability switches; missing legacy values default to enabled. */
  enabledSurfaces: EnabledSurfaceSettings;
  autosave: boolean;
  autosaveDelayMs: number;
  saveWhenClosing: boolean;
  showSaveStatus: boolean;
  retryFailedAutosaves: boolean;
  /** Escape commits an active text annotation, per the selected workflow. */
  textEscapeAction: "save";
  sidecarFolder: string;
  /** Vault-relative PDF template; page one is used. Empty means blank US Letter paper. */
  pdfTemplatePath: string;
  /** Left mouse drags use the selected annotation tool when enabled. */
  mouseInkingEnabled: boolean;
  /** Explicit touch-only/ambiguous-device fallback; never enabled by migration. */
  touchDrawFallback: boolean;
  /** Allow a finger double-tap on the page to switch to the eraser. */
  touchDoubleTapEraser: boolean;
  /** Auto uses stylus pressure when available; Pen/Mouse force that input model. */
  pressureProfile: PressureProfile;
  /** Device-pressure tuning; captured when each stroke starts. */
  pressureCalibration: PressureCalibration;
  simplifyStrokes: boolean;
  /** Experimental mobile-only replacement for the native two-finger PDF pinch; enabled by default with an explicit opt-out. */
  customMobilePdfPinchZoom: boolean;
  /** Advanced accessibility opt-out; the page label remains visible by default. */
  hideStylusAnnotationLabel: boolean;
  /** Mobile-only opt-in to suppress swipe gestures that open sidebars or the command palette. */
  disableSwipeNavigation: boolean;
  toolbarPlacement: ToolbarPlacement;
  vaultDebugLog: boolean;
  vaultDebugLogPath: string;
  /** Restore a validated annotation backup after a corrupt store is quarantined. */
  automaticAnnotationRecovery: boolean;
  /** Vault-relative folder for validated sidecar/recovery backups. */
  annotationBackupPath: string;
  /** Prefer the plugin-owned PDF viewer for full control over zoom, rendering, and gestures. */
  preferPluginPdfView: boolean;
  toolPreferences: ToolPreferences;
}

export const PLUGIN_ID = "native-pdf-handwriting";

export function createDefaultToolPreferences(): ToolPreferences {
  const pen: DrawingToolPreferences = {
    color: "#111827",
    width: 1.5,
    opacity: 1,
    pressureSensitivity: true,
    stabilization: "medium",
    thinning: 0.55,
    textureStrength: 0,
    tiltSensitivity: false,
    simulateMousePressure: true,
    penType: "fountain"
  };
  const pencil: DrawingToolPreferences = {
    color: "#4b5563",
    width: 4,
    opacity: 0.88,
    pressureSensitivity: true,
    stabilization: "low",
    thinning: 0.2,
    textureStrength: 0.85,
    tiltSensitivity: true,
    simulateMousePressure: true
  };
  const highlighter: DrawingToolPreferences = {
    color: "#facc15",
    width: 14,
    opacity: 0.35,
    pressureSensitivity: false,
    stabilization: "low",
    thinning: 0.05,
    textureStrength: 0,
    tiltSensitivity: false,
    simulateMousePressure: true
  };
  return {
    activeTool: "pen",
    pen,
    pencil,
    highlighter,
    shape: { holdToRecognize: true },
    text: {
      color: "#111827",
      fontSize: 16,
      fontFamily: "sans-serif",
      bold: false,
      italic: false,
      strikethrough: false
    },
    eraser: { size: 12, eraseWholeStrokes: false },
    lasso: { type: "freeform" },
    laser: {
      color: "#ff0000",
      width: 2,
      opacity: 0.95,
      holdMs: 900,
      fadeMs: 1400
    },
    recentColors: ["#111827", "#2563eb", "#dc2626", "#059669", "#f59e0b", "#facc15"]
  };
}

/** Build path defaults from Vault#configDir. */
export function createDefaultSettings(configDir: string): PluginSettings {
  const root = configDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const vaultDebugLogPath = `${root}/plugins/${PLUGIN_ID}/debug.md`;
  return {
  enabledSurfaces: { pdf: true, image: true, markdown: true },
  autosave: true,
  autosaveDelayMs: 750,
  saveWhenClosing: true,
  showSaveStatus: true,
  retryFailedAutosaves: true,
  textEscapeAction: "save",
  sidecarFolder: `${root}/plugins/${PLUGIN_ID}/annotations`,
  pdfTemplatePath: "",
  mouseInkingEnabled: false,
  touchDrawFallback: false,
  touchDoubleTapEraser: true,
  pressureProfile: "auto",
  pressureCalibration: { initialFloor: 0.15, gain: 1.15, smoothing: 0.78 },
  simplifyStrokes: true,
  customMobilePdfPinchZoom: true,
  hideStylusAnnotationLabel: false,
  disableSwipeNavigation: false,
  toolbarPlacement: "main",
  vaultDebugLog: false,
  vaultDebugLogPath,
  automaticAnnotationRecovery: true,
  annotationBackupPath: parentVaultFolder(vaultDebugLogPath),
  preferPluginPdfView: true,
  toolPreferences: createDefaultToolPreferences()
  };
}

/** Test/helper defaults; runtime uses createDefaultSettings(app.vault.configDir). */
export const DEFAULT_SETTINGS: PluginSettings = createDefaultSettings("config");

const LEGACY_SETTING_KEYS = [
  // Draw mode is mouse/stylus ink; fingers keep native scroll (legacy fingerDraw removed).
  "fingerDraw",
  "yoloMode",
  "yoloConfirmed",
  "yoloAutosaveDelayMs",
  "createBackupBeforeDirectModification",
  "backupLocation",
  "retainSidecarAfterDirectModification",
  "showZoomMenu",
  // The removed 25× PDF zoom option must not be written back from old settings.
  "boostedPdfZoom"
] as const;

export function mergeSettings(
  saved: Partial<PluginSettings> | null | undefined,
  configDir = "config"
): PluginSettings {
  const defaults = createDefaultSettings(configDir);
  const raw = { ...(saved ?? {}) } as Record<string, unknown>;
  const legacyDisableSearchBarSwipe = raw.disableSearchBarSwipe === true;
  const savedDisableSwipeNavigation = raw.disableSwipeNavigation;
  const legacyDisableSidebarSwipe = raw.disableSidebarSwipe === true;
  const legacyDisableCommandPaletteSwipeSetting = raw.disableCommandPaletteSwipe;
  const legacyDisableCommandPaletteSwipe = legacyDisableCommandPaletteSwipeSetting === true;
  const legacyMouseInputMode = raw.mouseInputMode;
  const legacyMouseLeftDragDraw = raw.mouseLeftDragDraw;
  const savedMouseInkingEnabled = raw.mouseInkingEnabled;
  const legacyMouseInkingEnabled = legacyMouseInputMode === "annotate"
    ? legacyMouseLeftDragDraw !== false
    : legacyMouseInputMode === undefined && legacyMouseLeftDragDraw === true;
  const disableSwipeNavigation = typeof savedDisableSwipeNavigation === "boolean"
    ? savedDisableSwipeNavigation
    : legacyDisableSidebarSwipe
      || legacyDisableCommandPaletteSwipe
      || (legacyDisableCommandPaletteSwipeSetting === undefined && legacyDisableSearchBarSwipe);
  delete raw.disableSidebarSwipe;
  delete raw.disableCommandPaletteSwipe;
  delete raw.disableSearchBarSwipe;
  delete raw.mouseInputMode;
  delete raw.mouseDragScroll;
  delete raw.mouseLeftDragDraw;
  delete raw.mouseRightDragErase;
  for (const key of LEGACY_SETTING_KEYS) delete raw[key];
  const cleaned = raw as Partial<PluginSettings>;
  const lassoRaw = { ...defaults.toolPreferences.lasso, ...cleaned.toolPreferences?.lasso } as {
    type: LassoType;
    includeLocked?: unknown;
    selectionMode?: unknown;
  };
  const lasso = {
    type: lassoRaw.type === "freeform" || lassoRaw.type === "rectangle" ? lassoRaw.type : "freeform" as const
  };
  const toolbarPlacement = cleaned.toolbarPlacement;
  const pdfTemplatePath = typeof cleaned.pdfTemplatePath === "string"
    ? cleaned.pdfTemplatePath.trim()
    : defaults.pdfTemplatePath;
  const pressureProfile = cleaned.pressureProfile;
  const pressureCalibration = normalizePressureCalibration(cleaned.pressureCalibration, defaults.pressureCalibration);
  const mouseInkingEnabled = typeof savedMouseInkingEnabled === "boolean"
    ? savedMouseInkingEnabled
    : legacyMouseInkingEnabled;
  const savedEnabledSurfaces = cleaned.enabledSurfaces as Partial<EnabledSurfaceSettings> | undefined;
  const savedToolPreferences = { ...(cleaned.toolPreferences ?? {}) } as Record<string, unknown>;
  delete savedToolPreferences.pan;
  // Presets were the old way to store a drawing style. Migrate their last known
  // values into the permanent per-tool settings, then discard the legacy keys so
  // they cannot leak back into the persisted schema.
  const migratedDrawingPreferences = migrateLegacyDrawingPreferences(savedToolPreferences, defaults.toolPreferences);
  delete savedToolPreferences.presets;
  delete savedToolPreferences.activePresetId;
  delete savedToolPreferences.sidebarPresetIds;
  // Shape recognition used to be a separate active tool. It is now an enabled-by-default
  // option in every drawing tool's Advanced settings, so safely return existing users to pen.
  const savedActiveTool = (cleaned.toolPreferences as { activeTool?: unknown } | undefined)?.activeTool;
  const activeTool = savedActiveTool === "shape"
    ? "pen"
    : isToolId(savedActiveTool)
      ? savedActiveTool
      : defaults.toolPreferences.activeTool;
  const merged = {
    ...defaults,
    ...cleaned,
    enabledSurfaces: {
      pdf: savedEnabledSurfaces?.pdf !== false,
      image: savedEnabledSurfaces?.image !== false,
      markdown: savedEnabledSurfaces?.markdown !== false
    },
    toolbarPlacement: toolbarPlacement === "left" || toolbarPlacement === "right" || toolbarPlacement === "main"
      ? toolbarPlacement
      : defaults.toolbarPlacement,
    pdfTemplatePath,
    mouseInkingEnabled,
    // Legacy `fingerDraw` is removed above; only the new explicit setting may
    // opt into touch ink, and only with the literal boolean value true.
    touchDrawFallback: cleaned.touchDrawFallback === true,
    touchDoubleTapEraser: cleaned.touchDoubleTapEraser !== false,
    textEscapeAction: "save" as const,
    preferPluginPdfView: cleaned.preferPluginPdfView !== false,
    customMobilePdfPinchZoom: typeof cleaned.customMobilePdfPinchZoom === "boolean"
      ? cleaned.customMobilePdfPinchZoom
      : defaults.customMobilePdfPinchZoom,
    hideStylusAnnotationLabel: cleaned.hideStylusAnnotationLabel === true,
    disableSwipeNavigation,
    pressureProfile: pressureProfile === "pen" || pressureProfile === "mouse" || pressureProfile === "auto"
      ? pressureProfile
      : defaults.pressureProfile,
    pressureCalibration,
    toolPreferences: {
      ...defaults.toolPreferences,
      ...savedToolPreferences,
      activeTool,
      pen: {
        ...migratedDrawingPreferences.pen,
        penType: isPenType(migratedDrawingPreferences.pen.penType)
          ? migratedDrawingPreferences.pen.penType
          : "fountain"
      },
      pencil: migratedDrawingPreferences.pencil,
      highlighter: migratedDrawingPreferences.highlighter,
      shape: {
        holdToRecognize: cleaned.toolPreferences?.shape?.holdToRecognize !== false
      },
      text: {
        color: cleaned.toolPreferences?.text?.color ?? defaults.toolPreferences.text.color,
        fontSize: cleaned.toolPreferences?.text?.fontSize ?? defaults.toolPreferences.text.fontSize,
        fontFamily: cleaned.toolPreferences?.text?.fontFamily ?? defaults.toolPreferences.text.fontFamily,
        bold: cleaned.toolPreferences?.text?.bold === true,
        italic: cleaned.toolPreferences?.text?.italic === true,
        strikethrough: cleaned.toolPreferences?.text?.strikethrough === true
      },
      eraser: {
        size: cleaned.toolPreferences?.eraser?.size ?? defaults.toolPreferences.eraser.size,
        eraseWholeStrokes: cleaned.toolPreferences?.eraser?.eraseWholeStrokes === true
      },
      lasso,
      laser: {
        ...defaults.toolPreferences.laser,
        ...cleaned.toolPreferences?.laser,
        holdMs: clampLaserMs(
          cleaned.toolPreferences?.laser?.holdMs ?? defaults.toolPreferences.laser.holdMs,
          200,
          3000,
          defaults.toolPreferences.laser.holdMs
        ),
        fadeMs: clampLaserMs(
          cleaned.toolPreferences?.laser?.fadeMs ?? defaults.toolPreferences.laser.fadeMs,
          300,
          4000,
          defaults.toolPreferences.laser.fadeMs
        )
      }
    }
  };
  merged.sidecarFolder = remapPluginDataPath(cleaned.sidecarFolder, defaults.sidecarFolder, configDir);
  merged.vaultDebugLogPath = migrateVaultDebugLogPath(
    remapPluginDataPath(cleaned.vaultDebugLogPath, defaults.vaultDebugLogPath, configDir)
  );
  merged.automaticAnnotationRecovery = cleaned.automaticAnnotationRecovery !== false;
  merged.annotationBackupPath = normalizeVaultFolderPath(
    cleaned.annotationBackupPath,
    parentVaultFolder(merged.vaultDebugLogPath),
    configDir
  );
  return merged;
}

/** Prefer `.md` so the vault log opens as a note in Obsidian. */
function migrateVaultDebugLogPath(path: string): string {
  return path.replace(/\/debug\.log$/i, "/debug.md").replace(/^debug\.log$/i, "debug.md");
}

function parentVaultFolder(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator >= 0 ? normalized.slice(0, separator) : "";
}

function normalizeVaultFolderPath(saved: unknown, fallback: string, configDir: string): string {
  if (typeof saved !== "string") return fallback;
  const normalized = saved.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return "";
  const remapped = remapPluginDataPath(normalized, fallback, configDir)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const parts = remapped.split("/").filter((part) => part && part !== ".");
  return parts.includes("..") ? fallback : parts.join("/");
}

function remapPluginDataPath(saved: string | undefined, fallback: string, configDir: string): string {
  if (!saved || !saved.trim()) return fallback;
  const marker = `/plugins/${PLUGIN_ID}`;
  const normalized = saved.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    const root = configDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return `${root}${normalized.slice(index)}`;
  }
  return saved;
}

function normalizePressureCalibration(value: unknown, fallback: PressureCalibration): PressureCalibration {
  const raw = value && typeof value === "object" ? value as Partial<PressureCalibration> : {};
  return {
    initialFloor: clampPressureCalibration(raw.initialFloor, 0, 0.3, fallback.initialFloor),
    gain: clampPressureCalibration(raw.gain, 0.4, 2, fallback.gain),
    smoothing: clampPressureCalibration(raw.smoothing, 0, 1, fallback.smoothing)
  };
}

function clampPressureCalibration(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampLaserMs(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface LegacyDrawingPreset {
  id: string;
  tool: DrawingTool;
  settings: Partial<DrawingToolPreferences>;
}

function migrateLegacyDrawingPreferences(
  saved: Record<string, unknown>,
  defaults: ToolPreferences
): Pick<ToolPreferences, "pen" | "pencil" | "highlighter"> {
  const legacyPresets = readLegacyDrawingPresets(saved.presets);
  const activePresetId = typeof saved.activePresetId === "string" ? saved.activePresetId : undefined;
  const migrated = {} as Pick<ToolPreferences, "pen" | "pencil" | "highlighter">;
  for (const tool of DRAWING_TOOLS) {
    const savedTool = isRecord(saved[tool]) ? saved[tool] : {};
    const legacyPreset = legacyPresets.find((preset) => preset.id === activePresetId && preset.tool === tool)
      ?? legacyPresets.find((preset) => preset.tool === tool);
    migrated[tool] = {
      ...defaults[tool],
      ...(legacyPreset?.settings ?? {}),
      ...savedTool
    };
  }
  return migrated;
}

function readLegacyDrawingPresets(value: unknown): LegacyDrawingPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: LegacyDrawingPreset[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const tool = candidate.tool;
    if (typeof id !== "string" || !id || typeof tool !== "string" || !isDrawingTool(tool) || seen.has(id)) continue;
    if (!isRecord(candidate.settings)) continue;
    seen.add(id);
    result.push({ id, tool, settings: candidate.settings as Partial<DrawingToolPreferences> });
    if (result.length === 8) break;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
