import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationPageInfo, AnnotationSurface, AnnotationViewState } from "../src/runtime/AnnotationSurface";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { DEFAULT_SETTINGS, type InkStroke, type PdfPoint, type PdfTextAnnotation } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { HN_DEV_PROBE_ACTIVE_KEY, HN_DEV_PROBE_EVENT, type HnDevProbeDiagnostic } from "../src/runtime/DevProbeDiagnostics";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";
import { createDocumentIdentity, hashDocumentContent } from "../src/storage/DocumentIdentity";
import { serializeSidecar, type SidecarSchemaV1 } from "../src/storage/SidecarSchema";
import type { TextStyleChange } from "../src/ui/TextDropdown";

class MemoryFiles implements TextFileAdapter {
  readonly values = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.values.has(path); }
  async read(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, contents: string): Promise<void> { this.values.set(path, contents); }
  async remove(path: string): Promise<void> { this.values.delete(path); }
}

class FakeAdapter implements AnnotationSurface {
  readonly kind = "direct" as const;
  readonly host = document.createElement("div");
  readonly root = document.createElement("div");
  pageElement = document.createElement("div");
  readonly toolbarHost = document.createElement("div");
  readonly focusedPages: number[] = [];
  readonly restoredViewStates: AnnotationViewState[] = [];
  viewState: AnnotationViewState = { pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 };
  destroyed = false;

  constructor() {
    this.pageElement.dataset.pageNumber = "1";
    Object.defineProperty(this.pageElement, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    });
    this.root.append(this.toolbarHost, this.pageElement);
    this.host.append(this.root);
    document.body.append(this.host);
  }

  pages(): AnnotationPageInfo[] {
    return [{ pageNumber: 1, width: 600, height: 800, scale: 1, rotation: 0, element: this.pageElement }];
  }
  page(pageNumber: number): AnnotationPageInfo | undefined {
    return this.pages().find((page) => page.pageNumber === pageNumber);
  }
  getViewState(): AnnotationViewState { return { ...this.viewState }; }
  restoreViewState(state: AnnotationViewState): void {
    this.restoredViewStates.push({ ...state });
    this.viewState = { ...state };
  }
  focusPage(pageNumber: number): boolean { this.focusedPages.push(pageNumber); return Boolean(this.page(pageNumber)); }
  scrollElement(): HTMLElement { return this.root; }
  mountOverlay(pageNumber: number): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = String(pageNumber);
    this.pageElement.append(overlay);
    return overlay;
  }
  replacePageElementKeepingOldPageConnected(): HTMLElement {
    const previous = this.pageElement;
    const replacement = document.createElement("div");
    replacement.dataset.pageNumber = "1";
    Object.defineProperty(replacement, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    });
    this.root.replaceChild(replacement, previous);
    this.host.append(previous);
    this.pageElement = replacement;
    return replacement;
  }
  mountToolbar(toolbar: HTMLElement): void { this.toolbarHost.append(toolbar); }
  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return { errors: [], warnings: [] };
  }
  destroy(): void { this.destroyed = true; this.root.remove(); }
}

class FakePdfSurface extends FakeAdapter {
  readonly supportsPdfExport = true as const;
}

function pointer(
  type: string,
  x: number,
  y: number,
  { pointerType = "pen", pointerId = 7, pressure = 0.6 }: { pointerType?: string; pointerId?: number; pressure?: number } = {}
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    pressure: { value: pressure },
    tiltX: { value: 4 },
    tiltY: { value: 2 },
    width: { value: 1 },
    height: { value: 1 },
    buttons: { value: type === "pointerup" ? 0 : 1 },
    getCoalescedEvents: { value: () => [] }
  });
  return event as unknown as PointerEvent;
}

describe("viewer runtime tracer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("draws a stylus stroke, saves sidecar, exports copy, and cleans up", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const files = new MemoryFiles();
    const adapter = new FakePdfSurface();
    let exported: Uint8Array | undefined;
    let exportedSvg: { name: string; svg: string } | undefined;
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => sourceBytes,
      writeExport: async (_name, bytes) => { exported = bytes; },
      writeSvgExport: async (name, svg) => { exportedSvg = { name, svg }; return `Notes/${name}`; },
      notice: () => undefined
    });

    const nativeSidebarHandle = document.createElement("div");
    nativeSidebarHandle.className = "pdf-sidebar-resizer";
    adapter.host.append(nativeSidebarHandle);
    const sidebarPointer = pointer("pointerdown", 16, 16, { pointerType: "mouse", pointerId: 1 });
    nativeSidebarHandle.dispatchEvent(sidebarPointer);
    // Mouse pan must not take over the native sidebar's resize handle.
    expect(sidebarPointer.defaultPrevented).toBe(false);

    const nativePointer = pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 2 });
    adapter.pageElement.dispatchEvent(nativePointer);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120, { pointerType: "mouse", pointerId: 2 }));
    // Primary mouse input on a PDF page is now owned by the handwriting route.
    expect(nativePointer.defaultPrevented).toBe(true);

    const dragDown = pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 3 });
    const dragMove = pointer("pointermove", 100, 160, { pointerType: "mouse", pointerId: 3 });
    adapter.pageElement.dispatchEvent(dragDown);
    adapter.pageElement.dispatchEvent(dragMove);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 160, { pointerType: "mouse", pointerId: 3 }));
    expect(dragDown.defaultPrevented).toBe(true);
    expect(dragMove.defaultPrevented).toBe(true);

    expect(adapter.toolbarHost.querySelector("[data-control='draw']")).toBeNull();
    expect(adapter.root.classList.contains("native-pdf-handwriting-hide-native-cursor")).toBe(false);

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    const diagnostics: HnDevProbeDiagnostic[] = [];
    const listener = (event: Event) => diagnostics.push((event as CustomEvent<HnDevProbeDiagnostic>).detail);
    window.addEventListener(HN_DEV_PROBE_EVENT, listener);
    (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY] = true;
    try {
      await session.manualSave();
    } finally {
      delete (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY];
      window.removeEventListener(HN_DEV_PROBE_EVENT, listener);
    }

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(3);
    expect(diagnostics.find((diagnostic) => diagnostic.type === "sidecar-persist")).toMatchObject({
      metrics: { outcome: "saved", strokeCount: 3, textCount: 0 }
    });
    expect(diagnostics.find((diagnostic) => diagnostic.type === "manual-save")).toMatchObject({
      metrics: { ok: true, durationMs: expect.any(Number) }
    });

    settings.toolPreferences.activeTool = "eraser";
    settings.toolPreferences.eraser.size = 12;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 130, 150));
    settings.toolPreferences.eraser.size = 1_000;
    adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150));
    await session.manualSave();
    const erasedSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(erasedSidecar![1]).pages[0].strokes).toHaveLength(4);

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='undo']")?.click();
    await session.manualSave();
    const restoredSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(restoredSidecar![1]).pages[0].strokes).toHaveLength(3);

    settings.toolPreferences.eraser.size = 12;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointercancel", 130, 150));
    await session.manualSave();
    const cancelledSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(cancelledSidecar![1]).pages[0].strokes).toHaveLength(3);

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='redo']")?.click();
    await session.manualSave();
    const redoneSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(redoneSidecar![1]).pages[0].strokes).toHaveLength(4);

    await session.exportCopy();
    expect(exported).toBeDefined();
    await expect(PDFDocument.load(exported!)).resolves.toBeDefined();
    session.applySelectionShortcut("selectAll");
    expect(session.canExportSelectedInkSvg()).toBe(true);
    await session.exportSelectedInkSvg();
    expect(exportedSvg?.name).toBe("example_selected_ink.svg");
    expect(exportedSvg?.svg).toContain("Selected PDF ink");
    expect(exportedSvg?.svg).toContain("data-stroke-id=");
    expect([...sourceBytes]).toEqual([...await source.save()]);

    await expect(session.destroy()).resolves.toBe(true);
    expect(adapter.destroyed).toBe(true);
  });

  it("correlates stroke creation and model insertion while preserving missing pen identity", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.png",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readDocument: async () => new Uint8Array([1, 2, 3]),
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: { write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} }) }
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 17 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 17 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 17 }));

    const lifecycle = writes.filter((entry) => entry.event === "stroke lifecycle");
    const phases = lifecycle.map((entry) => entry.payload.phase);
    expect(phases).toEqual(expect.arrayContaining([
      "stroke-route-start",
      "stroke-create",
      "stroke-model-insert",
      "stroke-pointerup",
      "stroke-commit",
      "stroke-first-render",
      "stroke-render-ack"
    ]));
    const strokeIds = new Set(lifecycle.map((entry) => entry.payload.strokeId));
    expect(strokeIds.size).toBe(1);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-create", penContactId: null }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-model-insert", modelPresent: true, penContactId: null }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-commit", modelPresent: true, penContactId: null }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-first-render", renderExecuted: true, expectedVisible: true }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-render-ack", renderExecuted: true }) })
    ]));

    const committedCanvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(committedCanvas).not.toBeNull();
    committedCanvas!.width = 1;
    session.refresh("canvas-rebuild");
    const internal = session as unknown as {
      renderPage(pageNumber: number, stats?: unknown, reason?: string): boolean;
      surfaces: Map<number, { canvasGeneration: number; paintGeneration: number }>;
      ink: { page(pageNumber: number): readonly InkStroke[] };
      recordStrokeRenderOmissions(
        surface: { canvasGeneration: number; paintGeneration: number },
        storedStrokes: readonly InkStroke[],
        visibleStrokes: readonly InkStroke[],
        reason: string,
        expectedVisible?: boolean
      ): void;
      strokeRenderStates: Map<string, { firstRendered: boolean; lastCanvasGeneration: number | null }>;
      scheduleStrokeRenderVerification(strokeId: string, page: number): void;
    };
    internal.renderPage(1, undefined, "zoom-settle");
    const refreshedLifecycle = writes.filter((entry) => entry.event === "stroke lifecycle");
    expect(refreshedLifecycle.map((entry) => entry.payload.phase)).toEqual(expect.arrayContaining([
      "stroke-canvas-rebuild-before",
      "stroke-canvas-rebuild-after",
      "stroke-vector-repaint-included",
      "stroke-zoom-settle-check"
    ]));
    expect(refreshedLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-vector-repaint-included", renderExecuted: true }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-zoom-settle-check", includedInLatestPaint: true }) })
    ]));

    const strokeId = String([...strokeIds][0]);
    const surface = internal.surfaces.get(1)!;
    const committedStroke = internal.ink.page(1)[0]!;
    internal.recordStrokeRenderOmissions(surface, [committedStroke], [], "test-omission");
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "stroke lifecycle",
        payload: expect.objectContaining({
          phase: "stroke-vector-repaint-missing",
          strokeId,
          expectedVisible: true,
          includedInLatestPaint: false
        })
      })
    ]));

    internal.strokeRenderStates.get(strokeId)!.lastCanvasGeneration = 0;
    vi.useFakeTimers();
    internal.scheduleStrokeRenderVerification(strokeId, 1);
    vi.advanceTimersByTime(180);
    vi.useRealTimers();
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "stroke lifecycle",
        payload: expect.objectContaining({
          phase: "stroke-lifecycle-regression",
          strokeId,
          reason: "not-redrawn-after-canvas-rebuild",
          modelPresent: true
        })
      })
    ]));

    await expect(session.destroy()).resolves.toBe(true);
  });

  it("correlates stroke serialization, persistence, and reload restoration", async () => {
    const files = new MemoryFiles();
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const createSession = (adapter: FakeAdapter) => ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.png",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readDocument: async () => new Uint8Array([1, 2, 3]),
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: { write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} }) }
    });

    const adapter = new FakeAdapter();
    const session = await createSession(adapter);
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 401 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 401 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 401 }));
    await session.manualSave();

    const savedLifecycle = writes.filter((entry) => entry.event === "stroke lifecycle");
    expect(savedLifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-serialization-included", serializationIncluded: true, store: "recovery" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-serialization-included", serializationIncluded: true, store: "sidecar" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-persisted", persisted: true, serializationIncluded: true }) })
    ]));

    const savedSidecar = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]) as SidecarSchemaV1;
    const internal = session as unknown as {
      recordStrokeSerialization(snapshot: SidecarSchemaV1, store: "recovery" | "sidecar", reason: string): void;
    };
    internal.recordStrokeSerialization({
      ...savedSidecar,
      updatedAt: new Date(Date.parse(savedSidecar.updatedAt) + 1).toISOString(),
      pages: savedSidecar.pages.map((page) => ({ ...page, strokes: [] }))
    }, "sidecar", "test-omission");
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "stroke lifecycle",
        payload: expect.objectContaining({ phase: "stroke-serialization-omitted", serializationIncluded: false, reason: "missing-from-snapshot" })
      })
    ]));

    const reloaded = await createSession(new FakeAdapter());
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-reload-restoration", restored: true, source: "sidecar", modelPresent: true }) })
    ]));

    await expect(reloaded.destroy()).resolves.toBe(true);
    await expect(session.destroy()).resolves.toBe(true);
  });

  it("emits bounded delayed pixel presence evidence without scanning full canvases", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        if (reads++ > 0) data[3] = 255;
        return { data };
      })
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    const files = new MemoryFiles();
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/pixels.png",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readDocument: async () => new Uint8Array([4, 5, 6]),
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: { write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} }) }
    });
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 501 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 501 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 501 }));
    await vi.advanceTimersByTimeAsync(220);

    const pixelEvents = writes.filter((entry) => entry.event === "stroke lifecycle" && String(entry.payload.phase).startsWith("stroke-pixel-"));
    expect(pixelEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-pixel-region-pre", samplePhase: "before" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-pixel-region-post", samplePhase: "after" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-pixel-presence-check", verification: "delayed", pixelVisibilityVerified: true }) })
    ]));
    for (const event of pixelEvents) {
      expect(event.payload.affectedRegionWidth).toBeLessThanOrEqual(192);
      expect(event.payload.affectedRegionHeight).toBeLessThanOrEqual(192);
      expect(event.payload).not.toHaveProperty("imageData");
    }
    await expect(session.destroy()).resolves.toBe(true);
  });

  it("fails closed when pixel evidence cannot be sampled", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), drawImage: vi.fn(),
      getImageData: vi.fn(() => { throw new Error("pixel read unavailable"); })
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    const files = new MemoryFiles();
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/pixels-unavailable.png",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readDocument: async () => new Uint8Array([7, 8, 9]),
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: { write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} }) }
    });
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 601 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 601 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 601 }));
    const unavailable = writes.filter((entry) => entry.event === "stroke lifecycle" && String(entry.payload.phase).startsWith("stroke-pixel-") && entry.payload.pixelVisibilityVerified === false);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-pixel-region-pre", pixelEvidenceAvailable: false }) }),
      expect.objectContaining({ payload: expect.objectContaining({ phase: "stroke-pixel-region-post", pixelVisibilityVerified: false }) })
    ]));
    await expect(session.destroy()).resolves.toBe(true);
  });

  it("runs the shared session against a non-PDF surface without PDF extensions", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.png",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readDocument: async () => new Uint8Array([1, 2, 3]),
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    const saved = JSON.parse(sidecar![1]).pages[0].strokes;
    expect(saved).toHaveLength(1);
    expect(saved[0].points.length).toBeGreaterThanOrEqual(2);
    await expect(session.destroy()).resolves.toBe(true);
    expect(adapter.destroyed).toBe(true);
  });

  it("pencil-first: pen annotates without Draw toggle; touch never inks", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const adapter = new FakeAdapter();
    Object.assign(adapter.pageElement, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/pencil-first.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => sourceBytes,
      writeExport: async () => undefined,
      notice: () => undefined
    });
    expect(adapter.toolbarHost.querySelector("[data-control='draw']")).toBeNull();

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);

    const before = JSON.parse(sidecar![1]).pages[0].strokes.length;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 200, 220, { pointerType: "touch", pointerId: 3, pressure: 0.5 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 230, 250, { pointerType: "touch", pointerId: 3, pressure: 0.5 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 260, 280, { pointerType: "touch", pointerId: 3, pressure: 0 }));
    await session.manualSave();
    const after = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes.length;
    expect(after).toBe(before);

    await session.destroy();
  });

  it("position-gated mouse drawing wins on PDF pages regardless of empty-space mode", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const adapter = new FakeAdapter();
    Object.assign(adapter.pageElement, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.mouseInputMode = "pan";
    settings.mouseDragScroll = true;
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/mouse-policy.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => sourceBytes,
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 1 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 1 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 1 }));
    await session.manualSave();
    let sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(sidecar ? JSON.parse(sidecar[1]).pages?.[0]?.strokes ?? [] : []).toHaveLength(1);

    settings.mouseInputMode = "annotate";
    settings.mouseDragScroll = false;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 2 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 2 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 2 }));
    await session.manualSave();
    sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(2);
    await session.destroy();
  });

  it("routes an in-view MockTab wheel pan to its PDF when another HN session claimed the document event", async () => {
    const files = new MemoryFiles();
    const inactiveAdapter = new FakeAdapter();
    const inactiveSession = await ViewerInkSession.create({
      adapter: inactiveAdapter,
      documentPath: "Notes/inactive.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const adapter = new FakeAdapter();
    adapter.root.className = "pdf-viewer-container";
    let scrollTop = 0;
    Object.defineProperties(adapter.root, {
      scrollHeight: { value: 2_000, configurable: true },
      clientHeight: { value: 800, configurable: true },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
        configurable: true
      }
    });
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 24,
      clientX: 100,
      clientY: 120
    });
    adapter.pageElement.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(scrollTop).toBe(24);
    expect(logs).toContainEqual({
      event: "pointer seen",
      payload: expect.objectContaining({ source: "wheel-pan", phase: "in-view", deltaY: 24, changed: true })
    });

    await session.destroy();
    await inactiveSession.destroy();
  });

  it("leaves a native PDF sidebar wheel event for the sidebar", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    adapter.root.className = "pdf-viewer-container";
    let scrollTop = 0;
    Object.defineProperties(adapter.root, {
      scrollHeight: { value: 2_000, configurable: true },
      clientHeight: { value: 800, configurable: true },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
        configurable: true
      }
    });
    const sidebar = document.createElement("div");
    sidebar.className = "pdf-sidebar-container";
    adapter.root.append(sidebar);
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 24,
      clientX: 20,
      clientY: 120
    });
    sidebar.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
    expect(scrollTop).toBe(0);
    expect(logs).toContainEqual({
      event: "pointer seen",
      payload: expect.objectContaining({ source: "wheel-pan", phase: "sidebar", deltaY: 24 })
    });

    await session.destroy();
  });

  it("opens with empty annotations after quarantining malformed sidecar JSON", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations", {
      now: () => new Date("2026-02-01T03:04:05.678Z")
    });
    const documentId = createDocumentIdentity({
      vaultPath: "Notes/example.pdf",
      contentHash: hashDocumentContent(sourceBytes)
    }).id;
    const sourcePath = sidecars.pathFor(documentId);
    files.values.set(sourcePath, "{");
    const notices: string[] = [];
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];

    const session = await ViewerInkSession.create({
      adapter: new FakeAdapter(),
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars,
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => sourceBytes,
      writeExport: async () => undefined,
      notice: (message) => notices.push(message),
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });

    const quarantinePath = `${sourcePath}.corrupt-20260201T030405678Z`;
    expect(notices).toEqual([`Malformed annotation data moved to ${quarantinePath}. Opened with empty annotations.`]);
    expect(await files.read(quarantinePath)).toBe("{");
    expect(files.values.has(sourcePath)).toBe(false);
    expect(logs).toContainEqual({
      event: "sidecar quarantined",
      payload: expect.objectContaining({
        documentId,
        store: "sidecar",
        sourcePath,
        quarantinePath,
        error: expect.any(String)
      })
    });
    await session.destroy({ silent: true });
  });

  it("remounts a router when a replacement PDF page leaves its prior overlay connected", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, { overlay: HTMLElement }>;
      reattachSurface(surface: { overlay: HTMLElement }, page: PdfPageInfo): boolean;
      tryReattachDisconnectedSurfaces(pages: PdfPageInfo[]): boolean;
    };

    try {
      const replacement = adapter.replacePageElementKeepingOldPageConnected();
      const current = adapter.pages()[0]!;
      const surface = internal.surfaces.get(1)!;

      expect(internal.reattachSurface(surface, current)).toBe(false);
      expect(internal.tryReattachDisconnectedSurfaces([current])).toBe(true);
      expect(replacement.contains(surface.overlay)).toBe(true);

      const nativeTextLayer = document.createElement("div");
      nativeTextLayer.className = "textLayer";
      replacement.append(nativeTextLayer);
      const down = pointer("pointerdown", 100, 120);
      nativeTextLayer.dispatchEvent(down);
      nativeTextLayer.dispatchEvent(pointer("pointermove", 130, 150));
      nativeTextLayer.dispatchEvent(pointer("pointerup", 160, 180));

      expect(down.defaultPrevented).toBe(true);
      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      await session.destroy();
    }
  });

  it("rebinds page router when listeners were aborted but bindsTo still matches", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const canvas = document.createElement("canvas");
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    wrap.append(canvas);
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        overlay: HTMLElement;
        page: PdfPageInfo;
        router: { destroy(): void; bindsTo(el: HTMLElement): boolean; isAlive(): boolean } | null;
      }>;
      ensurePageRouter(surface: unknown, options?: { force?: boolean; reason?: string }): void;
    };

    try {
      const surface = internal.surfaces.get(1)!;
      surface.router!.destroy();
      expect(surface.router!.bindsTo(adapter.pageElement)).toBe(true);
      expect(surface.router!.isAlive()).toBe(false);

      internal.ensurePageRouter(surface, { reason: "test-zombie" });
      expect(surface.router!.isAlive()).toBe(true);
      expect(surface.router!.bindsTo(adapter.pageElement)).toBe(true);

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 91 });
      canvas.dispatchEvent(down);
      canvas.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 91 }));
      expect(down.defaultPrevented).toBe(true);
    } finally {
      await session.destroy();
    }
  });

  it("remounts overlay+router on content mutation when live page element drifts", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    wrap.append(document.createElement("canvas"));
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        overlay: HTMLElement;
        page: PdfPageInfo;
        router: { bindsTo(el: HTMLElement): boolean; isAlive(): boolean } | null;
      }>;
      onPdfPageContentMutation(recordCount: number): void;
    };

    try {
      const previous = adapter.pageElement;
      const replacement = adapter.replacePageElementKeepingOldPageConnected();
      const liveWrap = document.createElement("div");
      liveWrap.className = "canvasWrapper";
      const liveCanvas = document.createElement("canvas");
      liveWrap.append(liveCanvas);
      replacement.append(liveWrap);

      // Overlay still connected under the predecessor — mutation must remount.
      expect(previous.contains(internal.surfaces.get(1)!.overlay)).toBe(true);
      session.onPdfPageContentMutation(1);

      const surface = internal.surfaces.get(1)!;
      expect(surface.page.element).toBe(replacement);
      expect(replacement.contains(surface.overlay)).toBe(true);
      expect(surface.router?.bindsTo(replacement)).toBe(true);
      expect(surface.router?.isAlive()).toBe(true);

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 44 });
      liveCanvas.dispatchEvent(down);
      liveCanvas.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 44 }));
      expect(down.defaultPrevented).toBe(true);
    } finally {
      await session.destroy();
    }
  });

  it("force-rebinds page router after zoom settle even when bindsTo+isAlive match", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    wrap.append(document.createElement("canvas"));
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        page: PdfPageInfo;
        router: { bindsTo(el: HTMLElement): boolean; isAlive(): boolean } | null;
      }>;
      ensurePageRouter(surface: unknown, options?: { force?: boolean; reason?: string }): void;
    };

    try {
      const surface = internal.surfaces.get(1)!;
      const before = surface.router;
      expect(before?.bindsTo(adapter.pageElement)).toBe(true);
      expect(before?.isAlive()).toBe(true);

      internal.ensurePageRouter(surface, { force: true, reason: "test-zoom-force" });
      expect(surface.router).not.toBe(before);
      expect(surface.router?.bindsTo(adapter.pageElement)).toBe(true);
      expect(surface.router?.isAlive()).toBe(true);
    } finally {
      await session.destroy();
    }
  });

  it("reclaims stylus input after touch/UI activity and a rebind loses the prior terminal", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        builder: object | undefined;
        router: { destroy(): void } | null;
      }>;
      ensurePageRouter(surface: unknown, options?: { force?: boolean; reason?: string }): void;
    };

    try {
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "touch", pointerId: 201 }));
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 140, 160, { pointerType: "touch", pointerId: 202 }));
      adapter.pageElement.dispatchEvent(pointer("pointerup", 140, 160, { pointerType: "touch", pointerId: 202 }));
      adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120, { pointerType: "touch", pointerId: 201 }));

      const surface = internal.surfaces.get(1)!;
      const firstDown = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 301 });
      adapter.pageElement.dispatchEvent(firstDown);
      const firstBuilder = surface.builder;
      expect(firstBuilder).toBeDefined();

      // Simulate a zoom/page handoff that tears down the listener before the
      // platform delivers the old stylus terminal event.
      surface.router!.destroy();
      internal.ensurePageRouter(surface, { reason: "test-missed-terminal-rebind" });

      const secondDown = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 301 });
      adapter.pageElement.dispatchEvent(secondDown);
      expect(secondDown.defaultPrevented).toBe(true);
      expect(surface.builder).not.toBe(firstBuilder);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 301 }));
    } finally {
      await session.destroy({ silent: true, alreadyPersisted: true });
    }
  });

  it("adopts a routed stylus pointer across a mobile router rebind", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        builder: object | undefined;
        router: { destroy(): void } | null;
      }>;
      ensurePageRouter(surface: unknown, options?: { force?: boolean; reason?: string }): void;
    };

    try {
      const surface = internal.surfaces.get(1)!;
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 303 }));
      adapter.pageElement.dispatchEvent(pointer("pointermove", 120, 140, { pointerType: "pen", pointerId: 303 }));
      const builderBefore = surface.builder;
      expect(builderBefore).toBeDefined();

      surface.router!.destroy();
      internal.ensurePageRouter(surface, { reason: "test-mobile-scroll-rebind" });
      adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 160, { pointerType: "pen", pointerId: 303 }));
      expect(surface.builder).toBe(builderBefore);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "pen", pointerId: 303 }));
      expect(surface.builder).toBeUndefined();

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      await session.destroy({ silent: true, alreadyPersisted: true });
    }
  });

  it("document capture remounts router onto the hit page shell when duplicates diverge", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    adapter.pageElement.className = "page";
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    wrap.append(document.createElement("canvas"));
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        overlay: HTMLElement;
        page: PdfPageInfo;
        router: {
          bindsTo(el: HTMLElement): boolean;
          isAlive(): boolean;
          generation: number;
        } | null;
      }>;
    };

    try {
      const bound = adapter.pageElement;
      const hitShell = document.createElement("div");
      hitShell.className = "page";
      hitShell.dataset.pageNumber = "1";
      Object.defineProperty(hitShell, "getBoundingClientRect", {
        value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
      });
      const hitWrap = document.createElement("div");
      hitWrap.className = "canvasWrapper";
      const hitCanvas = document.createElement("canvas");
      hitWrap.append(hitCanvas);
      hitShell.append(hitWrap);
      // Keep the locator/adapter bound shell, but put the hittable duplicate under host.
      adapter.host.append(hitShell);

      const before = internal.surfaces.get(1)!.router;
      expect(before?.bindsTo(bound)).toBe(true);

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 77 });
      hitCanvas.dispatchEvent(down);

      const surface = internal.surfaces.get(1)!;
      expect(surface.page.element).toBe(hitShell);
      expect(surface.router?.bindsTo(hitShell)).toBe(true);
      expect(surface.router?.isAlive()).toBe(true);
      expect(surface.router).not.toBe(before);
      expect(down.defaultPrevented).toBe(true);
      expect(hitShell.contains(surface.overlay)).toBe(true);
    } finally {
      await session.destroy();
    }
  });

  it("document capture sync-routes pen when page capture is blocked but binds/alive look healthy", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    adapter.pageElement.className = "page";
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    wrap.append(canvas);
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        page: PdfPageInfo;
        router: { destroy(): void; bindsTo(el: HTMLElement): boolean; isAlive(): boolean } | null;
      }>;
      ensurePageRouter(surface: unknown, options?: { force?: boolean; reason?: string }): void;
    };

    try {
      const surface = internal.surfaces.get(1)!;
      // Kill current listeners, install a capture stopper, then rebind so the
      // page router registers AFTER the stopper (descent never reaches it).
      surface.router!.destroy();
      surface.router = null;
      adapter.pageElement.addEventListener("pointerdown", (event) => {
        event.stopImmediatePropagation();
      }, { capture: true });
      internal.ensurePageRouter(surface, { force: true, reason: "test-blocked-page-capture" });
      const rebound = internal.surfaces.get(1)!;
      expect(rebound.router?.bindsTo(adapter.pageElement)).toBe(true);
      expect(rebound.router?.isAlive()).toBe(true);

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 88 });
      canvas.dispatchEvent(down);
      canvas.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 88 }));
      expect(down.defaultPrevented).toBe(true);

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      await session.destroy();
    }
  });

  it("document capture routes pen when hit page lacks data-page-number but matches surface shell", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    adapter.pageElement.className = "page";
    delete adapter.pageElement.dataset.pageNumber;
    adapter.pageElement.removeAttribute("data-page-number");
    const wrap = document.createElement("div");
    wrap.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    wrap.append(canvas);
    adapter.pageElement.append(wrap);

    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    try {
      // Simulate loadingIcon shell: attribute stripped after surface mount.
      delete adapter.pageElement.dataset.pageNumber;
      adapter.pageElement.removeAttribute("data-page-number");
      adapter.pageElement.classList.add("loadingIcon");

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 89 });
      canvas.dispatchEvent(down);
      canvas.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 89 }));
      expect(down.defaultPrevented).toBe(true);

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      await session.destroy();
    }
  });

  it("recovers pen input from visible-page geometry without hijacking a real UI target", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });
    const drawer = document.createElement("div");
    drawer.className = "workspace-drawer mod-left is-shown";
    const uiTarget = document.createElement("div");
    uiTarget.className = "setting-item";
    drawer.append(uiTarget);
    document.body.append(drawer);
    const originalElementFromPoint = document.elementFromPoint;
    const originalElementsFromPoint = document.elementsFromPoint;

    try {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => adapter.pageElement
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [adapter.pageElement]
      });

      const recovered = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 91 });
      uiTarget.dispatchEvent(recovered);
      expect(recovered.defaultPrevented).toBe(true);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 91 }));

      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => uiTarget
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [uiTarget]
      });
      const nativeUi = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 92 });
      uiTarget.dispatchEvent(nativeUi);
      expect(nativeUi.defaultPrevented).toBe(false);
      expect(logs).not.toContainEqual(expect.objectContaining({
        event: "ink input anomaly",
        payload: expect.objectContaining({ reason: "pen-over-visible-page-not-routed" })
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        event: "page router",
        payload: expect.objectContaining({
          phase: "skip",
          reason: "ui-occluded",
          pageOccludedByUi: true,
          firstInteractiveHit: expect.objectContaining({ classes: expect.arrayContaining(["setting-item"]) })
        })
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        event: "ink input anomaly",
        payload: expect.objectContaining({
          reason: "pen-occlusion-anomaly",
          pageOccludedByUi: true,
          occluderShell: expect.objectContaining({ kind: "drawer", active: true })
        })
      }));

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      if (originalElementFromPoint) document.elementFromPoint = originalElementFromPoint;
      else delete (document as Partial<Document>).elementFromPoint;
      if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
      else delete (document as Partial<Document>).elementsFromPoint;
      drawer.remove();
      await session.destroy();
    }
  });

  it("draws through a closed drawer leftover that still appears in the hit stack", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });
    // Closed mobile drawer: still in DOM, no is-shown / is-pinned.
    const drawer = document.createElement("div");
    drawer.className = "workspace-drawer mod-left";
    const staleHit = document.createElement("div");
    staleHit.className = "workspace-drawer-header";
    drawer.append(staleHit);
    document.body.append(drawer);
    const originalElementFromPoint = document.elementFromPoint;
    const originalElementsFromPoint = document.elementsFromPoint;

    try {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => staleHit
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [staleHit, adapter.pageElement]
      });

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 1171 });
      staleHit.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 1171 }));

      expect(logs).not.toContainEqual(expect.objectContaining({
        event: "page router",
        payload: expect.objectContaining({ reason: "ui-occluded" })
      }));

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      if (originalElementFromPoint) document.elementFromPoint = originalElementFromPoint;
      else delete (document as Partial<Document>).elementFromPoint;
      if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
      else delete (document as Partial<Document>).elementsFromPoint;
      drawer.remove();
      await session.destroy();
    }
  });

  it("does not treat bare .vertical-tab-content as a pen occluder", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });
    const layout = document.createElement("div");
    layout.className = "vertical-tab-content";
    document.body.append(layout);
    const originalElementFromPoint = document.elementFromPoint;
    const originalElementsFromPoint = document.elementsFromPoint;

    try {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => layout
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [layout, adapter.pageElement]
      });

      const down = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 1172 });
      layout.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 1172 }));

      expect(logs).not.toContainEqual(expect.objectContaining({
        event: "page router",
        payload: expect.objectContaining({ reason: "ui-occluded" })
      }));

      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      if (originalElementFromPoint) document.elementFromPoint = originalElementFromPoint;
      else delete (document as Partial<Document>).elementFromPoint;
      if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
      else delete (document as Partial<Document>).elementsFromPoint;
      layout.remove();
      await session.destroy();
    }
  });

  it("keeps occluding an open settings modal after open/close churn", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      debugEnabled: () => true,
      vaultLog: {
        write: (_level, event, payload = {}) => logs.push({ event, payload })
      }
    });
    const modal = document.createElement("div");
    modal.className = "modal-container";
    const modalBackdrop = document.createElement("div");
    modalBackdrop.className = "modal-bg";
    const modalBody = document.createElement("div");
    modalBody.className = "modal";
    const tabContent = document.createElement("div");
    tabContent.className = "vertical-tab-content";
    let setting = document.createElement("div");
    setting.className = "setting-item-description";
    tabContent.append(setting);
    modalBody.append(tabContent);
    modalBackdrop.append(modalBody);
    modal.append(modalBackdrop);
    document.body.append(modal);
    const originalElementFromPoint = document.elementFromPoint;
    const originalElementsFromPoint = document.elementsFromPoint;

    try {
      // Simulate Settings open → close → reopen. Each logical opening emits once.
      modal.classList.add("mod-open");
      await Promise.resolve();
      modal.remove();
      await Promise.resolve();
      document.body.append(modal);
      await Promise.resolve();
      const modalOpens = logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "open" && payload.surfaceKind === "modal");
      expect(modalOpens).toHaveLength(2);
      expect(modalOpens[0]?.payload).toMatchObject({ nestedShellCount: 3 });
      expect(modalOpens[1]?.payload.surfaceId).toBe(modalOpens[0]?.payload.surfaceId);
      const modalSurfaceId = modalOpens[0]?.payload.surfaceId;

      const menu = document.createElement("div");
      menu.className = "menu";
      modal.append(menu);
      await Promise.resolve();
      const stackedModal = document.createElement("div");
      stackedModal.className = "modal-container mod-open";
      const stackedModalBody = document.createElement("div");
      stackedModalBody.className = "modal";
      stackedModal.append(stackedModalBody);
      document.body.append(stackedModal);
      await Promise.resolve();
      const surfaceOpens = logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "open");
      expect(surfaceOpens).toHaveLength(4);
      expect(surfaceOpens.map(({ payload }) => payload.surfaceKind)).toEqual(expect.arrayContaining(["modal", "menu"]));
      const modalSurfaceIds = surfaceOpens
        .filter(({ payload }) => payload.surfaceKind === "modal")
        .map(({ payload }) => payload.surfaceId);
      expect(new Set(modalSurfaceIds).size).toBe(2);

      const replacement = document.createElement("div");
      replacement.className = "setting-item-description";
      setting.replaceWith(replacement);
      setting = replacement;
      await Promise.resolve();
      expect(logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "open")).toHaveLength(4);

      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => setting
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [setting, tabContent, modal]
      });

      const blocked = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 1173 });
      setting.dispatchEvent(blocked);
      expect(blocked.defaultPrevented).toBe(false);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "page router",
        payload: expect.objectContaining({ reason: "ui-occluded", pageOccludedByUi: true })
      }));

      // Close menu and modal: remove them from the DOM so pen can draw again.
      menu.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const menuCloses = logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "close" && payload.kind === "menu");
      expect(menuCloses).toHaveLength(1);
      stackedModal.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const stackedModalCloses = logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "close" && payload.kind === "modal");
      expect(stackedModalCloses).toHaveLength(2);
      expect(stackedModalCloses.find(({ payload }) => payload.surfaceId !== modalSurfaceId)?.payload.surfaceId).not.toBe(modalSurfaceId);
      modal.remove();
      // Let the bounded UI-shell observer arm the post-Settings trace.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const modalCloses = logs.filter(({ event, payload }) => event === "ui surface" && payload.phase === "close" && payload.kind === "modal");
      expect(modalCloses).toHaveLength(3);
      expect(modalCloses.at(-1)?.payload.surfaceId).toBe(modalSurfaceId);
      expect(logs).toContainEqual(expect.objectContaining({
        event: "post-ui input probe",
        payload: expect.objectContaining({ phase: "armed", transition: expect.objectContaining({ reason: "removed" }) })
      }));
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => adapter.pageElement
      });
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [adapter.pageElement]
      });
      const draw = pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 1174 });
      adapter.pageElement.dispatchEvent(draw);
      expect(draw.defaultPrevented).toBe(true);
      adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "pen", pointerId: 1174 }));

      expect(logs).toContainEqual(expect.objectContaining({
        event: "post-ui input probe",
        payload: expect.objectContaining({ phase: "terminal", outcome: "post-ui-pen-success", contact: expect.objectContaining({ pointerType: "pen" }) })
      }));
      await session.manualSave();
      expect(logs).toContainEqual(expect.objectContaining({
        event: "post-ui input probe",
        payload: expect.objectContaining({ phase: "persisted", persisted: true, persistedStrokePoints: expect.any(Number) })
      }));
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    } finally {
      if (originalElementFromPoint) document.elementFromPoint = originalElementFromPoint;
      else delete (document as Partial<Document>).elementFromPoint;
      if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
      else delete (document as Partial<Document>).elementsFromPoint;
      modal.remove();
      await session.destroy();
    }
  });


  it("lets mouse annotate policy ink while fingers keep native scroll policy", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.mouseInputMode = "annotate";
    settings.mouseDragScroll = false;
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    const finger = pointer("pointerdown", 100, 120, { pointerType: "touch", pointerId: 22 });
    adapter.pageElement.dispatchEvent(finger);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150, { pointerType: "touch", pointerId: 22 }));
    expect(finger.defaultPrevented).toBe(false);
    // Pencil-first: draw-hit-page is transient for active pen only — not permanent.
    expect(adapter.pageElement.classList.contains("native-pdf-handwriting-draw-hit-page")).toBe(false);
    expect(adapter.pageElement.classList.contains("native-pdf-handwriting-touch-draw-page")).toBe(false);

    const mouse = pointer("pointerdown", 100, 120, { pointerType: "mouse", pointerId: 7 });
    adapter.pageElement.dispatchEvent(mouse);
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150, { pointerType: "mouse", pointerId: 7 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, { pointerType: "mouse", pointerId: 7 }));
    expect(mouse.defaultPrevented).toBe(true);

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    expect(adapter.pageElement.classList.contains("native-pdf-handwriting-draw-hit-page")).toBe(false);
    await session.destroy();
  });

  it("commits an active stylus line before a mobile page is virtualized", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 23 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 170, { pointerType: "pen", pointerId: 23 }));
    vi.spyOn(adapter, "pages").mockReturnValue([]);
    vi.spyOn(adapter, "page").mockReturnValue(undefined);
    session.refresh("page-virtualized");

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    await session.destroy();
  });

  it("includes a held stylus line in the emergency teardown snapshot", async () => {
    const files = new MemoryFiles();
    const emergencyFiles = new Map<string, string>();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pointerType: "pen", pointerId: 24 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 170, { pointerType: "pen", pointerId: 24 }));
    session.emergencyPersist((path, contents) => emergencyFiles.set(path, contents), { force: true, reason: "test-teardown" });

    const sidecar = [...emergencyFiles.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    await session.destroy({ silent: true, alreadyPersisted: true });
  });

  it("captures a stable pressure profile for each new stroke", async () => {
    const adapter = new FakeAdapter();
    let profile: "auto" | "pen" | "mouse" = "auto";
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.mouseInputMode = "annotate";
    settings.mouseDragScroll = false;
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined,
      pressureProfile: () => profile
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, { pressure: 0 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 120, 150, { pressure: 0.8 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 140, 180, { pressure: 0.2 }));

    profile = "mouse";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 200, 220, { pointerType: "mouse", pointerId: 8, pressure: 1 }));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 230, 250, { pointerType: "mouse", pointerId: 8, pressure: 0 }));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 260, 280, { pointerType: "mouse", pointerId: 8, pressure: 1 }));

    const strokes = (session as unknown as { ink: { all(): InkStroke[] } }).ink.all();
    expect(strokes).toHaveLength(2);
    expect(strokes[0]!.points[0]!.pressure).toBeCloseTo(0.15, 8);
    expect(strokes[0]!.points[1]!.pressure).toBeGreaterThan(strokes[0]!.points[0]!.pressure);
    expect(strokes[1]!.inputType).toBe("mouse");
    expect(strokes[1]!.points.every((point) => point.pressure === 0.5)).toBe(true);
    await session.destroy();
  });

  it("uses Cmd or Ctrl as a non-persistent temporary eraser", async () => {
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as { activeTool(): string };
    const down = new KeyboardEvent("keydown", { key: "Control", bubbles: true, cancelable: true });
    expect(session.handleKeyDown(down)).toBe(true);
    expect(down.defaultPrevented).toBe(false);
    expect(internal.activeTool()).toBe("eraser");
    expect(adapter.toolbarHost.querySelector(".native-pdf-handwriting-toolbar")?.classList.contains("native-pdf-handwriting-temporary-eraser")).toBe(true);

    expect(session.handleKeyUp(new KeyboardEvent("keyup", { key: "Control", bubbles: true }))).toBe(true);
    expect(internal.activeTool()).toBe("pen");
    expect(settings.toolPreferences.activeTool).toBe("pen");
    await session.destroy();
  });

  it("defers off-viewport page paint until the page approaches the PDF viewport", async () => {
    const adapter = new FakeAdapter();
    Object.defineProperty(adapter.root, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) })
    });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, { overlay: HTMLElement; viewportCullPending: boolean }>;
      renderPage(page: number, stats?: undefined, reason?: string): void;
    };
    const surface = internal.surfaces.get(1)!;
    Object.defineProperty(surface.overlay, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 1200, right: 600, bottom: 2000, width: 600, height: 800, x: 0, y: 1200, toJSON: () => ({}) })
    });
    internal.renderPage(1, undefined, "viewport-cull-test");
    expect(surface.viewportCullPending).toBe(true);

    Object.defineProperty(surface.overlay, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 100, right: 600, bottom: 900, width: 600, height: 800, x: 0, y: 100, toJSON: () => ({}) })
    });
    internal.renderPage(1, undefined, "viewport-enter-test");
    expect(surface.viewportCullPending).toBe(false);
    await session.destroy();
  });

  it("uses strict viewport cull on zoom settle reasons and blit-only when backing is unchanged", async () => {
    const adapter = new FakeAdapter();
    Object.defineProperty(adapter.root, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) })
    });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      surfaces: Map<number, {
        overlay: HTMLElement;
        viewportCullPending: boolean;
        canvas: HTMLCanvasElement;
        inkLayer: HTMLCanvasElement | null;
        inkLayerValid: boolean;
        inkLayerBackingScale: number | null;
        inkLayerBurstCapture: boolean;
      }>;
      renderPage(
        page: number,
        stats?: { canvasesResized: number; strokesRedrawn: number; skippedBlitOnly?: number },
        reason?: string
      ): boolean;
      repaintSurfaces(reason: string): void;
      resolveInkBacking(width: number, height: number): { pixelWidth: number; pixelHeight: number; backingScale: number };
    };
    const surface = internal.surfaces.get(1)!;

    // Just outside the root, but inside the idle prefetch pad (~0.75×).
    Object.defineProperty(surface.overlay, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 420, right: 600, bottom: 1220, width: 600, height: 800, x: 0, y: 420, toJSON: () => ({}) })
    });
    expect(internal.renderPage(1, undefined, "idle-near-pad")).toBe(true);
    expect(surface.viewportCullPending).toBe(false);

    expect(internal.renderPage(1, undefined, "view-scalechanging")).toBe(false);
    expect(surface.viewportCullPending).toBe(true);

    // Bring back on-screen and seed a canonical ink layer matching current backing.
    Object.defineProperty(surface.overlay, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 40, right: 600, bottom: 840, width: 600, height: 800, x: 0, y: 40, toJSON: () => ({}) })
    });
    expect(internal.renderPage(1, undefined, "view-scalechanging")).toBe(true);
    expect(surface.inkLayerValid).toBe(true);
    expect(surface.inkLayerBurstCapture).toBe(false);
    expect(surface.inkLayerBackingScale).not.toBeNull();

    const stats = { canvasesResized: 0, strokesRedrawn: 0, skippedBlitOnly: 0 };
    expect(internal.renderPage(1, stats, "view-scalechanging")).toBe(true);
    expect(stats.canvasesResized).toBe(0);
    expect(stats.strokesRedrawn).toBe(0);
    expect(stats.skippedBlitOnly).toBe(1);

    await session.destroy();
  });

  it("uses the committed pen renderer for the live draft", async () => {
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.pen.stabilization = "off";
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    const internal = session as unknown as {
      surfaces: Map<number, {
        draftContext: CanvasRenderingContext2D;
        draftCanvas: HTMLCanvasElement;
        liveDrawPaintedPoints: number;
        builder?: { add(point: { x: number; y: number; pressure: number; time: number }): void };
      }>;
      renderLiveDrawPreview(surface: {
        draftContext: CanvasRenderingContext2D;
        draftCanvas: HTMLCanvasElement;
        liveDrawPaintedPoints: number;
      }): { draftPoints: number; incremental: boolean; stabilization: string };
    };
    const surface = internal.surfaces.get(1)!;
    vi.clearAllMocks();

    const first = internal.renderLiveDrawPreview(surface);
    expect(first.incremental).toBe(false);
    expect(first.stabilization).toBe("off");
    expect(surface.draftContext.fill).toHaveBeenCalled();
    expect(surface.draftContext.stroke).not.toHaveBeenCalled();

    const draftContext = surface.draftContext as unknown as {
      clearRect: { mock: { calls: unknown[] } };
      fill: { mock: { calls: unknown[] } };
    };
    const clearsAfterFirst = draftContext.clearRect.mock.calls.length;
    const fillsAfterFirst = draftContext.fill.mock.calls.length;
    surface.builder?.add({ x: 110, y: 130, pressure: 0.5, time: 2 });
    surface.builder?.add({ x: 120, y: 140, pressure: 0.5, time: 3 });
    const second = internal.renderLiveDrawPreview(surface);
    expect(second.incremental).toBe(true);
    expect(second.draftPoints).toBeGreaterThan(first.draftPoints);
    // Incremental frames must not wipe the whole draft backing.
    expect(draftContext.clearRect.mock.calls.length).toBe(clearsAfterFirst);
    expect(draftContext.fill.mock.calls.length).toBeGreaterThan(fillsAfterFirst);

    await session.destroy();
  });

  it("keeps incremental live draft under medium stabilization (causal preview)", async () => {
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.pen.stabilization = "medium";
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    const internal = session as unknown as {
      surfaces: Map<number, {
        draftContext: CanvasRenderingContext2D;
        builder?: { add(point: { x: number; y: number; pressure: number; time: number }): void };
      }>;
      renderLiveDrawPreview(surface: {
        draftContext: CanvasRenderingContext2D;
      }): { draftPoints: number; incremental: boolean; stabilization: string };
    };
    const surface = internal.surfaces.get(1)!;
    vi.clearAllMocks();

    internal.renderLiveDrawPreview(surface);
    const draftContext = surface.draftContext as unknown as {
      clearRect: { mock: { calls: unknown[] } };
    };
    const clearsAfterFirst = draftContext.clearRect.mock.calls.length;
    surface.builder?.add({ x: 110, y: 130, pressure: 0.5, time: 2 });
    surface.builder?.add({ x: 120, y: 140, pressure: 0.5, time: 3 });
    const second = internal.renderLiveDrawPreview(surface);
    expect(second.stabilization).toBe("medium");
    expect(second.incremental).toBe(true);
    expect(draftContext.clearRect.mock.calls.length).toBe(clearsAfterFirst);

    await session.destroy();
  });

  it("consumes an outside text-tool click to close the active editor before creating another box", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
    const firstEditor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
    const overlay = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    expect(firstEditor).not.toBeNull();
    expect(firstEditor?.parentElement).toBe(overlay);
    expect(firstEditor?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(firstEditor);

    // Empty editor: the next PDF click closes/discards it but does not open another editor.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 240, 300));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 240, 300));
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-input")).toHaveLength(0);
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-box")).toHaveLength(0);

    // With no editor open, the following click is the one that creates a new box.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 240, 300));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 240, 300));
    const editor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
    expect(editor).not.toBeNull();
    editor!.textContent = "Keep this annotation";
    editor!.dispatchEvent(new Event("input", { bubbles: true }));

    // Non-empty editor: outside click commits it and still does not open another editor.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 420));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 360, 420));
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-input")).toHaveLength(0);
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-box")).toHaveLength(1);

    await session.destroy();
  });

  it("updates an active text font size without a redundant session refresh", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const saveSettings = vi.fn(async () => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    try {
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
      adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
      const editor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
      expect(editor).not.toBeNull();

      const refresh = vi.spyOn(session, "refresh");
      adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
      const size = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu input[type='number']");
      expect(size).not.toBeNull();
      size!.value = "36";
      size!.dispatchEvent(new Event("change", { bubbles: true }));

      expect(editor?.style.fontSize).toBe("36px");
      expect(settings.toolPreferences.text.fontSize).toBe(36);
      expect(saveSettings).toHaveBeenCalledWith(settings.toolPreferences);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it("patches an existing text box style without resetting its other properties and protects IME composition", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const existing: PdfTextAnnotation = {
      id: "existing", page: 1, text: "Keep my style", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true,
      runs: [{ text: "Keep my style", color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true }],
      sourceRuns: [{ text: "Keep my style", color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      applyTextStyleToActiveEditor(change: { property: "color"; value: string; source: "input" }): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
      selectedTexts: PdfTextAnnotation[];
      selectionPage: number | null;
    };
    internal.texts.add(existing);
    internal.openTextEditor(internal.surfaces.get(1), existing);
    const initialEditor = internal.activeTextEditor!.element;
    const allText = initialEditor.ownerDocument.createRange();
    allText.selectNodeContents(initialEditor);
    const nativeSelection = initialEditor.ownerDocument.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(allText);
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#dc2626", source: "input" });
    internal.commitActiveTextEditor("test");
    expect(internal.texts.all()[0]).toMatchObject({
      color: "#dc2626", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true
    });

    internal.selectedTexts = [internal.texts.all()[0]!];
    internal.selectionPage = 1;
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#2563eb", source: "input" });
    expect(internal.texts.all()[0]).toMatchObject({ color: "#2563eb", fontSize: 18, fontFamily: "serif", bold: true });
    expect(internal.texts.all()[0]?.runs[0]?.color).toBe("#2563eb");

    internal.openTextEditor(internal.surfaces.get(1), internal.texts.all()[0]!);
    const editor = internal.activeTextEditor!.element;
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const composingEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    editor.dispatchEvent(composingEscape);
    expect(composingEscape.defaultPrevented).toBe(false);
    expect(internal.activeTextEditor?.element).toBe(editor);
    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    editor.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(internal.activeTextEditor).toBeNull();
    await session.destroy();
  });

  it("commits an active text editor when switching away from the Text tool", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const annotation: PdfTextAnnotation = {
      id: "switch-tools", page: 1, text: "Before", x: 100, y: 300, width: 160, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Before", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Before", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(annotation);
    internal.openTextEditor(internal.surfaces.get(1), annotation);
    internal.activeTextEditor!.element.textContent = "After";
    internal.activeTextEditor!.element.dispatchEvent(new Event("input", { bubbles: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='eraser']")?.click();

    expect(internal.activeTextEditor).toBeNull();
    expect(internal.texts.all()).toMatchObject([{ id: "switch-tools", text: "After" }]);
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-box")).not.toBeNull();
    await session.destroy();
  });

  it("moves selected ink and text together from the normal selection outline", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const stroke = {
      id: "ink", page: 1, tool: "pen" as const, color: "#000000", width: 2, opacity: 1,
      inputType: "pen" as const, points: [{ x: 100, y: 680, pressure: 1, time: 0 }], createdAt: "now", updatedAt: "now"
    };
    const text: PdfTextAnnotation = {
      id: "text", page: 1, text: "Move with ink", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Move with ink", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Move with ink", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "pen" as const, clientX, clientY, pressure: 1, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      ink: { add(value: InkStroke): void; all(): InkStroke[] };
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      tryStartSelectionMove(surface: unknown, input: { clientX: number; clientY: number }): boolean;
      pointerMove(surface: unknown, samples: { clientX: number; clientY: number }[], route: "draw", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: { clientX: number; clientY: number }[], route: "draw", event: PointerEvent): void;
      history: { undo(): boolean; redo(): boolean };
    };

    internal.ink.add(stroke);
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;
    expect(internal.tryStartSelectionMove(surface, sample(150, 150))).toBe(true);

    internal.pointerMove(surface, [sample(180, 180)], "draw", pointer("pointermove", 180, 180));
    internal.pointerEnd(surface, [sample(180, 180)], "draw", pointer("pointerup", 180, 180));

    expect(internal.ink.all()[0]?.points[0]).toMatchObject({ x: 130, y: 650 });
    expect(internal.texts.all()[0]).toMatchObject({ x: 250, y: 620 });
    expect(internal.history.undo()).toBe(true);
    expect(internal.ink.all()[0]?.points[0]).toMatchObject({ x: 100, y: 680 });
    expect(internal.texts.all()[0]).toMatchObject({ x: 220, y: 650 });

    await session.destroy();
  });

  it("moves selected text from the normal selection outline while the text tool is active", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const text: PdfTextAnnotation = {
      id: "move-in-text-mode", page: 1, text: "Move me", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Move me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Move me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "mouse" as const, clientX, clientY, pressure: 0.5, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      pointerStart(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerMove(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;
    internal.pointerStart(surface, [sample(250, 150)], "text", pointer("pointerdown", 250, 150));
    internal.pointerMove(surface, [sample(280, 180)], "text", pointer("pointermove", 280, 180));
    internal.pointerEnd(surface, [sample(280, 180)], "text", pointer("pointerup", 280, 180));

    expect(internal.texts.all()[0]).toMatchObject({ x: 250, y: 620 });
    await session.destroy();
  });

  it("clears selected text on the first empty click in text mode before creating a new box", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const text: PdfTextAnnotation = {
      id: "clear-on-click-away", page: 1, text: "Selected", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Selected", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Selected", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "mouse" as const, clientX, clientY, pressure: 0.5, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      pointerStart(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      selectedTexts: PdfTextAnnotation[];
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;

    internal.pointerStart(surface, [sample(500, 500)], "text", pointer("pointerdown", 500, 500));
    internal.pointerEnd(surface, [sample(500, 500)], "text", pointer("pointerup", 500, 500));
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.activeTextEditor).toBeNull();

    internal.pointerStart(surface, [sample(500, 500)], "text", pointer("pointerdown", 500, 500));
    internal.pointerEnd(surface, [sample(500, 500)], "text", pointer("pointerup", 500, 500));
    expect(internal.activeTextEditor).not.toBeNull();

    await session.destroy();
  });

  it("opens a selected text box for editing when its text is clicked", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const text: PdfTextAnnotation = {
      id: "click-selected-to-edit", page: 1, text: "Edit me", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Edit me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Edit me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void };
      selectAllOnCurrentPage(): void;
      activeTextEditor: { draft: PdfTextAnnotation } | null;
      selectedTexts: PdfTextAnnotation[];
      selectionShape: unknown;
      selectionPage: number | null;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box).not.toBeNull();

    box!.dispatchEvent(pointer("pointerdown", 250, 150));
    box!.dispatchEvent(pointer("pointerup", 250, 150));
    expect(internal.activeTextEditor?.draft.id).toBe(text.id);
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.selectionShape).toBeNull();
    expect(internal.selectionPage).toBeNull();

    await session.destroy();
  });

  it("persists only selected rich-text characters and renders their saved runs", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const existing: PdfTextAnnotation = {
      id: "rich", page: 1, text: "hello world", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "hello world", color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "hello world", color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      applyTextStyleToActiveEditor(change: TextStyleChange): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(existing);
    internal.openTextEditor(internal.surfaces.get(1), existing);
    const editor = internal.activeTextEditor!.element;
    const text = editor.querySelector("span")?.firstChild!;
    const range = editor.ownerDocument.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    const selection = editor.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#dc2626", source: "input" });
    expect(editor.querySelectorAll(".native-pdf-handwriting-text-run")).toHaveLength(2);
    internal.commitActiveTextEditor("test-rich-runs");

    const saved = internal.texts.all()[0]!;
    expect(saved.runs).toEqual([
      { ...existing.runs[0]!, text: "hello " },
      { ...existing.runs[0]!, text: "world", color: "#dc2626" }
    ]);
    const staticRuns = adapter.pageElement.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box .native-pdf-handwriting-text-run");
    expect(staticRuns).toHaveLength(2);
    expect(staticRuns[1]?.style.color).toBe("rgb(220, 38, 38)");

    internal.openTextEditor(internal.surfaces.get(1), saved);
    expect(internal.activeTextEditor!.element.querySelectorAll(".native-pdf-handwriting-text-run")).toHaveLength(2);
    await session.destroy();
  });

  it("uses NPDE-style text-box outlines, edge hit zones, and resize dots", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const annotation: PdfTextAnnotation = {
      id: "controls", page: 1, text: "Resize me", x: 100, y: 300, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Resize me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Resize me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, { context: CanvasRenderingContext2D }>;
      renderTextAnnotations(surface: unknown): void;
      resizeTextAnnotation(annotation: PdfTextAnnotation, handle: "se", point: { x: number; y: number }): PdfTextAnnotation;
    };
    internal.texts.add(annotation);
    internal.renderTextAnnotations(internal.surfaces.get(1));

    const box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).not.toBeNull();
    expect(box?.querySelectorAll("[data-handle]")).toHaveLength(12);
    expect(box?.querySelectorAll(".native-pdf-handwriting-text-resize-nw, .native-pdf-handwriting-text-resize-ne, .native-pdf-handwriting-text-resize-sw, .native-pdf-handwriting-text-resize-se")).toHaveLength(4);

    const preview = internal.resizeTextAnnotation(annotation, "se", { x: 320, y: 250 });
    expect(preview).toMatchObject({ x: 100, y: 300, width: 220, height: 50, text: "Resize me" });
    const handle = box?.querySelector<HTMLElement>(".native-pdf-handwriting-text-resize-se");
    const frame = box?.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
    handle?.dispatchEvent(pointer("pointerdown", 240, 528));
    internal.renderTextAnnotations(internal.surfaces.get(1));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-selection-frame")).toBe(frame);
    document.dispatchEvent(pointer("pointermove", 320, 550));
    expect(frame?.style.width).toBe("226px");
    expect(internal.texts.all()[0]).toMatchObject({ width: 140, height: 28, text: "Resize me" });
    document.dispatchEvent(pointer("pointerup", 320, 550));
    expect(internal.texts.all()[0]).toMatchObject({ x: 100, y: 300, width: 220, height: 50, text: "Resize me" });

    const movedBox = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    movedBox?.querySelector<HTMLElement>(".native-pdf-handwriting-text-move-e")?.dispatchEvent(pointer("pointerdown", 320, 525));
    document.dispatchEvent(pointer("pointermove", 400, 575));
    expect(movedBox?.style.transform).toBe("translate(80px, 50px)");
    expect(internal.texts.all()[0]).toMatchObject({ x: 100, y: 300, width: 220, height: 50 });
    vi.mocked(internal.surfaces.get(1)!.context.rect).mockClear();
    document.dispatchEvent(pointer("pointerup", 400, 575));
    expect(internal.texts.all()[0]).toMatchObject({ x: 180, y: 250, width: 220, height: 50, text: "Resize me" });
    // The canvas selection marquee must use the committed geometry, not leave
    // a second outline at the text box's prior position.
    expect(vi.mocked(internal.surfaces.get(1)!.context.rect).mock.calls.at(-1)).toEqual([180, 550, 220, 50]);
    await session.destroy();
  });

  it("paints stroke commits page-locally instead of full history refresh", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      refresh(reason: string): void;
      invalidateInkLayers(): void;
      ink: { all(): unknown[] };
    };
    const refresh = vi.spyOn(internal, "refresh");
    const invalidateAll = vi.spyOn(internal, "invalidateInkLayers");
    refresh.mockClear();
    invalidateAll.mockClear();

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 200));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    expect(internal.ink.all()).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalledWith("history");
    expect(invalidateAll).not.toHaveBeenCalled();

    await session.destroy();
  });

  it("keeps committed ink layer pixels when switching to text after drawing", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    settings.toolPreferences.pen.color = "#dc2626";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 200));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    const internal = session as unknown as {
      surfaces: Map<number, { inkLayerValid: boolean; builder?: unknown }>;
      ink: { all(): Array<{ color: string }> };
      invalidateInkLayers(): void;
    };
    const surface = internal.surfaces.get(1)!;
    expect(surface.builder).toBeUndefined();
    expect(internal.ink.all().at(-1)?.color).toBe("#dc2626");
    const layerValidBefore = surface.inkLayerValid;
    const invalidate = vi.spyOn(internal, "invalidateInkLayers");

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    expect(settings.toolPreferences.activeTool).toBe("text");
    // Tool-chrome refresh must not invalidate committed ink (zoom-blit snap).
    expect(invalidate).not.toHaveBeenCalled();
    expect(surface.inkLayerValid).toBe(layerValidBefore);
    expect(internal.ink.all().at(-1)?.color).toBe("#dc2626");

    await session.destroy();
  });

  it("makes text boxes interactable only in text or lasso mode while draw is on", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const annotation: PdfTextAnnotation = {
      id: "pass-through", page: 1, text: "Ink over me", x: 100, y: 300, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Ink over me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Ink over me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void };
      surfaces: Map<number, unknown>;
      renderTextAnnotations(surface: unknown): void;
      options: { settings: { toolPreferences: { activeTool: string } } };
      refreshToolChrome(reason?: string): void;
    };
    internal.texts.add(annotation);
    internal.renderTextAnnotations(internal.surfaces.get(1));

    let box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(false);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).toBeNull();

    // Production tool/style prefs use chrome-only refresh (no ink invalidate).
    internal.options.settings.toolPreferences.activeTool = "lasso";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).not.toBeNull();

    internal.options.settings.toolPreferences.activeTool = "text";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);

    internal.options.settings.toolPreferences.activeTool = "eraser";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(false);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).toBeNull();

    await session.destroy();
  });

  it("resizes a locked shape from a drawing tool when the pointer moves instead of reverting to raw ink", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    const point = (x: number, y: number): PdfPoint => ({ x, y, pressure: 0.6, time: 0 });
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    const surface = (session as unknown as {
      surfaces: Map<number, {
        shapeHoldTimer: number | null;
        shapePreview: PdfPoint[] | null;
        shapeResize: { recognition: { kind: "line"; points: PdfPoint[] }; anchor: PdfPoint; handle: PdfPoint } | null;
      }>;
    }).surfaces.get(1)!;
    expect(surface.shapeHoldTimer).not.toBeNull();
    surface.shapePreview = [point(100, 680), point(200, 680)];
    surface.shapeResize = {
      recognition: { kind: "line", points: [point(100, 680), point(200, 680)] },
      anchor: point(100, 680),
      handle: point(200, 680)
    };

    adapter.pageElement.dispatchEvent(pointer("pointermove", 260, 120));
    expect(surface.shapePreview).toEqual([
      expect.objectContaining({ x: 100, y: 680 }),
      expect.objectContaining({ x: 260, y: 680 })
    ]);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 260, 120));
    const ink = (session as unknown as { ink: { all(): Array<{ points: PdfPoint[] }> } }).ink.all();
    expect(ink[0]?.points.at(-1)).toMatchObject({ x: 260, y: 680 });

    await session.destroy();
  });

  it("bounds a held laser draft so high-rate input cannot grow without limit", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "laser";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    for (let index = 0; index < 1_100; index += 1) {
      adapter.pageElement.dispatchEvent(pointer("pointermove", 100 + index, 120));
    }

    const surfaces = (session as unknown as {
      surfaces: Map<number, { builder?: { preview(simplify?: boolean): readonly unknown[] } }>;
    }).surfaces;
    expect(surfaces.get(1)?.builder?.preview(false)).toHaveLength(1_024);
    await session.destroy();
    } finally {
      debug.mockRestore();
    }
  }, 15_000);

  it("renders a lasso outline while dragging", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "lasso";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 220));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(context.moveTo).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(canvas?.classList.contains("is-selection-chrome-raised")).toBe(true);
    await session.destroy();
  });

  it("keeps the shared lasso selection outline after selecting a text box", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const text: PdfTextAnnotation = {
      // PDF y grows upward; FakeAdapter maps clientY≈0 to pdfY≈800.
      id: "lasso-text", page: 1, text: "Select me", x: 120, y: 650, width: 160, height: 36,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Select me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Select me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void };
      selectedTexts: PdfTextAnnotation[];
      selectionShape: unknown;
      renderPage(pageNumber: number): void;
    };
    internal.texts.add(text);
    internal.renderPage(1);

    context.stroke.mockClear();
    context.rect.mockClear();
    context.setLineDash.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 240));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    expect(internal.selectedTexts).toHaveLength(1);
    expect(internal.selectionShape).not.toBeNull();
    expect(context.setLineDash).toHaveBeenCalled();
    expect(context.rect).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(canvas?.classList.contains("is-selection-chrome-raised")).toBe(true);
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-box.is-selected")).not.toBeNull();
    await session.destroy();
  });

  it("keeps the lasso visible and moves selected ink when dragged inside it", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 220));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));
    await session.manualSave();
    const before = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 200));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 360));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 360));
    await session.manualSave();
    const after = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    await session.destroy();
  });

  it("moves selected ink when dragged in draw mode with pen active", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));
    await session.manualSave();
    const beforeCount = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes.length;
    const before = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    settings.toolPreferences.activeTool = "pen";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 240));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));
    await session.manualSave();
    const afterSidecar = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes;
    expect(afterSidecar).toHaveLength(beforeCount);
    expect(afterSidecar[0].points[0].x).toBeGreaterThan(before.x);
    expect(afterSidecar[0].points[0].y).toBeLessThan(before.y);
    await session.destroy();
  });

  it("supports copy, cut, paste, and delete shortcuts with lasso selection context", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    // Draw a stroke first, then switch to lasso so select-all has ink to select.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 160, 180));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    session.selectTool("lasso");

    const selectAll = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(selectAll)).toBe(true);
    expect(selectAll.defaultPrevented).toBe(true);

    const strokeCount = () => {
      const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      if (!entry) return 0;
      return JSON.parse(entry[1]).pages.flatMap((page: { strokes: unknown[] }) => page.strokes).length;
    };

    const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(copy)).toBe(true);
    expect(copy.defaultPrevented).toBe(true);

    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    expect(session.handleKeyDown(del)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(0);

    const paste = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(paste)).toBe(true);
    await session.manualSave();
    const restored = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes;
    expect(restored).toHaveLength(1);
    expect(restored[0].points[0].x).toBeGreaterThan(100);

    const cut = new KeyboardEvent("keydown", { key: "x", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(cut)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(0);

    expect(session.handleKeyDown(paste)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(1);

    document.querySelector<HTMLButtonElement>(".native-pdf-handwriting-selection-toolbar button:last-of-type")?.click();
    // Leave annotation shortcut context so native PDF/editor shortcuts are not hijacked.
    settings.toolPreferences.activeTool = "pen";
    session.selectTool("pen");
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }))).toBe(false);
    expect(session.handleKeyDown(paste)).toBe(false);
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true }))).toBe(false);

    await session.destroy();
  });

  it("selects all active text before native typing while leaving delete native", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const text: PdfTextAnnotation = {
      id: "editor-shortcut", page: 1, text: "Select this text", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Select this text", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Select this text", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
      selectedTexts: PdfTextAnnotation[];
    };
    internal.texts.add(text);
    internal.openTextEditor(internal.surfaces.get(1), text);

    const editor = internal.activeTextEditor!.element;
    const selectAllInEditor = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    const deleteInEditor = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    expect(editor.dispatchEvent(selectAllInEditor)).toBe(false);
    expect(selectAllInEditor.defaultPrevented).toBe(true);
    expect(editor.ownerDocument.getSelection()?.toString()).toBe("Select this text");
    expect(session.handleKeyDown(deleteInEditor)).toBe(false);
    expect(deleteInEditor.defaultPrevented).toBe(false);
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.texts.all()).toHaveLength(1);

    // Browser editing replaces the native range selected above. Simulate that
    // native edit, then verify the runtime serializes the replacement only.
    const selection = editor.ownerDocument.getSelection()!;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const replacement = editor.ownerDocument.createTextNode("Replacement");
    range.insertNode(replacement);
    const caret = editor.ownerDocument.createRange();
    caret.setStartAfter(replacement);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    internal.commitActiveTextEditor("test-editor-shortcuts");
    expect(internal.texts.all()[0]?.text).toBe("Replacement");
    const selectAllAnnotations = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(selectAllAnnotations)).toBe(true);
    expect(selectAllAnnotations.defaultPrevented).toBe(true);
    expect(internal.selectedTexts).toHaveLength(1);

    await session.destroy();
  });

  it("keeps selection until cleared; no Draw-mode toggle exists", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    Object.assign(adapter.pageElement, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/selection-clear.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    expect(adapter.toolbarHost.querySelector("[data-control='draw']")).toBeNull();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 160, 180));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    session.selectTool("lasso");
    session.applySelectionShortcut("selectAll");
    expect(session.canSelectionShortcut("delete")).toBe(true);
    session.applySelectionShortcut("delete");
    expect(session.canSelectionShortcut("delete")).toBe(false);
    await session.destroy();
  });

  it("emergency-persists dirty ink without waiting for autosave", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autosaveDelayMs = 60_000;
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));

    const writes = new Map<string, string>();
    session.emergencyPersist((path, contents) => writes.set(path, contents));

    expect(writes.size).toBe(2);
    const persisted = [...writes.values()][0];
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted!).pages[0].strokes).toHaveLength(1);
    await session.destroy({ alreadyPersisted: true });
  });

  it("abandoned session refuses emergency and async persist", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autosaveDelayMs = 60_000;
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));

    session.abandonWrites("test-stale");
    const writes = new Map<string, string>();
    session.emergencyPersist((path, contents) => writes.set(path, contents), { force: true, reason: "test" });
    expect(writes.size).toBe(0);

    await session.destroy({ silent: true, alreadyPersisted: true });
  });

  it("loads newer recovery data when the sidecar is stale", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const documentId = createDocumentIdentity({ vaultPath: "Notes/example.pdf" }).id;
    const saved = JSON.parse(await files.read(sidecars.pathFor(documentId)));
    saved.updatedAt = "2026-01-01";
    saved.pages = [];
    await files.write(sidecars.pathFor(documentId), serializeSidecar(saved));

    const recovered = structuredClone(saved);
    recovered.updatedAt = "2026-02-01";
    recovered.pages = [{
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      strokes: [{
        id: "stroke-1",
        page: 1,
        tool: "pen",
        color: "#111827",
        width: 2.5,
        opacity: 1,
        inputType: "pen",
        points: [{ x: 100, y: 120, pressure: 0.6, time: 1 }],
        createdAt: "2026-02-01",
        updatedAt: "2026-02-01"
      }]
    }];
    await recovery.save(recovered);
    await session.destroy();

    const reloaded = await ViewerInkSession.create({
      adapter: new FakeAdapter(),
      documentPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    await reloaded.manualSave();
    const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry![1]).pages[0].strokes).toHaveLength(1);
    await reloaded.destroy();
  });

  it("coalesces live stylus painting without dropping samples or letting a terminal frame go stale", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    frames.length = 0;
    requestFrame.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 160));

    // One frame owns ink and one owns the independently batched cursor; raw
    // moves must not add more paint callbacks.
    expect(requestFrame).toHaveBeenCalledTimes(2);
    const queuedPaint = frames[0]!;
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    const surface = (session as unknown as {
      surfaces: Map<number, { livePaintFrame: number | null; pendingLivePaint: unknown }>;
    }).surfaces.get(1)!;
    expect(surface.livePaintFrame).toBeNull();
    expect(surface.pendingLivePaint).toBeNull();
    queuedPaint(0);
    expect(surface.pendingLivePaint).toBeNull();

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes[0].points).toHaveLength(4);
    await session.destroy();
  });

  it("keeps a captured PDF page visible through a delete reload until native render finishes", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const nativeCanvas = document.createElement("canvas");
    nativeCanvas.className = "pdf-native-canvas";
    Object.defineProperty(nativeCanvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    });
    adapter.pageElement.prepend(nativeCanvas);

    let finishDelete: (() => void) | undefined;
    const nativeDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      onDeletePage: async () => nativeDelete,
      notice: () => undefined
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const internal = session as unknown as {
      deletePage(pageNumber: number): Promise<void>;
      onPagesChanged(reason: string): void;
    };

    const deleting = internal.deletePage(1);
    await Promise.resolve();
    expect(document.querySelectorAll(".native-pdf-handwriting-page-mutation-snapshot")).toHaveLength(1);
    finishDelete?.();
    await deleting;

    internal.onPagesChanged("pages-settled");
    // A rebuilt page tree is present before PDF.js has painted its canvas.
    // Keep the captured page through that render window instead of exposing a
    // white frame between the two trees.
    expect(document.querySelectorAll(".native-pdf-handwriting-page-mutation-snapshot")).toHaveLength(1);
    const firstRenderedShieldFrame = frames.at(-1);
    expect(firstRenderedShieldFrame).toBeDefined();
    firstRenderedShieldFrame?.(0);
    expect(document.querySelectorAll(".native-pdf-handwriting-page-mutation-snapshot")).toHaveLength(1);
    const secondRenderedShieldFrame = frames.at(-1);
    expect(secondRenderedShieldFrame).toBeDefined();
    secondRenderedShieldFrame?.(16);
    expect(document.querySelectorAll(".native-pdf-handwriting-page-mutation-snapshot")).toHaveLength(0);

    await session.destroy();
  });

  it("focuses the inserted native PDF page after its reload publishes the new count", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const nativeCanvas = document.createElement("canvas");
    nativeCanvas.className = "pdf-native-canvas";
    Object.defineProperty(nativeCanvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    });
    adapter.pageElement.prepend(nativeCanvas);
    const page2 = document.createElement("div");
    page2.dataset.pageNumber = "2";
    adapter.root.append(page2);
    const initialPages = adapter.pages.bind(adapter);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      onInsertPage: async () => {
        const pages = [...initialPages(), { pageNumber: 2, width: 600, height: 800, scale: 1, rotation: 0, element: page2 }];
        vi.spyOn(adapter, "pages").mockReturnValue(pages);
        vi.spyOn(adapter, "page").mockImplementation((pageNumber) => pages.find((page) => page.pageNumber === pageNumber));
        return 2;
      },
      notice: () => undefined
    });

    await session.addPageAt(2);

    expect(adapter.focusedPages).toEqual([2]);
    expect(document.querySelectorAll(".native-pdf-handwriting-page-mutation-snapshot")).toHaveLength(1);
    await session.destroy();
  });

  it("restores Add Page zoom mode and correlates bounded lifecycle diagnostics", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    adapter.viewState = {
      pageNumber: 1,
      scrollFraction: 0.82,
      scale: 2.1789,
      scaleMode: 2.1789,
      rotation: 0
    };
    const page2 = document.createElement("div");
    page2.dataset.pageNumber = "2";
    adapter.root.append(page2);
    const initialPages = adapter.pages.bind(adapter);
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      onInsertPage: async () => {
        const pages = [...initialPages(), { pageNumber: 2, width: 600, height: 800, scale: 1, rotation: 0, element: page2 }];
        vi.spyOn(adapter, "pages").mockReturnValue(pages);
        vi.spyOn(adapter, "page").mockImplementation((pageNumber) => pages.find((page) => page.pageNumber === pageNumber));
        return 2;
      },
      vaultLog: {
        write: (_level, event, payload) => logs.push({ event, payload: payload ?? {} })
      },
      debugEnabled: () => true,
      notice: () => undefined
    });

    await session.addPageAt(2);

    expect(adapter.restoredViewStates).toHaveLength(1);
    expect(adapter.restoredViewStates[0]).toMatchObject({ scale: 2.1789, scaleMode: 2.1789, scrollFraction: 0.82 });
    const lifecycle = logs
      .filter((entry) => entry.event === "add-page lifecycle")
      .map((entry) => entry.payload);
    expect(lifecycle.map((entry) => entry.phase)).toEqual(["before-mutation", "mutation-complete"]);
    expect(lifecycle).toHaveLength(2);
    const beforeLifecycle = lifecycle[0]!;
    const afterLifecycle = lifecycle[1]!;
    expect(beforeLifecycle.addPageOperationId).toBe(afterLifecycle.addPageOperationId);
    expect(afterLifecycle).toMatchObject({ beforeScale: 2.1789, afterScale: 2.1789, staleSurfaceOverlap: false });
    await session.destroy();
  });

  it("commits imported-page PDF bytes and shifts the persisted sidecar atomically", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const originalPdf = new Uint8Array([1]);
    const importedPdf = new Uint8Array([2]);
    const writeSourcePdf = vi.fn(async (_bytes: Uint8Array) => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => originalPdf,
      writeSourcePdf,
      onImportPages: async () => ({ bytes: importedPdf, pageNumber: 2, pageCount: 2, pageNumbers: [1, 2] }),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const internal = session as unknown as {
      ink: { add(stroke: InkStroke): void };
    };
    internal.ink.add({
      id: "later", page: 2, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen",
      points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01"
    });

    await session.importPagesAfter(1);

    expect(writeSourcePdf).toHaveBeenCalledWith(importedPdf);
    const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry![1]).pages[0].page).toBe(4);
    expect(JSON.parse(entry![1]).pages[0].strokes[0].page).toBe(4);
    await session.destroy();
  });

  it("leaves PDF and sidecar untouched when the import picker is cancelled", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const writeSourcePdf = vi.fn(async (_bytes: Uint8Array) => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array([1]),
      writeSourcePdf,
      onImportPages: async () => null,
      writeExport: async () => undefined,
      notice: () => undefined
    });

    await session.importPagesAfter(1);

    expect(writeSourcePdf).not.toHaveBeenCalled();
    expect([...files.values.keys()]).toEqual([]);
    await session.destroy();
  });

  it("rolls the destination PDF back when the remapped sidecar cannot be saved", async () => {
    const files = new MemoryFiles();
    const originalWrite = files.write.bind(files);
    files.write = async (path, contents) => {
      if (path.startsWith("annotations/")) throw new Error("sidecar write failed");
      await originalWrite(path, contents);
    };
    const adapter = new FakeAdapter();
    const originalPdf = new Uint8Array([1]);
    const importedPdf = new Uint8Array([2]);
    const writes: Uint8Array[] = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => originalPdf,
      writeSourcePdf: async (bytes) => { writes.push(bytes); },
      onImportPages: async () => ({ bytes: importedPdf, pageNumber: 2, pageCount: 1, pageNumbers: [1] }),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    await session.importPagesAfter(1);

    expect(writes).toEqual([importedPdf, originalPdf]);
    expect([...files.values.keys()].some((path) => path.startsWith("annotations/"))).toBe(false);
    await session.destroy();
  });

  it("shows Scan document on mobile and inserts confirmed pages after the current page", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const page2 = document.createElement("div");
    page2.dataset.pageNumber = "2";
    const page3 = document.createElement("div");
    page3.dataset.pageNumber = "3";
    adapter.root.append(page2, page3);
    const initialPages = adapter.pages.bind(adapter);
    let requestedPage = 0;
    let insertedCount = 0;
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeSourcePdf: async () => undefined,
      onImportPages: async () => null,
      writeExport: async () => undefined,
      openScanDocument: async () => [
        { bytes: new Uint8Array([1]), mimeType: "image/jpeg", width: 100, height: 200 },
        { bytes: new Uint8Array([2]), mimeType: "image/jpeg", width: 200, height: 100 }
      ],
      onInsertScannedPages: async (pageNumber, pages) => {
        requestedPage = pageNumber;
        insertedCount = pages.length;
        const pagesAfterInsert = [
          ...initialPages(),
          { pageNumber: 2, width: 600, height: 800, scale: 1, rotation: 0, element: page2 },
          { pageNumber: 3, width: 600, height: 800, scale: 1, rotation: 0, element: page3 }
        ];
        vi.spyOn(adapter, "pages").mockReturnValue(pagesAfterInsert);
        vi.spyOn(adapter, "page").mockImplementation((number) => pagesAfterInsert.find((page) => page.pageNumber === number));
        return 2;
      },
      notice: () => undefined,
      runtimePlatform: () => ({ mobile: true, phone: false })
    });

    const more = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='more']");
    more?.click();
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='scan-document']")?.textContent).toBe("Scan document");
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='import-page']")?.textContent).toBe("Import page");
    await (session as unknown as { scanDocument(): Promise<void> }).scanDocument();

    expect(requestedPage).toBe(2);
    expect(insertedCount).toBe(2);
    expect(adapter.focusedPages).toContain(2);
    await session.destroy();
  });

  it("hides Scan document on desktop and leaves PDF unchanged when capture is cancelled", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const insert = vi.fn(async () => 2);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array([9]),
      writeSourcePdf: async () => undefined,
      onImportPages: async () => null,
      openScanDocument: async () => null,
      onInsertScannedPages: insert,
      writeExport: async () => undefined,
      notice: () => undefined,
      runtimePlatform: () => ({ mobile: false, phone: false })
    });

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='more']")?.click();
    expect(document.querySelector("[data-option-id='scan-document']")).toBeNull();
    expect(document.querySelector("[data-option-id='import-page']")?.textContent).toBe("Import page");
    await (session as unknown as { scanDocument(): Promise<void> }).scanDocument();
    expect(insert).not.toHaveBeenCalled();
    expect([...files.values.keys()]).toEqual([]);
    await session.destroy();
  });

  it("shifts live sidecar annotations when a single scanned page is inserted", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const page2 = document.createElement("div");
    page2.dataset.pageNumber = "2";
    adapter.root.append(page2);
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      openScanDocument: async () => [
        { bytes: new Uint8Array([1]), mimeType: "image/jpeg", width: 100, height: 200 }
      ],
      onInsertScannedPages: async () => {
        const pagesAfterInsert = [
          ...adapter.pages(),
          { pageNumber: 2, width: 600, height: 800, scale: 1, rotation: 0, element: page2 }
        ];
        vi.spyOn(adapter, "pages").mockReturnValue(pagesAfterInsert);
        return 2;
      },
      notice: () => undefined,
      runtimePlatform: () => ({ mobile: true, phone: true })
    });
    const internal = session as unknown as {
      ink: { add(stroke: InkStroke): void; all(): InkStroke[] };
    };
    internal.ink.add({
      id: "later", page: 2, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen",
      points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01"
    });

    await (session as unknown as { scanDocument(): Promise<void> }).scanDocument();
    expect(internal.ink.all().map((stroke) => stroke.page)).toEqual([3]);
    await session.destroy();
  });

  it("surfaces insert failures without mutating live ink when the scan write fails", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const notices: string[] = [];
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      openScanDocument: async () => [
        { bytes: new Uint8Array([1]), mimeType: "image/jpeg", width: 100, height: 200 }
      ],
      onInsertScannedPages: async () => {
        throw new Error("scan write failed");
      },
      notice: (message) => notices.push(message),
      runtimePlatform: () => ({ mobile: true, phone: false })
    });
    const internal = session as unknown as {
      ink: { add(stroke: InkStroke): void; all(): InkStroke[] };
    };
    internal.ink.add({
      id: "keep", page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen",
      points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01"
    });

    await (session as unknown as { scanDocument(): Promise<void> }).scanDocument();
    expect(notices.some((message) => message.includes("scan write failed"))).toBe(true);
    expect(internal.ink.all().map((stroke) => stroke.page)).toEqual([1]);
    await session.destroy();
  });
});
