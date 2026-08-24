import { describe, it, expect } from "vitest";
import { isToolId } from "../src/model";

describe("isToolId", () => {
  it("should return true for valid drawing tools", () => {
    expect(isToolId("pen")).toBe(true);
    expect(isToolId("pencil")).toBe(true);
    expect(isToolId("highlighter")).toBe(true);
  });

  it("should return true for other valid tools", () => {
    expect(isToolId("text")).toBe(true);
    expect(isToolId("eraser")).toBe(true);
    expect(isToolId("lasso")).toBe(true);
    expect(isToolId("laser")).toBe(true);
  });

  it("should return false for invalid tool strings", () => {
    expect(isToolId("shape")).toBe(false);
    expect(isToolId("pan")).toBe(false);
    expect(isToolId("")).toBe(false);
    expect(isToolId("unknown")).toBe(false);
  });

  it("should return false for non-string inputs", () => {
    expect(isToolId(null)).toBe(false);
    expect(isToolId(undefined)).toBe(false);
    expect(isToolId(123)).toBe(false);
    expect(isToolId({})).toBe(false);
    expect(isToolId([])).toBe(false);
    expect(isToolId(() => {})).toBe(false);
  });
});
