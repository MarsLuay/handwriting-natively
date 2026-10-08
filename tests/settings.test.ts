import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/model";

const platformState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("obsidian", () => {
  class MockObsidianBase {}
  return {
    FuzzySuggestModal: MockObsidianBase,
    Notice: MockObsidianBase,
    Platform: platformState,
    Plugin: MockObsidianBase,
    PluginSettingTab: MockObsidianBase,
    Setting: MockObsidianBase,
    TFile: MockObsidianBase,
    TFolder: MockObsidianBase
  };
});

const {
  NativePdfInkSettingTab,
  buildCopiedLogDiagnostics,
  COPIED_LOG_DIAGNOSTICS_SEPARATOR,
  getCopiedLogText,
  MAX_COPIED_LOG_CHARACTERS
} = await import("../src/settings");

const diagnostics = {
  pluginVersion: "0.1.55",
  obsidianVersion: "1.8.10",
  platform: "Windows",
  appMode: "desktop",
  runtime: "Chromium test runtime",
  userAgent: "TestRuntime/1.0",
  devicePixelRatio: 1.25,
  profileSchemaVersion: 2
};

describe("safe defaults", () => {
  it("appends the current mobile PDF pinch gate and observed mode", () => {
    const copied = buildCopiedLogDiagnostics({
      ...diagnostics,
      mobilePdfZoom: [{
        sessionNumber: 1,
        settingEnabled: true,
        gateMode: "custom-mobile",
        fallbackReason: null,
        active: false,
        activePhase: null,
        traceMode: "custom-mobile",
        tracePhase: "settled",
        observedCustomGesture: true,
        gestureBeginCount: 1,
        transformFrameCount: 12,
        transformTotalMs: 4.8,
        transformMaxMs: 0.9,
        nativeCommitWaitMs: 38.2,
        releaseReason: "stable"
      }]
    });

    expect(copied).toContain("Mobile PDF pinch zoom:");
    expect(copied).toContain("setting=on gate=custom-mobile active=no phase=none observed=yes");
    expect(copied).toContain("trace=custom-mobile/settled begins=1 transformFrames=12");
    expect(copied).toContain("nativeCommitWaitMs=38.2 release=stable fallback=none");
  });

  it("appends copy-time diagnostics while retaining the full short log", () => {
    const copied = getCopiedLogText("short log", diagnostics);

    expect(copied).toBe(
      `short log${COPIED_LOG_DIAGNOSTICS_SEPARATOR}${buildCopiedLogDiagnostics(diagnostics)}`
    );
    expect(copied).toContain("Plugin version: 0.1.55");
    expect(copied).toContain("Obsidian version/API: 1.8.10");
    expect(copied).toContain("Platform: Windows");
    expect(copied).toContain("App mode: desktop");
    expect(copied).toContain("Runtime: Chromium test runtime");
    expect(copied).toContain("User agent: TestRuntime/1.0");
    expect(copied).toContain("Device pixel ratio: 1.25");
    expect(copied).toContain("Performance profile schema: 2");
  });

  it("reserves diagnostics space before taking the newest log tail", () => {
    const logs = `${"a".repeat(12)}${"b".repeat(MAX_COPIED_LOG_CHARACTERS)}`;
    const diagnosticsText = buildCopiedLogDiagnostics(diagnostics);
    const logBudget = MAX_COPIED_LOG_CHARACTERS - COPIED_LOG_DIAGNOSTICS_SEPARATOR.length - diagnosticsText.length;
    const copied = getCopiedLogText(logs, diagnostics);

    expect(copied.length).toBe(MAX_COPIED_LOG_CHARACTERS);
    expect(copied).toBe(
      `${"b".repeat(logBudget)}${COPIED_LOG_DIAGNOSTICS_SEPARATOR}${diagnosticsText}`
    );
  });

  it("keeps the payload bounded and preserves core fields with missing or huge optional values", () => {
    const copied = getCopiedLogText("log", {
      pluginVersion: "0.1.55",
      obsidianVersion: "1.8.10",
      platform: "Windows",
      appMode: "desktop",
      userAgent: "u".repeat(MAX_COPIED_LOG_CHARACTERS),
      devicePixelRatio: Number.NaN
    });

    expect(copied.length).toBeLessThanOrEqual(MAX_COPIED_LOG_CHARACTERS);
    expect(copied).toContain("Plugin version: 0.1.55");
    expect(copied).toContain("Obsidian version/API: 1.8.10");
    expect(copied).toContain("Platform: Windows");
    expect(copied).toContain("Runtime: unavailable");
    expect(copied).toContain("User agent: ");
    expect(copied).toContain("Device pixel ratio: unavailable");
  });

  it("does not fail when optional runtime fields are unavailable", () => {
    const copied = getCopiedLogText("short log", {
      pluginVersion: "0.1.55",
      obsidianVersion: "1.8.10",
      platform: "unknown",
      appMode: "unknown"
    });

    expect(copied).toContain("Runtime: unavailable");
    expect(copied).toContain("User agent: unavailable");
    expect(copied).toContain("Device pixel ratio: unavailable");
  });

  it("defaults PDF handwriting on and preserves future surface switches", () => {
    expect(DEFAULT_SETTINGS.enabledSurfaces).toEqual({ pdf: true, image: true, markdown: true });
    expect(mergeSettings(undefined).enabledSurfaces.pdf).toBe(true);
    expect(mergeSettings({ enabledSurfaces: { pdf: false } } as never).enabledSurfaces).toEqual({
      pdf: false,
      image: true,
      markdown: true
    });
  });

  it("exposes a Markdown surface toggle and persists its value", async () => {
    const tab = Object.create(NativePdfInkSettingTab.prototype) as InstanceType<typeof NativePdfInkSettingTab>;
    const host = {
      inkSettings: { ...DEFAULT_SETTINGS, enabledSurfaces: { pdf: true, image: true, markdown: true } },
      saveSettings: vi.fn(async (settings) => {
        host.inkSettings = settings;
      })
    };
    Object.assign(tab, { host });

    const definition = tab.getSettingDefinitions().find((item) =>
      "name" in item && item.name === "Enable on Markdown"
    );
    expect(definition).toBeDefined();
    if (!definition || !("render" in definition) || typeof definition.render !== "function") return;

    let onChange: ((value: boolean) => Promise<void>) | undefined;
    const toggle = {
      setValue: vi.fn().mockReturnThis(),
      onChange: vi.fn((handler: (value: boolean) => Promise<void>) => {
        onChange = handler;
        return toggle;
      })
    };
    const setting = {
      addToggle: (render: (control: typeof toggle) => unknown) => {
        render(toggle);
        return setting;
      }
    };
    definition.render(setting as never);

    expect(toggle.setValue).toHaveBeenCalledWith(true);
    await onChange?.(false);
    expect(host.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      enabledSurfaces: { pdf: true, image: true, markdown: false }
    }));
  });

  it("migrates the retired plugin-owned PDF viewer preference to the native viewer", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty("preferPluginPdfView");
    expect(mergeSettings(undefined)).not.toHaveProperty("preferPluginPdfView");
    expect(mergeSettings({ preferPluginPdfView: true } as never)).not.toHaveProperty("preferPluginPdfView");
  });

  it("enables finger double-tap eraser switching by default and preserves an explicit opt-out", () => {
    expect(DEFAULT_SETTINGS.touchDoubleTapEraser).toBe(true);
    expect(mergeSettings(undefined).touchDoubleTapEraser).toBe(true);
    expect(mergeSettings({ touchDoubleTapEraser: false }).touchDoubleTapEraser).toBe(false);
    expect(mergeSettings({ touchDoubleTapEraser: "false" } as never).touchDoubleTapEraser).toBe(true);
  });

  it("keeps swipe navigation blocking opt-in and migrates legacy settings", () => {
    expect(DEFAULT_SETTINGS.disableSwipeNavigation).toBe(false);
    expect(mergeSettings({ disableSwipeNavigation: false }).disableSwipeNavigation).toBe(false);
    expect(mergeSettings({ disableSidebarSwipe: true } as never).disableSwipeNavigation).toBe(true);
    expect(mergeSettings({ disableCommandPaletteSwipe: true } as never).disableSwipeNavigation).toBe(true);
    expect(mergeSettings({ disableSidebarSwipe: false, disableCommandPaletteSwipe: false } as never)
      .disableSwipeNavigation).toBe(false);
    expect(mergeSettings({ disableSearchBarSwipe: true } as never).disableSwipeNavigation).toBe(true);

    const explicitlyDisabled = mergeSettings({
      disableSwipeNavigation: false,
      disableSidebarSwipe: true,
      disableCommandPaletteSwipe: true
    } as never);
    expect(explicitlyDisabled.disableSwipeNavigation).toBe(false);
    expect("disableSidebarSwipe" in explicitlyDisabled).toBe(false);
    expect("disableCommandPaletteSwipe" in explicitlyDisabled).toBe(false);

    expect(mergeSettings({
      disableSwipeNavigation: true,
      disableSidebarSwipe: false,
      disableCommandPaletteSwipe: false
    } as never).disableSwipeNavigation).toBe(true);
  });

  it("shows the combined swipe-navigation setting only in mobile mode", () => {
    const tab = Object.create(NativePdfInkSettingTab.prototype) as InstanceType<typeof NativePdfInkSettingTab>;
    Object.assign(tab, { host: { inkSettings: DEFAULT_SETTINGS } });
    const getSwipeSettings = () => {
      const navigationGroup = tab.getSettingDefinitions().find((definition) =>
        "heading" in definition && definition.heading === "PDF navigation"
      );
      return navigationGroup && "items" in navigationGroup
        ? navigationGroup.items
          .filter((item) => item.name.toLowerCase().includes("swipe"))
          .map(({ name, desc }) => ({ name, desc }))
        : [];
    };

    try {
      platformState.isMobile = true;
      expect(getSwipeSettings()).toEqual([{
        name: "Disable swipe-activated sidebars",
        desc: "Prevent one-finger swipe gestures from opening Obsidian’s left sidebar, right sidebar, or command palette on mobile/iPad. Buttons and normal commands still work."
      }]);

      platformState.isMobile = false;
      expect(getSwipeSettings()).toEqual([]);
    } finally {
      platformState.isMobile = false;
    }
  });

  it("enables custom mobile PDF pinch zoom by default while preserving an explicit opt-out", () => {
    expect(DEFAULT_SETTINGS.customMobilePdfPinchZoom).toBe(true);
    const retiredZoomSetting = mergeSettings({ boostedPdfZoom: true } as never);
    expect("boostedPdfZoom" in retiredZoomSetting).toBe(false);
    expect(mergeSettings(undefined).customMobilePdfPinchZoom).toBe(true);
    expect(retiredZoomSetting.customMobilePdfPinchZoom).toBe(true);
    expect(mergeSettings({ customMobilePdfPinchZoom: true }).customMobilePdfPinchZoom).toBe(true);
    expect(mergeSettings({ customMobilePdfPinchZoom: false }).customMobilePdfPinchZoom).toBe(false);
    expect(mergeSettings({ customMobilePdfPinchZoom: "true" } as never).customMobilePdfPinchZoom).toBe(true);
  });

  it("enables autosave", () => {
    expect(DEFAULT_SETTINGS.autosave).toBe(true);
    expect(DEFAULT_SETTINGS.autosaveDelayMs).toBe(750);
    expect(DEFAULT_SETTINGS.saveWhenClosing).toBe(true);
  });

  it("keeps pen, pencil, and highlighter preferences separate", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.pen).not.toEqual(
      DEFAULT_SETTINGS.toolPreferences.pencil
    );
    expect(DEFAULT_SETTINGS.toolPreferences.pencil.textureStrength).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.width).toBeGreaterThan(
      DEFAULT_SETTINGS.toolPreferences.pen.width
    );
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.opacity).toBeLessThan(0.5);
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.color).toBe("#facc15");
  });

  it("merges highlighter preferences from saved settings", () => {
    const merged = mergeSettings({
      toolPreferences: {
        highlighter: { width: 24, opacity: 0.2 }
      } as never
    });
    expect(merged.toolPreferences.highlighter.width).toBe(24);
    expect(merged.toolPreferences.highlighter.opacity).toBe(0.2);
    expect(merged.toolPreferences.highlighter.color).toBe("#facc15");
  });

  it("restores all remembered settings for each drawing tool", () => {
    const saved = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    saved.pen = { ...saved.pen, color: "#123456", width: 2.5, stabilization: "high", tiltSensitivity: true };
    saved.pencil = { ...saved.pencil, color: "#654321", width: 7, textureStrength: 0.4, simulateMousePressure: false };
    saved.highlighter = { ...saved.highlighter, color: "#22c55e", width: 24, opacity: 0.2 };
    const merged = mergeSettings({ toolPreferences: saved });
    expect(merged.toolPreferences.pen).toEqual(saved.pen);
    expect(merged.toolPreferences.pencil).toEqual(saved.pencil);
    expect(merged.toolPreferences.highlighter).toEqual(saved.highlighter);
  });

  it("migrates old preset styles into independent tool settings and drops legacy keys", () => {
    expect(DEFAULT_SETTINGS.toolPreferences).not.toHaveProperty("presets");
    expect(DEFAULT_SETTINGS.toolPreferences).not.toHaveProperty("activePresetId");
    const merged = mergeSettings({
      toolPreferences: {
        presets: [
          { id: "custom-pen", name: "Blue", tool: "pen", settings: { color: "#2563eb", width: 2 } },
          { id: "yellow", name: "Yellow", tool: "highlighter", settings: { width: 24, opacity: 0.2 } }
        ],
        activePresetId: "custom-pen",
        activeTool: "pen"
      } as never
    });
    expect(merged.toolPreferences.pen).toMatchObject({ color: "#2563eb", width: 2 });
    expect(merged.toolPreferences.highlighter).toMatchObject({ width: 24, opacity: 0.2 });
    expect(merged.toolPreferences).not.toHaveProperty("presets");
    expect(merged.toolPreferences).not.toHaveProperty("activePresetId");
    expect(merged.toolPreferences).not.toHaveProperty("sidebarPresetIds");
  });

  it("prefers saved per-tool settings over migrated legacy preset values", () => {
    const merged = mergeSettings({
      toolPreferences: {
        presets: [{ id: "old", name: "Old", tool: "pen", settings: { color: "#2563eb", width: 2 } }],
        activePresetId: "old",
        pen: { color: "#dc2626" }
      } as never
    });
    expect(merged.toolPreferences.pen.color).toBe("#dc2626");
    expect(merged.toolPreferences.pen.width).toBe(2);
  });

  it("merges laser preferences from saved settings", () => {
    const merged = mergeSettings({
      toolPreferences: {
        laser: { color: "#22c55e", holdMs: 500 }
      } as never
    });
    expect(merged.toolPreferences.laser.color).toBe("#22c55e");
    expect(merged.toolPreferences.laser.holdMs).toBe(500);
    expect(merged.toolPreferences.laser.fadeMs).toBe(DEFAULT_SETTINGS.toolPreferences.laser.fadeMs);
    expect(merged.toolPreferences.laser.width).toBe(DEFAULT_SETTINGS.toolPreferences.laser.width);
  });

  it("enables half-second shape recognition by default while allowing an opt-out", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.shape.holdToRecognize).toBe(true);
    expect(mergeSettings({ toolPreferences: { shape: { holdToRecognize: false } } as never }).toolPreferences.shape.holdToRecognize).toBe(false);
    expect(mergeSettings({ toolPreferences: { activeTool: "shape" } as never }).toolPreferences.activeTool).toBe("pen");
  });

  it("defaults mouse inking off and migrates the legacy annotate mode", () => {
    expect(DEFAULT_SETTINGS.mouseInkingEnabled).toBe(false);
    expect(mergeSettings({ mouseInkingEnabled: true }).mouseInkingEnabled).toBe(true);
    expect(mergeSettings({ mouseInputMode: "annotate" } as never).mouseInkingEnabled).toBe(true);
    expect(mergeSettings({ mouseInputMode: "annotate", mouseLeftDragDraw: false } as never).mouseInkingEnabled).toBe(false);
    expect(mergeSettings({ mouseInputMode: "pan", mouseLeftDragDraw: true } as never).mouseInkingEnabled).toBe(false);
    expect(mergeSettings({ mouseLeftDragDraw: true } as never).mouseInkingEnabled).toBe(true);
  });

  it("drops retired mouse pan and right-button eraser settings", () => {
    const merged = mergeSettings({
      mouseInputMode: "pan",
      mouseDragScroll: true,
      mouseRightDragErase: true,
      toolPreferences: { eraser: { eraseWithRightMouseButton: true } }
    } as never);
    expect(merged.mouseInkingEnabled).toBe(false);
    expect(merged).not.toHaveProperty("mouseInputMode");
    expect(merged).not.toHaveProperty("mouseDragScroll");
    expect(merged).not.toHaveProperty("mouseRightDragErase");
    expect(merged.toolPreferences.eraser).toEqual({ size: 12, eraseWholeStrokes: false });
  });

  it("drops the retired finger-draw preference (fingers stay native; stylus annotates)", () => {
    const merged = mergeSettings({ fingerDraw: true } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
    expect(merged).not.toHaveProperty("fingerDraw");
  });

  it("uses Auto input pressure unless a valid profile is saved", () => {
    expect(DEFAULT_SETTINGS.pressureProfile).toBe("auto");
    expect(mergeSettings({ pressureProfile: "pen" }).pressureProfile).toBe("pen");
    expect(mergeSettings({ pressureProfile: "mouse" }).pressureProfile).toBe("mouse");
    expect(mergeSettings({ pressureProfile: "not-a-profile" as "auto" }).pressureProfile).toBe("auto");
  });

  it("keeps pressure calibration bounded while preserving valid saved controls", () => {
    expect(DEFAULT_SETTINGS.pressureCalibration).toEqual({ initialFloor: 0.15, gain: 1.15, smoothing: 0.78 });
    expect(mergeSettings({ pressureCalibration: { initialFloor: -1, gain: 4, smoothing: 0.4 } }).pressureCalibration)
      .toEqual({ initialFloor: 0, gain: 2, smoothing: 0.4 });
    expect(mergeSettings({ pressureCalibration: { gain: 0.7 } as never }).pressureCalibration)
      .toEqual({ initialFloor: 0.15, gain: 0.7, smoothing: 0.78 });
  });

  it("enables stroke simplification by default", () => {
    expect(DEFAULT_SETTINGS.simplifyStrokes).toBe(true);
    expect({ ...DEFAULT_SETTINGS, simplifyStrokes: false }.simplifyStrokes).toBe(false);
  });

  it("keeps vault debug log off by default", () => {
    expect(DEFAULT_SETTINGS.vaultDebugLog).toBe(false);
    expect(DEFAULT_SETTINGS.vaultDebugLogPath).toBe(
      "config/plugins/native-pdf-handwriting/debug.md"
    );
    expect(DEFAULT_SETTINGS.automaticAnnotationRecovery).toBe(true);
    expect(DEFAULT_SETTINGS.annotationBackupPath).toBe(
      "config/plugins/native-pdf-handwriting"
    );
  });

  it("defaults annotation backups beside a custom debug log and preserves a custom backup folder", () => {
    expect(mergeSettings({ vaultDebugLogPath: "Logs/handwriting.md" }).annotationBackupPath).toBe("Logs");
    expect(mergeSettings({ annotationBackupPath: "Backups/handwriting" }).annotationBackupPath)
      .toBe("Backups/handwriting");
    expect(mergeSettings({ automaticAnnotationRecovery: false }).automaticAnnotationRecovery).toBe(false);
    expect(mergeSettings({ annotationBackupPath: "../outside" }).annotationBackupPath)
      .toBe("config/plugins/native-pdf-handwriting");
  });

  it("migrates vault debug log path from .log to .md", () => {
    const merged = mergeSettings({
      vaultDebugLogPath: ".obsidian/plugins/native-pdf-handwriting/debug.log"
    }, ".obsidian");
    expect(merged.vaultDebugLogPath).toBe(".obsidian/plugins/native-pdf-handwriting/debug.md");
  });

  it("migrates old toolbar placement to persistent floating orientation", () => {
    expect(DEFAULT_SETTINGS.toolbarOrientation).toBe("horizontal");
    expect(mergeSettings({ toolbarOrientation: "vertical" }).toolbarOrientation).toBe("vertical");
    const migratedRight = mergeSettings(JSON.parse('{"toolbarPlacement":"right"}'));
    const migratedLeft = mergeSettings(JSON.parse('{"toolbarPlacement":"left"}'));
    expect(migratedRight.toolbarOrientation).toBe("vertical");
    expect(migratedLeft.toolbarOrientation).toBe("vertical");
    expect(mergeSettings(JSON.parse('{"toolbarPlacement":"main"}')).toolbarOrientation).toBe("horizontal");
    expect(mergeSettings({ toolbarOrientation: "invalid" as "horizontal" }).toolbarOrientation).toBe("horizontal");
    expect("toolbarPlacement" in migratedRight).toBe(false);
  });

  it("uses blank Letter paper unless a PDF template path is configured", () => {
    expect(DEFAULT_SETTINGS.pdfTemplatePath).toBe("");
    expect(mergeSettings({ pdfTemplatePath: "Templates/ruled.pdf" }).pdfTemplatePath).toBe("Templates/ruled.pdf");
    expect(mergeSettings({ pdfTemplatePath: 42 as never }).pdfTemplatePath).toBe("");
  });

  it("strips legacy YOLO Mode keys and unused lasso fields from saved settings", () => {
    const merged = mergeSettings({
      autosave: false,
      yoloMode: true,
      yoloConfirmed: true,
      yoloAutosaveDelayMs: 9999,
      createBackupBeforeDirectModification: false,
      backupLocation: "somewhere",
      retainSidecarAfterDirectModification: false,
      toolPreferences: {
        lasso: { type: "rectangle", includeLocked: true, selectionMode: "enclosed" } as never
      }
    } as unknown as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
    expect(merged.autosave).toBe(false);
    expect(merged).not.toHaveProperty("yoloMode");
    expect(merged).not.toHaveProperty("yoloConfirmed");
    expect(merged).not.toHaveProperty("backupLocation");
    expect(merged.toolPreferences.lasso).toEqual({ type: "rectangle" });
  });

});
