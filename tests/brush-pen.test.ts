import { describe, expect, it } from "vitest";
import { brushSampleWidths, drawBrushStroke } from "../src/tools/BrushTool";

const options = {
  color: "#111827",
  width: 8,
  opacity: 1,
  pressureSensitivity: true,
  thinning: 0.55
};

function points(time: number) {
  return [
    { x: 0, y: 0, pressure: 0.8, time: 0 },
    { x: 20, y: 0, pressure: 0.8, time }
  ];
}

describe("brush pen", () => {
  it("thins at speed while retaining pressure-shaped width", () => {
    const slow = brushSampleWidths(points(100), options);
    const fast = brushSampleWidths(points(1), options);
    expect(slow[1]).toBeGreaterThan(fast[1]!);
    expect(slow[0]).toBeGreaterThan(0);
  });

  it("renders a filled ribbon with round dabs", () => {
    const operations: string[] = [];
    const context = {
      save: () => operations.push("save"),
      restore: () => operations.push("restore"),
      beginPath: () => operations.push("beginPath"),
      moveTo: () => operations.push("moveTo"),
      lineTo: () => operations.push("lineTo"),
      arc: () => operations.push("arc"),
      fill: () => operations.push("fill"),
      globalAlpha: 1,
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D;

    drawBrushStroke(context, points(16), options);
    expect(operations[0]).toBe("save");
    expect(operations).toContain("lineTo");
    expect(operations).toContain("arc");
    expect(operations.at(-1)).toBe("restore");
  });
});
