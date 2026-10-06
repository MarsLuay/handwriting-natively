import { describe, expect, it } from "vitest";
import { resolveToolbarPlacement } from "../src/runtime/resolveToolbarPlacement";

describe("resolveToolbarPlacement", () => {
  it("keeps every configured placement, including the PDF toolbar", () => {
    expect(resolveToolbarPlacement("main")).toBe("main");
    expect(resolveToolbarPlacement("left")).toBe("left");
    expect(resolveToolbarPlacement("right")).toBe("right");
  });

  it("defaults a missing placement to the PDF toolbar", () => {
    expect(resolveToolbarPlacement(undefined)).toBe("main");
  });
});
