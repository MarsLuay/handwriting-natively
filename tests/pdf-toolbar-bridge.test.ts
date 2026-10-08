import { describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import {
  ObsidianPdfToolbarBridge,
  captureObsidianPdfToolbarConstructor,
  nativePdfToolbarConstructorFromLeaf,
  type NativePdfToolbarActions,
  type NativePdfToolbarConstructor,
  type NativePdfToolbarState
} from "../src/integration/ObsidianPdfToolbarBridge";
import { replaceDefaultPdfViewRegistration } from "../src/integration/PdfExtensionRegistration";
import { nativePdfViewStateFromLegacyState } from "../src/integration/PdfViewStateMigration";

interface ToolbarEventBus {
  _on(name: string, handler: (data: Record<string, unknown>) => void): void;
  dispatch(name: string, data?: Record<string, unknown>): void;
}

interface ToolbarChild {
  pdfViewer: {
    eventBus: ToolbarEventBus;
    pdfSidebar: { isOpen: boolean; active: number; switchView(view: number, force?: boolean): void };
    pdfOutlineViewer: { outline: unknown };
    pdfViewer: { currentScaleValue: string; currentScale: number; spreadMode: number };
  };
  onCSSChange(): void;
}

class TestNativePdfToolbar {
  static lastChild: ToolbarChild | null = null;
  readonly toolbarEl: HTMLElement;
  readonly toolbarRightEl: HTMLElement;
  readonly setPageNumber = vi.fn();
  readonly setPagesCount = vi.fn();
  readonly setPageScale = vi.fn();
  readonly reset = vi.fn();

  constructor(_app: App, host: HTMLElement, child: ToolbarChild) {
    TestNativePdfToolbar.lastChild = child;
    const doc = host.ownerDocument;
    this.toolbarEl = doc.createElement("div");
    this.toolbarEl.className = "pdf-toolbar";
    this.toolbarRightEl = doc.createElement("div");
    this.toolbarRightEl.className = "pdf-toolbar-right";
    this.toolbarEl.append(this.toolbarRightEl);
    host.prepend(this.toolbarEl);
    child.pdfViewer.eventBus._on("sidebarviewchanged", () => undefined);
  }
}

const testToolbarConstructor = TestNativePdfToolbar as unknown as NativePdfToolbarConstructor;

function toolbarState(overrides: Partial<NativePdfToolbarState> = {}): NativePdfToolbarState {
  return {
    pageNumber: 3,
    pageCount: 12,
    scale: 1.5,
    scaleValue: "page-width",
    sidebarView: 2,
    hasOutline: true,
    ...overrides
  };
}

function toolbarActions(state: NativePdfToolbarState): NativePdfToolbarActions {
  return {
    getState: () => state,
    goToPage: vi.fn(),
    previousPage: vi.fn(),
    nextPage: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    setZoom: vi.fn(),
    fitWidth: vi.fn(),
    fitHeight: vi.fn(),
    fitPage: vi.fn(),
    toggleSidebar: vi.fn(),
    setSidebarView: vi.fn(),
    revealCurrentOutlineItem: vi.fn(),
    toggleSearch: vi.fn(),
    toggleHandMode: vi.fn(),
    isHandMode: () => true,
    rotateCounterclockwise: vi.fn(),
    rotateClockwise: vi.fn(),
    togglePresentationMode: vi.fn(),
    printPdf: vi.fn(),
    downloadPdf: vi.fn(),
    adaptToTheme: vi.fn(),
    unsupportedCommand: vi.fn()
  };
}

describe("Obsidian PDF toolbar compatibility bridge", () => {
  it("rejects a native toolbar without its right action container and removes the partial toolbar", () => {
    class IncompleteNativePdfToolbar {
      readonly toolbarEl: HTMLElement;
      setPageNumber(): void {}
      setPagesCount(): void {}
      setPageScale(): void {}

      constructor(_app: App, host: HTMLElement) {
        this.toolbarEl = host.ownerDocument.createElement("div");
        this.toolbarEl.className = "pdf-toolbar";
        host.append(this.toolbarEl);
      }
    }
    const host = document.createElement("div");
    document.body.append(host);

    expect(() => new ObsidianPdfToolbarBridge(
      {} as App,
      host,
      IncompleteNativePdfToolbar as unknown as NativePdfToolbarConstructor,
      toolbarActions(toolbarState())
    )).toThrow("native .pdf-toolbar and .pdf-toolbar-right elements");
    expect(host.querySelector(".pdf-toolbar")).toBeNull();
  });

  it("mounts Obsidian's toolbar and routes its events to one adapter state owner", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const state = toolbarState();
    const actions = toolbarActions(state);
    const bridge = new ObsidianPdfToolbarBridge({} as App, host, testToolbarConstructor, actions);
    const toolbar = TestNativePdfToolbar.lastChild?.pdfViewer.eventBus;

    expect(host.querySelector(".pdf-toolbar")).toBe(TestNativePdfToolbar.lastChild && bridge.toolbar.toolbarEl);
    expect(host.querySelector(".hn-owned-pdf-toolbar-actions")).not.toBeNull();
    expect(host.querySelector('select[aria-label="Zoom"]')).not.toBeNull();
    const zoomSelect = host.querySelector("select[aria-label='Zoom']") as HTMLSelectElement;
    expect(zoomSelect.value).toBe("");
    expect([...zoomSelect.options].map((option) => option.value)).not.toContain("auto");
    expect([...zoomSelect.options].map((option) => option.value)).not.toContain("page-height");
    expect(bridge.toolbar.setPagesCount).toHaveBeenCalledWith(12, false);
    expect(bridge.toolbar.setPageNumber).toHaveBeenCalledWith(3);
    expect(bridge.toolbar.setPageScale).toHaveBeenCalledWith("page-width", 1.5);
    expect(host.querySelector('[aria-label="Hand tool"]')?.getAttribute("aria-pressed")).toBe("true");

    toolbar?.dispatch("pagenumberchanged", { value: "7" });
    toolbar?.dispatch("zoomin");
    toolbar?.dispatch("zoomout");
    toolbar?.dispatch("scalechanged", { value: "page-width" });
    toolbar?.dispatch("scalechanged", { value: "page-height" });
    toolbar?.dispatch("scalechanged", { value: "page-fit" });
    toolbar?.dispatch("togglesidebar");
    toolbar?.dispatch("currentoutlineitem");
    toolbar?.dispatch("switchspreadmode", { mode: 1 });
    expect(actions.goToPage).toHaveBeenCalledWith(7);
    expect(actions.zoomIn).toHaveBeenCalledOnce();
    expect(actions.zoomOut).toHaveBeenCalledOnce();
    expect(actions.fitWidth).toHaveBeenCalledOnce();
    expect(actions.fitHeight).toHaveBeenCalledOnce();
    expect(actions.fitPage).toHaveBeenCalledOnce();
    expect(actions.toggleSidebar).toHaveBeenCalledOnce();
    expect(actions.revealCurrentOutlineItem).toHaveBeenCalledOnce();
    expect(actions.unsupportedCommand).toHaveBeenCalledWith("switchspreadmode", 1);

    zoomSelect.value = "2";
    zoomSelect.dispatchEvent(new Event("change"));
    expect(actions.setZoom).toHaveBeenCalledWith(2);

    bridge.destroy();
    expect(host.querySelector(".pdf-toolbar")).toBeNull();
    expect(host.querySelector(".hn-owned-pdf-toolbar-actions")).toBeNull();
    toolbar?.dispatch("zoomin");
    expect(actions.zoomIn).toHaveBeenCalledOnce();
  });

  it("discovers the native constructor across popout document realms", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignDocument = iframe.contentDocument;
    if (!foreignDocument) throw new Error("iframe document unavailable");
    const toolbarEl = foreignDocument.createElement("div");
    toolbarEl.className = "pdf-toolbar";
    const toolbarRightEl = foreignDocument.createElement("div");
    toolbarRightEl.className = "pdf-toolbar-right";
    toolbarEl.append(toolbarRightEl);
    const toolbar = {
      toolbarEl,
      toolbarRightEl,
      setPageNumber: () => undefined,
      setPagesCount: () => undefined,
      setPageScale: () => undefined,
      constructor: testToolbarConstructor
    };
    const leaf = { view: { viewer: { child: { toolbar } } } } as unknown as WorkspaceLeaf;
    expect(nativePdfToolbarConstructorFromLeaf(leaf)).toBe(testToolbarConstructor);
  });

  it("uses a fileless scratch view only when no live native toolbar exists, then detaches it", async () => {
    const toolbarEl = document.createElement("div");
    toolbarEl.className = "pdf-toolbar";
    const toolbarRightEl = document.createElement("div");
    toolbarRightEl.className = "pdf-toolbar-right";
    toolbarEl.append(toolbarRightEl);
    const toolbar = {
      toolbarEl,
      toolbarRightEl,
      setPageNumber: () => undefined,
      setPagesCount: () => undefined,
      setPageScale: () => undefined,
      constructor: testToolbarConstructor
    };
    const scratchLeaf = {
      view: { file: null, viewer: { child: { file: null, toolbar, pdfViewer: { pdfViewer: { pdfDocument: null } } } } },
      setViewState: vi.fn(async () => undefined),
      detach: vi.fn()
    } as unknown as WorkspaceLeaf;
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => scratchLeaf)
    };

    await expect(captureObsidianPdfToolbarConstructor({ workspace } as unknown as App)).resolves.toBe(testToolbarConstructor);
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(scratchLeaf.setViewState).toHaveBeenCalledWith({ type: "pdf", state: {}, active: false });
    expect(scratchLeaf.detach).toHaveBeenCalledOnce();
  });

  it("reuses an existing native constructor without making a scratch view", async () => {
    const toolbarEl = document.createElement("div");
    toolbarEl.className = "pdf-toolbar";
    const toolbarRightEl = document.createElement("div");
    toolbarRightEl.className = "pdf-toolbar-right";
    toolbarEl.append(toolbarRightEl);
    const toolbar = {
      toolbarEl,
      toolbarRightEl,
      setPageNumber: () => undefined,
      setPagesCount: () => undefined,
      setPageScale: () => undefined,
      constructor: testToolbarConstructor
    };
    const leaf = { view: { viewer: { child: { toolbar } } } } as unknown as WorkspaceLeaf;
    const workspace = {
      getLeavesOfType: vi.fn(() => [leaf]),
      getLeaf: vi.fn()
    };

    await expect(captureObsidianPdfToolbarConstructor({ workspace } as unknown as App)).resolves.toBe(testToolbarConstructor);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("rejects a scratch view that unexpectedly loaded a document and still detaches it", async () => {
    const toolbarEl = document.createElement("div");
    toolbarEl.className = "pdf-toolbar";
    const toolbar = {
      toolbarEl,
      setPageNumber: () => undefined,
      setPagesCount: () => undefined,
      setPageScale: () => undefined,
      constructor: testToolbarConstructor
    };
    const scratchLeaf = {
      view: { file: null, viewer: { child: { file: { path: "unexpected.pdf" }, toolbar, pdfViewer: { pdfViewer: { pdfDocument: {} } } } } },
      setViewState: vi.fn(async () => undefined),
      detach: vi.fn()
    } as unknown as WorkspaceLeaf;
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
      getLeaf: vi.fn(() => scratchLeaf)
    };

    await expect(captureObsidianPdfToolbarConstructor({ workspace } as unknown as App)).rejects.toThrow("unexpectedly loaded a PDF document");
    expect(scratchLeaf.detach).toHaveBeenCalledOnce();
  });
});

describe("PDF view ownership and saved state migration", () => {
  it("transfers only the pdf extension to the plugin view and restores its prior owner", () => {
    let owner: string | undefined = "pdf";
    const registry = {
      getTypeByExtension: vi.fn(() => owner),
      unregisterExtensions: vi.fn(() => { owner = undefined; }),
      registerExtensions: vi.fn((_extensions: string[], viewType: string) => { owner = viewType; })
    };
    const restore = replaceDefaultPdfViewRegistration({ viewRegistry: registry } as unknown as App, "handwriting-natively-pdf");
    expect(owner).toBe("handwriting-natively-pdf");
    restore();
    expect(owner).toBe("pdf");
    expect(registry.unregisterExtensions).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a later extension owner during cleanup", () => {
    let owner: string | undefined = "pdf";
    const registry = {
      getTypeByExtension: vi.fn(() => owner),
      unregisterExtensions: vi.fn(() => { owner = undefined; }),
      registerExtensions: vi.fn((_extensions: string[], viewType: string) => { owner = viewType; })
    };
    const restore = replaceDefaultPdfViewRegistration({ viewRegistry: registry } as unknown as App, "handwriting-natively-pdf");
    owner = "other-pdf-plugin";
    restore();
    expect(owner).toBe("other-pdf-plugin");
    expect(registry.unregisterExtensions).toHaveBeenCalledOnce();
  });

  it("migrates native page, zoom, position, and rotation state", () => {
    expect(nativePdfViewStateFromLegacyState({ page: 8, left: 125, top: 940, zoom: "125%", rotation: 90 })).toEqual({
      pageNumber: 8,
      viewport: { scale: 1.25, x: 125, y: 940 },
      scale: 1.25,
      scaleMode: "custom",
      rotation: 90,
      scrollFraction: 0
    });
    expect(nativePdfViewStateFromLegacyState({ page: 2, zoom: "page-height" })?.scaleMode).toBe("fit-height");
    expect(nativePdfViewStateFromLegacyState({})).toBeUndefined();
  });
});
