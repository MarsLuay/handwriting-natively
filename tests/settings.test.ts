import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/model";

vi.mock("obsidian", () => {
  class MockObsidianBase {}
  return {
    FuzzySuggestModal: MockObsidianBase,
    Notice: MockObsidianBase,
    Plugin: MockObsidianBase,
    PluginSettingTab: MockObsidianBase,
    Setting: MockObsidianBase,
    TFile: MockObsidianBase,
    TFolder: MockObsidianBase
  };
});

const {
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

  it("keeps one-finger sidebar and search-bar swipe blocking opt-in and migratable", () => {
    expect(DEFAULT_SETTINGS.disableSidebarSwipe).toBe(false);
    expect(DEFAULT_SETTINGS.disableSearchBarSwipe).toBe(false);
    expect(mergeSettings({ disableSidebarSwipe: true }).disableSidebarSwipe).toBe(true);
    expect(mergeSettings({ disableSidebarSwipe: false }).disableSidebarSwipe).toBe(false);
    expect(mergeSettings({ disableSearchBarSwipe: true }).disableSearchBarSwipe).toBe(true);
    expect(mergeSettings({ disableSearchBarSwipe: false }).disableSearchBarSwipe).toBe(false);
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

  it("defaults mouse input mode to pan and migrates mouseDragScroll", () => {
    expect(DEFAULT_SETTINGS.mouseInputMode).toBe("pan");
    expect(DEFAULT_SETTINGS.mouseDragScroll).toBe(true);
    expect(DEFAULT_SETTINGS.mouseLeftDragDraw).toBe(true);
    expect(DEFAULT_SETTINGS.mouseRightDragErase).toBe(false);
    expect(mergeSettings({ mouseDragScroll: false }).mouseInputMode).toBe("native");
    expect(mergeSettings({ mouseDragScroll: false }).mouseDragScroll).toBe(false);
    expect(mergeSettings({ mouseInputMode: "annotate" }).mouseDragScroll).toBe(false);
    expect(mergeSettings({ mouseInputMode: "annotate" }).mouseInputMode).toBe("annotate");
  });

  it("preserves mouse drag binding changes and migrates the legacy right-button eraser toggle", () => {
    expect(mergeSettings({ mouseLeftDragDraw: false, mouseRightDragErase: true })).toMatchObject({
      mouseLeftDragDraw: false,
      mouseRightDragErase: true
    });
    expect(mergeSettings({
      toolPreferences: { eraser: { eraseWithRightMouseButton: true } } as never
    })).toMatchObject({
      mouseRightDragErase: true,
      toolPreferences: { eraser: { eraseWithRightMouseButton: true } }
    });
    expect(mergeSettings({
      mouseRightDragErase: false,
      toolPreferences: { eraser: { eraseWithRightMouseButton: true } } as never
    })).toMatchObject({
      mouseRightDragErase: false,
      toolPreferences: { eraser: { eraseWithRightMouseButton: false } }
    });
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

  it("defaults toolbar placement to the PDF bar", () => {
    expect(DEFAULT_SETTINGS.toolbarPlacement).toBe("main");
    expect(mergeSettings({ toolbarPlacement: "right" }).toolbarPlacement).toBe("right");
    expect(mergeSettings({ toolbarPlacement: "nope" as "main" }).toolbarPlacement).toBe("main");
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
