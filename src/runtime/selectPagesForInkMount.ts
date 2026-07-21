import type { PdfPageInfo } from "../integration/PdfPageLocator";

export interface SelectPagesForInkMountOptions {
  mobile: boolean;
  currentPage: number;
  /** Neighbor pages to keep mounted around the current page. */
  pad?: number;
  /**
   * @deprecated Viewport intersection scanned every DOM page via getBoundingClientRect
   * and caused mobile scroll storms on large textbooks. Ignored — currentPage ± pad only.
   */
  scrollRoot?: HTMLElement | null;
}

/**
 * On mobile, mounting ink canvases for every DOM page OOMs Obsidian's WebView
 * (large textbooks often keep many `.page` nodes in the tree). Keep current
 * page ± pad only — no N-wide rect scans (unreliable during pinch anyway).
 */
export function selectPagesForInkMount(
  pages: PdfPageInfo[],
  options: SelectPagesForInkMountOptions
): PdfPageInfo[] {
  if (!options.mobile || pages.length <= 3) return pages;
  const pad = options.pad ?? 1;
  const keep = new Set<number>();
  for (let delta = -pad; delta <= pad; delta += 1) {
    keep.add(options.currentPage + delta);
  }
  const selected = pages.filter((page) => keep.has(page.pageNumber));
  if (selected.length > 0) return selected;
  return pages.slice(0, Math.min(3, pages.length));
}
