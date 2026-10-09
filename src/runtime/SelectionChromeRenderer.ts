import type { InkStroke, PagePoint, ToolId } from "../model";
import type { Bounds } from "../ink/StrokeHitTesting";
import { visibleStrokeSegments, type SelectionShape } from "../tools/LassoTool";

export interface SelectionChromeSurface {
  page: { pageNumber: number };
  canvas: HTMLCanvasElement;
  selectionCanvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  selectionContext: CanvasRenderingContext2D;
  liveLassoChromeBounds: Bounds | null;
  editPath: readonly PagePoint[];
}

export interface SelectionChromeHost<TSurface extends SelectionChromeSurface> {
  pageLayout(surface: TSurface): { contentWidth: number; contentHeight: number };
  displayScale(surface: TSurface): number;
  toViewport(surface: TSurface, point: Pick<PagePoint, "x" | "y">): Pick<PagePoint, "x" | "y">;
}

export interface SelectionChromeState {
  activeTool: ToolId;
  selectionPage: number | null;
  selectionShape: SelectionShape | null;
  moveShapePreview: SelectionShape | null;
  selected: readonly InkStroke[];
  movePreview: readonly InkStroke[] | null;
}

/** Paints transient lasso/selection chrome without coupling it to session state. */
export class SelectionChromeRenderer<TSurface extends SelectionChromeSurface = SelectionChromeSurface> {
  constructor(private readonly host: SelectionChromeHost<TSurface>) {}

  clear(surface: TSurface): void {
    const context = surface.selectionContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, surface.selectionCanvas.width, surface.selectionCanvas.height);
    surface.liveLassoChromeBounds = null;
    surface.canvas.classList.remove("is-selection-chrome-raised");
  }

  render(surface: TSurface, state: SelectionChromeState): void {
    this.clear(surface);
    if ((state.activeTool !== "lasso" && state.activeTool !== "text")
      || state.selectionPage !== surface.page.pageNumber
      || !state.selectionShape) return;

    const shape = state.moveShapePreview ?? state.selectionShape;
    if (state.activeTool === "text") {
      // Keep the text transform marquee on the committed canvas for the
      // text-layer interaction contract; lasso chrome uses the disposable
      // canvas below so drawing-tool changes are cheap and clean.
      this.drawSelectionShape(surface, shape, true, surface.context);
      surface.canvas.classList.add("is-selection-chrome-raised");
      return;
    }

    const scale = this.prepareCanvas(surface);
    const context = surface.selectionContext;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    this.drawSelectionShape(surface, shape, true, context);
    for (const stroke of state.selected) {
      if (stroke.page !== surface.page.pageNumber) continue;
      const preview = state.movePreview?.find((item) => item.id === stroke.id) ?? stroke;
      this.drawStroke(surface, preview, context);
    }
    surface.canvas.classList.add("is-selection-chrome-raised");
  }

  renderLassoPreview(
    surface: TSurface,
    activeTool: ToolId,
    shape: SelectionShape | null
  ): void {
    if (activeTool !== "lasso") {
      this.clear(surface);
      return;
    }

    const scale = this.prepareCanvas(surface);
    this.clearPreviousLassoRegion(surface, scale);
    const context = surface.selectionContext;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (shape) this.drawSelectionShape(surface, shape, false, context);

    const viewPoints = surface.editPath.map((point) => this.host.toViewport(surface, point));
    if (viewPoints.length) {
      const xs = viewPoints.map((point) => point.x);
      const ys = viewPoints.map((point) => point.y);
      surface.liveLassoChromeBounds = {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
      };
    }
    surface.canvas.classList.add("is-selection-chrome-raised");
  }

  private prepareCanvas(surface: TSurface): number {
    const layout = this.host.pageLayout(surface);
    const fallbackWidth = Math.max(1, Math.round(layout.contentWidth));
    const fallbackHeight = Math.max(1, Math.round(layout.contentHeight));
    const width = surface.canvas.width || fallbackWidth;
    const height = surface.canvas.height || fallbackHeight;
    if (surface.selectionCanvas.width !== width) surface.selectionCanvas.width = width;
    if (surface.selectionCanvas.height !== height) surface.selectionCanvas.height = height;
    return width / Math.max(1, layout.contentWidth);
  }

  private clearPreviousLassoRegion(surface: TSurface, scale: number): void {
    const previous = surface.liveLassoChromeBounds;
    if (!previous) return;
    const context = surface.selectionContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    const padding = 10 * scale;
    const left = Math.max(0, Math.floor(previous.minX * scale - padding));
    const top = Math.max(0, Math.floor(previous.minY * scale - padding));
    const right = Math.min(surface.selectionCanvas.width, Math.ceil(previous.maxX * scale + padding));
    const bottom = Math.min(surface.selectionCanvas.height, Math.ceil(previous.maxY * scale + padding));
    if (right > left && bottom > top) context.clearRect(left, top, right - left, bottom - top);
    surface.liveLassoChromeBounds = null;
  }

  private drawStroke(surface: TSurface, stroke: InkStroke, context: CanvasRenderingContext2D): void {
    const scale = this.host.displayScale(surface);
    const segments = stroke.tool === "highlighter"
      ? visibleStrokeSegments(stroke.points, stroke.eraseMasks)
      : stroke.points.length ? [stroke.points] : [];
    context.save();
    context.globalAlpha = 0.9;
    context.strokeStyle = "#2563eb";
    context.lineWidth = Math.max(0.5, stroke.width * scale) + 4;
    context.setLineDash([4, 3]);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const segment of segments) {
      if (!segment.length) continue;
      const first = this.host.toViewport(surface, segment[0]!);
      context.beginPath();
      if (segment.length === 1) {
        context.arc(first.x, first.y, Math.max(2, context.lineWidth / 2), 0, Math.PI * 2);
      } else {
        context.moveTo(first.x, first.y);
        for (const point of segment.slice(1)) {
          const view = this.host.toViewport(surface, point);
          context.lineTo(view.x, view.y);
        }
        context.stroke();
      }
      if (segment.length === 1) context.stroke();
    }
    context.restore();
  }

  private drawSelectionShape(
    surface: TSurface,
    shape: SelectionShape,
    closeFreeform: boolean,
    context: CanvasRenderingContext2D
  ): void {
    context.save();
    context.strokeStyle = "#2563eb";
    context.fillStyle = "rgba(37, 99, 235, 0.12)";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.globalAlpha = 0.95;

    if (shape.type === "freeform") {
      const points = shape.points;
      if (!points.length) {
        context.restore();
        return;
      }
      const first = this.host.toViewport(surface, points[0]!);
      context.beginPath();
      if (points.length === 1) {
        context.arc(first.x, first.y, 3, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(first.x, first.y);
        for (const point of points.slice(1)) {
          const view = this.host.toViewport(surface, point);
          context.lineTo(view.x, view.y);
        }
        if (closeFreeform && points.length >= 3) {
          context.closePath();
          context.fill();
        }
        context.stroke();
      }
      context.restore();
      return;
    }

    const bounds = shape.bounds;
    const topLeft = this.host.toViewport(surface, { x: bounds.minX, y: bounds.maxY });
    const bottomRight = this.host.toViewport(surface, { x: bounds.maxX, y: bounds.minY });
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    context.beginPath();
    context.rect(topLeft.x, topLeft.y, width, height);
    context.fill();
    context.stroke();
    context.restore();
  }
}
