import { describe, expect, it } from "vitest";
import { isDrawingTool } from "../src/model";

describe("isDrawingTool", () => {
  it("returns true for valid drawing tools", () => {
    expect(isDrawingTool("pen")).toBe(true);
    expect(isDrawingTool("pencil")).toBe(true);
    expect(isDrawingTool("highlighter")).toBe(true);
  });

  it("returns false for non-drawing tools", () => {
    expect(isDrawingTool("text")).toBe(false);
    expect(isDrawingTool("eraser")).toBe(false);
    expect(isDrawingTool("lasso")).toBe(false);
    expect(isDrawingTool("laser")).toBe(false);
  });

  it("returns false for invalid inputs", () => {
    expect(isDrawingTool("")).toBe(false);
    expect(isDrawingTool("random")).toBe(false);
    expect(isDrawingTool("pen1")).toBe(false);
  });
});
