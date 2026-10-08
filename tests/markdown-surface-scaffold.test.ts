import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMarkdownEditorRoot,
  findMarkdownPreviewRoot,
  findMarkdownSurfaceRoot,
  MarkdownViewAdapter
} from "../src/integration/MarkdownViewAdapter";
import { resolvePageCoordinateLayout } from "../src/pdf/PageCoordinateLayout";

const styles = readFileSync("styles.css", "utf8");

function markdownHost(): { host: HTMLElement; preview: HTMLElement; setScrollHeight: (height: number) => void } {
  const host = document.createElement("div");
  host.className = "workspace-leaf";
  const preview = document.createElement("div");
  preview.className = "markdown-preview-view";
  Object.defineProperty(preview, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(preview, "clientHeight", { configurable: true, value: 480 });
  Object.defineProperty(preview, "scrollWidth", { configurable: true, value: 640 });
  let scrollHeight = 1_280;
  Object.defineProperty(preview, "scrollHeight", { configurable: true, get: () => scrollHeight });
  preview.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
    width: 640, height: 480, toJSON: () => ({})
  });
  host.append(preview);
  document.body.append(host);
  return { host, preview, setScrollHeight: (height) => { scrollHeight = height; } };
}

function markdownEditorHost(): {
  host: HTMLElement;
  sourceView: HTMLElement;
  scroller: HTMLElement;
  content: HTMLElement;
  setScrollHeight: (height: number) => void;
} {
  const host = document.createElement("div");
  host.className = "workspace-leaf";
  const sourceView = document.createElement("div");
  sourceView.className = "markdown-source-view";
  const editor = document.createElement("div");
  editor.className = "cm-editor";
  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  scroller.style.overflow = "auto";
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 640 },
    clientHeight: { configurable: true, value: 480 },
    scrollWidth: { configurable: true, value: 640 }
  });
  let scrollHeight = 1_600;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
  scroller.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
    width: 640, height: 480, toJSON: () => ({})
  });
  const content = document.createElement("div");
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  scroller.append(content);
  editor.append(scroller);
  sourceView.append(editor);
  host.append(sourceView);
  document.body.append(host);
  return { host, sourceView, scroller, content, setScrollHeight: (height) => { scrollHeight = height; } };
}

afterEach(() => document.body.replaceChildren());

describe("Markdown annotation surface", () => {
  it("discovers the active Reading or CodeMirror editing root", () => {
    const { host, preview } = markdownHost();
    expect(findMarkdownPreviewRoot(host)).toBe(preview);
    expect(findMarkdownSurfaceRoot(host, "preview")).toBe(preview);

    const { host: sourceHost, scroller } = markdownEditorHost();
    expect(findMarkdownEditorRoot(sourceHost)).toBe(scroller);
    expect(findMarkdownSurfaceRoot(sourceHost, "source")).toBe(scroller);
    const misleadingPreview = document.createElement("div");
    misleadingPreview.className = "markdown-preview-view";
    scroller.append(misleadingPreview);
    expect(findMarkdownPreviewRoot(sourceHost)).toBeNull();
  });

  it("provides one top-left page with shared overlay lifecycle", async () => {
    const { host, preview, setScrollHeight } = markdownHost();
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
      scrollContentGeometry: true,
      geometrySafe: true,
      identitySafe: true
    });
    expect(resolvePageCoordinateLayout(adapter.pages()[0]!)).toMatchObject({
      contentWidth: 640,
      contentHeight: 1_280,
      scale: 1,
      scaleX: 1,
      scaleY: 1
    });

    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar);
    expect(overlay.dataset.surfaceType).toBe("markdown");
    expect(overlay.parentElement).toBe(preview);
    expect(toolbar.parentElement).toBe(host);

    setScrollHeight(1_440);
    preview.append(document.createElement("p"));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    expect(pagesChanged).toHaveBeenCalledWith("markdown-render");

    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
    expect(preview.classList.contains("native-pdf-handwriting-relative")).toBe(false);
    expect(adapter.compatibilityReport().errors).toEqual([]);
  });

  it("keeps native PDF embeds above the Markdown annotation overlay", () => {
    const { host, preview } = markdownHost();
    const pdfEmbed = document.createElement("div");
    pdfEmbed.className = "internal-embed pdf-embed";
    pdfEmbed.setAttribute("src", "Slides/lecture.pdf");
    preview.append(pdfEmbed);

    const adapter = MarkdownViewAdapter.attach(host);
    const overlay = adapter.mountOverlay(1);
    const embedRule = styles.match(
      /\.native-pdf-handwriting-markdown-surface \.internal-embed\[src\$="\.pdf"\],[\s\S]*?\.native-pdf-handwriting-markdown-surface \.pdf-embed \{([\s\S]*?)\n\}/
    )?.[1];

    expect(overlay.parentElement).toBe(preview);
    expect(preview.classList.contains("native-pdf-handwriting-markdown-surface")).toBe(true);
    expect(embedRule).toContain("z-index: 5");
    expect(embedRule).toContain("position: relative");

    adapter.destroy();
    expect(pdfEmbed.isConnected).toBe(true);
    expect(pdfEmbed.parentElement).toBe(preview);
    expect(preview.classList.contains("native-pdf-handwriting-markdown-surface")).toBe(false);
  });

  it("mounts editing ink beside, never inside, CodeMirror's editable content", async () => {
    const { host, scroller, content, setScrollHeight } = markdownEditorHost();
    const pagesChanged = vi.fn();
    const adapter = MarkdownViewAdapter.attach(host, { onPagesChanged: pagesChanged }, { mode: "source" });
    expect(adapter.root).toBe(scroller);
    expect(adapter.scrollElement()).toBe(scroller);
    expect(adapter.pages()[0]).toMatchObject({ width: 640, height: 1_600, scrollContentGeometry: true });
    expect(resolvePageCoordinateLayout(adapter.pages()[0]!)).toMatchObject({
      contentWidth: 640,
      contentHeight: 1_600,
      scale: 1,
      scaleX: 1,
      scaleY: 1
    });

    const scrollIntoView = vi.fn();
    Object.defineProperty(scroller, "scrollIntoView", { configurable: true, value: scrollIntoView });
    scroller.scrollTop = 240;
    adapter.focusPage(1);
    adapter.restoreViewState({
      pageNumber: 1,
      scrollFraction: 0,
      scale: 1,
      rotation: 0,
      viewport: { scale: 1, x: 0, y: 120 }
    });
    const overlay = adapter.mountOverlay(1);
    expect(overlay.parentElement).toBe(scroller);
    expect(overlay.parentElement).not.toBe(content);
    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(scroller.scrollTop).toBe(240);
    expect(scrollIntoView).not.toHaveBeenCalled();

    setScrollHeight(1_800);
    content.append(document.createTextNode("new line"));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    expect(pagesChanged).toHaveBeenCalledTimes(1);
    expect(pagesChanged).toHaveBeenCalledWith("markdown-render");

    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
  });

  it("fails closed when a caller supplies a surface root outside the Markdown host", () => {
    const { host } = markdownHost();
    const outside = document.createElement("div");
    outside.className = "markdown-preview-view";
    expect(() => MarkdownViewAdapter.attach(host, {}, { mode: "preview", surfaceRoot: outside }))
      .toThrow("Markdown surface root is outside its host");
  });
});
