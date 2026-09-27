import { describe, expect, it } from "vitest";
import { parseHistoryShortcut, parseSelectionShortcut, shouldIgnoreSelectionShortcut } from "../src/input/SelectionShortcuts";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("selection shortcuts", () => {
  it("keeps plain Ctrl/Cmd editing native and maps ink to Alt/Option", () => {
    expect(parseSelectionShortcut(keyEvent({ key: "c", ctrlKey: true }))).toBeNull();
    expect(parseSelectionShortcut(keyEvent({ key: "a", metaKey: true }))).toBeNull();
    expect(parseSelectionShortcut(keyEvent({ key: "c", ctrlKey: true, altKey: true }))).toBe("copy");
    expect(parseSelectionShortcut(keyEvent({ key: "C", metaKey: true, altKey: true }))).toBe("copy");
    expect(parseSelectionShortcut(keyEvent({ key: "x", ctrlKey: true, altKey: true }))).toBe("cut");
    expect(parseSelectionShortcut(keyEvent({ key: "v", metaKey: true, altKey: true }))).toBe("paste");
    expect(parseSelectionShortcut(keyEvent({ key: "a", metaKey: true, altKey: true }))).toBe("selectAll");
    expect(parseSelectionShortcut(keyEvent({ key: "A", ctrlKey: true, altKey: true }))).toBe("selectAll");
    expect(parseSelectionShortcut(keyEvent({ key: "Delete" }))).toBe("delete");
    expect(parseSelectionShortcut(keyEvent({ key: "Backspace" }))).toBe("delete");
  });

  it("parses ink undo and redo only with Alt/Option", () => {
    expect(parseHistoryShortcut(keyEvent({ key: "z", metaKey: true }))).toBeNull();
    expect(parseHistoryShortcut(keyEvent({ key: "z", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(parseHistoryShortcut(keyEvent({ key: "z", metaKey: true, altKey: true }))).toBe("undo");
    expect(parseHistoryShortcut(keyEvent({ key: "Z", ctrlKey: true, altKey: true }))).toBe("undo");
    expect(parseHistoryShortcut(keyEvent({ key: "z", metaKey: true, altKey: true, shiftKey: true }))).toBe("redo");
    expect(parseHistoryShortcut(keyEvent({ key: "y", ctrlKey: true, altKey: true }))).toBe("redo");
  });

  it("ignores modified delete and shifted paste", () => {
    expect(parseSelectionShortcut(keyEvent({ key: "Delete", ctrlKey: true }))).toBeNull();
    expect(parseSelectionShortcut(keyEvent({ key: "v", metaKey: true, altKey: true, shiftKey: true }))).toBeNull();
  });

  it("ignores form fields outside plugin chrome", () => {
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    const input = document.createElement("input");
    toolbar.append(input);
    document.body.append(toolbar);
    expect(shouldIgnoreSelectionShortcut(input)).toBe(false);
    toolbar.remove();

    const lone = document.createElement("input");
    document.body.append(lone);
    expect(shouldIgnoreSelectionShortcut(lone)).toBe(true);
    lone.remove();
  });
});
