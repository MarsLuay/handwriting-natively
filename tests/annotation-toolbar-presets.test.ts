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
    const editor = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-preset-editor input");
    expect(editor?.value).toBe("Blue pen");
    toolbar.destroy();
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

  it("automatically shows additional presets in order and ignores legacy pins", () => {
    const preferences = createDefaultToolPreferences();
    preferences.sidebarPresetIds = ["black-pen"];
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
    expect([...host!.querySelectorAll<HTMLButtonElement>("[data-sidebar-preset-id]")].map((button) => button.dataset.sidebarPresetId))
      .toEqual(["blue-pen", "yellow-highlighter"]);
    expect(host?.querySelector("[data-sidebar-preset-id='black-pen']")).toBeNull();
    expect(host?.getAttribute("aria-label")).toBe("Additional drawing presets");
    expect(document.querySelector("[data-action='sidebar-preset']")).toBeNull();

    const updateButtons = (): void => {
      (toolbar as unknown as { updateButtons(): void }).updateButtons();
    };
    preferences.presets.splice(2, 1);
    updateButtons();
    expect([...host!.querySelectorAll<HTMLButtonElement>("[data-sidebar-preset-id]")].map((button) => button.dataset.sidebarPresetId))
      .toEqual(["blue-pen"]);

    preferences.presets.push({
      id: "mechanical",
      name: "Mechanical pencil",
      tool: "pencil",
      settings: { ...preferences.pencil, color: "#4b5563" }
    });
    updateButtons();
    const additional = [...host!.querySelectorAll<HTMLButtonElement>("[data-sidebar-preset-id]")];
    expect(additional.map((button) => button.dataset.sidebarPresetId)).toEqual(["blue-pen", "mechanical"]);
    expect(additional.map((button) => button.querySelector("path")?.getAttribute("d")?.slice(0, 12))).toEqual([
      "M12 19 19 12",
      "M4 20 8.5 19"
    ]);
    expect(additional[1]?.getAttribute("aria-label")).toBe("Mechanical pencil");

    preferences.presets.splice(1, 1);
    updateButtons();
    expect([...host!.querySelectorAll<HTMLButtonElement>("[data-sidebar-preset-id]")].map((button) => button.dataset.sidebarPresetId))
      .toEqual(["mechanical"]);

    const finalPreferences = createDefaultToolPreferences();
    finalPreferences.presets = [finalPreferences.presets[0]!];
    finalPreferences.activePresetId = finalPreferences.presets[0]!.id;
    finalPreferences.activeTool = finalPreferences.presets[0]!.tool;
    const styleBefore = structuredClone(finalPreferences[finalPreferences.activeTool]);
    const finalToolbar = new AnnotationToolbar({
      preferences: finalPreferences,
      autosave: true,
      callbacks: { onPreferencesChange: () => undefined }
    });
    document.body.append(finalToolbar.element);
    finalToolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    const blocked = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete selected preset");
    expect(finalToolbar.element.querySelectorAll("[data-sidebar-preset-id]")).toHaveLength(0);
    expect(blocked?.disabled).toBe(true);
    blocked?.click();
    expect(finalPreferences.presets).toHaveLength(1);
    expect(finalPreferences.activeTool).toBe("pen");
    expect(finalPreferences[finalPreferences.activeTool]).toEqual(styleBefore);

    toolbar.destroy();
    finalToolbar.destroy();
    style.remove();
  });
});
