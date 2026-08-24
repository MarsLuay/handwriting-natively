import { describe, expect, it, vi } from "vitest";
import { setElementCssProps } from "../src/dom/typeGuards.js";

describe("setElementCssProps", () => {
  it("uses setCssProps if available", () => {
    const el = document.createElement("div") as any;
    el.setCssProps = vi.fn();
    el.style.setProperty = vi.fn();

    setElementCssProps(el, { color: "red" });

    expect(el.setCssProps).toHaveBeenCalledWith({ color: "red" });
    expect(el.style.setProperty).not.toHaveBeenCalled();
  });

  it("falls back to style.setProperty if setCssProps is not available", () => {
    const el = document.createElement("div");
    vi.spyOn(el.style, "setProperty");

    setElementCssProps(el, { color: "red" });

    expect(el.style.setProperty).toHaveBeenCalledWith("color", "red");
  });

  it("converts camelCase properties to kebab-case for style.setProperty fallback", () => {
    const el = document.createElement("div");
    vi.spyOn(el.style, "setProperty");

    setElementCssProps(el, { backgroundColor: "blue", fontSize: "16px" });

    expect(el.style.setProperty).toHaveBeenCalledWith("background-color", "blue");
    expect(el.style.setProperty).toHaveBeenCalledWith("font-size", "16px");
  });

  it("preserves CSS variable names starting with --", () => {
    const el = document.createElement("div");
    vi.spyOn(el.style, "setProperty");

    setElementCssProps(el, { "--myVar": "10px", "--myOtherVar": "20px" });

    expect(el.style.setProperty).toHaveBeenCalledWith("--myVar", "10px");
    expect(el.style.setProperty).toHaveBeenCalledWith("--myOtherVar", "20px");
  });
});
