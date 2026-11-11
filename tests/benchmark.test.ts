import { describe, expect, it } from "vitest";

describe("scanPdfLeaves Optimization Benchmark", () => {
  it("benchmarks N+1 array allocation vs cached array allocation", () => {
    // Mock for getLeavesOfType
    let callCount = 0;
    const workspace = {
      getLeavesOfType: (type: string) => {
        callCount++;
        return Array(100).fill({ type });
      }
    };
    const PLUGIN_PDF_VIEW_TYPE = "pdf-view-type";

    // Original implementation simulation
    const originalRun = () => {
      callCount = 0;
      const leaves = [...new Set([
        ...workspace.getLeavesOfType("pdf"),
        ...workspace.getLeavesOfType(PLUGIN_PDF_VIEW_TYPE),
        ...workspace.getLeavesOfType("image")
      ])];

      const payload = {
        pdfLeafCount: workspace.getLeavesOfType("pdf").length
          + workspace.getLeavesOfType(PLUGIN_PDF_VIEW_TYPE).length,
        imageLeafCount: workspace.getLeavesOfType("image").length,
      };

      return { leaves, payload, callCount };
    };

    // Optimized implementation simulation
    const optimizedRun = () => {
      callCount = 0;

      const pdfLeaves = workspace.getLeavesOfType("pdf");
      const pluginPdfLeaves = workspace.getLeavesOfType(PLUGIN_PDF_VIEW_TYPE);
      const imageLeaves = workspace.getLeavesOfType("image");

      const leaves = [...new Set([
        ...pdfLeaves,
        ...pluginPdfLeaves,
        ...imageLeaves
      ])];

      const payload = {
        pdfLeafCount: pdfLeaves.length + pluginPdfLeaves.length,
        imageLeafCount: imageLeaves.length,
      };

      return { leaves, payload, callCount };
    };

    // Measure time
    const iter = 10000;
    let originalTime = 0;
    let optimizedTime = 0;

    let res1: ReturnType<typeof originalRun> | undefined;
    let res2: ReturnType<typeof optimizedRun> | undefined;
    const t0 = performance.now();
    for (let i = 0; i < iter; i++) {
        res1 = originalRun();
    }
    const t1 = performance.now();
    originalTime = t1 - t0;

    const t2 = performance.now();
    for (let i = 0; i < iter; i++) {
        res2 = optimizedRun();
    }
    const t3 = performance.now();
    optimizedTime = t3 - t2;

    if (!res1 || !res2) {
      throw new Error("Benchmark iterations did not produce results");
    }

    console.log(`Original Time: ${originalTime.toFixed(2)} ms`);
    console.log(`Optimized Time: ${optimizedTime.toFixed(2)} ms`);
    console.log(`Original Call Count per iteration: ${res1.callCount}`);
    console.log(`Optimized Call Count per iteration: ${res2.callCount}`);

    expect(res2.payload).toEqual(res1.payload);
    expect(res2.leaves.length).toEqual(res1.leaves.length);
  });
});
