import { describe, expect, it } from "vitest";
import {
  inkBackingBudget,
  inkBackingSize,
  MAX_INK_EDGE_PX,
  MAX_INK_PIXELS,
  MOBILE_MAX_INK_EDGE_PX
} from "../src/runtime/inkBackingSize";

describe("inkBackingSize", () => {
  it("uses css×dpr while under the budget", () => {
    const size = inkBackingSize(800, 600, 2);
    expect(size.pixelWidth).toBe(1600);
    expect(size.pixelHeight).toBe(1200);
    expect(size.backingScale).toBeCloseTo(2, 5);
  });

  it("keeps full retina through common 3–4× pinch on desktop budget", () => {
    const budget = inkBackingBudget(false);
    // ~2100×2700 CSS @ dpr2 was soft under the old 4096 edge.
    const mid = inkBackingSize(2100, 2700, 2, budget.maxEdge, budget.maxPixels);
    expect(mid.pixelWidth).toBe(4200);
    expect(mid.pixelHeight).toBe(5400);
    expect(mid.backingScale).toBeCloseTo(2, 5);

    const mobile = inkBackingSize(2100, 2700, 2, MOBILE_MAX_INK_EDGE_PX, inkBackingBudget(true).maxPixels);
    expect(mobile.backingScale).toBeLessThan(2);
  });

  it("caps extreme zoom so settle does not allocate unbounded canvases", () => {
    const size = inkBackingSize(6500, 8400, 2);
    expect(size.pixelWidth).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
    expect(size.pixelHeight).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
    expect(size.pixelWidth * size.pixelHeight).toBeLessThanOrEqual(MAX_INK_PIXELS + MAX_INK_EDGE_PX);
    expect(size.backingScale).toBeLessThan(2);
    expect(size.backingScale).toBeGreaterThan(0.1);
  });

  it("keeps the same backing size once past the cap (further zoom = CSS stretch only)", () => {
    const a = inkBackingSize(12000, 16000, 2);
    const b = inkBackingSize(24000, 32000, 2);
    expect(a.pixelWidth).toBe(b.pixelWidth);
    expect(a.pixelHeight).toBe(b.pixelHeight);
  });
});
