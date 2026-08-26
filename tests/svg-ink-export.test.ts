import { describe, expect, it } from "vitest";
import type { InkStroke } from "../src/model";
import { exportInkStrokesToSvg } from "../src/pdf/SvgInkExportService";

function stroke(overrides: Partial<InkStroke> = {}): InkStroke {
  return {
    id: "stroke-a",
    page: 1,
    tool: "pen",
    color: "#2563eb",
    width: 4,
    opacity: 0.75,
    inputType: "pen",
    points: [
      { x: 10, y: 20, pressure: 0.2, time: 0 },
      { x: 40, y: 60, pressure: 1, time: 16 }
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("SVG ink export", () => {
  it("returns a valid, explicit empty SVG for no usable strokes", () => {
    const result = exportInkStrokesToSvg([stroke({ points: [] })]);
    expect(result.strokeCount).toBe(0);
    expect(result.pages).toEqual([]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
    expect(result.svg).toContain('viewBox="0 0 1 1"');
    expect(result.svg).toContain('data-empty="true"');
  });

  it("is deterministic, emits visible pressure-aware geometry, and retains the base width", () => {
    const input = [stroke()];
    const first = exportInkStrokesToSvg(input);
    const second = exportInkStrokesToSvg(input);
    expect(first.svg).toBe(second.svg);
    expect(first.strokeCount).toBe(1);
    expect(first.svg).toContain('<path ');
    expect(first.svg).toContain('d="M');
    expect(first.svg).toContain('fill="#2563eb"');
    expect(first.svg).toContain('data-base-width="4"');
    expect(first.svg).toContain('opacity="0.75"');
    // Endpoint radii differ because the recorded pressures differ.
    expect(first.svg).toContain('A0.64 0.64');
    expect(first.svg).toContain('A2 2');
  });

  it("escapes untrusted colors and stroke IDs as XML attribute values", () => {
    const result = exportInkStrokesToSvg([
      stroke({ id: 'a&b<"\'c', color: 'url("x&<y")' })
    ]);
    expect(result.svg).toContain('data-stroke-id="a&amp;b&lt;&quot;&#39;c"');
    expect(result.svg).toContain('fill="url(&quot;x&amp;&lt;y&quot;)"');
    expect(result.svg).not.toContain('data-stroke-id="a&b<');
  });

  it("uses supplied page bounds and vertically composes independent page coordinates", () => {
    const result = exportInkStrokesToSvg(
      [stroke({ page: 2 }), stroke({ id: "first", page: 1 })],
      { pageMetrics: [{ page: 1, width: 100, height: 200 }, { page: 2, width: 80, height: 50 }] }
    );
    expect(result.pages).toEqual([
      { page: 1, translateX: 16, translateY: 16, width: 100, height: 200 },
      { page: 2, translateX: 16, translateY: 240, width: 80, height: 50 }
    ]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 132, maxY: 306, width: 132, height: 306 });
    expect(result.svg).toContain('viewBox="0 0 132 306"');
    expect(result.svg).toContain('transform="translate(16 16)"');
    expect(result.svg).toContain('transform="translate(16 240)"');
  });

  it("can export a constant-width centerline when pressure geometry is disabled", () => {
    const result = exportInkStrokesToSvg([stroke()], { pressureAware: false, padding: 0 });
    expect(result.svg).toContain('fill="none"');
    expect(result.svg).toContain('stroke-width="4"');
    expect(result.svg).toContain('d="M10 20 L40 60"');
  });
});
