import { describe, expect, it } from "vitest";
import { isElement } from "../src/dom/typeGuards";

describe("dom type guards", () => {
  describe("isElement", () => {
    it("returns true for standard HTML elements", () => {
      const div = document.createElement("div");
      expect(isElement(div)).toBe(true);

      const span = document.createElement("span");
      expect(isElement(span)).toBe(true);
    });

    it("returns true for SVG elements", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      expect(isElement(svg)).toBe(true);

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      expect(isElement(path)).toBe(true);
    });

    it("returns false for non-element DOM nodes", () => {
      const textNode = document.createTextNode("hello");
      expect(isElement(textNode)).toBe(false);

      const commentNode = document.createComment("comment");
      expect(isElement(commentNode)).toBe(false);
    });

    it("returns false for primitives and null/undefined", () => {
      expect(isElement(null)).toBe(false);
      expect(isElement(undefined)).toBe(false);
      expect(isElement("div")).toBe(false);
      expect(isElement(123)).toBe(false);
      expect(isElement(true)).toBe(false);
    });

    it("returns false for plain objects", () => {
      expect(isElement({})).toBe(false);
      expect(isElement({ nodeType: 1 })).toBe(false);
      expect(isElement({ tagName: "DIV" })).toBe(false);
    });

    it("returns true for Obsidian popout-safe objects that expose .instanceOf()", () => {
      const mockElement = {
        instanceOf: (ctor: unknown) => ctor === Element
      };
      expect(isElement(mockElement)).toBe(true);
    });

    it("returns false for objects with .instanceOf() that return false", () => {
      const mockNonElement = {
        instanceOf: (ctor: unknown) => ctor === HTMLElement // But we are checking for Element
      };
      // Technically if it's HTMLElement it should be an Element, but in our mock
      // we check strictly `ctor === Element`.
      // Let's make it explicitly not Element
      const mockOther = {
        instanceOf: (ctor: unknown) => ctor === Text
      };
      expect(isElement(mockOther)).toBe(false);
    });
  });
});
