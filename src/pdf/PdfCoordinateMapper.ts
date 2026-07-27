export type PageRotation = 0 | 90 | 180 | 270;
export interface ViewportPoint { x: number; y: number }
export interface PdfCoordinateMapperOptions {
  width: number;
  height: number;
  /** Legacy uniform scale; used as the X/Y fallback. */
  scale: number;
  /** Exact rendered horizontal scale when PDF.js rounds the canvas independently. */
  scaleX?: number;
  /** Exact rendered vertical scale when PDF.js rounds the canvas independently. */
  scaleY?: number;
  rotation?: PageRotation;
  offsetX?: number;
  offsetY?: number;
}

export class PdfCoordinateMapper {
  readonly rotation: PageRotation;
  constructor(private readonly options: PdfCoordinateMapperOptions) {
    if (
      options.width <= 0
      || options.height <= 0
      || options.scale <= 0
      || (options.scaleX !== undefined && options.scaleX <= 0)
      || (options.scaleY !== undefined && options.scaleY <= 0)
    ) throw new RangeError("Page dimensions and scale must be positive");
    this.rotation = options.rotation ?? 0;
  }

  toViewport(pdf: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const scaleX = this.options.scaleX ?? scale;
    const scaleY = this.options.scaleY ?? scale;
    let x: number; let y: number;
    switch (this.rotation) {
      case 0: x = pdf.x * scaleX; y = (h - pdf.y) * scaleY; break;
      case 90: x = pdf.y * scaleX; y = pdf.x * scaleY; break;
      case 180: x = (w - pdf.x) * scaleX; y = pdf.y * scaleY; break;
      case 270: x = (h - pdf.y) * scaleX; y = (w - pdf.x) * scaleY; break;
    }
    return { x: x + (this.options.offsetX ?? 0), y: y + (this.options.offsetY ?? 0) };
  }

  toPdf(viewport: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale } = this.options;
    const scaleX = this.options.scaleX ?? scale;
    const scaleY = this.options.scaleY ?? scale;
    const vx = (viewport.x - (this.options.offsetX ?? 0)) / scaleX;
    const vy = (viewport.y - (this.options.offsetY ?? 0)) / scaleY;
    switch (this.rotation) {
      case 0: return { x: vx, y: h - vy };
      case 90: return { x: vy, y: vx };
      case 180: return { x: w - vx, y: vy };
      case 270: return { x: w - vy, y: h - vx };
    }
  }
}
