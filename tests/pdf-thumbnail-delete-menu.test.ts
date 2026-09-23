import { afterEach, describe, expect, it, vi } from "vitest";

const nativeMenuState = vi.hoisted(() => ({
  items: [] as Array<{
    title: string;
    icon: string | null;
    warning: boolean;
    handler: (() => void) | undefined;
  }>,
  events: [] as MouseEvent[]
}));

vi.mock("obsidian", () => {
  class Menu {
    addItem(callback: (item: {
      setTitle(title: string): unknown;
      setIcon(icon: string | null): unknown;
      setWarning(warning: boolean): unknown;
      onClick(handler: () => void): unknown;
    }) => unknown): this {
      const record = {
        title: "",
        icon: null as string | null,
        warning: false,
        handler: undefined as (() => void) | undefined
      };
      const item = {
        setTitle(title: string) { record.title = title; return this; },
        setIcon(icon: string | null) { record.icon = icon; return this; },
        setWarning(warning: boolean) { record.warning = warning; return this; },
        onClick(handler: () => void) { record.handler = handler; return this; }
      };
      nativeMenuState.items.push(record);
      callback(item);
      return this;
    }

    showAtMouseEvent(event: MouseEvent): this {
      nativeMenuState.events.push(event);
      const menu = document.createElement("div");
      menu.className = "menu";
      document.body.append(menu);
      return this;
    }
  }
  return { Menu };
});

import { Menu } from "obsidian";
import {
  PdfThumbnailSidebarActions,
  selectedThumbnailPageNumber,
  thumbnailActionAtPoint,
  thumbnailPageNumber
} from "../src/integration/PdfThumbnailDeleteMenu";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (window as Window & { electron?: unknown }).electron;
  nativeMenuState.items.length = 0;
  nativeMenuState.events.length = 0;
});

function rect(top: number, height = 40): DOMRect {
  return {
    x: 0, y: top, left: 0, top, right: 120, bottom: top + height, width: 120, height,
    toJSON: () => ({})
  };
}

function thumbnailHost(pageNumbers: number[] = [3]): {
  host: HTMLElement;
  sidebar: HTMLElement;
  thumbnailView: HTMLElement;
  thumbnail: HTMLElement;
  page: HTMLElement;
  thumbnails: HTMLElement[];
} {
  const host = document.createElement("div");
  const sidebar = document.createElement("div");
  sidebar.className = "pdf-sidebar-container";
  const pane = document.createElement("div");
  pane.className = "pdf-thumbnail-view";
  const thumbnailView = document.createElement("div");
  thumbnailView.id = "thumbnailView";
  const thumbnails = pageNumbers.map((pageNumber, index) => {
    const thumbnail = document.createElement("div");
    thumbnail.className = index === 0 ? "thumbnail selected" : "thumbnail";
    thumbnail.dataset.pageNumber = String(pageNumber);
    thumbnail.getBoundingClientRect = () => rect(100 + index * 40);
    thumbnailView.append(thumbnail);
    return thumbnail;
  });
  const thumbnail = thumbnails[0]!;
  const page = document.createElement("span");
  thumbnail.append(page);
  pane.append(thumbnailView);
  sidebar.append(pane);
  host.append(sidebar);
  document.body.append(host);
  return { host, sidebar, thumbnailView, thumbnail, page, thumbnails };
}

describe("PDF thumbnail sidebar actions", () => {
  it("selects an inclusive thumbnail range on Shift-click and resets it on a normal click", () => {
    const { host, thumbnails } = thumbnailHost([3, 4, 5, 6]);
    const menuEvents = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, {
      onAddPage: vi.fn(),
      onDeletePage: vi.fn(),
      onMenuEvent: menuEvents
    });

    thumbnails[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    thumbnails[3]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));

    expect(thumbnails.map((thumbnail) => thumbnail.classList.contains("native-pdf-handwriting-thumbnail-range-selected")))
      .toEqual([true, true, true, true]);
    expect(menuEvents).toHaveBeenCalledWith("range-selected", {
      anchorPage: 3,
      pageNumber: 6,
      firstPage: 3,
      lastPage: 6,
      count: 4
    });

    thumbnails[1]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(thumbnails.some((thumbnail) => thumbnail.classList.contains("native-pdf-handwriting-thumbnail-range-selected"))).toBe(false);
    thumbnails[3]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    expect(thumbnails.map((thumbnail) => thumbnail.classList.contains("native-pdf-handwriting-thumbnail-range-selected")))
      .toEqual([false, true, true, true]);
    actions.destroy();
  });

  it("deletes the selected thumbnail range once in descending source-page order", async () => {
    const { host, thumbnails } = thumbnailHost([3, 4, 5, 6]);
    const deleted = vi.fn();
    let finishDelete: (() => void) | undefined;
    const deleting = new Promise<void>((resolve) => { finishDelete = resolve; });
    const deletedPages = vi.fn(() => deleting);
    const menuEvents = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, {
      onAddPage: vi.fn(),
      onDeletePage: deleted,
      onDeletePages: deletedPages,
      onMenuEvent: menuEvents
    });

    thumbnails[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    thumbnails[3]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    expect(actions.handleKeyDown(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }))).toBe(true);
    expect(actions.handleKeyDown(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }))).toBe(true);

    expect(deletedPages).toHaveBeenCalledTimes(1);
    expect(deletedPages).toHaveBeenCalledWith([6, 5, 4, 3]);
    expect(deleted).not.toHaveBeenCalled();
    expect(menuEvents).toHaveBeenCalledWith("range-delete-requested", {
      via: "keyboard",
      pageNumbers: [6, 5, 4, 3],
      firstPage: 3,
      lastPage: 6,
      count: 4
    });
    expect(thumbnails.some((thumbnail) => thumbnail.classList.contains("native-pdf-handwriting-thumbnail-range-selected"))).toBe(false);
    finishDelete?.();
    await deleting;
    actions.destroy();
  });

  it("appends Delete page to the native thumbnail menu", async () => {
    const { host, thumbnail, page } = thumbnailHost();
    const deleted = vi.fn();
    const menuEvents = vi.fn();
    thumbnail.addEventListener("contextmenu", (event) => {
      new Menu()
        .addItem((item) => item
          .setTitle("Copy link to page 3")
          .setIcon("link")
          .setWarning(false)
          .onClick(() => undefined)
        )
        .showAtMouseEvent(event as MouseEvent);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted, onMenuEvent: menuEvents });

    expect(thumbnailPageNumber(host, page)).toBe(3);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 });
    thumbnail.dispatchEvent(contextMenu);
    await Promise.resolve();
    expect(nativeMenuState.events).toHaveLength(1);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(nativeMenuState.items).toMatchObject([{ title: "Copy link to page 3", icon: "link", warning: false }]);
    const deleteItem = document.querySelector<HTMLElement>("[data-native-pdf-handwriting-menu-action='delete']");
    expect(deleteItem?.textContent).toBe("Delete page");
    deleteItem?.click();
    expect(deleted).toHaveBeenCalledWith(3);
    expect(menuEvents).toHaveBeenCalledWith("native-menu-appended", expect.objectContaining({
      kind: "delete",
      pageNumber: 3,
      candidateSource: "new"
    }));
    actions.destroy();
  });

  it("appends Delete page when Obsidian repopulates a reused native menu", async () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const existingNativeMenu = document.createElement("div");
    existingNativeMenu.className = "menu";
    document.body.append(existingNativeMenu);
    thumbnail.addEventListener("contextmenu", () => {
      const copyLink = document.createElement("div");
      copyLink.className = "menu-item";
      copyLink.textContent = "Copy link to page 3";
      existingNativeMenu.append(copyLink);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    thumbnail.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 }));
    await Promise.resolve();

    const deleteItem = existingNativeMenu.querySelector<HTMLElement>("[data-native-pdf-handwriting-menu-action='delete']");
    expect(deleteItem?.textContent).toBe("Delete page");
    deleteItem?.click();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
  });

  it("appends Delete page to Obsidian's Electron-native template without replacing Copy link", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const copyLink = vi.fn();
    const nativeTemplates: Array<Array<{ label?: string; type?: string; click?(): void }>> = [];
    const menuApi = {
      buildFromTemplate(template: Array<{ label?: string; type?: string; click?(): void }>) {
        nativeTemplates.push(template);
        return { on: vi.fn(), popup: vi.fn() };
      }
    };
    (window as Window & { electron?: unknown }).electron = { remote: { Menu: menuApi } };
    thumbnail.addEventListener("contextmenu", () => {
      (window as Window & { electron?: { remote?: { Menu?: typeof menuApi } } }).electron?.remote?.Menu?.buildFromTemplate([
        { label: "Copy link to page 3", click: copyLink }
      ]);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    thumbnail.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 }));

    expect(nativeTemplates).toHaveLength(1);
    expect(nativeTemplates[0]?.map((item) => item.label ?? item.type)).toEqual([
      "Copy link to page 3",
      "separator",
      "Delete page"
    ]);
    nativeTemplates[0]?.[2]?.click?.();
    expect(copyLink).not.toHaveBeenCalled();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
  });

  it("intercepts before a document-capture native thumbnail handler", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const nativeTemplates: Array<Array<{ label?: string; type?: string; click?(): void }>> = [];
    const menuApi = {
      buildFromTemplate(template: Array<{ label?: string; type?: string; click?(): void }>) {
        nativeTemplates.push(template);
      }
    };
    (window as Window & { electron?: unknown }).electron = { remote: { Menu: menuApi } };
    const coreCapture = (): void => {
      (window as Window & { electron?: { remote?: { Menu?: typeof menuApi } } }).electron?.remote?.Menu?.buildFromTemplate([
        { label: "Copy link to page 3" }
      ]);
    };
    document.addEventListener("contextmenu", coreCapture, { capture: true });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    thumbnail.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 }));

    expect(nativeTemplates[0]?.map((item) => item.label ?? item.type)).toEqual([
      "Copy link to page 3",
      "separator",
      "Delete page"
    ]);
    nativeTemplates[0]?.[2]?.click?.();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
    document.removeEventListener("contextmenu", coreCapture, { capture: true });
  });

  it("keeps the Electron facade through deferred native template construction", async () => {
    vi.useFakeTimers();
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const nativeTemplates: Array<Array<{ label?: string; type?: string; click?(): void }>> = [];
    const menuApi = {
      buildFromTemplate(template: Array<{ label?: string; type?: string; click?(): void }>) {
        nativeTemplates.push(template);
      }
    };
    (window as Window & { electron?: unknown }).electron = { remote: { Menu: menuApi } };
    thumbnail.addEventListener("contextmenu", () => {
      window.setTimeout(() => {
        (window as Window & { electron?: { remote?: { Menu?: typeof menuApi } } }).electron?.remote?.Menu?.buildFromTemplate([
          { label: "Copy link to page 3" }
        ]);
      }, 0);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    thumbnail.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(nativeTemplates[0]?.map((item) => item.label ?? item.type)).toEqual([
      "Copy link to page 3",
      "separator",
      "Delete page"
    ]);
    nativeTemplates[0]?.[2]?.click?.();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
  });

  it("shadows a getter-backed Electron Menu facade without throwing", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const nativeTemplates: Array<Array<{ label?: string; type?: string; click?(): void }>> = [];
    const menuApi = {
      buildFromTemplate(template: Array<{ label?: string; type?: string; click?(): void }>) {
        nativeTemplates.push(template);
      }
    };
    const remote = {} as { Menu?: typeof menuApi };
    Object.defineProperty(remote, "Menu", { configurable: true, get: () => menuApi });
    (window as Window & { electron?: unknown }).electron = { remote };
    thumbnail.addEventListener("contextmenu", () => {
      (window as Window & { electron?: { remote?: { Menu?: typeof menuApi } } }).electron?.remote?.Menu?.buildFromTemplate([
        { label: "Copy link to page 3" }
      ]);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    thumbnail.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 }));

    expect(nativeTemplates[0]?.map((item) => item.label ?? item.type)).toEqual([
      "Copy link to page 3",
      "separator",
      "Delete page"
    ]);
    nativeTemplates[0]?.[2]?.click?.();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
  });

  it("uses the Electron object carried by Obsidian's context-menu event", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const fallbackTemplates: unknown[][] = [];
    const eventTemplates: Array<Array<{ label?: string; type?: string; click?(): void }>> = [];
    const fallbackMenuApi = { buildFromTemplate(template: unknown[]) { fallbackTemplates.push(template); } };
    const eventMenuApi = {
      buildFromTemplate(template: Array<{ label?: string; type?: string; click?(): void }>) {
        eventTemplates.push(template);
      }
    };
    (window as Window & { electron?: unknown }).electron = { remote: { Menu: fallbackMenuApi } };
    thumbnail.addEventListener("contextmenu", (event) => {
      const eventDocument = (event as MouseEvent & { doc?: { win?: { electron?: { remote?: { Menu?: typeof eventMenuApi } } } } }).doc;
      eventDocument?.win?.electron?.remote?.Menu?.buildFromTemplate([{ label: "Copy link to page 3" }]);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 120 });
    Object.defineProperty(contextMenu, "doc", { value: { win: { electron: { remote: { Menu: eventMenuApi } } } } });

    thumbnail.dispatchEvent(contextMenu);

    expect(fallbackTemplates).toHaveLength(0);
    expect(eventTemplates[0]?.map((item) => item.label ?? item.type)).toEqual([
      "Copy link to page 3",
      "separator",
      "Delete page"
    ]);
    eventTemplates[0]?.[2]?.click?.();
    expect(deleted).toHaveBeenCalledWith(3);
    actions.destroy();
  });

  it("puts + after the last thumbnail and appends from the current list", () => {
    const { host, thumbnailView, thumbnail } = thumbnailHost();
    const added = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: added, onDeletePage: vi.fn() });

    const add = thumbnailView.querySelector<HTMLButtonElement>(".native-pdf-handwriting-thumbnail-add-page");
    expect(thumbnail.nextElementSibling).toBe(add);
    expect(add?.getAttribute("aria-label")).toBe("Add page at end");
    add?.click();
    expect(added).toHaveBeenCalledWith(4);
    actions.destroy();
  });

  it("appends Add page to the native blank-sidebar menu at the insertion position", async () => {
    const { host, sidebar, thumbnailView } = thumbnailHost();
    const first = document.createElement("div");
    first.dataset.pageNumber = "1";
    first.getBoundingClientRect = () => rect(20);
    const second = document.createElement("div");
    second.dataset.pageNumber = "2";
    second.getBoundingClientRect = () => rect(160);
    thumbnailView.replaceChildren(first, second);
    const added = vi.fn();
    sidebar.addEventListener("contextmenu", (event) => {
      new Menu()
        .addItem((item) => item
          .setTitle("Sidebar options")
          .setIcon("settings")
          .setWarning(false)
          .onClick(() => undefined)
        )
        .showAtMouseEvent(event as MouseEvent);
    });
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: added, onDeletePage: vi.fn() });

    expect(thumbnailActionAtPoint(host, sidebar, 130)).toEqual({ kind: "add", pageNumber: 2 });
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 130 });
    sidebar.dispatchEvent(contextMenu);
    await Promise.resolve();
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(nativeMenuState.events).toHaveLength(1);
    expect(nativeMenuState.items).toMatchObject([{ title: "Sidebar options", icon: "settings", warning: false }]);
    const addItem = document.querySelector<HTMLElement>("[data-native-pdf-handwriting-menu-action='add']");
    expect(addItem?.textContent).toBe("Add page");
    addItem?.click();
    expect(added).toHaveBeenCalledWith(2);
    actions.destroy();
  });

  it("shows an Add menu only when the blank sidebar has no native menu", async () => {
    const { host, sidebar } = thumbnailHost();
    const added = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: added, onDeletePage: vi.fn() });

    sidebar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 130 }));
    expect(nativeMenuState.events).toHaveLength(0);
    await Promise.resolve();
    expect(nativeMenuState.items).toMatchObject([{ title: "Add page", icon: "plus", warning: false }]);
    expect(nativeMenuState.events).toHaveLength(1);
    nativeMenuState.items[0]?.handler?.();
    expect(added).toHaveBeenCalledWith(4);
    actions.destroy();
  });

  it("ignores document-page and outline right-clicks", () => {
    const { host } = thumbnailHost();
    const documentPage = document.createElement("div");
    documentPage.dataset.pageNumber = "1";
    host.append(documentPage);
    expect(thumbnailPageNumber(host, documentPage)).toBeNull();
    expect(thumbnailActionAtPoint(host, documentPage, 30)).toBeNull();
  });

  it("resolves the selected thumbnail page number", () => {
    const { host, thumbnail } = thumbnailHost();
    expect(selectedThumbnailPageNumber(host)).toBe(3);
    thumbnail.classList.remove("selected");
    expect(selectedThumbnailPageNumber(host)).toBeNull();
  });

  it("deletes the selected thumbnail page on Backspace after a sidebar click", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });

    expect(actions.handleKeyDown(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }))).toBe(false);
    expect(deleted).not.toHaveBeenCalled();

    thumbnail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(actions.handleKeyDown(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }))).toBe(true);
    expect(deleted).toHaveBeenCalledWith(3);

    deleted.mockClear();
    host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(actions.handleKeyDown(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }))).toBe(false);
    expect(deleted).not.toHaveBeenCalled();
    actions.destroy();
  });

  it("does not steal Backspace from text fields even when armed", () => {
    const { host, thumbnail } = thumbnailHost();
    const deleted = vi.fn();
    const actions = new PdfThumbnailSidebarActions(host, { onAddPage: vi.fn(), onDeletePage: deleted });
    thumbnail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

    const input = document.createElement("input");
    document.body.append(input);
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: input });
    expect(actions.handleKeyDown(event)).toBe(false);
    expect(deleted).not.toHaveBeenCalled();
    actions.destroy();
  });
});
