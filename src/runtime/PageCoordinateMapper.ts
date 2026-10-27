export type PageRotation = 0 | 90 | 180 | 270;
export type PageCoordinateOrigin = "top-left" | "bottom-left";

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface PageCoordinateMapperOptions {
  width: number;
  height: number;
  /** Legacy uniform scale; used as the X/Y fallback. */
  scale: number;
  /** Exact rendered horizontal scale when a surface rounds axes independently. */
  scaleX?: number;
  /** Exact rendered vertical scale when a surface rounds axes independently. */
  scaleY?: number;
  rotation?: PageRotation;
  origin?: PageCoordinateOrigin;
  offsetX?: number;
  offsetY?: number;
  /** CropBox / viewBox origin X coordinate in PDF user units. Default is 0. */
  minX?: number;
  /** CropBox / viewBox origin Y coordinate in PDF user units. Default is 0. */
  minY?: number;
  /** PDF 1.6+ UserUnit scaling factor. Default is 1. */
  userUnit?: number;
}

/** Maps stable page-local annotation geometry to a live viewport. */
export class PageCoordinateMapper {
  readonly rotation: PageRotation;
  private readonly origin: PageCoordinateOrigin;

  constructor(private readonly options: PageCoordinateMapperOptions) {
    if (
      options.width <= 0
      || options.height <= 0
      || options.scale <= 0
      || (options.scaleX !== undefined && options.scaleX <= 0)
      || (options.scaleY !== undefined && options.scaleY <= 0)
      || (options.userUnit !== undefined && options.userUnit <= 0)
    ) throw new RangeError("Page dimensions and scale must be positive");
    this.rotation = options.rotation ?? 0;
    this.origin = options.origin ?? "bottom-left";
  }

  toViewport(page: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const minX = this.options.minX ?? 0;
    const minY = this.options.minY ?? 0;
    const userUnit = this.options.userUnit && this.options.userUnit > 0 ? this.options.userUnit : 1;
    const scaleX = (this.options.scaleX ?? scale) * userUnit;
    const scaleY = (this.options.scaleY ?? scale) * userUnit;
    const dx = page.x - minX;
    const dy = page.y - minY;
    let x: number;
    let y: number;
    if (this.origin === "top-left") {
      switch (this.rotation) {
        case 0: x = dx * scaleX; y = dy * scaleY; break;
        case 90: x = (h - dy) * scaleX; y = dx * scaleY; break;
        case 180: x = (w - dx) * scaleX; y = (h - dy) * scaleY; break;
        case 270: x = dy * scaleX; y = (w - dx) * scaleY; break;
      }
    } else {
      switch (this.rotation) {
        case 0: x = dx * scaleX; y = (h - dy) * scaleY; break;
        case 90: x = dy * scaleX; y = dx * scaleY; break;
        case 180: x = (w - dx) * scaleX; y = dy * scaleY; break;
        case 270: x = (h - dy) * scaleX; y = (w - dx) * scaleY; break;
      }
    }
    return { x: x! + (this.options.offsetX ?? 0), y: y! + (this.options.offsetY ?? 0) };
  }

  toPage(viewport: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const minX = this.options.minX ?? 0;
    const minY = this.options.minY ?? 0;
    const userUnit = this.options.userUnit && this.options.userUnit > 0 ? this.options.userUnit : 1;
    const scaleX = (this.options.scaleX ?? scale) * userUnit;
    const scaleY = (this.options.scaleY ?? scale) * userUnit;
    const vx = (viewport.x - (this.options.offsetX ?? 0)) / scaleX;
    const vy = (viewport.y - (this.options.offsetY ?? 0)) / scaleY;
    if (this.origin === "top-left") {
      switch (this.rotation) {
        case 0: return { x: minX + vx, y: minY + vy };
        case 90: return { x: minX + vy, y: minY + h - vx };
        case 180: return { x: minX + w - vx, y: minY + h - vy };
        case 270: return { x: minX + w - vy, y: minY + vx };
      }
    }
    switch (this.rotation) {
      case 0: return { x: minX + vx, y: minY + h - vy };
      case 90: return { x: minX + vy, y: minY + vx };
      case 180: return { x: minX + w - vx, y: minY + vy };
      case 270: return { x: minX + w - vy, y: minY + h - vx };
    }
  }

  /** @deprecated Use toPage in shared annotation code. */
  toPdf(viewport: ViewportPoint): ViewportPoint {
    return this.toPage(viewport);
  }
}

/**
 * Minimal viewport contract used by the composed coordinate pipeline.
 * HandwritingViewport implements this without making the mapper depend on the
 * integration layer.
 */
export interface ElementViewportTransform {
  screenToElementLocal(
    element: HTMLElement,
    screenPoint: ViewportPoint,
    rect?: DOMRect
  ): ViewportPoint;
  elementLocalToScreen(
    element: HTMLElement,
    localPoint: ViewportPoint,
    rect?: DOMRect
  ): ViewportPoint;
}

/**
 * Shared unscaled element-rect transform for surfaces that do not have a
 * HandwritingViewport, such as the bounded native PDF zoom handoff.
 */
export class ElementRectViewportTransform implements ElementViewportTransform {
  screenToElementLocal(
    element: HTMLElement,
    screenPoint: ViewportPoint,
    rect = element.getBoundingClientRect()
  ): ViewportPoint {
    return {
      x: screenPoint.x - rect.left,
      y: screenPoint.y - rect.top
    };
  }

  elementLocalToScreen(
    element: HTMLElement,
    localPoint: ViewportPoint,
    rect = element.getBoundingClientRect()
  ): ViewportPoint {
    return {
      x: rect.left + localPoint.x,
      y: rect.top + localPoint.y
    };
  }
}

/**
 * Canonical composed coordinate path for interaction code:
 * client <-> rendered page viewport <-> stable page/PDF coordinates.
 */
export class PageCoordinateSpace {
  constructor(
    private readonly viewport: ElementViewportTransform,
    private readonly element: HTMLElement,
    private readonly pageMapper: PageCoordinateMapper
  ) {}

  clientToViewport(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.viewport.screenToElementLocal(this.element, point, rect);
  }

  viewportToClient(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.viewport.elementLocalToScreen(this.element, point, rect);
  }

  viewportToPage(point: ViewportPoint): ViewportPoint {
    return this.pageMapper.toPage(point);
  }

  pageToViewport(point: ViewportPoint): ViewportPoint {
    return this.pageMapper.toViewport(point);
  }

  clientToPage(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.viewportToPage(this.clientToViewport(point, rect));
  }

  pageToClient(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.viewportToClient(this.pageToViewport(point), rect);
  }

  /**
   * PDF surfaces use bottom-left stable page coordinates, so this is the
   * canonical client -> PDF path there. Top-left image surfaces keep their
   * native page coordinate origin through the same API.
   */
  clientToPdf(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.clientToPage(point, rect);
  }

  pdfToClient(point: ViewportPoint, rect?: DOMRect): ViewportPoint {
    return this.pageToClient(point, rect);
  }
}
