import type { DrawingTool, SaveStatus, TextStyle, ToolId, ToolPreferences } from "../model";
import { resolveDrawingTool } from "../model";
import { colorOptions } from "./ColorPicker";
import { DropdownController, type DropdownOpenOptions, type DropdownOption } from "./DropdownController";
import { drawingAdvanced, drawingOptions, penTypeOptions } from "./DrawingToolDropdown";
import { eraserMenu } from "./EraserDropdown";
import { laserMenu } from "./LaserDropdown";
import { lassoOptions } from "./LassoDropdown";
import { SaveStatusIndicator } from "./SaveStatusIndicator";
import { textMenu, type TextStyleChange } from "./TextDropdown";
import { createDetachedDiv, createDetachedEl } from "../vendor/createDetached";
import { setToolbarColorSwatch, setToolbarIcon, type ToolbarIcon } from "./ToolbarIcon";

const DRAWING_LABELS: Record<DrawingTool, string> = {
  pen: "Pen",
  pencil: "Pencil",
  highlighter: "Highlighter"
};

export type MoreAction =
  | "export"
  | "export-editable"
  | "export-image"
  | "import-page"
  | "scan-document"
  | "toolbar-main"
  | "toolbar-left"
  | "toolbar-right";

/** Identifies whether a preference change also needs a whole-session redraw. */
export type PreferenceChangeReason = "general" | "text-style" | "tool";

export interface AnnotationToolbarCallbacks {
  onPreferencesChange(preferences: ToolPreferences, reason?: PreferenceChangeReason): void;
  onEraserSizePreview?(size: number): void;
  onLassoCopyAll?(): void;
  onTextStyleChange?(change: TextStyleChange): void;
  /** Runs before the toolbar takes focus, preserving a contenteditable range. */
  onTextFormatPointerDown?(): void;
  activeTextStyle?(): TextStyle | undefined;
  onUndo?(): void;
  onRedo?(): void;
  onSave?(): void | Promise<void>;
  onMore?(action: MoreAction): void;
  /** True selects native PDF mouse interaction; false returns mouse to the active ink tool. */
  onMouseModeChange?(nativeSelection: boolean): void;
  toolbarPlacement?(): "main" | "left" | "right";
}

export interface AnnotationToolbarOptions {
  preferences: ToolPreferences;
  autosave: boolean;
  callbacks: AnnotationToolbarCallbacks;
  supportedMoreActions?: MoreAction[];
  /** Show the mouse/native-selection control while mouse annotation is configured. */
  mouseInkingEnabled?: boolean;
  mouseNavigationActive?: boolean;
  ownerDocument?: Document;
}

export class AnnotationToolbar {
  readonly element: HTMLElement;
  readonly dropdown: DropdownController;
  readonly saveStatus: SaveStatusIndicator;
  private readonly ownerDocument: Document;
  private readonly callbacks: AnnotationToolbarCallbacks;
  private readonly preferences: ToolPreferences;
  private readonly abort = new AbortController();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly controls: HTMLElement;
  private autosave: boolean;
  private mouseModeAvailable: boolean;
  private mouseNavigationActive: boolean;

  constructor(options: AnnotationToolbarOptions) {
    this.ownerDocument = options.ownerDocument ?? activeDocument;
    this.callbacks = options.callbacks;
    this.preferences = options.preferences;
    this.autosave = options.autosave;
    this.mouseModeAvailable = options.mouseInkingEnabled === true;
    this.mouseNavigationActive = this.mouseModeAvailable && options.mouseNavigationActive === true;
    this.dropdown = new DropdownController(this.ownerDocument);
    this.saveStatus = new SaveStatusIndicator(this.ownerDocument);
    this.element = createDetachedDiv(this.ownerDocument);
    this.element.className = "native-pdf-handwriting-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "PDF annotation tools");
    this.controls = createDetachedDiv(this.ownerDocument);
    this.controls.className = "native-pdf-handwriting-toolbar-controls";

    const mouse = this.actionButton("mouse", "Use mouse for PDF selection", () => {
      this.setMouseNavigationActive(!this.mouseNavigationActive);
    });
    if (this.mouseModeAvailable) this.controls.append(mouse);
    this.controls.append(this.drawingButton("pen"));
    this.controls.append(this.drawingButton("pencil"));
    this.controls.append(this.drawingButton("highlighter"));
    this.controls.append(this.colorButton());
    this.controls.append(this.groupedTool("eraser", () => this.eraserMenuOptions()));
    this.controls.append(this.groupedTool("laser", () => this.laserMenuOptions()));
    this.controls.append(this.groupedTool("lasso", () => ({ label: "Lasso options", options: this.lassoMenu() })));
    this.controls.append(this.groupedTool("text", () => this.textMenuOptions()));
    this.controls.append(this.actionButton("drag", "Drag", () => this.activate("drag")));
    this.controls.append(this.actionButton("undo", "Undo", () => this.callbacks.onUndo?.(), !this.callbacks.onUndo));
    this.controls.append(this.actionButton("redo", "Redo", () => this.callbacks.onRedo?.(), !this.callbacks.onRedo));
    const supportedMore = options.supportedMoreActions ?? [];
    if (this.callbacks.onMore && supportedMore.length > 0) this.controls.append(this.menuButton("more", "More", () => this.moreMenu(supportedMore)));
    if (!this.autosave && this.callbacks.onSave) this.controls.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
    this.element.append(this.controls, this.saveStatus.element);
    this.updateButtons();
  }

  setAutosave(enabled: boolean): void {
    this.autosave = enabled;
    const existing = this.buttons.get("save");
    if (enabled) {
      existing?.remove();
      this.buttons.delete("save");
    } else if (!existing && this.callbacks.onSave) {
      this.controls.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
    }
  }

  /** Show/hide and synchronize the session-local mouse navigation mode. */
  setMouseModeState(available: boolean, nativeSelection: boolean): void {
    this.mouseModeAvailable = available;
    this.mouseNavigationActive = available && nativeSelection;
    const mouse = this.buttons.get("mouse");
    if (mouse) {
      if (available && mouse.parentElement !== this.controls) this.controls.prepend(mouse);
      if (!available) mouse.remove();
    }
    this.updateButtons();
  }

  /**
   * Select a tool without opening its options menu. Used by palette commands
   * and hotkeys so they follow the exact same preference/change path as the
   * visible toolbar controls.
   */
  selectTool(tool: ToolId): void {
    this.dropdown.close(false);
    this.activate(tool);
  }

  setSaveStatus(status: SaveStatus, lastSavedAt?: Date): void {
    this.saveStatus.update(status, lastSavedAt);
  }

  destroy(): void {
    this.abort.abort();
    this.dropdown.destroy();
    this.element.remove();
  }

  private drawingButton(tool: DrawingTool): HTMLButtonElement {
    const button = this.actionButton(tool, DRAWING_LABELS[tool], () => {
      if (this.preferences.activeTool === tool && !this.mouseNavigationActive) {
        this.dropdown.toggle(`drawing-${tool}`, button, this.drawingMenu(tool));
      } else {
        this.activate(tool);
      }
    });
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private groupedTool(id: "text" | "eraser" | "lasso" | "laser", menu: () => DropdownOpenOptions): HTMLButtonElement {
    const main = this.actionButton(id, id, () => {
      const active = this.preferences.activeTool === id && !this.mouseNavigationActive;
      if (active) this.dropdown.toggle(id, main, menu());
      else this.activate(id);
    });
    if (id === "text") {
      main.addEventListener("pointerdown", () => this.callbacks.onTextFormatPointerDown?.(), { signal: this.abort.signal });
    }
    main.setAttribute("aria-haspopup", "menu");
    main.setAttribute("aria-expanded", "false");
    return main;
  }

  private actionButton(id: string, label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = createDetachedEl(this.ownerDocument, 'button');
    button.type = "button";
    button.className = "native-pdf-handwriting-toolbar-button clickable-icon";
    button.dataset.control = id;
    this.presentButton(button, label, this.iconFor(id));
    button.disabled = disabled;
    button.addEventListener("click", action, { signal: this.abort.signal });
    this.buttons.set(id, button);
    return button;
  }

  private presentButton(button: HTMLButtonElement, label: string, icon: ToolbarIcon): void {
    button.setAttribute("aria-label", label);
    // No native title — Obsidian already tooltips clickable-icon from aria-label (double bubble otherwise).
    button.removeAttribute("title");
    setToolbarIcon(button, icon);
  }

  private iconFor(id: string): ToolbarIcon {
    switch (id) {
      case "pen":
      case "pencil":
      case "highlighter":
      case "eraser":
      case "lasso":
      case "laser":
      case "text":
      case "mouse":
      case "drag":
      case "undo":
      case "redo":
      case "more":
      case "save":
        return id;
      default:
        return "more";
    }
  }

  private menuButton(id: string, label: string, options: () => DropdownOption[]): HTMLButtonElement {
    const button = this.actionButton(id, label, () => this.dropdown.toggle(id, button, { label: `${label} options`, options: options() }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private drawingMenu(tool: DrawingTool): DropdownOpenOptions {
    const content = createDetachedDiv(this.ownerDocument);
    const options = drawingOptions(this.preferences, (width) => {
      this.preferences[tool].width = width;
      this.changed();
    }, tool);
    if (tool === "pen") {
      for (const option of penTypeOptions(this.preferences, (penType) => {
        this.preferences.pen.penType = penType;
        this.changed();
      })) content.append(this.inlineOption(option));
    }
    for (const option of options) content.append(this.inlineOption(option));
    content.append(drawingAdvanced(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal));
    return { label: `${DRAWING_LABELS[tool]} options`, content };
  }

  private laserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Laser options",
      content: laserMenu(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal)
    };
  }

  private eraserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Eraser options",
      content: eraserMenu(this.ownerDocument, this.preferences, {
        onPreview: (size) => {
          this.preferences.activeTool = "eraser";
          this.preferences.eraser.size = size;
          this.callbacks.onEraserSizePreview?.(size);
        },
        onCommit: (size) => {
          this.preferences.activeTool = "eraser";
          this.preferences.eraser.size = size;
          this.changed();
        },
        onWholeStrokeChange: (enabled) => {
          this.preferences.eraser.eraseWholeStrokes = enabled;
          this.changed();
        }
      }, this.abort.signal)
    };
  }

  private textMenuOptions(): DropdownOpenOptions {
    // An existing text box has its own persisted style. Show that style in the
    // menu so changing one property does not visually imply the defaults apply.
    const style = { ...(this.callbacks.activeTextStyle?.() ?? this.preferences.text) };
    return {
      label: "Text options",
      content: textMenu(this.ownerDocument, style, (change) => {
        this.applyTextPreference(change);
        this.callbacks.onTextStyleChange?.(change);
        // Active and selected text receive their own focused render before
        // this callback. Do not follow it with a second full-page refresh.
        this.changed("text-style");
      }, this.abort.signal, () => this.callbacks.onTextFormatPointerDown?.())
    };
  }

  private applyTextPreference(change: TextStyleChange): void {
    switch (change.property) {
      case "fontFamily": this.preferences.text.fontFamily = change.value as string; return;
      case "color": this.preferences.text.color = change.value as string; return;
      case "fontSize": this.preferences.text.fontSize = change.value as number; return;
      case "bold": this.preferences.text.bold = change.value as boolean; return;
      case "italic": this.preferences.text.italic = change.value as boolean; return;
      case "strikethrough": this.preferences.text.strikethrough = change.value as boolean; return;
    }
  }

  private lassoMenu(): DropdownOption[] {
    return lassoOptions(this.preferences, (type) => {
      this.preferences.activeTool = "lasso";
      this.preferences.lasso.type = type;
      this.changed("tool");
    }, this.callbacks.onLassoCopyAll);
  }

  private colorButton(): HTMLButtonElement {
    const button = createDetachedEl(this.ownerDocument, 'button');
    button.type = "button";
    button.className = "native-pdf-handwriting-toolbar-button clickable-icon";
    button.dataset.control = "color";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => this.dropdown.toggle("color", button, { label: "Color options", content: this.colorMenu() }), { signal: this.abort.signal });
    this.buttons.set("color", button);
    return button;
  }

  private colorMenu(): HTMLElement {
    const content = createDetachedDiv(this.ownerDocument);
    const laserActive = this.preferences.activeTool === "laser";
    const textActive = this.preferences.activeTool === "text";
    const drawingTool = resolveDrawingTool(this.preferences.activeTool);
    const applyColor = (color: string): void => {
      if (laserActive) {
        this.preferences.laser.color = color;
        this.changed();
        return;
      }
      if (textActive) {
        this.preferences.text.color = color;
        this.callbacks.onTextStyleChange?.({ property: "color", value: color, source: "change" });
        this.changed("text-style");
        return;
      }
      this.preferences[drawingTool].color = color;
      this.changed();
    };
    const selectedColor = laserActive
      ? this.preferences.laser.color
      : textActive
        ? this.preferences.text.color
        : this.preferences[drawingTool].color;
    for (const option of colorOptions(this.preferences, applyColor, selectedColor)) content.append(this.inlineOption(option));
    const colorLabel = createDetachedEl(this.ownerDocument, 'label');
    colorLabel.textContent = "Custom color";
    const colorInput = createDetachedEl(this.ownerDocument, 'input');
    colorInput.type = "color";
    colorInput.value = laserActive ? this.preferences.laser.color : textActive ? this.preferences.text.color : this.preferences[drawingTool].color;
    colorInput.addEventListener("input", () => applyColor(colorInput.value), { signal: this.abort.signal });
    colorLabel.append(colorInput);
    content.append(colorLabel);
    if (!laserActive && !textActive) {
      const opacityLabel = createDetachedEl(this.ownerDocument, 'label');
      opacityLabel.textContent = "Opacity";
      const opacity = createDetachedEl(this.ownerDocument, 'input');
      opacity.type = "range";
      opacity.min = "0.1";
      opacity.max = "1";
      opacity.step = "0.05";
      opacity.value = String(this.preferences[drawingTool].opacity);
      opacity.addEventListener("input", () => {
        this.preferences[drawingTool].opacity = Number(opacity.value);
        this.changed();
      }, { signal: this.abort.signal });
      opacityLabel.append(opacity);
      content.append(opacityLabel);
    }
    return content;
  }

  private moreMenu(supported: MoreAction[]): DropdownOption[] {
    const labels: Record<MoreAction, string> = {
      export: "Export PDF",
      "export-editable": "Export editable PDF annotations",
      "export-image": "Export annotated image",
      "import-page": "Import page",
      "scan-document": "Scan document",
      "toolbar-main": "Toolbar: PDF bar",
      "toolbar-left": "Toolbar: Left sidebar",
      "toolbar-right": "Toolbar: Right sidebar"
    };
    return supported.map((id) => ({
      id,
      label: labels[id],
      active: id === `toolbar-${this.callbacks.toolbarPlacement?.() ?? "main"}`,
      onSelect: () => this.callbacks.onMore?.(id)
    }));
  }

  private inlineOption(option: DropdownOption): HTMLButtonElement {
    const button = createDetachedEl(this.ownerDocument, 'button');
    button.type = "button";
    button.className = "native-pdf-handwriting-dropdown-option";
    button.dataset.optionId = option.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(option.active ?? false));
    button.disabled = option.disabled ?? false;
    button.textContent = option.label;
    option.render?.(button);
    button.addEventListener("click", () => {
      option.onSelect();
      this.dropdown.close(true);
    }, { signal: this.abort.signal });
    return button;
  }

  /** Select a tool from a non-toolbar gesture while preserving normal change handling. */
  activateTool(tool: ToolId): void {
    this.activate(tool);
  }

  private activate(tool: ToolId): void {
    this.setMouseNavigationActive(false);
    this.preferences.activeTool = tool;
    this.changed("tool");
  }

  private setMouseNavigationActive(active: boolean): void {
    const next = this.mouseModeAvailable && active;
    if (this.mouseNavigationActive === next) return;
    this.mouseNavigationActive = next;
    this.dropdown.close(false);
    this.updateButtons();
    this.callbacks.onMouseModeChange?.(next);
  }

  private changed(reason: PreferenceChangeReason = "general"): void {
    this.updateButtons();
    this.callbacks.onPreferencesChange(this.preferences, reason);
  }

  private updateButtons(): void {
    const active = this.preferences.activeTool;
    const inkModeActive = !this.mouseNavigationActive;
    const mouse = this.buttons.get("mouse");
    if (mouse) {
      this.presentButton(
        mouse,
        this.mouseNavigationActive ? "Switch mouse to inking" : "Use mouse for PDF selection",
        "mouse"
      );
      mouse.setAttribute("aria-pressed", String(this.mouseNavigationActive));
    }
    for (const tool of ["pen", "pencil", "highlighter"] as const) {
      const button = this.buttons.get(tool)!;
      this.presentButton(button, DRAWING_LABELS[tool], tool);
      button.setAttribute("aria-pressed", String(inkModeActive && active === tool));
    }
    this.presentButton(this.buttons.get("eraser")!, "Eraser", "eraser");
    this.presentButton(this.buttons.get("laser")!, "Laser pointer", "laser");
    this.presentButton(this.buttons.get("lasso")!, this.preferences.lasso.type === "freeform" ? "Lasso" : "Rectangle", "lasso");
    this.presentButton(this.buttons.get("text")!, "Text", "text");
    const dragButton = this.buttons.get("drag");
    if (dragButton) {
      this.presentButton(dragButton, "Drag", "drag");
      dragButton.setAttribute("aria-pressed", String(active === "drag"));
    }
    this.buttons.get("eraser")!.setAttribute("aria-pressed", String(inkModeActive && active === "eraser"));
    this.buttons.get("laser")!.setAttribute("aria-pressed", String(inkModeActive && active === "laser"));
    this.buttons.get("lasso")!.setAttribute("aria-pressed", String(inkModeActive && active === "lasso"));
    this.buttons.get("text")!.setAttribute("aria-pressed", String(inkModeActive && active === "text"));
    const colorValue = active === "laser"
      ? this.preferences.laser.color
      : active === "text"
        ? this.preferences.text.color
      : this.preferences[resolveDrawingTool(active)].color;
    const color = this.buttons.get("color");
    if (color) {
      color.setAttribute("aria-label", `Color ${colorValue}`);
      color.removeAttribute("title");
      setToolbarColorSwatch(color, colorValue);
    }
  }
}
