import { describe, expect, it } from "vitest";
import { OpenInkStrokeGeometry } from "../src/input/InkStrokeGeometry";

describe("OpenInkStrokeGeometry", () => {
  it("reports a two-point stroke as a line", () => {
    const geometry = new OpenInkStrokeGeometry();
    geometry.noteSamples([{ clientX: 10, clientY: 20 }], false);
    geometry.noteSamples([{ clientX: 110, clientY: 20 }], true);
    const record = geometry.finish(7, "pointerup", { clientX: 110, clientY: 20 });
    expect(record).toMatchObject({
      pointerId: 7,
      pointCount: 2,
      routerMoveCount: 1,
      coalescedSampleCount: 1,
      chordLengthPx: 100,
      straightness: 1,
      terminalEvent: "pointerup",
      terminalSampleDropped: false
    });
  });

  it("reports a curve from coalesced samples as not a line", () => {
    const geometry = new OpenInkStrokeGeometry();
    geometry.noteSamples([{ clientX: 0, clientY: 0 }], false);
    geometry.noteSamples([
      { clientX: 10, clientY: 40 },
      { clientX: 40, clientY: 40 },
      { clientX: 50, clientY: 0 }
    ], true);
    const record = geometry.finish(3, "pointerup", { clientX: 50, clientY: 0 });
    expect(record.pointCount).toBe(4);
    expect(record.routerMoveCount).toBe(1);
    expect(record.coalescedSampleCount).toBe(3);
    expect(record.clientPathLengthPx).toBeGreaterThan(record.chordLengthPx + 20);
    expect(record.straightness).toBeLessThan(0.6);
  });

  it("drops a synthetic origin terminal instead of yanking the path to the corner", () => {
    const geometry = new OpenInkStrokeGeometry();
    geometry.noteSamples([{ clientX: 80, clientY: 90 }], false);
    geometry.noteSamples([{ clientX: 120, clientY: 140 }], true);
    const record = geometry.finish(4, "pointercancel", { clientX: 0, clientY: 0 });
    expect(record.pointCount).toBe(2);
    expect(record.terminalSampleDropped).toBe(true);
    expect(record.chordLengthPx).toBeGreaterThan(50);
  });
});
