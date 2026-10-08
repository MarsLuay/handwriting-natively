import { afterEach, describe, expect, it, vi } from "vitest";
import { findMarkdownPreviewRoot, MarkdownViewAdapter } from "../src/integration/MarkdownViewAdapter";

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

afterEach(() => document.body.replaceChildren());

describe("Markdown Reading surface", () => {
  it("discovers Reading view but never treats a source editor as a preview", () => {
    const { host, preview } = markdownHost();
    expect(findMarkdownPreviewRoot(host)).toBe(preview);

    const sourceHost = document.createElement("div");
    sourceHost.className = "cm-editor";
    const misleadingPreview = document.createElement("div");
    misleadingPreview.className = "markdown-preview-view";
    sourceHost.append(misleadingPreview);
    expect(findMarkdownPreviewRoot(sourceHost)).toBeNull();
  });

  it("provides one top-left page with shared overlay lifecycle", async () => {
    const { host, preview } = markdownHost();
    const pagesChanged = vi.fn();
    const adapter = MarkdownViewAdapter.attach(host, { onPagesChanged: pagesChanged });

    expect(adapter.surfaceType).toBe("markdown");
    expect(adapter.root).toBe(preview);
    expect(adapter.pages()[0]).toMatchObject({
      pageNumber: 1,
      width: 640,
      height: 1_280,
      scale: 1,
      coordinateOrigin: "top-left",
      geometrySafe: true,
      identitySafe: true
    });

    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar);
    expect(overlay.dataset.surfaceType).toBe("markdown");
    expect(overlay.parentElement).toBe(preview);
    expect(toolbar.parentElement).toBe(host);

    preview.append(document.createElement("p"));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(pagesChanged).toHaveBeenCalledWith("markdown-render");

    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
    expect(preview.classList.contains("native-pdf-handwriting-relative")).toBe(false);
    expect(adapter.compatibilityReport().errors).toEqual([]);
  });

  it("fails closed when a caller supplies a preview outside the Markdown host", () => {
    const { host } = markdownHost();
    const outside = document.createElement("div");
    outside.className = "markdown-preview-view";
    expect(() => MarkdownViewAdapter.attach(host, {}, { previewRoot: outside }))
      .toThrow("Markdown preview root is outside its host");
  });
});
