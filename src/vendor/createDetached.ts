/**
 * Detached DOM nodes for Obsidian popouts / Document.createEl quirks.
 * Never call Obsidian `Document.createDiv` / `createEl` / `createSpan` when the
 * element must stay unattached — some hosts append to `document` and throw
 * HierarchyRequestError ("Only one element on document allowed").
 *
 * `obsidianmd/prefer-create-el` is off for this file in eslint.config.mts.
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

/** Obsidian `Document.createSvg` appends to `document` — always use createElementNS. */
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
