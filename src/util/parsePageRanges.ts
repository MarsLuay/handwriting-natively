/**
 * Parse page lists like `1, 3-5, 8` into sorted unique 1-based page numbers.
 * Returns null when the input is empty or contains no valid pages.
 */
export function parsePageRanges(input: string): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const pages = new Set<number>();
  for (const part of trimmed.split(/[,\s]+/)) {
    if (!part) continue;
    const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(part);
    if (range) {
      let from = Number(range[1]);
      let to = Number(range[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1) return null;
      if (from > to) [from, to] = [to, from];
      for (let page = from; page <= to; page += 1) pages.add(page);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const page = Number(part);
    if (!Number.isFinite(page) || page < 1) return null;
    pages.add(page);
  }
  if (pages.size === 0) return null;
  return [...pages].sort((a, b) => a - b);
}
