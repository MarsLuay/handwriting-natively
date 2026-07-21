import { describe, expect, it } from "vitest";
import { parsePageRanges } from "../src/util/parsePageRanges";

describe("parsePageRanges", () => {
  it("parses singles, ranges, and mixed lists", () => {
    expect(parsePageRanges("1")).toEqual([1]);
    expect(parsePageRanges("1, 3-5, 8")).toEqual([1, 3, 4, 5, 8]);
    expect(parsePageRanges("5-3")).toEqual([3, 4, 5]);
    expect(parsePageRanges("2 4 6")).toEqual([2, 4, 6]);
  });

  it("rejects empty or invalid input", () => {
    expect(parsePageRanges("")).toBeNull();
    expect(parsePageRanges("   ")).toBeNull();
    expect(parsePageRanges("0")).toBeNull();
    expect(parsePageRanges("1-")).toBeNull();
    expect(parsePageRanges("a,2")).toBeNull();
  });
});
