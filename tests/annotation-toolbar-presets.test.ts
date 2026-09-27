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

  it("pins presets under Pen with tool icons and blocks the last deletion", () => {
    const preferences = createDefaultToolPreferences();
    preferences.presets.push({
      id: "mechanical",
      name: "Mechanical pencil",
      tool: "pencil",
      settings: { ...preferences.pencil, color: "#4b5563" }
    });
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: () => undefined }
    });
    const style = document.createElement("style");
    style.textContent = `
      .native-pdf-handwriting-sidebar-presets { display: none; }
      .native-pdf-handwriting-toolbar.is-sidebar-left .native-pdf-handwriting-sidebar-presets {
        display: flex;
      }
    `;
    document.head.append(style);
    document.body.append(toolbar.element);
    toolbar.element.classList.add("is-sidebar-left");

    const drawing = toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']");
    const host = toolbar.element.querySelector<HTMLElement>(".native-pdf-handwriting-sidebar-presets");
    expect(drawing?.nextElementSibling).toBe(host);
    expect(host?.nextElementSibling).toBe(toolbar.element.querySelector("[data-control='eraser']"));

    drawing?.click();
    const add = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add preset to sidebar");
    const remove = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete selected preset");
    expect(add?.previousElementSibling).toBe(remove);
    add?.click();
    expect(preferences.sidebarPresetIds).toEqual(["black-pen"]);

    preferences.sidebarPresetIds = ["black-pen", "yellow-highlighter", "mechanical"];
    toolbar.element.querySelector<HTMLButtonElement>("[data-sidebar-preset-id='black-pen']")?.click();
    const pins = [...toolbar.element.querySelectorAll<HTMLButtonElement>("[data-sidebar-preset-id]")];
    expect(pins.map((button) => button.dataset.sidebarPresetId)).toEqual(["black-pen", "yellow-highlighter", "mechanical"]);
    expect(pins.map((button) => button.querySelector("path")?.getAttribute("d")?.slice(0, 12))).toEqual([
      "M12 19 19 12",
      "M4 20H20",
      "M4 20 8.5 19"
    ]);
    expect(pins[0]?.textContent).not.toContain("Black pen");
    expect(pins[0]?.getAttribute("aria-label")).toBe("Black pen");
    expect(pins[1]?.getAttribute("aria-label")).toBe("Yellow highlighter");
    expect(pins[2]?.getAttribute("aria-label")).toBe("Mechanical pencil");
    expect(getComputedStyle(host!).display).toBe("flex");

    pins[0]?.click();
    expect(preferences.activePresetId).toBe("black-pen");
    expect(toolbar.element.querySelector("[data-sidebar-preset-id='black-pen']")?.getAttribute("aria-pressed")).toBe("true");

    const openDrawing = () => {
      drawing?.click();
      if (!document.querySelector(".native-pdf-handwriting-preset-editor")) drawing?.click();
    };
    openDrawing();
    expect(document.querySelector("[data-action='sidebar-preset']")?.textContent).toBe("Remove preset from sidebar");
    document.querySelector<HTMLButtonElement>("[data-action='sidebar-preset']")?.click();
    expect(preferences.sidebarPresetIds).toEqual(["yellow-highlighter", "mechanical"]);

    openDrawing();
    document.querySelector<HTMLButtonElement>("[data-option-id='preset-blue-pen']")?.click();
    expect(preferences.activePresetId).toBe("blue-pen");
    drawing?.click();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete selected preset")?.click();
    expect(preferences.presets.some((preset) => preset.id === "blue-pen")).toBe(false);
    expect(preferences.sidebarPresetIds).not.toContain("blue-pen");
    expect(preferences.activePresetId).not.toBe("blue-pen");

    preferences.presets = preferences.presets.filter((preset) => preset.id === "black-pen");
    preferences.activePresetId = "black-pen";
    preferences.activeTool = "pen";
    preferences.sidebarPresetIds = [];
    openDrawing();
    const blocked = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete selected preset");
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.title).toBe("At least one preset is required.");
    blocked?.click();
    expect(preferences.presets.map((preset) => preset.id)).toEqual(["black-pen"]);

    toolbar.element.remove();
    style.remove();
  });
});
