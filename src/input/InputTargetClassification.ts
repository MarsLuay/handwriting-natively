import { isElement } from "../dom/typeGuards";

export type InputTargetClass = "page" | "ui-control" | "ui-input" | "ui-menu";

export interface InputTargetClassification {
  targetClass: InputTargetClass;
  reason: string;
}

const UI_CONTROL_SELECTOR = [
  ".native-pdf-handwriting-toolbar",
  ".native-pdf-handwriting-selection-toolbar",
  ".native-pdf-handwriting-selection-control",
  ".native-pdf-handwriting-rail",
  ".native-pdf-handwriting-text-box",
  "button",
  "a[href]",
  "label",
  "[role='button']",
  "[role='option']",
  "[role='tab']",
  "[aria-haspopup]"
].join(", ");

const UI_INPUT_SELECTOR = [
  ".native-pdf-handwriting-text-input",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']"
].join(", ");

const UI_MENU_SELECTOR = [
  ".native-pdf-handwriting-dropdown",
  ".native-pdf-handwriting-eraser-menu",
  ".native-pdf-handwriting-advanced",
  ".menu",
  ".popover",
  ".modal",
  ".modal-container",
  ".suggestion-container",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']"
].join(", ");

/**
 * Classify the initial contact target before any pointer can claim ownership.
 * The result is intentionally independent of the active tool or mouse policy:
 * UI controls remain native for Pencil and mouse, while captured page contacts
 * are governed by their existing route after the initial classification.
 */
export function classifyInputTarget(target: EventTarget | null): InputTargetClassification {
  if (!isElement(target)) return { targetClass: "page", reason: "non-element-target" };

  if (target.closest(UI_INPUT_SELECTOR)) {
    return { targetClass: "ui-input", reason: "editable-control" };
  }
  if (target.closest(UI_MENU_SELECTOR)) {
    return { targetClass: "ui-menu", reason: "menu-or-popover" };
  }
  if (target.closest(UI_CONTROL_SELECTOR)) {
    return { targetClass: "ui-control", reason: "interactive-control" };
  }
  return { targetClass: "page", reason: "page-surface" };
}

export function isUiInputTarget(target: EventTarget | null): boolean {
  return classifyInputTarget(target).targetClass !== "page";
}
