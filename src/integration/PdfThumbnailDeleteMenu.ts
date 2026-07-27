import { Menu } from "obsidian";
import { isElement, isHTMLElement } from "../dom/typeGuards";

const THUMBNAIL_VIEW_SELECTOR = ".pdf-thumbnail-view, #thumbnailView, .thumbnailView";
type ThumbnailAction = { kind: "delete" | "add"; pageNumber: number };
export type ThumbnailMenuPhase =
  | "context-seen"
  | "context-ignored"
  | "menu-scan"
  | "native-template-armed"
  | "native-template-appended"
  | "native-template-unavailable"
  | "native-menu-appended"
  | "native-menu-missing"
  | "standalone-add";

export interface PdfThumbnailSidebarActionsCallbacks {
  onAddPage(pageNumber: number): void | Promise<void>;
  onDeletePage(pageNumber: number): void | Promise<void>;
  /** Durable diagnostics for augmenting Obsidian's own thumbnail menu. */
  onMenuEvent?(phase: ThumbnailMenuPhase, details: Record<string, unknown>): void;
}

interface ObsidianDomWindow {
  createDiv(): HTMLDivElement;
  createEl(tag: string): HTMLElement;
}

interface MenuSignature {
  childCount: number;
  itemCount: number;
  hasCopyLink: boolean;
}

interface NativeMenuScan {
  menu: HTMLElement | null;
  source: "new" | "changed" | "copy-link" | null;
  menuCount: number;
  newMenuCount: number;
  changedMenuCount: number;
  copyLinkMenuCount: number;
  candidate: Record<string, unknown> | null;
}

interface ElectronMenuTemplate {
  label?: string;
  type?: string;
  click?(): void;
  [key: string]: unknown;
}

interface ElectronMenuApi {
  buildFromTemplate?(template: ElectronMenuTemplate[]): unknown;
}

interface ElectronRemoteApi {
  Menu?: ElectronMenuApi;
  [key: string]: unknown;
}

interface NativeTemplateIntercept {
  handled: boolean;
}

interface ObsidianElectronWindow extends Window {
  electron?: {
    remote?: ElectronRemoteApi;
  };
}

function domWindow(ownerDocument: Document): ObsidianDomWindow {
  return ownerDocument.win as unknown as ObsidianDomWindow;
}

/** Native thumbnail-sidebar controls and context actions (never document pages). */
export class PdfThumbnailSidebarActions {
  private readonly abort = new AbortController();
  private addButton: HTMLButtonElement | null = null;
  private observer: MutationObserver | null = null;
  private mountFrame: number | null = null;
  /** Restores the one active Electron facade before another thumbnail menu opens. */
  private restoreTemplateIntercept: (() => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: PdfThumbnailSidebarActionsCallbacks
  ) {
    // Obsidian's native thumbnail handler may run in document capture. Window
    // capture is the only stable phase before it, including after a reload.
    const contextRoot = host.ownerDocument.defaultView ?? host;
    contextRoot.addEventListener("contextmenu", (event) => this.show(event as MouseEvent), {
      capture: true,
      signal: this.abort.signal
    });
    this.observer = new MutationObserver(() => this.scheduleMountAddButton());
    this.observer.observe(host, { childList: true, subtree: true });
    this.mountAddButton();
  }

  destroy(): void {
    this.restoreTemplateIntercept?.();
    this.restoreTemplateIntercept = null;
    this.abort.abort();
    this.observer?.disconnect();
    this.observer = null;
    if (this.mountFrame !== null) this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.mountFrame);
    this.addButton?.remove();
    this.addButton = null;
  }

  private show = (event: MouseEvent): void => {
    const requestedAction = thumbnailActionAtPoint(this.host, event.target, event.clientY);
    const context = this.contextDetails(event.target);
    if (!requestedAction) {
      this.callbacks.onMenuEvent?.("context-ignored", { ...context, reason: "outside-thumbnail-sidebar" });
      return;
    }
    this.callbacks.onMenuEvent?.("context-seen", { ...requestedAction, ...context });
    if (requestedAction.kind === "delete") {
      const nativeTemplate = this.interceptElectronNativeMenu(requestedAction, event);
      this.appendToNativeThumbnailMenu(event, requestedAction, nativeTemplate);
      return;
    }
    // Native handlers still receive the event. Prevent only the browser's
    // fallback menu while we wait to append to a native sidebar menu (or show
    // our own only when this Obsidian build does not supply one).
    event.preventDefault();
    this.appendToNativeThumbnailMenu(event, requestedAction);
  }

  /**
   * Obsidian's PDF viewer owns the “Copy link to page N” menu and uses an
   * internal Menu class (not the plugin API class). Some builds reuse an old
   * menu element instead of appending a new one, so detect both a new menu and
   * a changed/repopulated existing menu. Never replace the native instance.
   */
  private appendToNativeThumbnailMenu(
    event: MouseEvent,
    action: ThumbnailAction,
    nativeTemplate: NativeTemplateIntercept | null = null
  ): void {
    const ownerDocument = this.host.ownerDocument;
    const existingMenus = new Map(
      [...ownerDocument.querySelectorAll<HTMLElement>(".menu")].map((menu) => [menu, menuSignature(menu)])
    );
    const tryAppend = (attempt: number): void => {
      if (this.abort.signal.aborted) return;
      // Native menus on desktop have no DOM `.menu`. The Electron template
      // interceptor has already extended the exact menu constructed by core.
      if (nativeTemplate?.handled) return;
      const scan = findNativeMenu(ownerDocument, existingMenus);
      this.callbacks.onMenuEvent?.("menu-scan", {
        ...action,
        attempt,
        menuCountBefore: existingMenus.size,
        menuCount: scan.menuCount,
        newMenuCount: scan.newMenuCount,
        changedMenuCount: scan.changedMenuCount,
        copyLinkMenuCount: scan.copyLinkMenuCount,
        candidateSource: scan.source,
        candidate: scan.candidate
      });
      if (scan.menu && this.addNativeMenuAction(scan.menu, action)) {
        this.callbacks.onMenuEvent?.("native-menu-appended", {
          ...action,
          attempt,
          candidateSource: scan.source,
          candidate: scan.candidate
        });
        return;
      }
      const window = ownerDocument.defaultView;
      if (action.kind === "delete" && attempt < 3 && window?.requestAnimationFrame) {
        window.requestAnimationFrame(() => tryAppend(attempt + 1));
        return;
      }
      this.callbacks.onMenuEvent?.("native-menu-missing", {
        ...action,
        attempts: attempt + 1,
        menuCountBefore: existingMenus.size,
        menuCount: scan.menuCount,
        newMenuCount: scan.newMenuCount,
        changedMenuCount: scan.changedMenuCount,
        copyLinkMenuCount: scan.copyLinkMenuCount
      });
      // Obsidian's current PDF implementation has no context menu for blank
      // thumbnail-sidebar space. A standalone Add menu is therefore not a
      // replacement for a native one.
      if (action.kind === "add") this.showStandaloneAddMenu(event, action.pageNumber);
    };
    queueMicrotask(() => tryAppend(0));
  }

  /**
   * Obsidian's desktop Menu keeps its items outside the renderer DOM. Core
   * constructs the thumbnail menu synchronously with Electron's
   * `buildFromTemplate`; one call-scoped intercept preserves that core menu
   * and appends Delete before Electron displays it.
   */
  private interceptElectronNativeMenu(action: ThumbnailAction, event: MouseEvent): NativeTemplateIntercept | null {
    if (action.kind !== "delete") return null;
    this.restoreTemplateIntercept?.();
    // Core's `showAtMouseEvent` intentionally uses `event.doc.win`, which
    // can differ from `ownerDocument.defaultView` for a workspace leaf.
    const eventDocument = (event as unknown as { doc?: { win?: ObsidianElectronWindow } }).doc;
    const window: ObsidianElectronWindow | null = eventDocument?.win
      ?? event.view
      ?? this.host.ownerDocument.defaultView;
    const electron = window?.electron;
    const remote = electron?.remote;
    const menu = remote?.Menu;
    if (!window || !electron || !remote || !menu || typeof menu.buildFromTemplate !== "function") {
      this.callbacks.onMenuEvent?.("native-template-unavailable", { ...action, reason: "electron-menu-api-missing" });
      return null;
    }
    const original = (template: ElectronMenuTemplate[]): unknown => menu.buildFromTemplate!(template);
    // event.doc.win can be a minimal Electron facade; use the host window for
    // timer ownership so a pop-out restores its own temporary hook reliably.
    const timerWindow = this.host.ownerDocument.defaultView ?? window;

    const state: NativeTemplateIntercept = { handled: false };
    const facadeMenu = Object.create(menu) as ElectronMenuApi;
    const facadeRemote = Object.create(remote) as ElectronRemoteApi;
    const facadeElectron = Object.create(electron) as { remote?: ElectronRemoteApi };
    let restoreElectron: (() => void) | null = null;
    let restoreTimer: number | null = null;
    let facadeScope: "window-electron" | "electron-remote" | null = null;
    const restore = (): void => {
      if (restoreTimer !== null) {
        timerWindow.clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      restoreElectron?.();
      restoreElectron = null;
      if (this.restoreTemplateIntercept === restore) this.restoreTemplateIntercept = null;
    };
    const callbacks = this.callbacks;
    const intercepted = function (this: void, template: ElectronMenuTemplate[]): unknown {
      if (state.handled || !Array.isArray(template)) return original(template);
      state.handled = true;
      restore();
      const deleteItem: ElectronMenuTemplate = {
        label: "Delete page",
        type: "normal",
        click: () => void callbacks.onDeletePage(action.pageNumber)
      };
      callbacks.onMenuEvent?.("native-template-appended", {
        ...action,
        originalItemCount: template.length,
        finalItemCount: template.length + 2
      });
      return original([...template, { type: "separator" }, deleteItem]);
    };
    // Electron exposes Menu/remote through getter-backed proxies in some
    // Obsidian builds. Assignment walks that accessor and throws; defining a
    // data property on our forwarding facade is a safe, local shadow instead.
    Object.defineProperty(facadeMenu, "buildFromTemplate", { configurable: true, value: intercepted, writable: true });
    Object.defineProperty(facadeRemote, "Menu", { configurable: true, value: facadeMenu, writable: true });
    Object.defineProperty(facadeElectron, "remote", { configurable: true, value: facadeRemote, writable: true });
    try {
      // @electron/remote may hand out a new proxy on each access. Shadow the
      // event window's `electron` root first, so core's full lookup receives
      // one stable forwarding facade; fall back to the remote property only
      // for hosts that expose `electron` as a non-configurable global.
      restoreElectron = overrideOwnProperty(window, "electron", facadeElectron);
      facadeScope = "window-electron";
      if (!restoreElectron || window.electron?.remote?.Menu !== facadeMenu) {
        restore();
        restoreElectron = overrideOwnProperty(electron, "remote", facadeRemote);
        facadeScope = "electron-remote";
        if (!restoreElectron || electron.remote?.Menu !== facadeMenu) {
          restore();
          this.callbacks.onMenuEvent?.("native-template-unavailable", { ...action, reason: "electron-facade-unavailable" });
          return null;
        }
      }
    } catch (error) {
      this.callbacks.onMenuEvent?.("native-template-unavailable", {
        ...action,
        reason: "electron-menu-api-patch-failed",
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
    this.callbacks.onMenuEvent?.("native-template-armed", {
      ...action,
      electronSource: eventDocument?.win ? "event-doc" : event.view ? "event-view" : "host-document",
      eventDocumentMatchesHost: eventDocument ? eventDocument === this.host.ownerDocument : null,
      remoteFacade: true,
      facadeScope
    });
    this.restoreTemplateIntercept = restore;
    // Obsidian currently reaches this template from document capture and can
    // defer construction past the contextmenu microtask. The facade restores
    // immediately after the one template call, with a short hard cap solely
    // as a safety net for a host that abandons the native menu.
    restoreTimer = timerWindow.setTimeout(restore, 300);
    return state;
  }

  private addNativeMenuAction(menu: HTMLElement, action: ThumbnailAction): boolean {
    const selector = `[data-native-pdf-handwriting-menu-action="${action.kind}"]`;
    const existing = menu.querySelector<HTMLElement>(selector);
    if (existing?.dataset.nativePdfHandwritingPageNumber === String(action.pageNumber)) return true;
    existing?.remove();
    const ownerDocument = menu.ownerDocument;
    const window = domWindow(ownerDocument);
    const item = window.createDiv();
    item.className = action.kind === "delete" ? "menu-item is-warning" : "menu-item";
    item.dataset.nativePdfHandwritingMenuAction = action.kind;
    item.dataset.nativePdfHandwritingPageNumber = String(action.pageNumber);
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    const icon = window.createDiv();
    icon.className = "menu-item-icon";
    icon.setAttribute("aria-hidden", "true");
    const title = window.createDiv();
    title.className = "menu-item-title";
    title.textContent = action.kind === "delete" ? "Delete page" : "Add page";
    item.append(icon, title);
    let invoked = false;
    const invoke = (): void => {
      if (invoked) return;
      invoked = true;
      menu.remove();
      if (action.kind === "delete") void this.callbacks.onDeletePage(action.pageNumber);
      else void this.callbacks.onAddPage(action.pageNumber);
    };
    item.addEventListener("click", invoke, { signal: this.abort.signal });
    item.addEventListener("keydown", (keyboardEvent) => {
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
      keyboardEvent.preventDefault();
      invoke();
    }, { signal: this.abort.signal });
    menu.append(item);
    return true;
  }

  private showStandaloneAddMenu(event: MouseEvent, pageNumber: number): void {
    const menu = new Menu();
    this.addPageAction(menu, pageNumber);
    menu.showAtMouseEvent(event);
    this.callbacks.onMenuEvent?.("standalone-add", { kind: "add", pageNumber });
  }

  private addPageAction(menu: Menu, pageNumber: number): void {
    menu.addItem((item) => item
      .setTitle("Add page")
      .setIcon("plus")
      .setWarning(false)
      .onClick(() => void this.callbacks.onAddPage(pageNumber))
    );
  }

  private addDeleteAction(menu: Menu, pageNumber: number): void {
    menu.addItem((item) => item
      .setTitle("Delete page")
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => void this.callbacks.onDeletePage(pageNumber))
    );
  }

  private contextDetails(target: EventTarget | null): Record<string, unknown> {
    const element = isElement(target) ? target : null;
    const thumbnailView = findThumbnailView(this.host);
    return {
      targetTag: element?.tagName.toLowerCase() ?? null,
      targetClasses: element ? [...element.classList].slice(0, 6) : [],
      hostContainsTarget: Boolean(element && this.host.contains(element)),
      thumbnailViewPresent: Boolean(thumbnailView),
      targetWithinThumbnailView: Boolean(element && thumbnailView?.contains(element)),
      targetWithinThumbnail: Boolean(element?.closest(".thumbnail")),
      targetWithinSidebar: Boolean(element?.closest(`.pdf-sidebar-container, .pdf-sidebar, ${THUMBNAIL_VIEW_SELECTOR}`))
    };
  }

  private scheduleMountAddButton(): void {
    if (this.mountFrame !== null) return;
    const view = this.host.ownerDocument.defaultView;
    if (!view) {
      this.mountAddButton();
      return;
    }
    this.mountFrame = view.requestAnimationFrame(() => {
      this.mountFrame = null;
      this.mountAddButton();
    });
  }

  private mountAddButton(): void {
    const thumbnailView = findThumbnailView(this.host);
    if (!thumbnailView) {
      this.addButton?.remove();
      this.addButton = null;
      return;
    }
    if (!this.addButton) {
      this.addButton = domWindow(this.host.ownerDocument).createEl("button") as HTMLButtonElement;
      this.addButton.type = "button";
      this.addButton.className = "native-pdf-handwriting-thumbnail-add-page clickable-icon";
      this.addButton.setAttribute("aria-label", "Add page at end");
      this.addButton.textContent = "+";
      this.addButton.addEventListener("click", () => {
        // PDF.js replaces the thumbnail list during reload. Resolve it on
        // click rather than retaining the first (possibly detached) list.
        const currentThumbnailView = findThumbnailView(this.host);
        if (currentThumbnailView) void this.callbacks.onAddPage(nextPageNumber(currentThumbnailView));
      }, { signal: this.abort.signal });
    }
    if (this.addButton.parentElement !== thumbnailView) thumbnailView.append(this.addButton);
    else if (thumbnailView.lastElementChild !== this.addButton) thumbnailView.append(this.addButton);
  }
}

/** Temporarily shadows a getter-backed Electron remote property and restores it exactly. */
function overrideOwnProperty(target: object, key: string, value: unknown): (() => void) | null {
  const properties = target as Record<string, unknown>;
  const prior = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: prior?.enumerable ?? true,
      writable: true,
      value
    });
  } catch {
    return null;
  }
  if (properties[key] !== value) {
    if (prior) Object.defineProperty(target, key, prior);
    else delete properties[key];
    return null;
  }
  let restored = false;
  return (): void => {
    if (restored) return;
    restored = true;
    if (prior) Object.defineProperty(target, key, prior);
    else delete properties[key];
  };
}

function findNativeMenu(ownerDocument: Document, before: ReadonlyMap<HTMLElement, MenuSignature>): NativeMenuScan {
  const menus = [...ownerDocument.querySelectorAll<HTMLElement>(".menu")];
  const fresh = menus.filter((menu) => !before.has(menu));
  const changed = menus.filter((menu) => {
    const prior = before.get(menu);
    return prior !== undefined && !sameMenuSignature(prior, menuSignature(menu));
  });
  const copyLink = menus.filter((menu) => menuSignature(menu).hasCopyLink);
  const menu = fresh.at(-1) ?? changed.at(-1) ?? copyLink.at(-1) ?? null;
  const source: NativeMenuScan["source"] = fresh.length ? "new"
    : changed.length ? "changed"
      : copyLink.length ? "copy-link"
        : null;
  return {
    menu,
    source,
    menuCount: menus.length,
    newMenuCount: fresh.length,
    changedMenuCount: changed.length,
    copyLinkMenuCount: copyLink.length,
    candidate: menu ? menuDetails(menu) : null
  };
}

function menuSignature(menu: HTMLElement): MenuSignature {
  return {
    childCount: menu.children.length,
    itemCount: menu.querySelectorAll(".menu-item").length,
    hasCopyLink: /\bcopy link\b/i.test(menu.textContent ?? "")
  };
}

function sameMenuSignature(left: MenuSignature, right: MenuSignature): boolean {
  return left.childCount === right.childCount
    && left.itemCount === right.itemCount
    && left.hasCopyLink === right.hasCopyLink;
}

/** Privacy-safe menu shape for diagnosing Obsidian internal menu changes. */
function menuDetails(menu: HTMLElement): Record<string, unknown> {
  const signature = menuSignature(menu);
  return {
    tag: menu.tagName.toLowerCase(),
    classes: [...menu.classList].slice(0, 6),
    childCount: signature.childCount,
    itemCount: signature.itemCount,
    hasCopyLink: signature.hasCopyLink
  };
}

/** Resolves a page only from the PDF thumbnail sidebar, never the document canvas. */
export function thumbnailPageNumber(host: HTMLElement, target: EventTarget | null): number | null {
  if (!isHTMLElement(target)) return null;
  const thumbnailView = findThumbnailView(host);
  if (!thumbnailView || !thumbnailView.contains(target)) return null;
  const numbered = target.closest<HTMLElement>("[data-page-number]");
  if (!numbered || !thumbnailView.contains(numbered)) return null;
  const pageNumber = Number(numbered.dataset.pageNumber);
  return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}

export function thumbnailActionAtPoint(
  host: HTMLElement,
  target: EventTarget | null,
  clientY: number
): ThumbnailAction | null {
  // A thumbnail may contain SVG content; accept any DOM element, not just an
  // HTMLElement, while still excluding document-page clicks below.
  if (!isElement(target)) return null;
  const thumbnailView = findThumbnailView(host);
  const sidebar = target.closest(`.pdf-sidebar-container, .pdf-sidebar, ${THUMBNAIL_VIEW_SELECTOR}`);
  if (
    !thumbnailView
    || !isHTMLElement(sidebar)
    || !host.contains(sidebar)
    || !sidebar.contains(thumbnailView)
  ) return null;
  const thumbnailPage = thumbnailPageNumber(host, target);
  if (thumbnailPage !== null) return { kind: "delete", pageNumber: thumbnailPage };
  return { kind: "add", pageNumber: insertionPageNumber(thumbnailView, clientY) };
}

function findThumbnailView(host: HTMLElement): HTMLElement | null {
  const root = host.querySelector<HTMLElement>(THUMBNAIL_VIEW_SELECTOR);
  if (!root) return null;
  return root.querySelector<HTMLElement>("#thumbnailView") ?? root;
}

function thumbnails(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-page-number]")]
    .filter((element) => Number.isInteger(Number(element.dataset.pageNumber)) && Number(element.dataset.pageNumber) >= 1);
}

function nextPageNumber(root: HTMLElement): number {
  return thumbnails(root).reduce((last, thumbnail) => Math.max(last, Number(thumbnail.dataset.pageNumber)), 0) + 1;
}

function insertionPageNumber(root: HTMLElement, clientY: number): number {
  const items = thumbnails(root).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
  if (!items.length) return 1;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return Number(item.dataset.pageNumber);
  }
  return nextPageNumber(root);
}
