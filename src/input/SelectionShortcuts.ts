export type SelectionShortcutAction = "copy" | "cut" | "paste" | "delete" | "selectAll";
export type HistoryShortcutAction = "undo" | "redo";

const PLUGIN_CHROME =
  ".native-pdf-handwriting-toolbar, .native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-eraser-menu, .native-pdf-handwriting-advanced";

export function shouldIgnoreSelectionShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Tool chrome: allow Mod+A / undo through Obsidian commands; DOM path still skips real fields.
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    if (target.closest(PLUGIN_CHROME)) return false;
    return true;
  }
  const el = target as HTMLElement;
  return Boolean(el.isContentEditable);
}

/**
 * Parse ink copy/cut/paste/select-all. Ctrl/Cmd+Alt is the explicit ink chord;
 * plain Ctrl/Cmd remains available to the host application.
 */
export function parseSelectionShortcut(event: KeyboardEvent): SelectionShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.altKey) {
    if (event.shiftKey) return null;
    const key = event.key.toLowerCase();
    if (key === "a") return "selectAll";
    if (key === "c") return "copy";
    if (key === "x") return "cut";
    if (key === "v") return "paste";
    return null;
  }
  if (!mod && !event.altKey && !event.shiftKey) {
    if (event.key === "Delete" || event.key === "Backspace" || event.code === "Delete" || event.code === "Backspace") {
      return "delete";
    }
  }
  return null;
}

/** Ctrl/Cmd+Alt always targets ink history; plain Ctrl/Cmd does so only in ink mode. */
export function parseHistoryShortcut(
  event: KeyboardEvent
): HistoryShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

export type InkHotkeyCommand =
  | "select-all-ink"
  | "copy-ink"
  | "cut-ink"
  | "paste-ink"
  | "undo-ink"
  | "redo-ink";

export function inkHotkeyCommand(event: KeyboardEvent): InkHotkeyCommand | null {
  const history = parseHistoryShortcut(event);
  if (history === "undo") return "undo-ink";
  if (history === "redo") return "redo-ink";
  const action = parseSelectionShortcut(event);
  if (action === "selectAll") return "select-all-ink";
  if (action === "copy") return "copy-ink";
  if (action === "cut") return "cut-ink";
  if (action === "paste") return "paste-ink";
  return null;
}
