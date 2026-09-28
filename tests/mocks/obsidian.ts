/** Runtime shim for modules that are externalized as `obsidian` in production. */
function textElement(tag: string): HTMLElement {
  const element = document.createElement(tag);
  (element as HTMLElement & { setText(value: string): void }).setText = (value: string) => {
    element.textContent = value;
  };
  return element;
}

export type App = unknown;

export class Modal {
  readonly titleEl = textElement("h2");
  readonly contentEl = document.createElement("div");
  constructor(readonly app: App) {}
  open(): this { this.onOpen(); return this; }
  close(): void { this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
  private placeholder = "";
  setPlaceholder(value: string): void { this.placeholder = value; }
  getItems(): T[] { return []; }
  getItemText(item: T): string { return String(item); }
  getSuggestions(query: string): Array<{ item: T; match: { score: number; matches: Array<[number, number]> } }> {
    const normalized = query.trim().toLowerCase();
    return this.getItems()
      .filter((item) => !normalized || this.getItemText(item).toLowerCase().includes(normalized))
      .map((item) => ({ item, match: { score: 0, matches: [] } }));
  }
  onChooseItem(_item: T): void {}
}

export class Menu {
  addItem(): this { return this; }
  showAtMouseEvent(): this { return this; }
}
