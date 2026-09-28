import { describe, expect, it } from "vitest";
import { LayoutWorkTrace } from "../src/runtime/LayoutWorkTrace";

function clock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; }
  };
}

describe("LayoutWorkTrace", () => {
  it("keeps fast phases silent and records their timings when a slow operation is observed", () => {
    const time = clock();
    const trace = new LayoutWorkTrace({ now: time.now });
    const fast = trace.start("zoom-layout", "burst");
    fast.phase("page-snapshot", () => time.advance(2));
    fast.phase("dom-write", () => time.advance(3));
    expect(fast.finish()?.slowEvent).toBeNull();

    const slow = trace.start("zoom-layout", "burst");
    slow.phase("page-snapshot", () => time.advance(1));
    slow.phase("geometry-read", () => time.advance(9));
    const result = slow.finish();

    expect(result).toMatchObject({
      operation: "zoom-layout",
      durationMs: 10,
      phaseDurations: { "page-snapshot": 1, "geometry-read": 9 },
      slowPhases: [{ phase: "geometry-read", durationMs: 9 }],
      slowEvent: {
        event: "layout-slow",
        operation: "zoom-layout",
        sampleCount: 1,
        operationMaxMs: 10
      }
    });
  });

  it("deduplicates repeated observer bursts and bounds retained slow evidence", () => {
    const time = clock();
    const trace = new LayoutWorkTrace({ now: time.now });
    for (let index = 0; index < 20; index += 1) {
      const operation = trace.start("resize-observer", "resize");
      operation.phase("callback", () => time.advance(10));
      operation.finish();
    }

    const summary = trace.summary();
    expect(summary.slowEventCount).toBe(1);
    expect(summary.byOperation["resize-observer"]).toEqual({ count: 20, maxMs: 10 });
    expect(summary.worst).toHaveLength(1);
  });

  it("does not retain phase detail after the bounded phase limit", () => {
    const time = clock();
    const trace = new LayoutWorkTrace({ now: time.now });
    const operation = trace.start("page-render", "settle");
    for (let index = 0; index < 20; index += 1) {
      operation.phase(`phase-${index}`, () => time.advance(1));
    }
    const result = operation.finish();
    expect(Object.keys(result?.phaseDurations ?? {})).toHaveLength(12);
  });
});
