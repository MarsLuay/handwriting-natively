import type { PdfTextRun } from "../model";

/** The editable formatting carried by a text run. */
export type TextRunStyle = Omit<PdfTextRun, "text">;

/** A partial style change applied to an existing character range. */
export type TextRunStylePatch = Partial<TextRunStyle>;

/**
 * The formatting represented by a text selection.
 *
 * `none` means there are no characters to inspect. A collapsed selection is
 * queried at its insertion point, so it is either `uniform` or `none`.
 */
export type TextRunStyleQuery =
  | { kind: "none" }
  | { kind: "uniform"; style: TextRunStyle }
  | { kind: "mixed" };

/**
 * Return a normalized, independent run list. Empty runs are removed and
 * adjacent runs with equal formatting are coalesced.
 *
 * Text offsets in this module are UTF-16 code-unit offsets, matching DOM
 * `Range` and `Selection` offsets.
 */
export function normalizeTextRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
  const merged: PdfTextRun[] = [];
  for (const source of runs) {
    if (!source.text) continue;
    const run = copyRun(source);
    const previous = merged.at(-1);
    if (previous && sameTextRunStyle(previous, run)) {
      previous.text += run.text;
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/** Alias that reads naturally at call sites which append or split runs. */
export const mergeTextRuns = normalizeTextRuns;

/** Convert a rich run list into its exact plain-text content. */
export function plainTextFromRuns(runs: readonly PdfTextRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** Convert plain text into one run without retaining external object references. */
export function plainTextToRuns(text: string, style: TextRunStyle): PdfTextRun[] {
  return text ? [copyRun({ text, ...style })] : [];
}

/** Return a styled, independent slice of a run list using a half-open range. */
export function sliceTextRuns(
  runs: readonly PdfTextRun[],
  start: number,
  end: number
): PdfTextRun[] {
  const normalized = normalizeTextRuns(runs);
  const [from, to] = orderedOffsets(normalized, start, end);
  if (from === to) return [];

  const sliced: PdfTextRun[] = [];
  let position = 0;
  for (const run of normalized) {
    const runStart = position;
    const runEnd = runStart + run.text.length;
    const overlapStart = Math.max(from, runStart);
    const overlapEnd = Math.min(to, runEnd);
    if (overlapStart < overlapEnd) {
      sliced.push(copyRun(run, run.text.slice(overlapStart - runStart, overlapEnd - runStart)));
    }
    position = runEnd;
  }
  return sliced;
}

/**
 * Apply a style patch to the selected half-open character range.
 *
 * A collapsed range intentionally does not create an empty styled run. The
 * caller should retain a pending insertion style until text is actually typed.
 */
export function patchTextRunRange(
  runs: readonly PdfTextRun[],
  start: number,
  end: number,
  patch: TextRunStylePatch
): PdfTextRun[] {
  const normalized = normalizeTextRuns(runs);
  const [from, to] = orderedOffsets(normalized, start, end);
  if (from === to || Object.keys(patch).length === 0) return normalized;

  const patched: PdfTextRun[] = [];
  let position = 0;
  for (const run of normalized) {
    const runStart = position;
    const runEnd = runStart + run.text.length;
    const overlapStart = Math.max(from, runStart);
    const overlapEnd = Math.min(to, runEnd);

    if (overlapStart >= overlapEnd) {
      patched.push(copyRun(run));
    } else {
      const before = run.text.slice(0, overlapStart - runStart);
      const selected = run.text.slice(overlapStart - runStart, overlapEnd - runStart);
      const after = run.text.slice(overlapEnd - runStart);
      if (before) patched.push(copyRun(run, before));
      patched.push(copyRun({ ...run, ...patch }, selected));
      if (after) patched.push(copyRun(run, after));
    }
    position = runEnd;
  }
  return normalizeTextRuns(patched);
}

/**
 * Return the style at an insertion offset. At a run boundary the following
 * run wins; at the end of text the preceding run wins.
 */
export function styleAtTextOffset(
  runs: readonly PdfTextRun[],
  offset: number
): TextRunStyle | undefined {
  const normalized = normalizeTextRuns(runs);
  if (!normalized.length) return undefined;

  const clamped = clampOffset(offset, textLength(normalized));
  let position = 0;
  for (const run of normalized) {
    position += run.text.length;
    if (clamped < position) return copyStyle(run);
  }
  return copyStyle(normalized.at(-1)!);
}

/** Safely report whether a selection has one style, mixed styles, or no text. */
export function styleForTextRange(
  runs: readonly PdfTextRun[],
  start: number,
  end: number
): TextRunStyleQuery {
  const normalized = normalizeTextRuns(runs);
  const [from, to] = orderedOffsets(normalized, start, end);
  if (from === to) {
    const style = styleAtTextOffset(normalized, from);
    return style ? { kind: "uniform", style } : { kind: "none" };
  }

  let found: TextRunStyle | undefined;
  let position = 0;
  for (const run of normalized) {
    const runEnd = position + run.text.length;
    if (from < runEnd && to > position) {
      const style = copyStyle(run);
      if (!found) {
        found = style;
      } else if (!sameTextRunStyle(found, style)) {
        return { kind: "mixed" };
      }
    }
    position = runEnd;
  }
  return found ? { kind: "uniform", style: found } : { kind: "none" };
}

/** Compare only the formatting properties, never run content or references. */
export function sameTextRunStyle(left: TextRunStyle, right: TextRunStyle): boolean {
  return left.color === right.color &&
    left.fontSize === right.fontSize &&
    left.fontFamily === right.fontFamily &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough;
}

function orderedOffsets(runs: readonly PdfTextRun[], start: number, end: number): [number, number] {
  const length = textLength(runs);
  const first = clampOffset(start, length);
  const second = clampOffset(end, length);
  return first <= second ? [first, second] : [second, first];
}

function clampOffset(offset: number, length: number): number {
  if (Number.isNaN(offset) || offset <= 0) return 0;
  if (!Number.isFinite(offset) || offset >= length) return length;
  return Math.trunc(offset);
}

function textLength(runs: readonly PdfTextRun[]): number {
  return runs.reduce((length, run) => length + run.text.length, 0);
}

function copyRun(run: PdfTextRun, text = run.text): PdfTextRun {
  return { text, ...copyStyle(run) };
}

function copyStyle(run: TextRunStyle): TextRunStyle {
  return {
    color: run.color,
    fontSize: run.fontSize,
    fontFamily: run.fontFamily,
    bold: run.bold,
    italic: run.italic,
    strikethrough: run.strikethrough
  };
}
