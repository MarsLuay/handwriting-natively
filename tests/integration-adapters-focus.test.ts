import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPdfAdapter } from "../src/integration/EmbeddedPdfAdapter";
import { ImageViewAdapter } from "../src/integration/ImageViewAdapter";
import { NativePdfViewAdapter } from "../src/integration/NativePdfViewAdapter";
import { OBSIDIAN_DEFAULT_MAX_SCALE } from "../src/integration/PdfZoomBoost";

afterEach(() => { document.body.replaceChildren(); });

function pdfViewer(): HTMLElement {
  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.dataset.scale = "1.5";
  page.dataset.rotation = "90";
  const canvas = document.createElement("canvas");
  canvas.width = 2400;
  canvas.height = 1800;
  page.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 900,
    width: 1200, height: 900, toJSON: () => ({})
  });
  page.append(canvas);
  viewer.append(page);
  return viewer;
}

function compatibleHost(className = "workspace-leaf"): HTMLElement {
  const host = document.createElement("div");
  host.className = className;
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  host.append(toolbar, pdfViewer());
  document.body.append(host);
  return host;
}

describe("PDF adapters", () => {
  it("fails clearly when direct or embedded selectors change", async () => {
    const host = document.createElement("div");
    await expect(NativePdfViewAdapter.attach(host)).rejects.toThrow(/PDF viewer root missing/);
    expect(() => EmbeddedPdfAdapter.attach(host)).toThrow(/embedded PDF adapter incompatible/);
  });

  it("locates page metrics, mounts shared UI, and reverses cleanup", async () => {
    const host = compatibleHost();
    const stateChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, { onViewStateChange: stateChanges });
    expect(adapter.pages()[0]).toMatchObject({ pageNumber: 1, width: 600, height: 800, scale: 1.5, rotation: 90 });
    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    adapter.mountToolbar(toolbar);
    adapter.scrollElement().dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
    adapter.root.dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
  });

  it("reports a viewer reload and releases the reload observer on destroy", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    const previousRoot = adapter.root;
    expect(adapter.viewerGeneration).toBe(1);

    previousRoot.remove();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).toHaveBeenCalledWith("host-dom");
    expect(adapter.viewerGeneration).toBe(2);
    expect(adapter.compatibilityReport().profile).toMatchObject({
      viewerGeneration: 2,
      counters: { viewerReplacements: 1 }
    });
    const callsBeforeDestroy = pageChanges.mock.calls.length;

    adapter.destroy();
    host.append(pdfViewer());
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).toHaveBeenCalledTimes(callsBeforeDestroy);
  });

  it("emits semantic zoom and page lifecycle signals, then cleans them up", async () => {
    vi.useFakeTimers();
    const host = compatibleHost();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const eventBus = {
      on: (name: string, handler: (payload: unknown) => void) => {
        const handlers = listeners.get(name) ?? new Set();
        handlers.add(handler);
        listeners.set(name, handlers);
      },
      off: (name: string, handler: (payload: unknown) => void) => listeners.get(name)?.delete(handler),
      emit: (name: string, payload: unknown = {}) => listeners.get(name)?.forEach((handler) => handler(payload))
    };
    const zoom = vi.fn();
    const lifecycle = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, {
      onZoomChange: zoom,
      onPageLifecycleChange: lifecycle
    }, { privateViewer: { currentScale: 1, eventBus } });

    eventBus.emit("scalechanging", { scale: 1.25 });
    eventBus.emit("pagerendered", { pageNumber: 1 });
    expect(zoom.mock.calls.map(([change]) => change.phase)).toEqual(["begin", "change"]);
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({ kind: "render", viewerGeneration: 1 }));

    vi.advanceTimersByTime(120);
    expect(zoom.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "settled", source: "viewer-event" });
    const callsBeforeDestroy = zoom.mock.calls.length;
    adapter.destroy();
    eventBus.emit("scalechanging", { scale: 1.5 });
    expect(zoom.mock.calls).toHaveLength(callsBeforeDestroy);
    vi.useRealTimers();
  });

  it("keeps page-space zoom alignment and restores the zoom patch on cleanup", async () => {
    const host = compatibleHost();
    const stateChanges = vi.fn();
    let currentScale = 1.5;
    const privateViewer = {
      currentScale,
      updateScale: vi.fn(() => undefined)
    };
    const globals = window as typeof window & {
      pdfjsViewer?: {
        MAX_SCALE: number;
        AppOptions: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
      };
    };
    const previousGlobals = globals.pdfjsViewer;
    const appOptions = {
      get: vi.fn(() => 16 * 1024 * 1024),
      set: vi.fn()
    };
    globals.pdfjsViewer = { MAX_SCALE: OBSIDIAN_DEFAULT_MAX_SCALE, AppOptions: appOptions };

    const adapter = await NativePdfViewAdapter.attach(
      host,
      { onViewStateChange: stateChanges },
      { privateViewer }
    );
    const page = host.querySelector(".page") as HTMLElement;
    const overlay = adapter.mountOverlay(1);
    adapter.setBoostedZoom?.(true);

    currentScale = 2.25;
    privateViewer.currentScale = currentScale;
    page.dataset.scale = String(currentScale);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(adapter.page(1)).toMatchObject({ scale: currentScale });
    expect(overlay.parentElement).toBe(page);
    expect(stateChanges.mock.calls.at(-1)?.[0]).toMatchObject({ scale: currentScale });
    expect(globals.pdfjsViewer.MAX_SCALE).toBeGreaterThan(OBSIDIAN_DEFAULT_MAX_SCALE);

    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(globals.pdfjsViewer.MAX_SCALE).toBe(OBSIDIAN_DEFAULT_MAX_SCALE);
    expect(appOptions.set).toHaveBeenLastCalledWith("maxCanvasPixels", 16 * 1024 * 1024);
    if (previousGlobals) globals.pdfjsViewer = previousGlobals;
    else delete globals.pdfjsViewer;
  });

  it("replaces stale annotation toolbars when mounting again", async () => {
    const host = compatibleHost();
    const adapter = await NativePdfViewAdapter.attach(host);
    const stale = document.createElement("div");
    stale.className = "native-pdf-handwriting-toolbar";
    const fresh = document.createElement("div");
    fresh.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(stale);
    adapter.mountToolbar(fresh);
    const toolbars = host.querySelectorAll(".native-pdf-handwriting-toolbar");
    expect(toolbars).toHaveLength(1);
    expect(toolbars[0]).toBe(fresh);
    adapter.destroy();
  });

  it("ignores selection toolbar mount inside overlay", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-selection-toolbar";
    toolbar.dataset.focusOverlayInternal = "true";
    overlay.append(toolbar);
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("ignores annotation overlay mutations when watching page changes", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    adapter.mountOverlay(1);
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("reports a removed annotation overlay as page-content recovery, not a page remount", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const pageContentMutations = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, {
      onPagesChanged: pageChanges,
      onPageContentMutation: pageContentMutations
    });
    const overlay = adapter.mountOverlay(1);

    overlay.remove();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(pageChanges).not.toHaveBeenCalled();
    expect(pageContentMutations).toHaveBeenCalledOnce();
    adapter.destroy();
  });

  it("ignores PDF.js page-content redraws but reacts when a page node changes", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const pageContentMutations = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, {
      onPagesChanged: pageChanges,
      onPageContentMutation: pageContentMutations
    });
    const page = host.querySelector(".page") as HTMLElement;

    // PDF.js replaces these children repeatedly while scaling; the annotation
    // overlay is still on the same .page and must not remount or blink.
    page.querySelector("canvas")?.remove();
    page.append(document.createElement("canvas"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).not.toHaveBeenCalled();
    expect(pageContentMutations).toHaveBeenCalledOnce();
    expect(pageContentMutations).toHaveBeenLastCalledWith(2);

    const replacement = document.createElement("div");
    replacement.className = "page";
    replacement.dataset.pageNumber = "2";
    host.querySelector(".pdf-viewer")?.append(replacement);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).toHaveBeenCalledOnce();
    expect(pageChanges).toHaveBeenLastCalledWith("pages-dom");
    adapter.destroy();
  });

  it("routes data-scale attribute changes to view state instead of page remounts", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const stateChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, {
      onPagesChanged: pageChanges,
      onViewStateChange: stateChanges
    });
    const page = host.querySelector(".page") as HTMLElement;
    page.dataset.scale = "2";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).not.toHaveBeenCalled();
    expect(stateChanges).toHaveBeenCalled();
    expect(stateChanges.mock.calls.at(-1)?.[1]).toBe("data-scale");
    adapter.destroy();
  });

  it("discovers embedded PDFs", async () => {
    const note = document.createElement("div");
    const embed = document.createElement("div");
    embed.className = "internal-embed";
    embed.setAttribute("src", "paper.pdf");
    embed.append(pdfViewer());
    note.append(embed);
    expect(EmbeddedPdfAdapter.discover(note)).toHaveLength(1);
  });

  it("ignores PDF++ DOM mutations when watching page changes", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = await NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    const page = host.querySelector(".page") as HTMLElement;
    const layer = document.createElement("div");
    layer.className = "pdf-plus-backlink-highlight-layer";
    page.append(layer);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("mounts annotation toolbar after PDF++ color palette", async () => {
    const host = compatibleHost();
    const toolbarHost = host.querySelector(".pdf-toolbar") as HTMLElement;
    const palette = document.createElement("div");
    palette.className = "pdf-plus-color-palette";
    toolbarHost.append(palette);
    const adapter = await NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar);
    expect(palette.nextSibling).toBe(toolbar);
    adapter.destroy();
  });

  it("keeps sidebar rail outside the PDF scroll container", async () => {
    const host = document.createElement("div");
    host.className = "workspace-leaf";
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "pdf-toolbar";
    const scroll = document.createElement("div");
    scroll.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroll, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 600, configurable: true });
    scroll.append(pdfViewer());
    host.append(toolbarHost, scroll);
    document.body.append(host);

    const adapter = await NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar, "left");

    const chrome = host.querySelector(".native-pdf-handwriting-chrome");
    const rail = host.querySelector(".native-pdf-handwriting-rail");
    expect(chrome).not.toBeNull();
    expect(chrome?.classList.contains("is-toolbar-left")).toBe(true);
    expect(rail?.parentElement).toBe(chrome);
    expect(scroll.parentElement).toBe(chrome);
    expect(scroll.contains(rail!)).toBe(false);
    expect(chrome?.contains(adapter.root)).toBe(true);
    adapter.destroy();
  });

  it("pins right sidebar with chrome grid class even when remounting", async () => {
    const host = document.createElement("div");
    host.className = "workspace-leaf";
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "pdf-toolbar";
    const scroll = document.createElement("div");
    scroll.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroll, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 600, configurable: true });
    scroll.append(pdfViewer());
    host.append(toolbarHost, scroll);
    document.body.append(host);

    const adapter = await NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar, "left");
    adapter.mountToolbar(toolbar, "right");

    const chrome = host.querySelector(".native-pdf-handwriting-chrome");
    const rail = host.querySelector(".native-pdf-handwriting-rail");
    expect(chrome?.classList.contains("is-toolbar-right")).toBe(true);
    expect(chrome?.classList.contains("is-toolbar-left")).toBe(false);
    expect(rail?.classList.contains("is-right")).toBe(true);
    expect(toolbar.classList.contains("is-sidebar-right")).toBe(true);
    expect(rail?.parentElement?.lastElementChild).toBe(rail);
    adapter.destroy();
  });

  it("provides one-page image geometry through the generic surface contract", () => {
    const host = document.createElement("div");
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 800 });
    image.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400,
      width: 600, height: 400, toJSON: () => ({})
    });
    host.append(image);
    document.body.append(host);

    const pagesChanged = vi.fn();
    const adapter = ImageViewAdapter.attach(host, { onPagesChanged: pagesChanged });
    expect(adapter.pages()).toMatchObject([{
      pageNumber: 1,
      width: 1200,
      height: 800,
      scale: 0.5,
      rotation: 0,
      coordinateOrigin: "top-left"
    }]);
    expect(adapter.supportsImageExport).toBe(true);
    expect(adapter.imageElement()).toBe(image);
    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    adapter.mountToolbar(toolbar);
    expect(overlay.parentElement).toBe(adapter.root);
    expect(toolbar.isConnected).toBe(true);

    image.dispatchEvent(new Event("load"));
    expect(pagesChanged).toHaveBeenCalledWith("image-load");
    adapter.destroy();
    expect(image.parentElement).toBe(host);
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
  });

  it("does not start sidebar tracking for PDF/text style churn when the rail is right", async () => {
    const host = compatibleHost();
    const adapter = await NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar, "left");
    adapter.mountToolbar(toolbar, "right");

    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const page = host.querySelector(".page") as HTMLElement;
    const textLayer = document.createElement("div");
    page.append(textLayer);
    textLayer.style.width = "120px";
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(debug.mock.calls.some((call) => call[1] === "pdf sidebar rail follow start")).toBe(false);
    debug.mockRestore();
    adapter.destroy();
  });
});
