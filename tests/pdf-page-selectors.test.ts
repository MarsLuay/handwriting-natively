import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describePdfPageDom,
  ensurePdfPageNumbers,
  queryPdfPageNodes,
  waitForPdfPageNodes
} from "../src/integration/pdfPageSelectors";

describe("pdfPageSelectors", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("resolves immediately when numbered pages already exist", async () => {
    const root = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    root.append(page);
    await expect(waitForPdfPageNodes(root, 1_000)).resolves.toBe(true);
    expect(queryPdfPageNodes(root)).toHaveLength(1);
  });

  it("waits for data-page-number to appear on mobile-style delayed mount", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const page = document.createElement("div");
    page.className = "page";
    root.append(page);

    const pending = waitForPdfPageNodes(root, 5_000);
    window.setTimeout(() => {
      page.dataset.pageNumber = "1";
    }, 150);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(true);
  });

  it("times out when pages never appear", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const pending = waitForPdfPageNodes(root, 250);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(false);
  });

  it("describePdfPageDom reports candidate pages without numbers", () => {
    const root = document.createElement("div");
    root.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    root.append(page);
    expect(describePdfPageDom(root)).toMatchObject({
      viewerRoot: true,
      numberedPageCount: 0,
      candidatePageCount: 1,
      firstCandidateHasPageNumber: false
    });
  });

  it("ensurePdfPageNumbers stamps plausible page shells without data-page-number", () => {
    const root = document.createElement("div");
    root.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    Object.defineProperty(page, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    });
    root.append(page);
    expect(queryPdfPageNodes(root)).toHaveLength(0);
    expect(ensurePdfPageNumbers(root)).toBe(1);
    expect(page.dataset.pageNumber).toBe("1");
    expect(queryPdfPageNodes(root)).toHaveLength(1);
  });

  it("does not treat handwriting overlay as a PDF page node", () => {
    const root = document.createElement("div");
    root.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    Object.defineProperty(page, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    });
    const wrapper = document.createElement("div");
    wrapper.className = "canvasWrapper";
    wrapper.append(document.createElement("canvas"));
    const overlay = document.createElement("div");
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = "1";
    const ink = document.createElement("canvas");
    ink.className = "native-pdf-handwriting-canvas";
    overlay.append(ink);
    page.append(wrapper, overlay);
    root.append(page);

    expect(queryPdfPageNodes(root)).toHaveLength(0);
    expect(queryPdfPageNodes(root).some((el) => el.classList.contains("native-pdf-handwriting-page-overlay"))).toBe(false);
    expect(ensurePdfPageNumbers(root)).toBe(1);
    expect(queryPdfPageNodes(root)[0]).toBe(page);
  });

  it("still finds .page nodes inside the sidebar chrome wrapper", () => {
    // mountToolbar wraps the scroller in .native-pdf-handwriting-chrome; pages
    // live under that node and must remain discoverable for ink surfaces.
    const chrome = document.createElement("div");
    chrome.className = "native-pdf-handwriting-chrome is-toolbar-right";
    const root = document.createElement("div");
    root.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    const text = document.createElement("div");
    text.className = "textLayer";
    page.append(text);
    root.append(page);
    chrome.append(root);
    document.body.append(chrome);

    expect(queryPdfPageNodes(root)).toEqual([page]);
    expect(queryPdfPageNodes(chrome)).toEqual([page]);
  });
});
