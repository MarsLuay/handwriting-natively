import { describe, expect, it } from "vitest";
import { resolveToolbarPlacement } from "../src/runtime/resolveToolbarPlacement";

describe("resolveToolbarPlacement", () => {
  it("keeps configured placement on desktop", () => {
    expect(resolveToolbarPlacement("main", false)).toBe("main");
    expect(resolveToolbarPlacement("left", false)).toBe("left");
    expect(resolveToolbarPlacement("right", false)).toBe("right");
  });

  it("maps main to left on mobile", () => {
    expect(resolveToolbarPlacement("main", true)).toBe("left");
    expect(resolveToolbarPlacement(undefined, true)).toBe("left");
  });

  it("preserves explicit sidebars on mobile", () => {
    expect(resolveToolbarPlacement("left", true)).toBe("left");
    expect(resolveToolbarPlacement("right", true)).toBe("right");
  });
});
