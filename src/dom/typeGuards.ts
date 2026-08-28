/** Cross-window DOM type guards (Obsidian popout-safe). Prefer `.instanceOf` over `instanceof`. */

type InstanceOfCapable = {
  instanceOf: (constructor: unknown) => boolean;
};

type DomConstructor<T> = abstract new (...args: never[]) => T;

function hasInstanceOf(value: unknown): value is InstanceOfCapable {
  return (
    (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as Partial<InstanceOfCapable>).instanceOf === "function"
  );
}

function isDomInstance<T>(value: unknown, constructor: DomConstructor<T>): value is T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  if (hasInstanceOf(value)) {
    return value.instanceOf(constructor);
  }
  return Function.prototype[Symbol.hasInstance].call(constructor, value);
}

export function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && isDomInstance(value, HTMLElement);
}

export function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && isDomInstance(value, Element);
}

/** Popout-safe Element check using the node's owner document constructor. */
export function isElementInDocument(value: unknown, ownerDocument: Document): value is Element {
  const elementConstructor = ownerDocument.defaultView?.Element;
  return elementConstructor !== undefined && isDomInstance(value, elementConstructor);
}

export function isHTMLCanvasElement(value: unknown): value is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && isDomInstance(value, HTMLCanvasElement);
}

type CssPropsHost = HTMLElement & {
  setCssProps?: (props: Record<string, string>) => void;
};

export function isSafeCssValue(value: string): boolean {
  if (typeof value !== "string") return false;

  let decoded = value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => {
    const code = parseInt(hex, 16);
    if (code > 0x10FFFF) {
      return String.fromCharCode(0xFFFD);
    }
    return String.fromCodePoint(code);
  });

  decoded = decoded.replace(/\\([^0-9a-fA-F])/g, "$1");

  const noComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  const decodedNoComments = decoded.replace(/\/\*[\s\S]*?\*\//g, "");

  const rawNormalized = noComments.toLowerCase().replace(/[^a-z0-9():]/g, "");
  const decodedNormalized = decodedNoComments.toLowerCase().replace(/[^a-z0-9():]/g, "");

  const isDangerous = (s: string) =>
    s.includes("javascript:") ||
    s.includes("vbscript:") ||
    s.includes("expression(") ||
    s.includes("mozbinding:") ||
    s.includes("behavior:");

  return !(isDangerous(rawNormalized) || isDangerous(decodedNormalized));
}

/** Prefer Obsidian `setCssProps`; setProperty fallback for jsdom/tests (no `.style.* =` writes). */
export function setElementCssProps(el: HTMLElement, props: Record<string, string>): void {
  const safeProps: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isSafeCssValue(value)) {
      safeProps[key] = value;
    }
  }

  const host = el as CssPropsHost;
  if (typeof host.setCssProps === "function") {
    host.setCssProps(safeProps);
    return;
  }
  for (const [key, value] of Object.entries(safeProps)) {
    const cssKey = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
    el.style.setProperty(cssKey, value);
  }
}
