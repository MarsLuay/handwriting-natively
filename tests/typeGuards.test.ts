import { describe, it, expect } from "vitest";
import { isElementInDocument } from "../src/dom/typeGuards";

describe("isElementInDocument", () => {
  it("returns true for a normal element in the document", () => {
    const el = document.createElement("div");
    expect(isElementInDocument(el, document)).toBe(true);
  });

  it("returns false for non-elements", () => {
    expect(isElementInDocument({}, document)).toBe(false);
    expect(isElementInDocument(null, document)).toBe(false);
    expect(isElementInDocument("string", document)).toBe(false);
    expect(isElementInDocument(document, document)).toBe(false);
  });

  it("returns false if ownerDocument has no defaultView", () => {
    const el = document.createElement("div");
    const docWithoutView = {
      defaultView: null
    } as unknown as Document;
    expect(isElementInDocument(el, docWithoutView)).toBe(false);
  });

  it("handles cross-window elements correctly", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) throw new Error("No iframe doc");
    const iframeEl = iframeDoc.createElement("div");

    // Should be true for its own document
    expect(isElementInDocument(iframeEl, iframeDoc)).toBe(true);
    // Should be false when tested against a different document's constructor
    expect(isElementInDocument(iframeEl, document)).toBe(false);

    document.body.removeChild(iframe);
  });

  it("respects Obsidian-style instanceOf method if present", () => {
    const mockConstructor = function() {};
    const mockDocument = {
      defaultView: { Element: mockConstructor }
    } as unknown as Document;

    const objWithInstanceOf = {
      instanceOf: (ctor: unknown) => ctor === mockConstructor
    };

    expect(isElementInDocument(objWithInstanceOf, mockDocument)).toBe(true);
  });
});
