import { describe, expect, it } from "vitest";
import {
  createDetachedDiv,
  createDetachedEl,
  createDetachedSpan,
  createDetachedSvg
} from "../src/vendor/createDetached";

describe("createDetached", () => {
  it("creates detached HTML and SVG elements in the supplied document", () => {
    const doc = document.implementation.createHTMLDocument("popout");
    Object.defineProperty(doc, "win", {
      configurable: true,
      value: {
        createSvg(tag: string) {
          return doc.createElementNS("http://www.w3.org/2000/svg", tag);
        }
      }
    });

    const nodes = [
      createDetachedEl(doc, "button"),
      createDetachedDiv(doc),
      createDetachedSpan(doc),
      createDetachedSvg(doc, "path")
    ];

    expect(nodes.map((node) => node.ownerDocument)).toEqual([doc, doc, doc, doc]);
    expect(nodes.every((node) => node.parentNode === null && !node.isConnected)).toBe(true);
    expect(nodes.map((node) => node.tagName)).toEqual(["BUTTON", "DIV", "SPAN", "path"]);
    expect(nodes[3]?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });
});
