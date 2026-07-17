import { describe, expect, it } from "vitest";
import type { PdfTextRun } from "../src/model";
import {
  mergeTextRuns,
  normalizeTextRuns,
  patchTextRunRange,
  plainTextFromRuns,
  plainTextToRuns,
  sliceTextRuns,
  styleAtTextOffset,
  styleForTextRange
} from "../src/text/RichTextRuns";

const base = {
  color: "#111111",
  fontSize: 16,
  fontFamily: "Inter",
  bold: false,
  italic: false,
  strikethrough: false
};

function run(text: string, patch: Partial<Omit<PdfTextRun, "text">> = {}): PdfTextRun {
  return { text, ...base, ...patch };
}

describe("RichTextRuns", () => {
  it("normalizes empty runs, merges equal neighbours, and strips unrelated fields", () => {
    const input = [
      { ...run("Hel"), transient: "do not retain" },
      run(""),
      run("lo"),
      run(" world", { bold: true }),
      run("!", { bold: true })
    ];

    const result = normalizeTextRuns(input);

    expect(result).toEqual([run("Hello"), run(" world!", { bold: true })]);
    expect(result[0]).not.toHaveProperty("transient");
    expect(result[0]).not.toBe(input[0]);
    expect(mergeTextRuns(input)).toEqual(result);
  });

  it("converts between plain text and a single style without retaining style references", () => {
    const style = { ...base, italic: true };
    const runs = plainTextToRuns("alpha\nbeta", style);
    style.color = "#ef4444";

    expect(runs).toEqual([run("alpha\nbeta", { italic: true })]);
    expect(plainTextFromRuns([run("alpha"), run(" beta", { bold: true })])).toBe("alpha beta");
    expect(plainTextToRuns("", base)).toEqual([]);
  });

  it("slices selected character ranges across run boundaries", () => {
    const runs = [run("hello"), run(" world", { bold: true }), run("!", { italic: true })];

    expect(sliceTextRuns(runs, 3, 9)).toEqual([run("lo"), run(" wor", { bold: true })]);
    expect(sliceTextRuns(runs, 9, 3)).toEqual([run("lo"), run(" wor", { bold: true })]);
    expect(sliceTextRuns(runs, -10, Number.POSITIVE_INFINITY)).toEqual(runs);
  });

  it("patches only selected characters and merges matching boundaries", () => {
    const source = [run("hello"), run(" world", { bold: true }), run("!", { italic: true })];
    const result = patchTextRunRange(source, 3, 9, { color: "#2563eb", italic: true });

    expect(result).toEqual([
      run("hel"),
      run("lo", { color: "#2563eb", italic: true }),
      run(" wor", { bold: true, color: "#2563eb", italic: true }),
      run("ld", { bold: true }),
      run("!", { italic: true })
    ]);
    expect(source).toEqual([run("hello"), run(" world", { bold: true }), run("!", { italic: true })]);
  });

  it("does not create empty runs for collapsed styling, and clamps reversed invalid ranges", () => {
    const source = [run("abc"), run("def", { bold: true })];

    expect(patchTextRunRange(source, 3, 3, { italic: true })).toEqual(source);
    expect(patchTextRunRange(source, Number.NaN, Number.POSITIVE_INFINITY, { italic: true })).toEqual([
      run("abc", { italic: true }),
      run("def", { bold: true, italic: true })
    ]);
    expect(patchTextRunRange(source, 6, -1, { color: "#2563eb" })).toEqual([
      run("abc", { color: "#2563eb" }),
      run("def", { bold: true, color: "#2563eb" })
    ]);
  });

  it("returns cloned styles safely at offsets and selection ranges", () => {
    const runs = [run("ab"), run("cd", { bold: true }), run("ef", { italic: true })];

    expect(styleAtTextOffset(runs, -1)).toEqual(base);
    expect(styleAtTextOffset(runs, 2)).toEqual({ ...base, bold: true });
    expect(styleAtTextOffset(runs, 100)).toEqual({ ...base, italic: true });
    expect(styleAtTextOffset([], 0)).toBeUndefined();
    expect(styleForTextRange(runs, 0, 2)).toEqual({ kind: "uniform", style: base });
    expect(styleForTextRange(runs, 1, 3)).toEqual({ kind: "mixed" });
    expect(styleForTextRange(runs, 6, 6)).toEqual({ kind: "uniform", style: { ...base, italic: true } });
    expect(styleForTextRange([], 0, 0)).toEqual({ kind: "none" });

    const queried = styleAtTextOffset(runs, 0)!;
    queried.color = "#ef4444";
    expect(runs[0]?.color).toBe("#111111");
  });
});
