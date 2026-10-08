import { setIcon, setTooltip } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";

export interface NativePdfToolbarState {
  pageNumber: number;
  pageCount: number;
  scale: number;
  scaleValue: string;
  sidebarView: 0 | 1 | 2;
  hasOutline: boolean;
}

export interface NativePdfToolbarActions {
  getState(): NativePdfToolbarState;
  goToPage(pageNumber: number): void;
  previousPage(): void;
  nextPage(): void;
  zoomIn(): void;
  zoomOut(): void;
  setZoom(scale: number): void;
  fitWidth(): void;
  fitHeight(): void;
  fitPage(): void;
  toggleSidebar(): void;
  setSidebarView(view: number): void;
  revealCurrentOutlineItem(): void;
  toggleSearch(): void;
  toggleHandMode(): void;
  isHandMode(): boolean;
  rotateCounterclockwise(): void;
  rotateClockwise(): void;
  togglePresentationMode(): void;
  printPdf(): void;
  downloadPdf(): void;
  adaptToTheme(): void;
  unsupportedCommand?(name: string, value: unknown): void;
}

interface NativePdfToolbar {
  toolbarEl: HTMLElement;
  toolbarRightEl: HTMLElement;
  setPageNumber(pageNumber: number, pageLabel?: string | null): void;
  setPagesCount(pageCount: number, hasPageLabels?: boolean): void;
  setPageScale(scaleValue: string, scale: number): void;
  reset(): void;
}

interface NativePdfToolbarChild {
  file?: unknown;
  pdfViewer: {
    eventBus: ToolbarEventBus;
    pdfSidebar: {
      readonly isOpen: boolean;
      readonly active: number;
      switchView(view: number, force?: boolean): void;
    };
    pdfOutlineViewer: { readonly outline: unknown };
    pdfViewer: {
      readonly currentScaleValue: string;
      readonly currentScale: number;
      readonly spreadMode: number;
    };
  };
  onCSSChange(): void;
}

export type NativePdfToolbarConstructor = new (
  app: App,
  host: HTMLElement,
  child: NativePdfToolbarChild
) => NativePdfToolbar;

export interface NativePdfToolbarCaptureResult {
  constructor: NativePdfToolbarConstructor | null;
  error: string | null;
}

function createElement<T extends keyof HTMLElementTagNameMap>(ownerDocument: Document, tag: T): HTMLElementTagNameMap[T] {
  if (!ownerDocument.body) throw new Error("PDF toolbar document body is unavailable");
  const element = ownerDocument.body.createEl(tag);
  element.remove();
  return element;
}

type ToolbarEventHandler = (data: Record<string, unknown>) => void;

class ToolbarEventBus {
  private readonly handlers = new Map<string, Set<ToolbarEventHandler>>();

  _on(name: string, handler: ToolbarEventHandler): void {
    const handlers = this.handlers.get(name) ?? new Set<ToolbarEventHandler>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
  }

  _off(name: string, handler: ToolbarEventHandler): void {
    const handlers = this.handlers.get(name);
    handlers?.delete(handler);
    if (handlers?.size === 0) this.handlers.delete(name);
  }

  dispatch(name: string, data: Record<string, unknown> = {}): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(data);
  }

  clear(): void {
    this.handlers.clear();
  }
}

interface NativeToolbarLike {
  constructor?: unknown;
  toolbarEl?: HTMLElement;
  toolbarRightEl?: HTMLElement;
  setPageNumber?: unknown;
  setPagesCount?: unknown;
  setPageScale?: unknown;
}

interface NativePdfViewerChildLike {
  toolbar?: NativeToolbarLike;
  file?: unknown;
  pdfViewer?: {
    pdfViewer?: { pdfDocument?: unknown };
  };
}

interface NativePdfViewerComponentLike {
  child?: NativePdfViewerChildLike | null;
  then?(callback: (child: NativePdfViewerChildLike) => void): void;
}

interface NativePdfViewLike {
  viewer?: NativePdfViewerComponentLike;
  file?: unknown;
}

function isElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { nodeType?: unknown; classList?: { contains?: unknown } };
  return candidate.nodeType === 1 && typeof candidate.classList?.contains === "function";
}

function isToolbarConstructor(toolbar: NativeToolbarLike | undefined): NativePdfToolbarConstructor | null {
  if (
    !toolbar ||
    typeof toolbar.constructor !== "function" ||
    !isElement(toolbar.toolbarEl) ||
    !toolbar.toolbarEl.classList.contains("pdf-toolbar") ||
    !isElement(toolbar.toolbarRightEl) ||
    !toolbar.toolbarEl.contains(toolbar.toolbarRightEl) ||
    typeof toolbar.setPageNumber !== "function" ||
    typeof toolbar.setPagesCount !== "function" ||
    typeof toolbar.setPageScale !== "function"
  ) return null;
  return toolbar.constructor as NativePdfToolbarConstructor;
}

function getToolbarConstructor(child: NativePdfViewerChildLike | null | undefined): NativePdfToolbarConstructor | null {
  return isToolbarConstructor(child?.toolbar);
}

function waitForNativeChild(viewer: NativePdfViewerComponentLike, timeoutMs: number): Promise<NativePdfViewerChildLike> {
  if (viewer.child) return Promise.resolve(viewer.child);
  if (typeof viewer.then !== "function") return Promise.reject(new Error("Obsidian PDF viewer child is unavailable"));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out waiting for Obsidian PDF toolbar initialization")), timeoutMs);
    viewer.then?.((child) => {
      window.clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function constructorFromView(view: NativePdfViewLike, timeoutMs: number): Promise<NativePdfToolbarConstructor | null> {
  const viewer = view.viewer;
  if (!viewer) return null;
  const child = await waitForNativeChild(viewer, timeoutMs);
  return getToolbarConstructor(child);
}

/**
 * Obsidian does not export PDFToolbar. Capture its constructor from an existing
 * native child, or briefly initialize a fileless native PDF view on a new tab.
 * The scratch view is detached before the plugin-owned PDF view is registered;
 * it never receives or renders a PDF document. PDFToolbar itself only creates
 * toolbar DOM and dispatches commands; the bridge supplies the viewer state.
 */
export async function captureObsidianPdfToolbarConstructor(app: App): Promise<NativePdfToolbarConstructor> {
  const errors: string[] = [];
  for (const leaf of app.workspace.getLeavesOfType("pdf")) {
    try {
      const constructor = await constructorFromView(leaf.view as NativePdfViewLike, 2_000);
      if (constructor) return constructor;
      errors.push("native PDF view did not expose the expected .pdf-toolbar contract");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const scratchLeaf = app.workspace.getLeaf("tab");
  try {
    await scratchLeaf.setViewState({ type: "pdf", state: {}, active: false });
    const view = scratchLeaf.view as NativePdfViewLike;
    const constructor = await constructorFromView(view, 5_000);
    const child = view.viewer?.child;
    if (view.file || child?.file || child?.pdfViewer?.pdfViewer?.pdfDocument) {
      throw new Error("Fileless Obsidian toolbar bootstrap unexpectedly loaded a PDF document");
    }
    if (!constructor) throw new Error("Obsidian PDFToolbar constructor is incompatible with this host");
    return constructor;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error([
      "Unable to obtain Obsidian's native PDFToolbar constructor.",
      ...errors,
      detail
    ].filter(Boolean).join("; "));
  } finally {
    scratchLeaf.detach();
  }
}

/**
 * Toolbar discovery depends on Obsidian's private PDF view internals. Keep a
 * discovery failure from rejecting the plugin's entire onload; the owned PDF
 * view will surface the captured error if a PDF is opened without the toolbar.
 */
export async function captureObsidianPdfToolbarConstructorResult(app: App): Promise<NativePdfToolbarCaptureResult> {
  try {
    return { constructor: await captureObsidianPdfToolbarConstructor(app), error: null };
  } catch (error) {
    return {
      constructor: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

interface PluginToolbarAction {
  id: string;
  label: string;
  icon: string;
  run(): void;
}

const PLUGIN_TOOLBAR_ACTIONS: Array<Pick<PluginToolbarAction, "id" | "label" | "icon">> = [
  { id: "previous-page", label: "Previous page", icon: "lucide-chevron-left" },
  { id: "next-page", label: "Next page", icon: "lucide-chevron-right" },
  { id: "find", label: "Find in document", icon: "lucide-search" },
  { id: "hand", label: "Hand tool", icon: "lucide-hand" },
  { id: "rotate-counterclockwise", label: "Rotate counterclockwise", icon: "lucide-rotate-ccw" },
  { id: "rotate-clockwise", label: "Rotate clockwise", icon: "lucide-rotate-cw" },
  { id: "presentation", label: "Presentation mode", icon: "lucide-presentation" },
  { id: "print", label: "Print PDF", icon: "lucide-printer" },
  { id: "download", label: "Download PDF", icon: "lucide-download" }
];

/** Owns only the command/state seam around Obsidian's actual PDFToolbar. */
export class ObsidianPdfToolbarBridge {
  readonly toolbar: NativePdfToolbar;
  private readonly eventBus = new ToolbarEventBus();
  private readonly actionGroup: HTMLElement;
  private readonly zoomSelect: HTMLSelectElement;
  private readonly cleanup: Array<() => void> = [];
  private handButton: HTMLElement | null = null;
  private disposed = false;

  constructor(
    app: App,
    host: HTMLElement,
    ToolbarConstructor: NativePdfToolbarConstructor,
    private readonly actions: NativePdfToolbarActions
  ) {
    const state = (): NativePdfToolbarState => this.actions.getState();
    const pdfJsViewer = {
      get currentScaleValue(): string { return state().scaleValue; },
      get currentScale(): number { return state().scale; },
      get spreadMode(): number { return 0; }
    };
    const sidebar = {
      get isOpen(): boolean { return state().sidebarView !== 0; },
      get active(): number { return state().sidebarView; },
      switchView: (view: number): void => {
        this.actions.setSidebarView(view);
        this.syncState();
      }
    };
    const child: NativePdfToolbarChild = {
      file: null,
      pdfViewer: {
        eventBus: this.eventBus,
        pdfSidebar: sidebar,
        pdfOutlineViewer: {
          get outline(): unknown { return state().hasOutline ? [] : null; }
        },
        pdfViewer: pdfJsViewer
      },
      onCSSChange: () => this.actions.adaptToTheme()
    };

    this.eventBus._on("pagenumberchanged", ({ value }) => this.run(() => this.actions.goToPage(Number(value))));
    this.eventBus._on("zoomin", () => this.run(() => this.actions.zoomIn()));
    this.eventBus._on("zoomout", () => this.run(() => this.actions.zoomOut()));
    this.eventBus._on("scalechanged", ({ value }) => this.onScaleChanged(value));
    this.eventBus._on("togglesidebar", () => this.run(() => this.actions.toggleSidebar()));
    this.eventBus._on("switchspreadmode", ({ mode }) => this.actions.unsupportedCommand?.("switchspreadmode", mode));
    this.eventBus._on("currentoutlineitem", () => this.run(() => this.actions.revealCurrentOutlineItem()));

    let toolbar: NativePdfToolbar;
    try {
      toolbar = new ToolbarConstructor(app, host, child);
    } catch (error) {
      for (const element of host.querySelectorAll(".pdf-toolbar")) element.remove();
      this.eventBus.clear();
      throw error;
    }
    if (
      !isElement(toolbar.toolbarEl) ||
      !toolbar.toolbarEl.classList.contains("pdf-toolbar") ||
      !host.contains(toolbar.toolbarEl) ||
      !isElement(toolbar.toolbarRightEl) ||
      !toolbar.toolbarEl.contains(toolbar.toolbarRightEl)
    ) {
      if (isElement(toolbar.toolbarEl)) toolbar.toolbarEl.remove();
      this.eventBus.clear();
      throw new Error("Obsidian PDFToolbar did not create its native .pdf-toolbar and .pdf-toolbar-right elements");
    }
    this.toolbar = toolbar;
    this.zoomSelect = createElement(host.ownerDocument, "select");
    this.zoomSelect.className = "hn-owned-pdf-toolbar-zoom-select";
    this.zoomSelect.setAttribute("aria-label", "Zoom");
    setTooltip(this.zoomSelect, "Zoom level");
    const placeholder = createElement(host.ownerDocument, "option");
    placeholder.textContent = "Zoom…";
    placeholder.value = "";
    placeholder.disabled = true;
    this.zoomSelect.append(placeholder);
    for (const [label, value] of [
      ["Fit page", "page-fit"],
      ["50%", "0.5"], ["75%", "0.75"], ["100%", "1"],
      ["125%", "1.25"], ["150%", "1.5"], ["200%", "2"], ["300%", "3"], ["400%", "4"]
    ] as const) {
      const option = createElement(host.ownerDocument, "option");
      option.textContent = label;
      option.value = value;
      this.zoomSelect.append(option);
    }
    const onZoomChange = (): void => {
      const value = this.zoomSelect.value;
      if (!value) return;
      if (value === "page-fit") this.run(() => this.actions.fitPage());
      else this.run(() => this.actions.setZoom(Number(value)));
    };
    this.zoomSelect.addEventListener("change", onZoomChange);
    this.cleanup.push(() => this.zoomSelect.removeEventListener("change", onZoomChange));
    toolbar.toolbarRightEl.append(this.zoomSelect);
    this.actionGroup = createElement(host.ownerDocument, "div");
    this.actionGroup.className = "hn-owned-pdf-toolbar-actions";
    const spacer = createElement(host.ownerDocument, "div");
    spacer.className = "pdf-toolbar-spacer";
    this.actionGroup.append(spacer);
    toolbar.toolbarRightEl.append(this.actionGroup);
    for (const action of PLUGIN_TOOLBAR_ACTIONS) this.addPluginAction(action);
    this.syncState();
  }

  private addPluginAction(action: Pick<PluginToolbarAction, "id" | "label" | "icon">): void {
    const element = createElement(this.actionGroup.ownerDocument, "div");
    element.className = "clickable-icon hn-owned-pdf-toolbar-action";
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", action.label);
    this.actionGroup.append(element);
    setTooltip(element, action.label);
    setIcon(element, action.icon);
    const invoke = (): void => {
      switch (action.id) {
        case "previous-page": this.run(() => this.actions.previousPage()); break;
        case "next-page": this.run(() => this.actions.nextPage()); break;
        case "find": this.run(() => this.actions.toggleSearch()); break;
        case "hand": this.run(() => this.actions.toggleHandMode()); break;
        case "rotate-counterclockwise": this.run(() => this.actions.rotateCounterclockwise()); break;
        case "rotate-clockwise": this.run(() => this.actions.rotateClockwise()); break;
        case "presentation": this.run(() => this.actions.togglePresentationMode()); break;
        case "print": this.actions.printPdf(); break;
        case "download": this.actions.downloadPdf(); break;
      }
    };
    const onClick = (): void => invoke();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      invoke();
    };
    element.addEventListener("click", onClick);
    element.addEventListener("keydown", onKeyDown);
    this.cleanup.push(
      () => element.removeEventListener("click", onClick),
      () => element.removeEventListener("keydown", onKeyDown)
    );
    if (action.id === "hand") this.handButton = element;
  }

  private onScaleChanged(value: unknown): void {
    this.run(() => {
      if (value === "page-width") this.actions.fitWidth();
      else if (value === "page-height") this.actions.fitHeight();
      else if (value === "page-fit") this.actions.fitPage();
      else if (typeof value === "number" || (typeof value === "string" && value.trim())) {
        const scale = Number(value);
        if (Number.isFinite(scale) && scale > 0) this.actions.setZoom(scale);
      }
    });
  }

  private run(action: () => void): void {
    if (this.disposed) return;
    action();
    this.syncState();
  }

  syncState(): void {
    if (this.disposed) return;
    const state = this.actions.getState();
    this.toolbar.setPagesCount(state.pageCount, false);
    this.toolbar.setPageNumber(state.pageNumber);
    this.toolbar.setPageScale(state.scaleValue, state.scale);
    const scaleValue = state.scaleValue === "page-width" || state.scaleValue === "page-height"
      ? ""
      : state.scaleValue;
    const customZoom = this.zoomSelect.querySelector<HTMLOptionElement>('option[data-custom-zoom="true"]');
    if (customZoom && customZoom.value !== scaleValue) customZoom.remove();
    let option = [...this.zoomSelect.options].find((candidate) => candidate.value === scaleValue);
    if (scaleValue && !option && state.scale > 0) {
      const custom = createElement(this.zoomSelect.ownerDocument, "option");
      custom.dataset.customZoom = "true";
      custom.value = String(state.scale);
      custom.textContent = `${Math.round(state.scale * 100)}%`;
      this.zoomSelect.append(custom);
      option = custom;
    }
    this.zoomSelect.value = option ? scaleValue : "";
    this.eventBus.dispatch("sidebarviewchanged", { view: state.sidebarView });
    this.setHandMode(this.actions.isHandMode());
  }

  setHandMode(active: boolean): void {
    this.handButton?.setAttribute("aria-pressed", String(active));
    this.handButton?.classList.toggle("is-active", active);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.cleanup.splice(0).reverse()) dispose();
    this.eventBus.clear();
    this.actionGroup.remove();
    this.zoomSelect.remove();
    this.toolbar.toolbarEl.remove();
    this.handButton = null;
  }
}

/** Exposed for migration tests without importing Obsidian's runtime classes. */
export function nativePdfToolbarConstructorFromLeaf(leaf: WorkspaceLeaf): NativePdfToolbarConstructor | null {
  const view = leaf.view as NativePdfViewLike;
  return getToolbarConstructor(view.viewer?.child);
}
