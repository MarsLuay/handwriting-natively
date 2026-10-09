import { describe, expect, it } from "vitest";
import {
  inkBackingBudget,
  inkBackingSize,
  MAX_INK_EDGE_PX,
  MAX_INK_PIXELS,
  markdownInkBackingBudget,
  MOBILE_MAX_INK_EDGE_PX,
  MOBILE_MAX_INK_PIXELS
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

  it("gives tall Markdown canvases a larger edge while preserving platform pixel budgets", () => {
    const desktop = markdownInkBackingBudget(false);
    const desktopSize = inkBackingSize(640, 10_000, 2, desktop.maxEdge, desktop.maxPixels);
    expect(desktopSize.backingScale).toBeCloseTo(2, 5);
    expect(desktopSize.pixelWidth * desktopSize.pixelHeight).toBeLessThanOrEqual(MAX_INK_PIXELS);

    const mobile = markdownInkBackingBudget(true);
    const mobileSize = inkBackingSize(640, 5_000, 2, mobile.maxEdge, mobile.maxPixels);
    const oldMobileSize = inkBackingSize(640, 5_000, 2, MOBILE_MAX_INK_EDGE_PX, MOBILE_MAX_INK_PIXELS);
    expect(mobileSize.backingScale).toBeGreaterThan(oldMobileSize.backingScale);
    expect(mobileSize.pixelWidth * mobileSize.pixelHeight).toBeLessThanOrEqual(MOBILE_MAX_INK_PIXELS);
  });

  it("stress-checks edge and area transitions for PDF, image, and Markdown budgets across DPRs", () => {
    const budgets = [
      { name: "PDF/image desktop", budget: inkBackingBudget(false) },
      { name: "PDF/image mobile", budget: inkBackingBudget(true) },
      { name: "Markdown desktop", budget: markdownInkBackingBudget(false) },
      { name: "Markdown mobile", budget: markdownInkBackingBudget(true) }
    ];
    const devicePixelRatios = [1, 1.5, 2, 3];

    for (const { name, budget } of budgets) {
      for (const dpr of devicePixelRatios) {
        const belowEdge = inkBackingSize((budget.maxEdge - 2) / dpr, 500 / dpr, dpr, budget.maxEdge, budget.maxPixels);
        const aboveEdge = inkBackingSize((budget.maxEdge + 100) / dpr, 500 / dpr, dpr, budget.maxEdge, budget.maxPixels);
        const aboveVerticalEdge = inkBackingSize(500 / dpr, (budget.maxEdge + 100) / dpr, dpr, budget.maxEdge, budget.maxPixels);
        const belowAreaEdge = Math.sqrt(budget.maxPixels) * 0.98 / dpr;
        const aboveAreaEdge = Math.sqrt(budget.maxPixels) * 1.02 / dpr;
        const belowArea = inkBackingSize(belowAreaEdge, belowAreaEdge, dpr, budget.maxEdge, budget.maxPixels);
        const aboveArea = inkBackingSize(aboveAreaEdge, aboveAreaEdge, dpr, budget.maxEdge, budget.maxPixels);

        expect(belowEdge.backingScale, `${name} DPR ${dpr} below edge`).toBeCloseTo(dpr, 4);
        for (const size of [aboveEdge, aboveVerticalEdge, belowArea, aboveArea]) {
          expect(size.pixelWidth, `${name} DPR ${dpr} width`).toBeLessThanOrEqual(budget.maxEdge);
          expect(size.pixelHeight, `${name} DPR ${dpr} height`).toBeLessThanOrEqual(budget.maxEdge);
          expect(
            size.pixelWidth * size.pixelHeight,
            `${name} DPR ${dpr} area`
          ).toBeLessThanOrEqual(budget.maxPixels + budget.maxEdge * 2);
          expect(size.backingScale).toBeGreaterThan(0);
          // backingScale derives from the rounded bitmap width, so allow a
          // one-pixel rounding overshoot at very wide Markdown dimensions.
          expect(size.backingScale).toBeLessThanOrEqual(dpr + 0.001);
        }
        expect(aboveEdge.backingScale).toBeLessThan(dpr);
        expect(aboveVerticalEdge.backingScale).toBeLessThan(dpr);
        expect(belowArea.backingScale).toBeCloseTo(dpr, 3);
        expect(aboveArea.backingScale).toBeLessThan(dpr);
      }
    }
  });
});
