import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { AnnotationToolbar } from "../src/ui/AnnotationToolbar";
import { DROPDOWN_MAX_HEIGHT, DropdownController } from "../src/ui/DropdownController";

afterEach(() => { document.body.replaceChildren(); });

describe("DropdownController", () => {
  it("selects, closes, restores focus, and supports keyboard navigation", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const selected = vi.fn();
    const dropdown = new DropdownController(document);
    dropdown.open("tools", trigger, { label: "Tools", options: [
      { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
      { id: "pen", label: "Pen", onSelect: selected },
      { id: "pencil", label: "Pencil", onSelect: vi.fn() }
    ] });
    expect(dropdown.isOpen("tools")).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.optionId).toBe("pen");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.optionId).toBe("pencil");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    (document.activeElement as HTMLButtonElement).click();
    expect(selected).toHaveBeenCalledOnce();
    expect(dropdown.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("flips above on collision, closes outside and on Escape", () => {
    const trigger = document.createElement("button");
    trigger.getBoundingClientRect = () => ({ x: 10, y: 700, left: 10, top: 700, right: 54, bottom: 744, width: 44, height: 44, toJSON: () => ({}) });
    document.body.append(trigger);
    const dropdown = new DropdownController(document);
    dropdown.open("x", trigger, { label: "X", options: [{ id: "x", label: "X", onSelect: vi.fn() }] });
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-dropdown")?.dataset.placement).toBe("top");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
    dropdown.open("x", trigger, { label: "X", options: [{ id: "x", label: "X", onSelect: vi.fn() }] });
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
  });

  it("closes on a page pen even when the page listener stops the event", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const dropdown = new DropdownController(document);
    dropdown.open("drawing", trigger, { label: "Drawing", options: [{ id: "pen", label: "Pen", onSelect: vi.fn() }] });
    const page = document.createElement("div");
    page.className = "textLayer";
    document.body.append(page);
    document.addEventListener("pointerdown", (event) => event.stopImmediatePropagation(), { capture: true, once: true });
    page.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "pen" }));
    expect(dropdown.isOpen()).toBe(false);
    page.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    dropdown.open("drawing", trigger, { label: "Drawing", options: [{ id: "pen", label: "Pen", onSelect: vi.fn() }] });
    document.addEventListener("pointerdown", (event) => event.stopImmediatePropagation(), { capture: true, once: true });
    page.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    expect(dropdown.isOpen()).toBe(false);
  });

  it("caps every icon dropdown so long menus scroll inside it", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const dropdown = new DropdownController(document);
    dropdown.open("tools", trigger, { label: "Tools", options: [{ id: "tool", label: "Tool", onSelect: vi.fn() }] });
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-dropdown")?.style.maxHeight).toBe(`${DROPDOWN_MAX_HEIGHT}px`);
    dropdown.destroy();
  });
});

describe("AnnotationToolbar", () => {
  it("has no Draw checkbox; tool controls still mount", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector("[data-control='draw']")).toBeNull();
    expect(toolbar.element.textContent ?? "").not.toMatch(/\bDraw\b/);
    expect(toolbar.element.querySelector("[data-control='pen']")).toBeTruthy();
    expect(toolbar.element.querySelector("[data-control='pencil']")).toBeTruthy();
    expect(toolbar.element.querySelector("[data-control='highlighter']")).toBeTruthy();
    expect(toolbar.element.querySelector("[data-control='eraser']")).toBeTruthy();
    expect(toolbar.element.querySelector("[data-control='color']")).toBeTruthy();
    toolbar.destroy();
  });

  it("exposes tool aria labels without a Draw toggle", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector(".native-pdf-handwriting-draw-toggle")).toBeNull();
    expect(toolbar.element.getAttribute("aria-label")).toBe("PDF annotation tools");
    toolbar.destroy();
  });

  it("offers Copy All from the lasso menu", () => {
    const copyAll = vi.fn();
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.activeTool = "lasso";
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn(), onLassoCopyAll: copyAll },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    const option = document.querySelector<HTMLButtonElement>("[data-option-id='copy-all']");
    expect(option?.textContent).toBe("Copy All");
    option?.click();
    expect(copyAll).toHaveBeenCalledOnce();
    toolbar.destroy();
  });

  it("persists selected drawing preference, updates icon, and exposes manual save only when needed", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const save = vi.fn();
    const toolbar = new AnnotationToolbar({ preferences, autosave: false, callbacks: { onPreferencesChange: changed, onSave: save }, ownerDocument: document });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector("[data-control='save']")).not.toBeNull();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pencil']")?.click();
    expect(preferences.activeTool).toBe("pencil");
    const pencil = toolbar.element.querySelector<HTMLButtonElement>("[data-control='pencil']");
    expect(pencil?.getAttribute("aria-label")).toBe("Pencil");
    expect(pencil?.classList.contains("clickable-icon")).toBe(true);
    expect(pencil?.querySelector("svg")).not.toBeNull();
    expect(changed).toHaveBeenCalled();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='highlighter']")?.click();
    expect(preferences.activeTool).toBe("highlighter");
    const highlighter = toolbar.element.querySelector<HTMLButtonElement>("[data-control='highlighter']");
    expect(highlighter?.getAttribute("aria-label")).toBe("Highlighter");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='highlighter']")?.click();
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='shape']")).toBeNull();
    const shapeRecognition = document.querySelector<HTMLInputElement>("[data-setting='shape-recognition']");
    expect(shapeRecognition?.checked).toBe(true);
    shapeRecognition?.click();
    expect(preferences.shape.holdToRecognize).toBe(false);
    toolbar.setAutosave(true);
    expect(toolbar.element.querySelector("[data-control='save']")).toBeNull();
    toolbar.setSaveStatus("failed");
    expect(toolbar.saveStatus.element.textContent).toBe("");
    expect(toolbar.saveStatus.element.getAttribute("aria-label")).toBe("Save failed");
    expect(toolbar.saveStatus.element.dataset.status).toBe("failed");
    expect(toolbar.saveStatus.element.querySelector(".native-pdf-handwriting-save-status-dot")).not.toBeNull();
    expect(toolbar.saveStatus.element.parentElement).toBe(toolbar.element);
    expect(toolbar.saveStatus.element.previousElementSibling?.classList.contains("native-pdf-handwriting-toolbar-controls")).toBe(true);
    toolbar.destroy();
  });

  it("orders the three drawing tools before shared color and secondary tools", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const controls = [...toolbar.element.querySelectorAll<HTMLElement>("[data-control]")];
    const ids = controls.map((el) => el.dataset.control);
    expect(ids.indexOf("pen")).toBeLessThan(ids.indexOf("pencil"));
    expect(ids.indexOf("pencil")).toBeLessThan(ids.indexOf("highlighter"));
    expect(ids.indexOf("highlighter")).toBeLessThan(ids.indexOf("color"));
    expect(ids.indexOf("color")).toBeLessThan(ids.indexOf("eraser"));
    expect(ids.indexOf("eraser")).toBeLessThan(ids.indexOf("laser"));
    toolbar.destroy();
  });

  it("does not put Add page in the annotation toolbar", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const append = toolbar.element.querySelector<HTMLButtonElement>("[data-control='append-page']");
    expect(append).toBeNull();
    toolbar.destroy();
  });

  it("offers a toolbar rotation action that reflects the next orientation", () => {
    let orientation: "horizontal" | "vertical" = "horizontal";
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: {
        onPreferencesChange: vi.fn(),
        toolbarOrientation: () => orientation,
        onMore: (action) => {
          if (action === "rotate-toolbar") orientation = orientation === "horizontal" ? "vertical" : "horizontal";
        }
      },
      supportedMoreActions: ["rotate-toolbar"],
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const more = toolbar.element.querySelector<HTMLButtonElement>("[data-control='more']");
    more?.click();
    const rotate = document.querySelector<HTMLButtonElement>("[data-option-id='rotate-toolbar']");
    expect(rotate?.textContent).toBe("Rotate toolbar to vertical");
    rotate?.click();
    more?.click();
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='rotate-toolbar']")?.textContent).toBe("Rotate toolbar to horizontal");
    toolbar.destroy();
  });

  it("shows Import page in More and reports its selection", () => {
    const selected = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn(), onMore: selected },
      supportedMoreActions: ["import-page"],
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='more']")?.click();
    const importOption = document.querySelector<HTMLButtonElement>("[data-option-id='import-page']");
    expect(importOption?.textContent).toBe("Import page");
    importOption?.click();
    expect(selected).toHaveBeenCalledWith("import-page");
    toolbar.destroy();
  });

  it("exposes Scan document as a More action", () => {
    const selected: string[] = [];
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: {
        onPreferencesChange: vi.fn(),
        onMore: (action) => selected.push(action)
      },
      supportedMoreActions: ["scan-document"],
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='more']")?.click();
    const scan = document.querySelector<HTMLButtonElement>("[data-option-id='scan-document']");
    expect(scan?.textContent).toBe("Scan document");
    scan?.click();
    expect(selected).toEqual(["scan-document"]);
    toolbar.destroy();
  });

  it("activates the laser pointer from the toolbar", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: changed },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const laser = toolbar.element.querySelector<HTMLButtonElement>("[data-control='laser']");
    expect(laser).not.toBeNull();
    laser?.click();
    expect(preferences.activeTool).toBe("laser");
    expect(laser?.getAttribute("aria-pressed")).toBe("true");
    expect(changed).toHaveBeenCalled();
    laser?.click();
    expect(document.querySelector(".native-pdf-handwriting-laser-note")?.textContent).toContain("never saved");
    toolbar.destroy();
  });

  it("selects a tool programmatically through the toolbar change path", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: changed },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='laser']")?.click();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='laser']")?.click();
    expect(document.querySelector(".native-pdf-handwriting-dropdown")).not.toBeNull();
    toolbar.selectTool("text");
    expect(document.querySelector(".native-pdf-handwriting-dropdown")).toBeNull();
    expect(preferences.activeTool).toBe("text");
    expect(toolbar.element.querySelector("[data-control='text']")?.getAttribute("aria-pressed")).toBe("true");
    expect(changed).toHaveBeenLastCalledWith(preferences, "tool");
    toolbar.destroy();
  });

  it("moves the laser width checkmark when another option is selected", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.activeTool = "laser";
    preferences.laser.width = 2;
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='laser']")?.click();
    const fine = document.querySelector<HTMLButtonElement>("[data-option-id='laser-width-1']");
    const standard = document.querySelector<HTMLButtonElement>("[data-option-id='laser-width-2']");
    expect(standard?.getAttribute("aria-checked")).toBe("true");
    expect(fine?.getAttribute("aria-checked")).toBe("false");
    fine?.click();
    expect(preferences.laser.width).toBe(1);
    expect(fine?.getAttribute("aria-checked")).toBe("true");
    expect(standard?.getAttribute("aria-checked")).toBe("false");
    toolbar.destroy();
  });

  it("keeps laser color controls in the shared Color menu", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.activeTool = "laser";
    const changed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: changed },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='laser']")?.click();
    expect(document.querySelector(".native-pdf-handwriting-laser-menu input[type='color']")).toBeNull();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    const custom = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-dropdown input[type='color']");
    if (!custom) throw new Error("Shared custom color input missing");
    expect(custom.value).toBe("#ff0000");
    custom.value = "#22c55e";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preferences.laser.color).toBe("#22c55e");
    expect(preferences.activeTool).toBe("laser");
    expect(changed).toHaveBeenCalledOnce();
    toolbar.destroy();
  });

  it("reports which text style control changed", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.activeTool = "text";
    const textStyleChanged = vi.fn();
    const preferencesChanged = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: preferencesChanged, onTextStyleChange: textStyleChanged },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    const font = document.querySelector<HTMLSelectElement>(".native-pdf-handwriting-text-menu select");
    expect(font).not.toBeNull();
    font!.value = "serif";
    font!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(preferences.text.fontFamily).toBe("serif");
    expect(textStyleChanged).toHaveBeenCalledWith({ property: "fontFamily", value: "serif", source: "change" });
    expect(preferencesChanged).toHaveBeenLastCalledWith(preferences, "text-style");
    toolbar.destroy();
  });

  it("shows the active drawing color as the color button icon", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.pen.color = "#dc2626";
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const color = toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']");
    const swatch = color?.querySelector<HTMLElement>(".native-pdf-handwriting-color-icon");
    expect(swatch?.style.backgroundColor).toBe("rgb(220, 38, 38)");
    expect(color?.querySelector("svg")).toBeNull();
    toolbar.destroy();
  });

  it("offers an eraser size slider with live preview", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const previewed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: {
        onPreferencesChange: changed,
        onEraserSizePreview: previewed
      },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const eraser = toolbar.element.querySelector<HTMLButtonElement>("[data-control='eraser']");
    eraser?.click(); // select
    eraser?.click(); // open options when already selected
    const slider = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-eraser-menu input[type='range']");
    const preview = document.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-menu .native-pdf-handwriting-eraser-preview");
    const frame = document.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-preview-frame");
    expect(slider).toMatchObject({ min: "4", max: "100", step: "1", value: "12" });
    expect(frame?.style.getPropertyValue("--ink-eraser-preview-frame-size")).toBe("100px");
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("12px");
    slider!.value = "20";
    slider!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preferences.activeTool).toBe("eraser");
    expect(preferences.eraser).toEqual({ size: 20, eraseWholeStrokes: false });
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("20px");
    expect(previewed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce(); // first click activated eraser
    slider!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(2);
    toolbar.destroy();
  });

  it("builds toolbar icons without Obsidian Document.createSvg appending to document", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const doc = document as Document & { createSvg?: (tag: string) => SVGElement };
    const previous = doc.createSvg;
    Object.defineProperty(doc, "createSvg", {
      configurable: true,
      writable: true,
      value: () => {
        throw new DOMException(
          "Failed to execute 'appendChild' on 'Node': Only one element on document allowed.",
          "HierarchyRequestError"
        );
      }
    });
    try {
      const toolbar = new AnnotationToolbar({
        preferences,
        autosave: true,
        callbacks: { onPreferencesChange: vi.fn() },
        ownerDocument: doc
      });
      expect(toolbar.element.querySelectorAll("svg.native-pdf-handwriting-toolbar-icon").length).toBeGreaterThan(0);
      toolbar.destroy();
    } finally {
      if (previous) Object.defineProperty(doc, "createSvg", { configurable: true, writable: true, value: previous });
      else Reflect.deleteProperty(doc, "createSvg");
    }
  });
});
