import { describe, expect, it } from "vitest";
import { InkSession } from "../src/ink/InkSession";
import { eraseWholeStrokes } from "../src/tools/EraserTool";
import type { InkStroke } from "../src/model";

function stroke(index: number): InkStroke {
  const x = (index % 100) * 24;
  const y = Math.floor(index / 100) * 24;
  return {
    id: `dense-${index}`,
    page: 1,
    tool: "pen",
    color: "#111827",
    width: 4,
    opacity: 1,
    inputType: "pen",
    points: [
      { x, y, pressure: 0.5, time: index },
      { x: x + 16, y: y + 4, pressure: 0.5, time: index + 1 }
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("large-document editing bounds", () => {
  it("keeps dense page queries spatially bounded", () => {
    const session = new InkSession(Array.from({ length: 4000 }, (_, index) => stroke(index)));
    const candidates = session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 80, maxY: 80 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(40);
  });

  it("passes only local candidates to dense whole-stroke erasing", () => {
    const strokes = Array.from({ length: 4000 }, (_, index) => stroke(index));
    const session = new InkSession(strokes);
    const candidates = session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 80, maxY: 80 });
    const candidateIds = new Set(candidates.map((item) => item.id));
    const result = eraseWholeStrokes(strokes, [{ x: 20, y: 20 }, { x: 60, y: 20 }], 20, { candidateIds });
    expect(candidateIds.size).toBeLessThan(40);
    expect(result.erased.every((item) => candidateIds.has(item.id))).toBe(true);
    expect(result.kept.length + result.erased.length).toBe(strokes.length);
  });
});
