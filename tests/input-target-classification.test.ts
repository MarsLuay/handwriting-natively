import { describe, expect, it } from "vitest";
import { classifyInputTarget, isUiInputTarget } from "../src/input/InputTargetClassification";

describe("input target classification", () => {
  it("keeps page surfaces distinct from controls, fields, and menus", () => {
    const page = document.createElement("div");
    page.className = "page";
    const canvas = document.createElement("canvas");
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    const button = document.createElement("button");
    const input = document.createElement("input");
    const menu = document.createElement("div");
    menu.className = "menu";
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitem");

    page.append(canvas, toolbar, input, menu);
    toolbar.append(button);
    menu.append(menuItem);

    expect(classifyInputTarget(canvas)).toEqual({ targetClass: "page", reason: "page-surface" });
    expect(classifyInputTarget(button)).toEqual({ targetClass: "ui-control", reason: "interactive-control" });
    expect(classifyInputTarget(input)).toEqual({ targetClass: "ui-input", reason: "editable-control" });
    expect(classifyInputTarget(menuItem)).toEqual({ targetClass: "ui-menu", reason: "menu-or-popover" });
    expect(isUiInputTarget(toolbar)).toBe(true);
  });

  it("does not classify non-element event targets as UI", () => {
    expect(classifyInputTarget(null)).toEqual({ targetClass: "page", reason: "non-element-target" });
  });
});
