/** Runtime shim for modules that are externalized as `obsidian` in production. */
export class Menu {
  addItem(): this { return this; }
  showAtMouseEvent(): this { return this; }
}

export type App = unknown;

export class Modal {
  readonly titleEl = document.createElement("h2");
  readonly contentEl = document.createElement("div");
  constructor(readonly app: App) {}
  open(): void { this.onOpen(); }
  close(): void { this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}
