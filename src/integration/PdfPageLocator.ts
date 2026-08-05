import type { PdfJsViewerLike } from "./PdfViewerCompatibility";
import {
  ensurePdfPageNumbers,
  isHandwritingPageChrome,
  looksLikePdfPage,
  queryPdfPageNodes
} from "./pdfPageSelectors";
import { pdfRenderCanvas } from "../pdf/PageCoordinateLayout";

export interface PdfPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  element: HTMLElement;
}

interface CanonicalPageSize {
  width: number;
  height: number;
}

const PLAUSIBLE_PDF_MIN = 200;
const PLAUSIBLE_PDF_MAX = 2500;

export class PdfPageLocator {
  private readonly canonicalByElement = new WeakMap<HTMLElement, CanonicalPageSize>();

  constructor(private readonly viewerRoot: HTMLElement, private readonly privateViewer?: PdfJsViewerLike) {}

  pages(): PdfPageInfo[] {
    // PDF.js / Obsidian Mobile can leave duplicate `.page[data-page-number=N]`
    // shells after pinch zoom. Keep one live shell per number so zoom Maps and
    // mobile `page(N)` agree (last connected shell with a PDF canvas wins).
    const byNumber = new Map<number, PdfPageInfo>();
    for (const element of queryPdfPageNodes(this.viewerRoot)) {
      const info = this.info(element);
      const previous = byNumber.get(info.pageNumber);
      byNumber.set(
        info.pageNumber,
        previous ? this.info(this.preferLivePageElement(previous.element, element)) : info
      );
    }
    return [...byNumber.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  }

  page(pageNumber: number): PdfPageInfo | undefined {
    // Stamp missing numbers on `.page` shells before the bare `[data-page-number]`
    // fallback can resolve HN overlays that carry the same attribute.
    ensurePdfPageNumbers(this.viewerRoot);
    const numbered = Array.from(
      this.viewerRoot.querySelectorAll<HTMLElement>(
        `.page[data-page-number="${pageNumber}"], .pdf-page-view[data-page-number="${pageNumber}"]`
      )
    ).filter((element) => !isHandwritingPageChrome(element));
    if (numbered.length > 0) {
      return this.info(this.preferLivePageElement(...numbered));
    }
    const fallback: HTMLElement[] = [];
    for (const element of this.viewerRoot.querySelectorAll<HTMLElement>(`[data-page-number="${pageNumber}"]`)) {
      if (isHandwritingPageChrome(element) || !looksLikePdfPage(element)) continue;
      fallback.push(element);
    }
    if (fallback.length === 0) return undefined;
    return this.info(this.preferLivePageElement(...fallback));
  }

  /**
   * Prefer the shell that still hosts a native PDF canvas. After pinch zoom the
   * first `querySelector` hit can be a connected predecessor while hits land on
   * a later sibling — PointerRouter on the predecessor never sees pen events.
   *
   * When multiple shells keep a canvas, prefer the one whose canvas is topmost
   * under `elementFromPoint` (paint order), not merely last in DOM order.
   */
  private preferLivePageElement(...candidates: HTMLElement[]): HTMLElement {
    if (candidates.length <= 1) return candidates[0]!;
    const connected = candidates.filter((element) => element.isConnected);
    const pool = connected.length > 0 ? connected : candidates;
    const withCanvas = pool.filter((element) => Boolean(pdfRenderCanvas(element)));
    const ranked = withCanvas.length > 0 ? withCanvas : pool;
    if (ranked.length === 1) return ranked[0]!;
    const hitReceiving = this.pickHitReceivingShell(ranked);
    if (hitReceiving) return hitReceiving;
    const withOverlay = ranked.find((element) =>
      Boolean(element.querySelector(":scope > .native-pdf-handwriting-page-overlay"))
    );
    if (withOverlay) return withOverlay;
    return ranked[ranked.length - 1]!;
  }

  /** Pick the shell whose PDF canvas is the topmost hit at its visual center. */
  private pickHitReceivingShell(candidates: HTMLElement[]): HTMLElement | null {
    const doc = candidates[0]?.ownerDocument;
    if (!doc?.elementFromPoint) return null;
    // Walk last→first so a covering later sibling is checked before an underlayer.
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const element = candidates[i]!;
      const canvas = pdfRenderCanvas(element);
      if (!canvas) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!(top instanceof Element)) continue;
      if (top === canvas || canvas.contains(top) || element.contains(top)) {
        const hitPage = top.closest(".page, .pdf-page-view");
        if (hitPage === element || element.contains(top)) return element;
      }
    }
    return null;
  }

  pageAt(clientX: number, clientY: number): PdfPageInfo | undefined {
    return this.pages().find(({ element }) => {
      const rect = element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
  }

  currentPage(): number {
    return this.privateViewer?.currentPageNumber ?? this.pages()[0]?.pageNumber ?? 1;
  }

  private info(element: HTMLElement): PdfPageInfo {
    const rect = element.getBoundingClientRect();
    const pageNumber = Number(element.dataset.pageNumber) || 1;
    const scale = this.scaleFor(element);
    const rotation = this.number(element.dataset.rotation, this.number(this.privateViewer?.pagesRotation, 0));
    const { width, height } = this.canonicalSize(element, rect, scale, rotation);
    return { pageNumber, width, height, scale, rotation, element };
  }

  private canonicalSize(
    element: HTMLElement,
    rect: DOMRect,
    scale: number,
    rotation: number
  ): CanonicalPageSize {
    const fromDataset = this.sizeFromDataset(element);
    if (fromDataset) {
      this.canonicalByElement.set(element, fromDataset);
      return fromDataset;
    }

    const fromCanvasCss = this.sizeFromCanvasCss(element, scale, rotation);
    if (fromCanvasCss && this.isPlausible(fromCanvasCss)) {
      this.canonicalByElement.set(element, fromCanvasCss);
      return fromCanvasCss;
    }

    const rotated = rotation % 180 !== 0;
    if (rect.width > 0 && rect.height > 0 && scale > 0) {
      const inferred = {
        width: (rotated ? rect.height : rect.width) / scale,
        height: (rotated ? rect.width : rect.height) / scale
      };
      if (this.isPlausible(inferred)) {
        this.canonicalByElement.set(element, inferred);
        return inferred;
      }
    }

    const fromCanvasBitmap = this.sizeFromCanvasBitmap(element, scale, rotation);
    if (fromCanvasBitmap && this.isPlausible(fromCanvasBitmap)) {
      this.canonicalByElement.set(element, fromCanvasBitmap);
      return fromCanvasBitmap;
    }

    const cached = this.canonicalByElement.get(element);
    if (cached) return cached;
    return fromCanvasCss ?? fromCanvasBitmap ?? { width: 1, height: 1 };
  }

  private sizeFromDataset(element: HTMLElement): CanonicalPageSize | undefined {
    const width = this.number(element.dataset.pdfWidth, 0);
    const height = this.number(element.dataset.pdfHeight, 0);
    if (width > 0 && height > 0) return { width, height };
    return undefined;
  }

  private sizeFromCanvasCss(element: HTMLElement, scale: number, rotation: number): CanonicalPageSize | undefined {
    const canvas = pdfRenderCanvas(element);
    if (!canvas || !(scale > 0)) return undefined;
    const cssWidth = canvas.clientWidth || 0;
    const cssHeight = canvas.clientHeight || 0;
    if (!(cssWidth > 8 && cssHeight > 8)) return undefined;
    const rotated = rotation % 180 !== 0;
    return {
      width: (rotated ? cssHeight : cssWidth) / scale,
      height: (rotated ? cssWidth : cssHeight) / scale
    };
  }

  private sizeFromCanvasBitmap(element: HTMLElement, scale: number, rotation: number): CanonicalPageSize | undefined {
    const canvas = pdfRenderCanvas(element);
    if (!canvas || !(scale > 0)) return undefined;
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const bitmapWidth = canvas.width / ratio;
    const bitmapHeight = canvas.height / ratio;
    if (!(bitmapWidth > 0 && bitmapHeight > 0)) return undefined;
    const rotated = rotation % 180 !== 0;
    return {
      width: (rotated ? bitmapHeight : bitmapWidth) / scale,
      height: (rotated ? bitmapWidth : bitmapHeight) / scale
    };
  }

  private scaleFor(element: HTMLElement): number {
    const fromPage = this.number(element.dataset.scale, 0);
    const fromViewer = this.number(this.privateViewer?.currentScale, 0);
    const canvas = pdfRenderCanvas(element);
    const cssWidth = canvas ? (canvas.clientWidth || canvas.getBoundingClientRect().width) : 0;

    if (fromPage > 0 && fromViewer > 0 && Math.abs(fromPage - fromViewer) > 0.01 && cssWidth > 8) {
      const pageWidth = cssWidth / fromPage;
      const viewerWidth = cssWidth / fromViewer;
      const pageOk = this.isPlausibleWidth(pageWidth);
      const viewerOk = this.isPlausibleWidth(viewerWidth);
      if (viewerOk && !pageOk) return fromViewer;
      // Zoom-out lag: leftover large canvas still matches stale *high* data-scale while
      // PDF.js currentScale already dropped. Never prefer that page scale.
      if (pageOk && !viewerOk && fromPage <= fromViewer) return fromPage;
      // Measurable canvas + disagreement → trust live viewer (not stale page shells).
      return fromViewer;
    }
    if (fromPage > 0) return fromPage;
    if (fromViewer > 0) return fromViewer;
    return 1;
  }

  private isPlausible(size: CanonicalPageSize): boolean {
    return this.isPlausibleWidth(size.width) && this.isPlausibleWidth(size.height);
  }

  private isPlausibleWidth(value: number): boolean {
    return value >= PLAUSIBLE_PDF_MIN && value <= PLAUSIBLE_PDF_MAX;
  }

  private number(value: unknown, fallback: number): number {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
