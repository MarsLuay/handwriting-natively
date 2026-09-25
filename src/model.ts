export type DrawingTool = "pen" | "pencil" | "highlighter";
/** Annotation tools. Mouse pan/native modes live in settings, not as a tool. */
export type ToolId = DrawingTool | "text" | "eraser" | "lasso" | "laser";
export type LassoType = "freeform" | "rectangle";
export type ToolbarPlacement = "main" | "left" | "right";
export type MouseInputMode = "pan" | "annotate" | "native";
/** Which input source supplies pressure for new ink strokes. */
export type PressureProfile = "auto" | "pen" | "mouse";
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
  return typeof tool === "string" && (isDrawingTool(tool) || tool === "text" || tool === "eraser" || tool === "lasso" || tool === "laser");
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
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: "pen" | "mouse" | "touch";
  points: PagePoint[];
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
}

/** A named, persisted drawing configuration that can be selected in one action. */
export interface DrawingPreset {
  id: string;
  name: string;
  tool: DrawingTool;
  settings: DrawingToolPreferences;
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
  eraseWithRightMouseButton: boolean;
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
  /** User-selectable drawing configurations; capped during settings migration. */
  presets: DrawingPreset[];
  activePresetId: string | null;
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
  /**
   * Explicit mouse behavior without a Draw checkbox.
   * Migrated from legacy `mouseDragScroll` when absent (`true` → pan, `false` → native).
   */
  mouseInputMode?: MouseInputMode;
  /** Legacy mirror of `mouseInputMode === "pan"` for older sidecars / readers. */
  mouseDragScroll: boolean;
  /** Auto uses stylus pressure when available; Pen/Mouse force that input model. */
  pressureProfile: PressureProfile;
  /** Device-pressure tuning; captured when each stroke starts. */
  pressureCalibration: PressureCalibration;
  simplifyStrokes: boolean;
  /** Advanced opt-in: raise Obsidian PDF viewer zoom from 10× to 25×. */
  boostedPdfZoom: boolean;
  /** Advanced accessibility opt-out; the page label remains visible by default. */
  hideStylusAnnotationLabel: boolean;
  toolbarPlacement: ToolbarPlacement;
  vaultDebugLog: boolean;
  vaultDebugLogPath: string;
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
    simulateMousePressure: true
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
  const presets: DrawingPreset[] = [
    { id: "black-pen", name: "Black pen", tool: "pen", settings: { ...pen } },
    { id: "blue-pen", name: "Blue pen", tool: "pen", settings: { ...pen, color: "#2563eb", width: 1.2 } },
    { id: "yellow-highlighter", name: "Yellow highlighter", tool: "highlighter", settings: { ...highlighter } }
  ];
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
    eraser: { size: 12, eraseWholeStrokes: false, eraseWithRightMouseButton: false },
    lasso: { type: "freeform" },
    laser: {
      color: "#ff0000",
      width: 2,
      opacity: 0.95,
      holdMs: 900,
      fadeMs: 1400
    },
    recentColors: ["#111827", "#2563eb", "#dc2626", "#059669", "#f59e0b", "#facc15"],
    presets,
    activePresetId: presets[0]?.id ?? null
  };
}

/** Build path defaults from Vault#configDir. */
export function createDefaultSettings(configDir: string): PluginSettings {
  const root = configDir.replace(/\\/g, "/").replace(/\/+$/, "");
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
  mouseInputMode: "pan",
  mouseDragScroll: true,
  pressureProfile: "auto",
  pressureCalibration: { initialFloor: 0.15, gain: 1.15, smoothing: 0.78 },
  simplifyStrokes: true,
  boostedPdfZoom: false,
  hideStylusAnnotationLabel: false,
  toolbarPlacement: "main",
  vaultDebugLog: false,
  vaultDebugLogPath: `${root}/plugins/${PLUGIN_ID}/debug.md`,
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
  "showZoomMenu"
] as const;

export function mergeSettings(
  saved: Partial<PluginSettings> | null | undefined,
  configDir = "config"
): PluginSettings {
  const defaults = createDefaultSettings(configDir);
  const raw = { ...(saved ?? {}) } as Record<string, unknown>;
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
  const savedEnabledSurfaces = cleaned.enabledSurfaces as Partial<EnabledSurfaceSettings> | undefined;
  const savedToolPreferences = { ...(cleaned.toolPreferences ?? {}) } as Record<string, unknown>;
  delete savedToolPreferences.pan;
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
    textEscapeAction: "save" as const,
    boostedPdfZoom: cleaned.boostedPdfZoom === true,
    hideStylusAnnotationLabel: cleaned.hideStylusAnnotationLabel === true,
    pressureProfile: pressureProfile === "pen" || pressureProfile === "mouse" || pressureProfile === "auto"
      ? pressureProfile
      : defaults.pressureProfile,
    pressureCalibration,
    toolPreferences: {
      ...defaults.toolPreferences,
      ...savedToolPreferences,
      activeTool,
      pen: { ...defaults.toolPreferences.pen, ...cleaned.toolPreferences?.pen },
      pencil: { ...defaults.toolPreferences.pencil, ...cleaned.toolPreferences?.pencil },
        highlighter: {
          ...defaults.toolPreferences.highlighter,
          ...cleaned.toolPreferences?.highlighter
        },
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
        eraseWholeStrokes: cleaned.toolPreferences?.eraser?.eraseWholeStrokes === true,
        eraseWithRightMouseButton: cleaned.toolPreferences?.eraser?.eraseWithRightMouseButton === true
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
      },
      presets: normalizeDrawingPresets(cleaned.toolPreferences?.presets, defaults.toolPreferences.presets),
      activePresetId: null as string | null
    }
  };
  const savedPresetId = cleaned.toolPreferences?.activePresetId;
  merged.toolPreferences.activePresetId = typeof savedPresetId === "string" &&
    merged.toolPreferences.presets.some((preset) => preset.id === savedPresetId)
    ? savedPresetId
    : merged.toolPreferences.presets[0]?.id ?? null;
  merged.sidecarFolder = remapPluginDataPath(cleaned.sidecarFolder, defaults.sidecarFolder, configDir);
  merged.vaultDebugLogPath = migrateVaultDebugLogPath(
    remapPluginDataPath(cleaned.vaultDebugLogPath, defaults.vaultDebugLogPath, configDir)
  );
  const mouseInputMode = resolvePersistedMouseInputMode(cleaned);
  merged.mouseInputMode = mouseInputMode;
  merged.mouseDragScroll = mouseInputMode === "pan";
  return merged;
}

function resolvePersistedMouseInputMode(
  cleaned: Partial<PluginSettings>
): MouseInputMode {
  const mode = cleaned.mouseInputMode;
  if (mode === "pan" || mode === "annotate" || mode === "native") return mode;
  return cleaned.mouseDragScroll === false ? "native" : "pan";
}

/** Prefer `.md` so the vault log opens as a note in Obsidian. */
function migrateVaultDebugLogPath(path: string): string {
  return path.replace(/\/debug\.log$/i, "/debug.md").replace(/^debug\.log$/i, "debug.md");
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

function normalizeDrawingPresets(value: unknown, fallback: readonly DrawingPreset[]): DrawingPreset[] {
  if (!Array.isArray(value)) return fallback.map(cloneDrawingPreset);
  const seen = new Set<string>();
  const result: DrawingPreset[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Partial<DrawingPreset> & { settings?: Partial<DrawingToolPreferences> };
    const id = raw.id;
    const name = raw.name;
    const tool = raw.tool;
    if (typeof id !== "string" || typeof name !== "string" || typeof tool !== "string" || !isDrawingTool(tool) || seen.has(id)) continue;
    const defaults = fallback.find((preset) => preset.tool === tool)?.settings;
    if (!defaults) continue;
    seen.add(id);
    result.push({
      id: id.slice(0, 64),
      name: name.trim().slice(0, 80) || id.slice(0, 64),
      tool,
      settings: { ...defaults, ...(raw.settings ?? {}) }
    });
    if (result.length === 8) break;
  }
  return result.length ? result : fallback.map(cloneDrawingPreset);
}

function cloneDrawingPreset(preset: DrawingPreset): DrawingPreset {
  return { ...preset, settings: { ...preset.settings } };
}
