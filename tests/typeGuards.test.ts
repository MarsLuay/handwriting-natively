import { describe, expect, it } from "vitest";
import { isHTMLCanvasElement } from "../src/dom/typeGuards";

describe("isHTMLCanvasElement", () => {
  it("returns true for a canvas element", () => {
    const canvas = document.createElement("canvas");
    expect(isHTMLCanvasElement(canvas)).toBe(true);
  });

  it("returns false for a non-canvas element", () => {
    const div = document.createElement("div");
    expect(isHTMLCanvasElement(div)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isHTMLCanvasElement(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isHTMLCanvasElement(undefined)).toBe(false);
  });

  it("returns false for a plain object", () => {
    expect(isHTMLCanvasElement({})).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isHTMLCanvasElement("canvas")).toBe(false);
  });
});
