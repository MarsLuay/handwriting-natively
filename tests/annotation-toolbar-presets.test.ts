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

  it("hides preset names in the sidebar and keeps them on the main toolbar", () => {
    const preferences = createDefaultToolPreferences();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: () => undefined }
    });
    const style = document.createElement("style");
    style.textContent = `
      .native-pdf-handwriting-toolbar.is-sidebar-left .native-pdf-handwriting-preset-slots,
      .native-pdf-handwriting-toolbar.is-sidebar-right .native-pdf-handwriting-preset-slots {
        display: none;
      }
    `;
    document.head.append(style);
    document.body.append(toolbar.element);

    const black = toolbar.element.querySelector<HTMLButtonElement>("[data-preset-id='black-pen']");
    const color = toolbar.element.querySelector<HTMLElement>("[data-control='color']");
    const slots = toolbar.element.querySelector<HTMLElement>(".native-pdf-handwriting-preset-slots");
    expect(black?.textContent).toBe("Black pen");
    expect(black?.getAttribute("aria-label")).toBe("Black pen");
    expect(black?.title).toBe("Black pen");
    expect(getComputedStyle(slots!).display).not.toBe("none");
    expect(toolbar.element.textContent).toContain("Black pen");

    toolbar.element.classList.add("is-sidebar-left");
    expect(getComputedStyle(slots!).display).toBe("none");
    const controls = [...toolbar.element.querySelector(".native-pdf-handwriting-toolbar-controls")!.children];
    const firstVisible = controls.find((node) => node instanceof HTMLElement && getComputedStyle(node).display !== "none");
    expect(firstVisible).toBe(color);

    toolbar.element.classList.remove("is-sidebar-left");
    toolbar.element.classList.add("is-sidebar-right");
    expect(getComputedStyle(slots!).display).toBe("none");

    toolbar.element.classList.remove("is-sidebar-right");
    expect(getComputedStyle(slots!).display).not.toBe("none");
    expect(black?.textContent).toBe("Black pen");

    toolbar.element.remove();
    style.remove();
  });
});
