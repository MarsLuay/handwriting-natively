import { describe, expect, it } from "vitest";
import type { PdfPoint } from "../src/model";
import { recognizeHeldShape, resizeShapePoints, shapeResizeAnchor, SHAPE_RECOGNITION_HOLD_MS } from "../src/tools/ShapeRecognizer";

const point = (x: number, y: number): PdfPoint => ({ x, y, pressure: 0.5, time: 0 });

describe("stationary-hold shape recognition", () => {
  it("snaps after a half-second stationary hold", () => {
    expect(SHAPE_RECOGNITION_HOLD_MS).toBe(500);
  });

  it("turns a confident freehand line into a clean two-point line", () => {
    const result = recognizeHeldShape([point(0, 0), point(25, 0.3), point(75, -0.2), point(100, 0)]);
    expect(result?.kind).toBe("line");
    expect(result?.points).toHaveLength(2);
    expect(result?.points[1]).toMatchObject({ x: 100, y: 0 });
  });

  it("recognises closed rectangles and triangles without reshaping uncertain ink", () => {
    const rectangle = recognizeHeldShape([point(0, 0), point(100, 0), point(100, 60), point(0, 60), point(0, 0)]);
    expect(rectangle?.kind).toBe("rectangle");
    expect(rectangle?.points.at(-1)).toMatchObject({ x: 0, y: 0 });
    const verticalRectangle = recognizeHeldShape([point(0, 0), point(0, 100), point(60, 100), point(60, 0), point(0, 0)]);
    expect(verticalRectangle?.kind).toBe("rectangle");
    const triangle = recognizeHeldShape([point(0, 0), point(100, 0), point(50, 80), point(0, 0)]);
    expect(triangle?.kind).toBe("triangle");
    expect(recognizeHeldShape([point(0, 0), point(10, 25), point(2, 12), point(20, 40)])).toBeNull();
  });

  it("recognises and snaps axis-aligned and rotated squares as constrained shapes", () => {
    const square = recognizeHeldShape([point(0, 0), point(102, 1), point(100, 98), point(-1, 100), point(0, 0)]);
    expect(square?.kind).toBe("square");
    const sides = square!.points.slice(1).map((corner, index) => Math.hypot(corner.x - square!.points[index]!.x, corner.y - square!.points[index]!.y));
    expect(Math.max(...sides) - Math.min(...sides)).toBeLessThan(1e-6);

    const rotatedSquare = recognizeHeldShape([
      point(50, 0), point(100, 50), point(50, 100), point(0, 50), point(50, 0)
    ]);
    expect(rotatedSquare?.kind).toBe("square");
  });

  it("snaps rough circles to circles and retains intentional ovals as ellipses", () => {
    const roughCircle = Array.from({ length: 17 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 16;
      const radius = 50 + (index % 2 === 0 ? 3 : -2);
      return point(60 + Math.cos(angle) * radius, 60 + Math.sin(angle) * radius);
    });
    const circle = recognizeHeldShape(roughCircle);
    expect(circle?.kind).toBe("circle");
    const radii = circle!.points.slice(0, -1).map((candidate) => Math.hypot(candidate.x - 60, candidate.y - 60));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);

    const oval = Array.from({ length: 17 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 16;
      return point(100 + Math.cos(angle) * 70, 60 + Math.sin(angle) * 40);
    });
    expect(recognizeHeldShape(oval)?.kind).toBe("ellipse");
  });

  it("recognises a regular five-point star", () => {
    const star = Array.from({ length: 11 }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.PI * index) / 5;
      const radius = index % 2 === 0 ? 50 : 24;
      return point(60 + Math.cos(angle) * radius, 60 + Math.sin(angle) * radius);
    });
    expect(recognizeHeldShape(star)?.kind).toBe("star");
  });

  it("resizes a locked shape instead of reverting to the raw held stroke", () => {
    const rectangle = recognizeHeldShape([point(0, 0), point(100, 0), point(100, 60), point(0, 60), point(0, 0)]);
    expect(rectangle?.kind).toBe("rectangle");
    const handle = point(0, 0);
    const resized = resizeShapePoints(rectangle!.points, shapeResizeAnchor(rectangle!.points, handle), handle, point(-50, -30));
    expect(resized).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: -50, y: -30 }),
      expect.objectContaining({ x: 100, y: 60 })
    ]));

    const line = recognizeHeldShape([point(0, 0), point(100, 0)]);
    expect(line?.kind).toBe("line");
    const resizedLine = resizeShapePoints(line!.points, shapeResizeAnchor(line!.points, point(100, 0)), point(100, 0), point(150, 0));
    expect(resizedLine).toEqual([
      expect.objectContaining({ x: 0, y: 0 }),
      expect.objectContaining({ x: 150, y: 0 })
    ]);
  });

  it("moves a locked shape through every quadrant around its anchor", () => {
    const rectangle = recognizeHeldShape([point(0, 0), point(100, 0), point(100, 60), point(0, 60), point(0, 0)]);
    expect(rectangle?.kind).toBe("rectangle");
    const handle = point(0, 0);
    const anchor = shapeResizeAnchor(rectangle!.points, handle);
    for (const target of [point(-50, -30), point(150, -30), point(-50, 90), point(150, 90)]) {
      const transformed = resizeShapePoints(rectangle!.points, anchor, handle, target);
      expect(transformed).toEqual(expect.arrayContaining([expect.objectContaining({ x: target.x, y: target.y })]));
      expect(transformed).toEqual(expect.arrayContaining([expect.objectContaining({ x: anchor.x, y: anchor.y })]));
    }

    const line = recognizeHeldShape([point(0, 0), point(100, 0)]);
    const rotatedLine = resizeShapePoints(line!.points, point(0, 0), point(100, 0), point(0, -100));
    expect(rotatedLine).toEqual([
      expect.objectContaining({ x: 0, y: 0 }),
      expect.objectContaining({ x: 0, y: -100 })
    ]);
  });
});
