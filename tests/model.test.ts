import { describe, expect, it } from "vitest";
import { resolveDrawingTool } from "../src/model";

describe("resolveDrawingTool", () => {
  it("returns the drawing tool when a drawing tool is active", () => {
    expect(resolveDrawingTool("pen")).toBe("pen");
    expect(resolveDrawingTool("pencil")).toBe("pencil");
    expect(resolveDrawingTool("highlighter")).toBe("highlighter");
  });

  it("returns 'pen' when a non-drawing tool is active", () => {
    expect(resolveDrawingTool("text")).toBe("pen");
    expect(resolveDrawingTool("eraser")).toBe("pen");
    expect(resolveDrawingTool("lasso")).toBe("pen");
    expect(resolveDrawingTool("laser")).toBe("pen");
  });
});
