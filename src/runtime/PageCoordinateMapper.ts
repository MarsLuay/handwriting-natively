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
    ) throw new RangeError("Page dimensions and scale must be positive");
    this.rotation = options.rotation ?? 0;
    this.origin = options.origin ?? "bottom-left";
  }

  toViewport(page: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const scaleX = this.options.scaleX ?? scale;
    const scaleY = this.options.scaleY ?? scale;
    let x: number;
    let y: number;
    if (this.origin === "top-left") {
      switch (this.rotation) {
        case 0: x = page.x * scaleX; y = page.y * scaleY; break;
        case 90: x = (h - page.y) * scaleX; y = page.x * scaleY; break;
        case 180: x = (w - page.x) * scaleX; y = (h - page.y) * scaleY; break;
        case 270: x = page.y * scaleX; y = (w - page.x) * scaleY; break;
      }
    } else {
      switch (this.rotation) {
        case 0: x = page.x * scaleX; y = (h - page.y) * scaleY; break;
        case 90: x = page.y * scaleX; y = page.x * scaleY; break;
        case 180: x = (w - page.x) * scaleX; y = page.y * scaleY; break;
        case 270: x = (h - page.y) * scaleX; y = (w - page.x) * scaleY; break;
      }
    }
    return { x: x! + (this.options.offsetX ?? 0), y: y! + (this.options.offsetY ?? 0) };
  }

  toPage(viewport: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const scaleX = this.options.scaleX ?? scale;
    const scaleY = this.options.scaleY ?? scale;
    const vx = (viewport.x - (this.options.offsetX ?? 0)) / scaleX;
    const vy = (viewport.y - (this.options.offsetY ?? 0)) / scaleY;
    if (this.origin === "top-left") {
      switch (this.rotation) {
        case 0: return { x: vx, y: vy };
        case 90: return { x: vy, y: h - vx };
        case 180: return { x: w - vx, y: h - vy };
        case 270: return { x: w - vy, y: vx };
      }
    }
    switch (this.rotation) {
      case 0: return { x: vx, y: h - vy };
      case 90: return { x: vy, y: vx };
      case 180: return { x: w - vx, y: vy };
      case 270: return { x: w - vy, y: h - vx };
    }
  }

  /** @deprecated Use toPage in shared annotation code. */
  toPdf(viewport: ViewportPoint): ViewportPoint {
    return this.toPage(viewport);
  }
}
