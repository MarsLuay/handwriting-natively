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

export function isHTMLCanvasElement(value: unknown): value is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && isDomInstance(value, HTMLCanvasElement);
}

type CssPropsHost = HTMLElement & {
  setCssProps?: (props: Record<string, string>) => void;
};

/** Prefer Obsidian `setCssProps`; attribute fallback for jsdom/tests (no `.style.*` writes). */
export function setElementCssProps(el: HTMLElement, props: Record<string, string>): void {
  const host = el as CssPropsHost;
  if (typeof host.setCssProps === "function") {
    host.setCssProps(props);
    return;
  }
  const parts = Object.entries(props).map(([key, value]) => {
    const cssKey = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
    return `${cssKey}: ${value}`;
  });
  const previous = el.getAttribute("style") ?? "";
  el.setAttribute("style", previous ? `${previous};${parts.join(";")}` : parts.join(";"));
}
