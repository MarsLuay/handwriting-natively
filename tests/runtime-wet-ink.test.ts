import { describe, expect, it, vi } from "vitest";
import { DamageLedger } from "../src/ink/DamageLedger";
import { WetInkRenderer, type WetInkCanvas } from "../src/ink/WetInkRenderer";

interface FakeContext {
  operations: string[];
  globalCompositeOperation: string;
  globalAlpha: number;
  lineCap: string;
  lineJoin: string;
  lineWidth: number;
  save: () => void;
  restore: () => void;
  setTransform: (...args: number[]) => void;
  clearRect: (...args: number[]) => void;
  drawImage: (...args: unknown[]) => void;
  beginPath: () => void;
  arc: (...args: number[]) => void;
  fill: () => void;
  moveTo: (...args: number[]) => void;
  lineTo: (...args: number[]) => void;
  stroke: () => void;
}

function fakeContext(): FakeContext {
  const operations: string[] = [];
  return {
    operations,
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineWidth: 1,
    save: () => operations.push("save"),
    restore: () => operations.push("restore"),
    setTransform: () => operations.push("transform"),
    clearRect: () => operations.push("clear"),
    drawImage: () => operations.push("copy"),
    beginPath: () => operations.push("path"),
    arc: () => operations.push("arc"),
    fill: () => operations.push("fill"),
    moveTo: () => operations.push("move"),
    lineTo: () => operations.push("line"),
    stroke: () => operations.push("stroke")
  };
}

function fakeCanvas(context: FakeContext, width = 320, height = 240): WetInkCanvas {
  return {
    width,
    height,
    getContext: vi.fn(() => context) as unknown as WetInkCanvas["getContext"]
  };
}

describe("wet ink rendering", () => {
  it("copies committed pixels into a disposable layer and erases only that layer", () => {
    const committedContext = fakeContext();
    const wetContext = fakeContext();
    const committed = fakeCanvas(committedContext);
    const wet = fakeCanvas(wetContext, 1, 1);
    const damage = new DamageLedger();
    const renderer = new WetInkRenderer();

    expect(renderer.begin(committed, wet)).toBe(true);
    expect(wet.width).toBe(committed.width);
    expect(wet.height).toBe(committed.height);
    expect(committedContext.operations).toEqual([]);
    expect(wetContext.operations).toContain("copy");

    expect(renderer.erase(wet, [{ x: 20, y: 30 }, { x: 40, y: 30 }], 12, 2, damage)).toBe(true);
    expect(wetContext.globalCompositeOperation).toBe("destination-out");
    expect(committedContext.globalCompositeOperation).toBe("source-over");
    expect(damage.size).toBe(1);
    // Two points 20px apart with a 12px diameter eraser form a 32x12
    // repaint capsule, not a single 12x12 dab.
    expect(damage.totalArea()).toBe(32 * 12);

    renderer.end(wet);
    expect(wetContext.operations.at(-1)).toBe("restore");
  });

  it("coalesces overlapping damage and drains it at the wet-preview boundary", () => {
    const ledger = new DamageLedger();
    ledger.add({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    ledger.add({ minX: 8, minY: 5, maxX: 20, maxY: 15 });
    ledger.add({ minX: 100, minY: 100, maxX: 101, maxY: 101 });

    expect(ledger.size).toBe(2);
    expect(ledger.drain()).toHaveLength(2);
    expect(ledger.size).toBe(0);
  });
});
