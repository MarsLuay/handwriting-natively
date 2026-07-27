import { describe, expect, it } from "vitest";
import { InkSession } from "../src/ink/InkSession";
import type { InkStroke } from "../src/model";

function stroke(id: string, page: number, x: number, y: number, width = 4): InkStroke {
  return {
    id,
    page,
    tool: "pen",
    color: "#111827",
    width,
    opacity: 1,
    inputType: "pen",
    points: [{ x, y, pressure: 0.5, time: 0 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("ink spatial index", () => {
  it("returns only intersecting strokes in canonical draw order", () => {
    const session = new InkSession([
      stroke("near-a", 1, 10, 10),
      stroke("far", 1, 500, 500),
      stroke("near-b", 1, 60, 60),
      stroke("other-page", 2, 10, 10)
    ]);

    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 100, maxY: 100 }).map((item) => item.id))
      .toEqual(["near-a", "near-b"]);
    expect(session.pageIntersecting(2, { minX: 0, minY: 0, maxX: 100, maxY: 100 }).map((item) => item.id))
      .toEqual(["other-page"]);
  });

  it("keeps the index synchronized through remove, replace, and replacePage", () => {
    const session = new InkSession([stroke("one", 1, 20, 20), stroke("two", 1, 200, 200)]);
    session.remove("one");
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 50, maxY: 50 })).toEqual([]);

    session.replace({ ...stroke("two", 1, 30, 30), updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 50, maxY: 50 }).map((item) => item.id)).toEqual(["two"]);

    session.replacePage(1, [stroke("three", 1, 400, 400)]);
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 50, maxY: 50 })).toEqual([]);
    expect(session.pageIntersecting(1, { minX: 350, minY: 350, maxX: 450, maxY: 450 }).map((item) => item.id)).toEqual(["three"]);
  });

  it("ignores malformed or empty strokes without poisoning nearby queries", () => {
    const malformed = stroke("bad", 1, 0, 0);
    malformed.points = [];
    const session = new InkSession([malformed, stroke("good", 1, 10, 10)]);
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 20, maxY: 20 }).map((item) => item.id)).toEqual(["good"]);
  });
});
