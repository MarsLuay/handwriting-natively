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
    queueMicrotask(() => {
      page.dataset.pageNumber = "1";
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);
  });

  it("times out when pages never appear", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const pending = waitForPdfPageNodes(root, 100);
    await vi.advanceTimersByTimeAsync(100);
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

  it("accepts bare data-page-number nodes without .page class", () => {
    const root = document.createElement("div");
    const page = document.createElement("div");
    page.dataset.pageNumber = "2";
    Object.defineProperty(page, "getBoundingClientRect", {
      value: () => ({ width: 300, height: 400, top: 0, left: 0, right: 300, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
    });
    root.append(page);
    expect(queryPdfPageNodes(root)).toHaveLength(1);
  });
});
