import { describe, expect, it } from "vitest";
import {
  PDF_INTERACTION_FIXTURE_VERSION,
  PDF_INTERACTION_SCENARIOS
} from "./fixtures/pdfInteractionScenarios";

describe("reusable PDF interaction fixtures", () => {
  it("keeps every synthetic scenario adapter-reusable and hardware-independent", () => {
    expect(PDF_INTERACTION_FIXTURE_VERSION).toBe(1);
    expect(PDF_INTERACTION_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PDF_INTERACTION_SCENARIOS.map(({ id }) => id)).size)
      .toBe(PDF_INTERACTION_SCENARIOS.length);

    for (const scenario of PDF_INTERACTION_SCENARIOS) {
      expect(scenario.adapters).toEqual(["direct", "embedded"]);
      expect(scenario.requiresHardware).toBe(false);
      expect(scenario.actions.length).toBeGreaterThan(1);
      expect(scenario.assertions.length).toBeGreaterThan(1);
      expect(scenario.coverage.length).toBeGreaterThan(0);
    }
  });

  it("covers the complete non-hardware behavior matrix", () => {
    const ids = new Set(PDF_INTERACTION_SCENARIOS.map(({ id }) => id));
    expect(ids).toEqual(new Set([
      "open-write-pan",
      "pinch-zoom-and-zoom-fallback",
      "erase-and-select",
      "mount-boundary-scroll",
      "sidebar-transition",
      "page-actions-restart-export"
    ]));

    const all = PDF_INTERACTION_SCENARIOS.flatMap(({ assertions }) => assertions);
    expect(all).toEqual(expect.arrayContaining([
      "sidecar-integrity",
      "generation-safe-remount",
      "wet-ink-preserved",
      "cleanup",
      "export-reopen"
    ]));
  });
});
