import { describe, expect, it } from "vitest";
import { selectPagesForInkMount } from "../src/runtime/selectPagesForInkMount";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";

function page(pageNumber: number, top = 0, height = 800): PdfPageInfo {
  const element = document.createElement("div");
  element.dataset.pageNumber = String(pageNumber);
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({
      top,
      bottom: top + height,
      left: 0,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    })
  });
  return {
    pageNumber,
    element,
    width: 400,
    height,
    scale: 1,
    rotation: 0
  };
}

describe("selectPagesForInkMount", () => {
  it("returns all pages on desktop", () => {
    const pages = [page(1), page(2), page(3), page(4)];
    expect(selectPagesForInkMount(pages, {
      mobile: false,
      currentPage: 1
    })).toHaveLength(4);
  });

  it("keeps current page ± pad on mobile without scanning rects", () => {
    const pages = Array.from({ length: 20 }, (_, index) => page(index + 1, index * 800));
    const selected = selectPagesForInkMount(pages, {
      mobile: true,
      currentPage: 10,
      pad: 1
    }).map((entry) => entry.pageNumber);
    expect(selected).toEqual([9, 10, 11]);
  });

  it("ignores viewport geometry — current page wins even if rects say otherwise", () => {
    // All pages far above the "viewport"; still mount around currentPage.
    const pages = [page(1, -5000), page(2, -4000), page(3, -3000), page(4, -2000)];
    const selected = selectPagesForInkMount(pages, {
      mobile: true,
      currentPage: 3,
      pad: 1
    }).map((entry) => entry.pageNumber);
    expect(selected).toEqual([2, 3, 4]);
  });

  it("selects by page number only — large lists stay O(pad)", () => {
    const pages = Array.from({ length: 979 }, (_, index) => page(index + 1));
    const selected = selectPagesForInkMount(pages, { mobile: true, currentPage: 371, pad: 1 })
      .map((entry) => entry.pageNumber);
    expect(selected).toEqual([370, 371, 372]);
  });
});

