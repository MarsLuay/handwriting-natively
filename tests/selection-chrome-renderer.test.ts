import { describe, expect, it, vi } from "vitest";
import type { InkStroke, PagePoint } from "../src/model";
import type { SelectionShape } from "../src/tools/LassoTool";
import {
  SelectionChromeRenderer,
  type SelectionChromeSurface
} from "../src/runtime/SelectionChromeRenderer";

function makeContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn(),
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineCap: "round",
    lineJoin: "round"
  } as unknown as CanvasRenderingContext2D;
}

function makeSurface(): SelectionChromeSurface {
  const canvas = document.createElement("canvas");
  canvas.width = 1_000;
  canvas.height = 800;
  const selectionCanvas = document.createElement("canvas");
  return {
    page: { pageNumber: 1 },
    canvas,
    selectionCanvas,
    context: makeContext(),
    selectionContext: makeContext(),
    liveLassoChromeBounds: null,
    editPath: []
  };
}

function makeRenderer() {
  return new SelectionChromeRenderer<SelectionChromeSurface>({
    pageLayout: vi.fn().mockReturnValue({ contentWidth: 500, contentHeight: 400 }),
    displayScale: vi.fn().mockReturnValue(1),
    toViewport: (_surface, point) => ({ x: point.x + 10, y: point.y + 20 })
  });
}

const point = (x: number, y: number): PagePoint => ({ x, y, pressure: 0.5, time: 0 });

const rectangle: SelectionShape = {
  type: "rectangle",
  bounds: { minX: 1, minY: 2, maxX: 5, maxY: 8 }
};

describe("SelectionChromeRenderer", () => {
  it("renders live lasso chrome and clears only the previous damaged region", () => {
    const surface = makeSurface();
    surface.liveLassoChromeBounds = { minX: 5, minY: 6, maxX: 10, maxY: 12 };
    surface.editPath = [point(1, 2), point(5, 8)];
    const renderer = makeRenderer();

    renderer.renderLassoPreview(surface, "lasso", rectangle);

    expect(surface.selectionCanvas.width).toBe(1_000);
    expect(surface.selectionCanvas.height).toBe(800);
    expect(surface.selectionContext.clearRect).toHaveBeenCalledWith(0, 0, 40, 44);
    expect(surface.liveLassoChromeBounds).toEqual({ minX: 11, minY: 22, maxX: 15, maxY: 28 });
    expect(surface.selectionContext.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(surface.canvas.classList.contains("is-selection-chrome-raised")).toBe(true);
  });

  it("draws moved selected strokes on the disposable canvas, not the committed canvas", () => {
    const surface = makeSurface();
    const renderer = makeRenderer();
    const selected = {
      id: "stroke-1",
      page: 1,
      tool: "pen",
      width: 2,
      points: [point(1, 2), point(3, 4)]
    } as InkStroke;
    const moved = {
      ...selected,
      points: [point(10, 20), point(30, 40)]
    } as InkStroke;

    renderer.render(surface, {
      activeTool: "lasso",
      selectionPage: 1,
      selectionShape: rectangle,
      moveShapePreview: null,
      selected: [selected],
      movePreview: [moved]
    });

    expect(surface.selectionContext.moveTo).toHaveBeenCalledWith(20, 40);
    expect(surface.selectionContext.lineTo).toHaveBeenCalledWith(40, 60);
    expect(surface.selectionContext.stroke).toHaveBeenCalled();
    expect(surface.context.stroke).not.toHaveBeenCalled();
  });

  it("keeps text selection framing on the committed canvas", () => {
    const surface = makeSurface();
    const renderer = makeRenderer();

    renderer.render(surface, {
      activeTool: "text",
      selectionPage: 1,
      selectionShape: rectangle,
      moveShapePreview: null,
      selected: [],
      movePreview: null
    });

    expect(surface.context.rect).toHaveBeenCalledWith(11, 28, 4, -6);
    expect(surface.context.stroke).toHaveBeenCalled();
    expect(surface.selectionContext.stroke).not.toHaveBeenCalled();
  });
});
