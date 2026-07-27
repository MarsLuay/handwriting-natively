/**
 * Detached DOM nodes for Obsidian popouts. Document-level HTML helpers create
 * nodes in the supplied owner document without attaching them. SVG creation
 * uses the document's window helper because Document.createSvg may attach to
 * the document in some Obsidian hosts.
 */
type ObsidianWindow = Window & {
  createSvg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K];
};

export function createDetachedEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K
): HTMLElementTagNameMap[K] {
  return doc.createEl(tag);
}

export function createDetachedDiv(doc: Document): HTMLDivElement {
  return doc.createDiv();
}

export function createDetachedSpan(doc: Document): HTMLSpanElement {
  return doc.createSpan();
}

export function createDetachedSvg(
  doc: Document,
  tag: keyof SVGElementTagNameMap
): SVGElement {
  return (doc.win as ObsidianWindow).createSvg(tag);
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
