import { describe, expect, it } from "vitest";
import type { InkStroke, PdfTextAnnotation } from "../src/model";
import { insertPageIntoSidecar, removePageFromSidecar } from "../src/storage/SidecarPageRemoval";
import type { SidecarSchemaV1 } from "../src/storage/SidecarSchema";

function stroke(id: string, page: number): InkStroke {
  return {
    id, page, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen",
    points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01"
  };
}

function text(id: string, page: number): PdfTextAnnotation {
  const run = { text: "Note", color: "#000000", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false };
  return {
    id, page, text: "Note", x: 10, y: 50, width: 40, height: 20, color: "#000000", fontSize: 12,
    fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false, runs: [run], sourceRuns: [run],
    createdAt: "2026-01-01", updatedAt: "2026-01-01"
  };
}

describe("sidecar page removal", () => {
  it("drops deleted-page annotations and moves later annotation pages up", () => {
    const sidecar: SidecarSchemaV1 = {
      schemaVersion: 1,
      document: { id: "pdf-a", vaultPath: "note.pdf" },
      pages: [
        { page: 1, width: 400, height: 600, rotation: 0, strokes: [stroke("one", 1)] },
        { page: 2, width: 400, height: 600, rotation: 0, strokes: [stroke("deleted", 2)], texts: [text("deleted-text", 2)] },
        { page: 3, width: 500, height: 700, rotation: 90, strokes: [stroke("three", 3)], texts: [text("three-text", 3)] }
      ],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01"
    };

    const result = removePageFromSidecar(sidecar, 2, "2026-02-01");

    expect(result.updatedAt).toBe("2026-02-01");
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.pages[0]?.strokes[0]?.page).toBe(1);
    expect(result.pages[1]).toMatchObject({ page: 2, rotation: 90 });
    expect(result.pages[1]?.strokes[0]?.page).toBe(2);
    expect(result.pages[1]?.texts?.[0]?.page).toBe(2);
    expect(sidecar.pages[2]?.page).toBe(3);
  });

  it("rejects an invalid deleted page number", () => {
    const sidecar = { schemaVersion: 1, document: { id: "pdf-a", vaultPath: "note.pdf" }, pages: [], createdAt: "a", updatedAt: "a" } as SidecarSchemaV1;
    expect(() => removePageFromSidecar(sidecar, 0)).toThrow("positive integer");
  });

  it("leaves the inserted page empty and shifts later ink and text together", () => {
    const sidecar: SidecarSchemaV1 = {
      schemaVersion: 1,
      document: { id: "pdf-a", vaultPath: "note.pdf" },
      pages: [
        { page: 1, width: 400, height: 600, rotation: 0, strokes: [stroke("one", 1)] },
        { page: 2, width: 500, height: 700, rotation: 90, strokes: [stroke("two", 2)], texts: [text("two-text", 2)] }
      ],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01"
    };

    const result = insertPageIntoSidecar(sidecar, 2, "2026-02-01");

    expect(result.updatedAt).toBe("2026-02-01");
    expect(result.pages.map((page) => page.page)).toEqual([1, 3]);
    expect(result.pages[0]?.strokes[0]?.page).toBe(1);
    expect(result.pages[1]?.strokes[0]?.page).toBe(3);
    expect(result.pages[1]?.texts?.[0]?.page).toBe(3);
  });
});
