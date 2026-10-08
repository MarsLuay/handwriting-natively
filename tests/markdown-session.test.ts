import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type InkStroke } from "../src/model";
import { MarkdownViewAdapter } from "../src/integration/MarkdownViewAdapter";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";

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

function markdownHost(mode: "preview" | "source", scrollHeight = 1_280): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement("div");
  host.className = "workspace-leaf";
  const root = document.createElement("div");
  if (mode === "preview") {
    root.className = "markdown-preview-view";
  } else {
    const sourceView = document.createElement("div");
    sourceView.className = "markdown-source-view";
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    root.className = "cm-scroller";
    root.style.overflow = "auto";
    const content = document.createElement("div");
    content.className = "cm-content";
    content.setAttribute("contenteditable", "true");
    root.append(content);
    editor.append(root);
    sourceView.append(editor);
    host.append(sourceView);
  }
  Object.defineProperty(root, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 480 });
  Object.defineProperty(root, "scrollWidth", { configurable: true, value: 640 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: scrollHeight });
  root.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
    width: 640, height: 480, toJSON: () => ({})
  });
  if (mode === "preview") host.append(root);
  document.body.append(host);
  return { host, root };
}

function mockCanvasContext(): void {
  const context = {
    setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    ellipse: vi.fn(), drawImage: vi.fn()
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
}

function historyStroke(id: string): InkStroke {
  return {
    id,
    page: 1,
    tool: "pen",
    color: "#000000",
    width: 2,
    opacity: 1,
    inputType: "pen",
    points: [{ x: 12, y: 20, pressure: 0.5, time: 1 }],
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z"
  };
}

function dispatchWindowKeydown(target: HTMLElement, session: ViewerInkSession, event: KeyboardEvent): boolean {
  let handled = false;
  const onKeydown = (current: KeyboardEvent): void => {
    handled = session.handleKeyDown(current, "window");
  };
  window.addEventListener("keydown", onKeydown, true);
  try {
    target.dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", onKeydown, true);
  }
  return handled;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Markdown annotation session", () => {
  it("routes Ctrl+Z to ink after an annotation while CodeMirror remains focused", async () => {
    mockCanvasContext();
    const files = new MemoryFiles();
    const { host, root } = markdownHost("source");
    const editor = root.querySelector<HTMLElement>(".cm-content[contenteditable='true']");
    expect(editor).not.toBeNull();
    const adapter = MarkdownViewAdapter.attach(host, {}, { mode: "source" });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/undo.md",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "annotations/recovery"),
      saveSettings: async () => undefined,
      notice: () => undefined
    });
    const stroke = historyStroke("markdown-undo-stroke");
    const internal = session as unknown as {
      ink: { add(stroke: InkStroke): void; remove(id: string): void; page(page: number): InkStroke[] };
      executeHistory(command: { execute(): void; undo(): void }): void;
    };
    internal.executeHistory({
      execute: () => internal.ink.add(stroke),
      undo: () => internal.ink.remove(stroke.id)
    });

    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    try {
      expect(dispatchWindowKeydown(editor!, session, undo)).toBe(true);
      expect(undo.defaultPrevented).toBe(true);
      expect(internal.ink.page(1)).toHaveLength(0);
    } finally {
      await session.destroy({ silent: true });
    }
  });

  it("keeps Markdown text undo native after the editor changes", async () => {
    mockCanvasContext();
    const files = new MemoryFiles();
    const { host, root } = markdownHost("source");
    const editor = root.querySelector<HTMLElement>(".cm-content[contenteditable='true']");
    expect(editor).not.toBeNull();
    const adapter = MarkdownViewAdapter.attach(host, {}, { mode: "source" });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/native-undo.md",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "annotations/recovery"),
      saveSettings: async () => undefined,
      notice: () => undefined
    });
    const stroke = historyStroke("markdown-native-undo-stroke");
    const internal = session as unknown as {
      ink: { add(stroke: InkStroke): void; remove(id: string): void; page(page: number): InkStroke[] };
      executeHistory(command: { execute(): void; undo(): void }): void;
    };
    internal.executeHistory({
      execute: () => internal.ink.add(stroke),
      undo: () => internal.ink.remove(stroke.id)
    });
    editor!.dispatchEvent(new Event("input", { bubbles: true }));

    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    try {
      expect(dispatchWindowKeydown(editor!, session, undo)).toBe(false);
      expect(undo.defaultPrevented).toBe(false);
      expect(internal.ink.page(1)).toHaveLength(1);
    } finally {
      await session.destroy({ silent: true });
    }
  });

  it.each(["preview", "source"] as const)("uses the shared toolbar and sidecar in %s mode", async (mode) => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      ellipse: vi.fn(), drawImage: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const files = new MemoryFiles();
    const { host, root } = markdownHost(mode);
    const adapter = MarkdownViewAdapter.attach(host, {}, { mode });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/meeting.md",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "annotations/recovery"),
      saveSettings: async () => undefined,
      notice: () => undefined
    });

    try {
      const toolbars = document.body.querySelectorAll<HTMLElement>(".native-pdf-handwriting-toolbar");
      expect(toolbars).toHaveLength(1);
      expect(toolbars[0]?.getAttribute("aria-label")).toBe("Annotation tools");
      expect(toolbars[0]?.classList.contains("native-pdf-handwriting-toolbar-floating-fallback")).toBe(true);

      const internal = session as unknown as {
        ink: { add(stroke: InkStroke): void };
        saveCoordinator: { completedCommand(): void };
      };
      internal.ink.add({
        id: "markdown-stroke",
        page: 1,
        tool: "pen",
        color: "#000000",
        width: 2,
        opacity: 1,
        inputType: "pen",
        points: [{ x: 12, y: 20, pressure: 0.5, time: 1 }],
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z"
      });
      internal.saveCoordinator.completedCommand();
      await session.manualSave();

      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(sidecar?.[1]).toContain("markdown-stroke");
      expect(adapter.pages()).toHaveLength(1);
      expect(adapter.pages()[0]?.element).toBe(adapter.root);
      expect(adapter.root).toBe(root);
    } finally {
      await session.destroy({ silent: true });
    }
  });

  it("keeps tall Markdown note ink at display resolution within the backing pixel budget", async () => {
    mockCanvasContext();
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const files = new MemoryFiles();
    const { host } = markdownHost("preview", 5_000);
    const adapter = MarkdownViewAdapter.attach(host, {}, { mode: "preview" });
    const session = await ViewerInkSession.create({
      adapter,
      documentPath: "Notes/long-note.md",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "annotations/recovery"),
      saveSettings: async () => undefined,
      notice: () => undefined
    });

    try {
      const internal = session as unknown as {
        surfaces: Map<number, { canvas: HTMLCanvasElement }>;
      };
      const surface = internal.surfaces.get(1);
      expect(surface).toBeDefined();
      expect(surface!.canvas.width).toBe(1_280);
      expect(surface!.canvas.height).toBe(10_000);
    } finally {
      await session.destroy({ silent: true });
    }
  });
});
