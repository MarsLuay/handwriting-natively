import { describe, expect, it } from "vitest";
import {
  createDetachedDiv,
  createDetachedEl,
  createDetachedSpan,
  createDetachedSvg
} from "../src/vendor/createDetached";

describe("createDetached", () => {
  it("bypasses Obsidian document helpers that attach nodes before the caller mounts them", () => {
    const doc = document.implementation.createHTMLDocument("popout");
    const helperCalls: string[] = [];
    Object.defineProperties(doc, {
      createEl: {
        configurable: true,
        value(tag: string) {
          helperCalls.push(`html:${tag}`);
          const node = doc.createElement(tag);
          doc.body.append(node);
          return node;
        }
      },
      createDiv: {
        configurable: true,
        value() {
          helperCalls.push("html:div");
          const node = doc.createElement("div");
          doc.body.append(node);
          return node;
        }
      },
      createSpan: {
        configurable: true,
        value() {
          helperCalls.push("html:span");
          const node = doc.createElement("span");
          doc.body.append(node);
          return node;
        }
      },
      win: {
        configurable: true,
        value: {
          createSvg(tag: string) {
            helperCalls.push(`svg:${tag}`);
            const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
            doc.body.append(node);
            return node;
          }
        }
      }
    });

    const nodes = [
      createDetachedEl(doc, "button"),
      createDetachedDiv(doc),
      createDetachedSpan(doc),
      createDetachedSvg(doc, "path")
    ];

    expect(helperCalls).toEqual([]);
    expect(nodes.every((node) => node.parentNode === null && !node.isConnected)).toBe(true);
  });

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
