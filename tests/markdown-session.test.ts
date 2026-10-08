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

function markdownHost(): { host: HTMLElement; preview: HTMLElement } {
  const host = document.createElement("div");
  host.className = "workspace-leaf";
  const preview = document.createElement("div");
  preview.className = "markdown-preview-view";
  Object.defineProperty(preview, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(preview, "clientHeight", { configurable: true, value: 480 });
  Object.defineProperty(preview, "scrollWidth", { configurable: true, value: 640 });
  Object.defineProperty(preview, "scrollHeight", { configurable: true, value: 1_280 });
  preview.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
    width: 640, height: 480, toJSON: () => ({})
  });
  host.append(preview);
  document.body.append(host);
  return { host, preview };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Markdown annotation session", () => {
  it("uses the canonical floating toolbar and persists annotations to the Markdown sidecar", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      ellipse: vi.fn(), drawImage: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const files = new MemoryFiles();
    const { host } = markdownHost();
    const adapter = MarkdownViewAdapter.attach(host);
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
    } finally {
      await session.destroy({ silent: true });
    }
  });
});
