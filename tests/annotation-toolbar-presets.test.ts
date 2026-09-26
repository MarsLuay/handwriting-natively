import { describe, expect, it } from "vitest";
import { createDefaultToolPreferences } from "../src/model";
import { AnnotationToolbar } from "../src/ui/AnnotationToolbar";

describe("AnnotationToolbar presets", () => {
  it("switches a saved preset in one click without a draw-mode control", () => {
    const preferences = createDefaultToolPreferences();
    preferences.activeTool = "lasso";
    preferences.activePresetId = null;
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: () => undefined }
    });
    document.body.append(toolbar.element);
    const slots = [...toolbar.element.querySelectorAll<HTMLButtonElement>("[data-preset-id]")];
    expect(slots.map((slot) => slot.dataset.presetId)).toEqual(["black-pen", "blue-pen", "yellow-highlighter"]);
    expect(toolbar.element.textContent?.includes("Draw")).toBe(false);
    slots[1]?.click();
    expect(preferences.activeTool).toBe("pen");
    expect(preferences.activePresetId).toBe("blue-pen");
    expect(preferences.pen.color).toBe("#2563eb");
    expect(toolbar.element.querySelector("[data-preset-id='blue-pen']")?.getAttribute("aria-pressed")).toBe("true");
    toolbar.element.remove();
  });
});
