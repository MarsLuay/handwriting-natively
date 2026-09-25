import { describe, expect, it } from "vitest";
import {
  LARGE_DOCUMENT_BENCHMARK_VERSION,
  LARGE_DOCUMENT_WORKLOADS,
  buildLargeDocumentWorkloadPlan,
  sanitizeLargeDocumentTrace
} from "./fixtures/largeDocumentWorkloads";

describe("large-document benchmark workloads", () => {
  it("covers the representative page-count and density matrix deterministically", () => {
    const plans = LARGE_DOCUMENT_WORKLOADS.map(buildLargeDocumentWorkloadPlan);
    expect(plans.map((plan) => plan.pageCount)).toEqual([10, 100, 500, 1000, 100, 500, 1000]);
    expect(plans.map((plan) => plan.seed)).toEqual(plans.map((plan) => buildLargeDocumentWorkloadPlan(
      LARGE_DOCUMENT_WORKLOADS.find((workload) => workload.id === plan.id)!
    ).seed));
    expect(plans.find((plan) => plan.id === "1000-dense")?.totalStrokes).toBe(80_000);
    expect(plans.find((plan) => plan.id === "mixed-editing")?.actions).toContain("mutate");
  });

  it("sanitizes bounded trace samples without inventing runtime evidence", () => {
    const trace = sanitizeLargeDocumentTrace({
      schemaVersion: LARGE_DOCUMENT_BENCHMARK_VERSION,
      capturedAt: "2026-09-25T00:00:00.000Z".repeat(20),
      context: {
        evidenceClass: "synthetic",
        platform: "desktop",
        device: "fixture",
        runtime: "browser-emulator",
        dpr: Number.NaN,
        refreshRateHz: 60,
        pluginVersion: "test",
        hostVersion: "fixture"
      },
      workloads: [{
        workloadId: "100-sparse",
        pointerToRenderMs: Array.from({ length: 300 }, (_, index) => index),
        scrollZoomMs: [3],
        remountMs: [4],
        saveMs: [5],
        cacheBytes: -1,
        pluginOwnedMemoryBytes: Number.POSITIVE_INFINITY,
        mountedPages: 4.9,
        evictions: -2,
        unsafeGates: 1.9
      }]
    });

    expect(trace.capturedAt).toHaveLength(40);
    expect(trace.workloads[0]?.pointerToRenderMs).toHaveLength(256);
    expect(trace.context.dpr).toBe(0);
    expect(trace.workloads[0]?.cacheBytes).toBe(0);
    expect(trace.workloads[0]?.pluginOwnedMemoryBytes).toBe(0);
    expect(trace.workloads[0]?.mountedPages).toBe(4);
    expect(trace.workloads[0]?.unsafeGates).toBe(1);
  });
});
