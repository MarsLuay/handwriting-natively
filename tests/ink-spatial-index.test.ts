import { describe, expect, it, vi } from "vitest";
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

  it("updates only changed index entries when an eraser replaces a dense page", () => {
    const unchanged = Array.from({ length: 500 }, (_, index) => stroke(`unchanged-${index}`, 1, index * 8, 200));
    const erased = stroke("erased", 1, 20, 20);
    const replacement = stroke("replacement", 1, 24, 20);
    const session = new InkSession([...unchanged, erased]);
    const index = (session as unknown as { indexByPage: Map<number, { add: (stroke: InkStroke) => void; remove: (id: string) => void }> })
      .indexByPage.get(1)!;
    const add = vi.spyOn(index, "add");
    const remove = vi.spyOn(index, "remove");

    session.replacePage(1, [...unchanged, replacement], "erase-stroke-segments");

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("erased");
    expect(remove).toHaveBeenCalledWith("replacement");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(replacement);
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 40, maxY: 40 }).map((item) => item.id))
      .toEqual(["replacement"]);
  });

  it("emits bounded insert and explicit removal lifecycle events", () => {
    const events: Array<{ phase: string; stroke: InkStroke; reason?: string; modelPresent: boolean }> = [];
    const session = new InkSession([], (event) => events.push(event));
    const created = stroke("created", 1, 20, 20);

    session.add(created);
    session.remove(created.id, "selection-delete");

    expect(events).toEqual([
      expect.objectContaining({ phase: "stroke-model-insert", stroke: created, modelPresent: true }),
      expect.objectContaining({ phase: "stroke-model-remove", stroke: created, reason: "selection-delete", modelPresent: false })
    ]);
  });

  it("ignores malformed or empty strokes without poisoning nearby queries", () => {
    const malformed = stroke("bad", 1, 0, 0);
    malformed.points = [];
    const session = new InkSession([malformed, stroke("good", 1, 10, 10)]);
    expect(session.pageIntersecting(1, { minX: 0, minY: 0, maxX: 20, maxY: 20 }).map((item) => item.id)).toEqual(["good"]);
  });
});
