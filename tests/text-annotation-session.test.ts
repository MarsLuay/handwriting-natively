import { describe, expect, it } from "vitest";
import { TextAnnotationSession } from "../src/text/TextAnnotationSession";
import type { PdfTextAnnotation } from "../src/model";

function createAnnotation(id: string, page: number, text: string = "dummy text"): PdfTextAnnotation {
  return {
    id,
    page,
    text,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    color: "#000000",
    fontSize: 16,
    fontFamily: "sans-serif",
    bold: false,
    italic: false,
    strikethrough: false,
    runs: [],
    sourceRuns: [],
    createdAt: "2023-01-01T00:00:00.000Z",
    updatedAt: "2023-01-01T00:00:00.000Z"
  };
}

describe("TextAnnotationSession", () => {
  it("initializes with empty session if no annotations provided", () => {
    const session = new TextAnnotationSession();
    expect(session.all()).toEqual([]);
    expect(session.page(1)).toEqual([]);
  });

  it("initializes with provided annotations", () => {
    const a1 = createAnnotation("1", 1);
    const a2 = createAnnotation("2", 2);
    const session = new TextAnnotationSession([a1, a2]);

    expect(session.all()).toHaveLength(2);
    expect(session.all()).toEqual(expect.arrayContaining([a1, a2]));
    expect(session.page(1)).toEqual([a1]);
    expect(session.page(2)).toEqual([a2]);
  });

  it("adds an annotation and tracks it by page", () => {
    const session = new TextAnnotationSession();
    const a1 = createAnnotation("1", 1);
    const a2 = createAnnotation("2", 1);

    session.add(a1);
    session.add(a2);

    expect(session.page(1)).toEqual([a1, a2]);
    expect(session.all()).toHaveLength(2);
  });

  it("removes an annotation by id and returns it", () => {
    const a1 = createAnnotation("1", 1);
    const a2 = createAnnotation("2", 1);
    const session = new TextAnnotationSession([a1, a2]);

    const removed = session.remove("1");

    expect(removed).toEqual(a1);
    expect(session.page(1)).toEqual([a2]);
    expect(session.all()).toHaveLength(1);
  });

  it("returns undefined when removing a non-existent annotation", () => {
    const a1 = createAnnotation("1", 1);
    const session = new TextAnnotationSession([a1]);

    const removed = session.remove("non-existent");

    expect(removed).toBeUndefined();
    expect(session.page(1)).toEqual([a1]);
  });

  it("replaces an existing annotation", () => {
    const a1 = createAnnotation("1", 1, "original");
    const session = new TextAnnotationSession([a1]);

    const updated = createAnnotation("1", 1, "updated");
    session.replace(updated);

    expect(session.page(1)).toEqual([updated]);
    expect(session.page(1)[0].text).toBe("updated");
    expect(session.all()).toHaveLength(1);
  });

  it("replaces moves annotation to new page if page changed", () => {
    const a1 = createAnnotation("1", 1, "original");
    const session = new TextAnnotationSession([a1]);

    const updated = createAnnotation("1", 2, "updated");
    session.replace(updated);

    expect(session.page(1)).toEqual([]);
    expect(session.page(2)).toEqual([updated]);
    expect(session.all()).toHaveLength(1);
  });

  it("adds annotation on replace if id does not exist", () => {
    const session = new TextAnnotationSession();
    const a1 = createAnnotation("1", 1);

    session.replace(a1);

    expect(session.page(1)).toEqual([a1]);
  });

  it("returns annotations for a specific page or empty array if none", () => {
    const a1 = createAnnotation("1", 1);
    const session = new TextAnnotationSession([a1]);

    expect(session.page(1)).toEqual([a1]);
    expect(session.page(2)).toEqual([]);
  });

  it("returns all annotations across all pages", () => {
    const a1 = createAnnotation("1", 1);
    const a2 = createAnnotation("2", 2);
    const a3 = createAnnotation("3", 2);
    const session = new TextAnnotationSession([a1, a2, a3]);

    const all = session.all();
    expect(all).toHaveLength(3);
    expect(all).toEqual(expect.arrayContaining([a1, a2, a3]));
  });

  it("clears all annotations", () => {
    const a1 = createAnnotation("1", 1);
    const a2 = createAnnotation("2", 2);
    const session = new TextAnnotationSession([a1, a2]);

    session.clear();

    expect(session.all()).toEqual([]);
    expect(session.page(1)).toEqual([]);
    expect(session.page(2)).toEqual([]);
  });
});
