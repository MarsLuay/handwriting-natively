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

/** Prefer Obsidian `setCssProps`; setProperty fallback for jsdom/tests (no `.style.* =` writes). */
export function setElementCssProps(el: HTMLElement, props: Record<string, string>): void {
  const host = el as CssPropsHost;
  if (typeof host.setCssProps === "function") {
    host.setCssProps(props);
    return;
  }
  for (const [key, value] of Object.entries(props)) {
    const cssKey = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
    el.style.setProperty(cssKey, value);
  }
}
