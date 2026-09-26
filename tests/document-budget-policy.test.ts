import { describe, expect, it } from "vitest";
import { documentMountPolicy, mountWorkSuperseded } from "../src/runtime/documentBudgetPolicy";

function trace(platform: string, evidenceClass: "synthetic" | "manual-device") {
  return {
    capturedAt: "2026-09-26T00:00:00.000Z",
    context: {
      evidenceClass,
      platform,
      device: platform === "iPadOS" ? "iPad" : "desktop",
      runtime: "obsidian-test",
      dpr: 2,
      refreshRateHz: 60,
      pluginVersion: "test",
      hostVersion: "test"
    },
    workloads: [{
      workloadId: "rapid-scroll-zoom",
      pointerToRenderMs: [8, 12, 40],
      scrollZoomMs: [20, 30],
      remountMs: [15, 50],
      saveMs: [100],
      cacheBytes: null,
      pluginOwnedMemoryBytes: null,
      mountedPages: 2,
      evictions: 0,
      unsafeGates: 0
    }]
  };
}

describe("document mount budgets", () => {
  it("keeps numeric targets unqualified and cancels superseded scroll work without a device trace", () => {
    const desktop = documentMountPolicy([], "desktop");
    const constrained = documentMountPolicy([trace("iPadOS", "synthetic")], "constrained");
    expect(desktop.preloadRadiusPages).toBe(0);
    expect(constrained.preloadRadiusPages).toBe(0);
    expect(desktop.pointerToRender.status).toBe("unqualified");
    expect(constrained.remount.status).toBe("unqualified");
    expect(desktop.cancelSupersededScrollZoom).toBe(true);
    expect(mountWorkSuperseded(1, 2)).toBe(true);
    expect(mountWorkSuperseded(2, 2)).toBe(false);
    expect(JSON.stringify([desktop, constrained])).not.toMatch(/"p95Ms":/);
  });

  it("cites a manual-device trace only for that device class", () => {
    const desktop = documentMountPolicy([trace("Windows", "manual-device"), trace("iPadOS", "manual-device")], "desktop");
    const constrained = documentMountPolicy([trace("Windows", "manual-device")], "constrained");
    expect(desktop.pointerToRender).toMatchObject({
      status: "measured",
      workloadId: "rapid-scroll-zoom",
      device: "desktop",
      evidenceClass: "manual-device"
    });
    expect(constrained.pointerToRender.status).toBe("unqualified");
    expect(desktop.pluginOwnedMemory.status).toBe("unqualified");
    expect(desktop.preloadRadiusPages).toBe(0);
  });
});
