import { describe, expect, it } from "vitest";
import type { PdfTextRun, TextStyle } from "../src/model";
import { insertStyledText, readTextRuns, renderTextRuns, rescaleTextRuns, restoreSelection, selectionOffsets } from "../src/text/RichTextDom";

const base: TextStyle = {
  color: "#111111", fontSize: 16, fontFamily: "sans-serif",
  bold: false, italic: false, strikethrough: false
};

const run = (text: string, patch: Partial<TextStyle> = {}): PdfTextRun => ({ text, ...base, ...patch });

describe("RichTextDom", () => {
  it("renders and reads independent per-character style runs", () => {
    const root = document.createElement("div");
    const runs = [run("Hello "), run("world", { color: "#dc2626", bold: true })];

    renderTextRuns(root, runs, 2);

    const spans = root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-run");
    expect(spans).toHaveLength(2);
    expect(spans[1]?.style.fontSize).toBe("32px");
    expect(readTextRuns(root, base)).toEqual(runs);
  });

  it("rescales rendered runs in place without replacing their DOM", () => {
    const root = document.createElement("div");
    const runs = [run("Hello "), run("world", { fontSize: 20, bold: true })];
    renderTextRuns(root, runs, 1);
    const second = root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-run")[1];

    rescaleTextRuns(root, 1.5);

    expect(root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-run")[1]).toBe(second);
    expect(second?.style.fontSize).toBe("30px");
    expect(readTextRuns(root, base)).toEqual(runs);
  });

  it("uses UTF-16 root-relative selections and restores them after run DOM changes", () => {
    const root = document.createElement("div");
    document.body.append(root);
    renderTextRuns(root, [run("Hello "), run("world", { italic: true })]);
    const first = root.querySelector("span")?.firstChild!;
    const second = root.querySelectorAll("span")[1]?.firstChild!;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(second, 3);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const offsets = selectionOffsets(root);
    expect(offsets).toEqual({ start: 2, end: 9 });
    renderTextRuns(root, [run("Hello "), run("world", { italic: true, bold: true })]);
    restoreSelection(root, offsets!);
    expect(selectionOffsets(root)).toEqual(offsets);

    root.remove();
  });

  it("keeps native paragraph input as a newline and inserts chosen collapsed style", () => {
    const root = document.createElement("div");
    document.body.append(root);
    root.innerHTML = "<div>first</div><div>second</div>";
    expect(readTextRuns(root, base)).toEqual([run("first\nsecond")]);

    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    insertStyledText(root, "!", { ...base, fontSize: 22, bold: true });
    expect(readTextRuns(root, base)).toEqual([run("first\nsecond"), run("!", { fontSize: 22, bold: true })]);

    root.remove();
  });
});
