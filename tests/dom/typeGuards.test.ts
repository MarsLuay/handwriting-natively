import { describe, it, expect } from "vitest";
import {
  isHTMLElement,
  isElement,
  isElementInDocument,
  isHTMLCanvasElement,
  setElementCssProps
} from "../../src/dom/typeGuards";

describe("dom typeGuards", () => {
  describe("isHTMLElement", () => {
    it("returns true for standard HTMLElements", () => {
      expect(isHTMLElement(document.createElement("div"))).toBe(true);
      expect(isHTMLElement(document.createElement("span"))).toBe(true);
      expect(isHTMLElement(document.createElement("input"))).toBe(true);
      expect(isHTMLElement(document.body)).toBe(true);
    });

    it("returns false for SVG elements", () => {
      expect(isHTMLElement(document.createElementNS("http://www.w3.org/2000/svg", "svg"))).toBe(false);
      expect(isHTMLElement(document.createElementNS("http://www.w3.org/2000/svg", "rect"))).toBe(false);
    });

    it("returns false for non-element nodes", () => {
      expect(isHTMLElement(document.createTextNode("text"))).toBe(false);
      expect(isHTMLElement(document.createComment("comment"))).toBe(false);
      expect(isHTMLElement(document)).toBe(false);
    });

    it("returns false for primitives and plain objects", () => {
      expect(isHTMLElement(null)).toBe(false);
      expect(isHTMLElement(undefined)).toBe(false);
      expect(isHTMLElement("string")).toBe(false);
      expect(isHTMLElement(123)).toBe(false);
      expect(isHTMLElement(true)).toBe(false);
      expect(isHTMLElement({})).toBe(false);
      expect(isHTMLElement({ nodeType: 1 })).toBe(false);
    });

    it("supports custom instanceOf protocol (cross-window popout support)", () => {
      const mockElement = {
        instanceOf: (constructor: unknown) => constructor === HTMLElement
      };
      expect(isHTMLElement(mockElement)).toBe(true);

      const mockNonElement = {
        instanceOf: (constructor: unknown) => constructor === SVGElement
      };
      expect(isHTMLElement(mockNonElement)).toBe(false);
    });
  });

  describe("isElement", () => {
    it("returns true for standard HTMLElements", () => {
      expect(isElement(document.createElement("div"))).toBe(true);
    });

    it("returns true for SVG elements", () => {
      expect(isElement(document.createElementNS("http://www.w3.org/2000/svg", "svg"))).toBe(true);
    });

    it("returns false for non-element nodes", () => {
      expect(isElement(document.createTextNode("text"))).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isElement(null)).toBe(false);
      expect(isElement(undefined)).toBe(false);
    });

    it("supports custom instanceOf protocol", () => {
      const mockElement = {
        instanceOf: (constructor: unknown) => constructor === Element
      };
      expect(isElement(mockElement)).toBe(true);
    });
  });

  describe("isElementInDocument", () => {
    it("returns true for elements belonging to the document", () => {
      const el = document.createElement("div");
      expect(isElementInDocument(el, document)).toBe(true);
    });

    it("returns false for primitives", () => {
      expect(isElementInDocument(null, document)).toBe(false);
    });

    it("returns true when testing instanceOf via custom ownerDocument constructor", () => {
        const mockDoc = {
            defaultView: {
                Element: class MockElement {}
            }
        } as unknown as Document;
        const el = new mockDoc.defaultView!.Element!();
        expect(isElementInDocument(el, mockDoc)).toBe(true);
    });
  });

  describe("isHTMLCanvasElement", () => {
    it("returns true for canvas element", () => {
      expect(isHTMLCanvasElement(document.createElement("canvas"))).toBe(true);
    });

    it("returns false for other elements", () => {
      expect(isHTMLCanvasElement(document.createElement("div"))).toBe(false);
    });
  });

  describe("setElementCssProps", () => {
    it("sets style properties using style.setProperty fallback", () => {
      const el = document.createElement("div");
      setElementCssProps(el, { color: "red", backgroundColor: "blue", "--custom-prop": "10px" });
      expect(el.style.color).toBe("red");
      expect(el.style.backgroundColor).toBe("blue");
      expect(el.style.getPropertyValue("--custom-prop")).toBe("10px");
    });

    it("uses setCssProps if available (Obsidian specific)", () => {
      const el = document.createElement("div") as any;
      let calledProps = null;
      el.setCssProps = (props: Record<string, string>) => {
        calledProps = props;
      };

      const props = { color: "red" };
      setElementCssProps(el, props);

      expect(calledProps).toBe(props);
      // should not touch style.setProperty if setCssProps is used
      expect(el.style.color).toBe("");
    });
  });
});
