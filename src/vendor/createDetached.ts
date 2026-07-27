/**
 * Detached DOM nodes for Obsidian popouts.
 *
 * Do not use Obsidian's Document.createEl/createDiv/createSpan/createSvg
 * helpers here: some host and popout documents attach their result immediately.
 * These nodes must remain detached until the caller places them in the PDF
 * chrome, otherwise sidebar mounting can fail before its rail is inserted.
 */
export function createDetachedEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K
): HTMLElementTagNameMap[K] {
  return doc.createElement(tag);
}

export function createDetachedDiv(doc: Document): HTMLDivElement {
  return doc.createElement("div");
}

export function createDetachedSpan(doc: Document): HTMLSpanElement {
  return doc.createElement("span");
}

export function createDetachedSvg(
  doc: Document,
  tag: keyof SVGElementTagNameMap
): SVGElement {
  return doc.createElementNS("http://www.w3.org/2000/svg", tag);
}

/** Prefer body; fall back to a connected host so attach cannot target `document`. */
export function appendToBodyOr(doc: Document, node: Node, fallback: ParentNode): void {
  const body = doc.body;
  if (body) {
    body.append(node);
    return;
  }
  fallback.append(node);
}
