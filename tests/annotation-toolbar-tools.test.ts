import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultToolPreferences } from "../src/model";
import { AnnotationToolbar } from "../src/ui/AnnotationToolbar";

afterEach(() => { document.body.replaceChildren(); });

describe("AnnotationToolbar drawing tools", () => {
  it("always exposes Pen, Pencil, and Highlighter without preset controls", () => {
    const toolbar = new AnnotationToolbar({
      preferences: createDefaultToolPreferences(),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() }
    });
    document.body.append(toolbar.element);

    expect([...toolbar.element.querySelectorAll<HTMLButtonElement>("[data-control]")]
      .filter((button) => ["pen", "pencil", "highlighter"].includes(button.dataset.control ?? "")))
      .toHaveLength(3);
    expect(toolbar.element.querySelector("[data-preset-id], [data-sidebar-preset-id], .native-pdf-handwriting-preset-editor"))
      .toBeNull();
    expect(toolbar.element.querySelector("[data-control='pen']")?.getAttribute("aria-label")).toBe("Pen");
    expect(toolbar.element.querySelector("[data-control='pencil']")?.getAttribute("aria-label")).toBe("Pencil");
    expect(toolbar.element.querySelector("[data-control='highlighter']")?.getAttribute("aria-label")).toBe("Highlighter");
    toolbar.destroy();
  });

  it("switches tools directly and restores each tool's independent settings", () => {
    const preferences = createDefaultToolPreferences();
    preferences.pen.width = 2.5;
    preferences.pen.color = "#123456";
    preferences.pencil.width = 7;
    preferences.pencil.color = "#654321";
    const changed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: changed }
    });
    document.body.append(toolbar.element);

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pencil']")?.click();
    expect(preferences.activeTool).toBe("pencil");
    expect(preferences.pencil).toMatchObject({ width: 7, color: "#654321" });
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pen']")?.click();
    expect(preferences.activeTool).toBe("pen");
    expect(preferences.pen).toMatchObject({ width: 2.5, color: "#123456" });
    expect(preferences.pencil).toMatchObject({ width: 7, color: "#654321" });
    expect(changed).toHaveBeenCalledWith(preferences, "tool");
    toolbar.destroy();
  });

  it("places the three pen types above pen thickness controls", () => {
    const preferences = createDefaultToolPreferences();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() }
    });
    document.body.append(toolbar.element);

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pen']")?.click();
    const options = [...document.querySelectorAll<HTMLButtonElement>("[data-option-id]")];
    expect(options.slice(0, 3).map((option) => option.textContent)).toEqual([
      "Fountain Pen",
      "Ball Pen",
      "Brush Pen"
    ]);
    expect(options.slice(3, 10).every((option) => option.dataset.optionId?.startsWith("width-"))).toBe(true);

    document.querySelector<HTMLButtonElement>("[data-option-id='pen-type-brush']")?.click();
    expect(preferences.pen.penType).toBe("brush");
    toolbar.destroy();
  });

  it("edits only the active tool and keeps its settings when switching away and back", () => {
    const preferences = createDefaultToolPreferences();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() }
    });
    document.body.append(toolbar.element);

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pen']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='width-2.5']")?.click();
    expect(preferences.pen.width).toBe(2.5);
    expect(preferences.pencil.width).not.toBe(2.5);

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pencil']")?.click();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pencil']")?.click();
    expect(document.querySelector("[data-option-id='width-4.5']")).not.toBeNull();
    expect(document.querySelector("[data-option-id='width-2.5']")?.getAttribute("aria-checked")).toBe("false");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pen']")?.click();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pen']")?.click();
    expect(document.querySelector("[data-option-id='width-2.5']")?.getAttribute("aria-checked")).toBe("true");
    toolbar.destroy();
  });
});
