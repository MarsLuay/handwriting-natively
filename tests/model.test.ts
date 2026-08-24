import { describe, expect, it } from "vitest";
import { isDrawingTool, isInkDrawTool, isToolId, resolveDrawingTool } from "../src/model";

describe("isInkDrawTool", () => {
  it("returns true for drawing tools", () => {
    expect(isInkDrawTool("pen")).toBe(true);
    expect(isInkDrawTool("pencil")).toBe(true);
    expect(isInkDrawTool("highlighter")).toBe(true);
  });

  it("returns true for laser tool", () => {
    expect(isInkDrawTool("laser")).toBe(true);
  });

  it("returns false for non-ink drawing tools", () => {
    expect(isInkDrawTool("eraser")).toBe(false);
    expect(isInkDrawTool("lasso")).toBe(false);
    expect(isInkDrawTool("text")).toBe(false);
  });

  it("returns false for arbitrary strings", () => {
    expect(isInkDrawTool("")).toBe(false);
    expect(isInkDrawTool("shape")).toBe(false);
    expect(isInkDrawTool("random")).toBe(false);
  });
});

describe("isDrawingTool", () => {
  it("returns true for drawing tools", () => {
    expect(isDrawingTool("pen")).toBe(true);
    expect(isDrawingTool("pencil")).toBe(true);
    expect(isDrawingTool("highlighter")).toBe(true);
  });

  it("returns false for non-drawing tools", () => {
    expect(isDrawingTool("laser")).toBe(false);
    expect(isDrawingTool("eraser")).toBe(false);
    expect(isDrawingTool("lasso")).toBe(false);
    expect(isDrawingTool("text")).toBe(false);
  });

  it("returns false for arbitrary strings", () => {
    expect(isDrawingTool("")).toBe(false);
    expect(isDrawingTool("shape")).toBe(false);
  });
});

describe("isToolId", () => {
  it("returns true for drawing tools", () => {
    expect(isToolId("pen")).toBe(true);
    expect(isToolId("pencil")).toBe(true);
    expect(isToolId("highlighter")).toBe(true);
  });

  it("returns true for other tools", () => {
    expect(isToolId("laser")).toBe(true);
    expect(isToolId("eraser")).toBe(true);
    expect(isToolId("lasso")).toBe(true);
    expect(isToolId("text")).toBe(true);
  });

  it("returns false for unknown tools", () => {
    expect(isToolId("")).toBe(false);
    expect(isToolId("shape")).toBe(false);
    expect(isToolId("random")).toBe(false);
  });

  it("returns false for non-string types", () => {
    expect(isToolId(null)).toBe(false);
    expect(isToolId(undefined)).toBe(false);
    expect(isToolId(123)).toBe(false);
    expect(isToolId({})).toBe(false);
  });
});

describe("resolveDrawingTool", () => {
  it("returns the tool if it is a drawing tool", () => {
    expect(resolveDrawingTool("pen")).toBe("pen");
    expect(resolveDrawingTool("pencil")).toBe("pencil");
    expect(resolveDrawingTool("highlighter")).toBe("highlighter");
  });

  it("returns pen if it is a non-drawing tool", () => {
    expect(resolveDrawingTool("laser")).toBe("pen");
    expect(resolveDrawingTool("eraser")).toBe("pen");
    expect(resolveDrawingTool("lasso")).toBe("pen");
    expect(resolveDrawingTool("text")).toBe("pen");
  });
});
