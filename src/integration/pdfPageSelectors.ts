/** Canonical rendered-page selectors shared by attach, locator, and observers. */
export const PDF_PAGE_SELECTOR =
  ".page[data-page-number], .pdf-page-view[data-page-number]";

/** Present before PDF.js stamps `data-page-number` (common on first mobile paint). */
export const PDF_PAGE_CANDIDATE_SELECTOR = ".page, .pdf-page-view";

export function looksLikePdfPage(element: HTMLElement): boolean {
  if (element.querySelector("canvas, .canvasWrapper, .textLayer, .annotationLayer")) return true;
  const rect = element.getBoundingClientRect();
  return rect.width >= 50 && rect.height >= 50;
}

export function queryPdfPageNodes(root: ParentNode): HTMLElement[] {
  const numbered = Array.from(root.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR));
  if (numbered.length > 0) return numbered;
  // Some Obsidian builds stamp data-page-number without .page / .pdf-page-view.
  return Array.from(root.querySelectorAll<HTMLElement>("[data-page-number]")).filter(looksLikePdfPage);
}

export function queryPdfPageCandidates(root: ParentNode): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(PDF_PAGE_CANDIDATE_SELECTOR));
  if (candidates.length > 0) return candidates;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-page-number]")).filter(looksLikePdfPage);
}

/**
 * Stamp sequential `data-page-number` on page shells that mounted without it.
 * Mobile Obsidian / PDF.js sometimes never sets the attribute even after canvases exist.
 * Returns how many nodes were stamped.
 */
export function ensurePdfPageNumbers(root: HTMLElement): number {
  const candidates = queryPdfPageCandidates(root);
  let stamped = 0;
  candidates.forEach((element, index) => {
    if (element.hasAttribute("data-page-number")) return;
    if (!looksLikePdfPage(element)) return;
    element.dataset.pageNumber = String(index + 1);
    stamped += 1;
  });
  return stamped;
}

/**
 * Wait until at least one numbered page node exists under `root`.
 * Mobile PDF.js often mounts the viewer shell before page nodes.
 */
export function waitForPdfPageNodes(root: HTMLElement, timeoutMs = 5_000): Promise<boolean> {
  if (queryPdfPageNodes(root).length > 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(ok);
    };

    const observer = new MutationObserver(() => {
      ensurePdfPageNumbers(root);
      if (queryPdfPageNodes(root).length > 0) finish(true);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-page-number", "class"]
    });

    const timer = window.setTimeout(() => {
      ensurePdfPageNumbers(root);
      finish(queryPdfPageNodes(root).length > 0);
    }, timeoutMs);
  });
}

export function describePdfPageDom(root: HTMLElement | undefined): Record<string, unknown> {
  if (!root) {
    return { viewerRoot: false };
  }
  const pages = queryPdfPageNodes(root);
  const candidates = queryPdfPageCandidates(root);
  const canvases = root.querySelectorAll("canvas").length;
  const childSample = Array.from(root.children)
    .slice(0, 8)
    .map((child) => {
      const el = child as HTMLElement;
      return {
        tag: el.tagName,
        className: typeof el.className === "string" ? el.className.slice(0, 120) : null,
        hasPageNumber: el.hasAttribute("data-page-number")
      };
    });
  return {
    viewerRoot: true,
    viewerRootTag: root.tagName,
    viewerRootClasses: typeof root.className === "string" ? root.className.slice(0, 160) : null,
    childElementCount: root.childElementCount,
    numberedPageCount: pages.length,
    candidatePageCount: candidates.length,
    canvasCount: canvases,
    firstCandidateTag: candidates[0]?.tagName ?? null,
    firstCandidateClasses: candidates[0]?.className || null,
    firstCandidateHasPageNumber: candidates[0]?.hasAttribute("data-page-number") ?? false,
    childSample
  };
}
