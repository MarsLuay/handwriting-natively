import { describe, expect, it } from "vitest";
import { setToolbarIcon } from "../src/ui/ToolbarIcon";

describe("toolbar icons", () => {
  it("keeps the eraser body above its paper baseline", () => {
    const button = document.createElement("button");

    setToolbarIcon(button, "eraser");

    const svg = button.querySelector<SVGSVGElement>("svg");
    const paths = [...button.querySelectorAll<SVGPathElement>("path")].map((path) => path.getAttribute("d"));
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(paths).toEqual([
      "M7 18 4 15 12 7 16 11 9 18Z",
      "M14 6 17 3 21 7 18 10",
      "M5 21H21"
    ]);

    const bodyCoordinates = paths[0]?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    expect(Math.max(...bodyCoordinates)).toBeLessThan(21);
  });
});
