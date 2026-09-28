import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultDocumentQuad,
  detectDocumentBoundary,
  rotateQuarterTurns
} from "../src/scanning/ScanDocument";
import { ScanDocumentModal } from "../src/ui/ScanDocumentModal";

const styles = readFileSync("styles.css", "utf8");

describe("scan document flow", () => {
  it("detects a reviewable paper boundary and keeps the fallback conservative", () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4);
    for (let y = 2; y <= 7; y += 1) {
      for (let x = 2; x <= 7; x += 1) {
        const offset = (y * 10 + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
      }
    }
    const boundary = detectDocumentBoundary(10, 10, { data: pixels, width: 10, height: 10 } as ImageData);
    expect(boundary.topLeft).toEqual({ x: 0.2, y: 0.2 });
    expect(boundary.bottomRight).toEqual({ x: 0.7, y: 0.7 });
    expect(detectDocumentBoundary(4, 4)).toEqual(defaultDocumentQuad());
  });

  it("rotates through four orientations", () => {
    expect([0, 1, 2, 3, 0].map((value) => rotateQuarterTurns(value))).toEqual([1, 2, 3, 0, 1]);
  });

  it("draws the current crop quadrilateral and updates every edge during corner drags", () => {
    const modal = new ScanDocumentModal({} as never, () => undefined);
    modal.open();
    const image = document.createElement("img");
    const internal = modal as unknown as {
      currentImage: HTMLImageElement | null;
      currentQuad: ReturnType<typeof defaultDocumentQuad>;
      renderReview(): void;
      preview: HTMLElement | null;
    };
    internal.currentImage = image;
    internal.currentQuad = {
      topLeft: { x: 0.2, y: 0.1 },
      topRight: { x: 0.8, y: 0.2 },
      bottomRight: { x: 0.9, y: 0.8 },
      bottomLeft: { x: 0.1, y: 0.9 }
    };
    internal.renderReview();
    const preview = internal.preview!;
    preview.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 210, bottom: 120, x: 10, y: 20, width: 200, height: 100,
      toJSON: () => ({})
    });
    const polygonPoints = (): string => preview.querySelector<SVGPolygonElement>(".native-pdf-handwriting-scan-outline-line")?.getAttribute("points") ?? "";
    expect(polygonPoints()).toBe("20,10 80,20 90,80 10,90");
    expect(preview.querySelectorAll(".native-pdf-handwriting-scan-outline polygon")).toHaveLength(2);

    const movedCorners = [
      ["topLeft", 0.25, 0.15],
      ["topRight", 0.75, 0.25],
      ["bottomRight", 0.85, 0.75],
      ["bottomLeft", 0.15, 0.85]
    ] as const;
    const expected = {
      topLeft: { x: 0.2, y: 0.1 },
      topRight: { x: 0.8, y: 0.2 },
      bottomRight: { x: 0.9, y: 0.8 },
      bottomLeft: { x: 0.1, y: 0.9 }
    };
    for (const [corner, x, y] of movedCorners) {
      const handle = preview.querySelector<HTMLElement>(`[data-corner="${corner}"]`)!;
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      handle.dispatchEvent(down);
      const move = new Event("pointermove", { bubbles: true, cancelable: true });
      Object.defineProperties(move, { clientX: { value: 10 + x * 200 }, clientY: { value: 20 + y * 100 } });
      preview.dispatchEvent(move);
      expected[corner] = { x, y };
      expect(polygonPoints()).toBe(["topLeft", "topRight", "bottomRight", "bottomLeft"]
        .map((name) => `${expected[name as keyof typeof expected].x * 100},${expected[name as keyof typeof expected].y * 100}`)
        .join(" "));
      const up = new Event("pointerup", { bubbles: true });
      preview.dispatchEvent(up);
    }
    expect(preview.querySelectorAll(".native-pdf-handwriting-scan-corner")).toHaveLength(4);
    modal.close();
  });

  it("styles crop handles as transparent ring-and-dot controls with a touch-sized hit area", () => {
    const handleRule = styles.match(/\.native-pdf-handwriting-scan-corner \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const ringRule = styles.match(/\.native-pdf-handwriting-scan-corner::before \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const dotRule = styles.match(/\.native-pdf-handwriting-scan-corner::after \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(handleRule).toContain("background: transparent");
    expect(handleRule).toContain("height: 28px");
    expect(handleRule).toContain("width: 28px");
    expect(ringRule).toContain("border: 2px solid #fff");
    expect(ringRule).toContain("inset: 4px");
    expect(dotRule).toContain("background: #fff");
    expect(dotRule).toContain("height: 6px");
    expect(dotRule).toContain("left: 50%");
    expect(dotRule).toContain("top: 50%");
    expect(dotRule).toContain("width: 6px");
  });

  it("requests rear-camera capture only when the scan modal opens and cleans up on cancel", () => {
    const result: unknown[][] = [];
    const modal = new ScanDocumentModal({} as never, (pages) => result.push(pages ? [...pages] : []));

    modal.open();

    const input = modal.contentEl.querySelector<HTMLInputElement>("input[type=file]");
    expect(input?.accept).toBe("image/*");
    expect(input?.getAttribute("capture")).toBe("environment");
    modal.contentEl.querySelector<HTMLButtonElement>("button:last-of-type")?.click();
    expect(result).toEqual([[]]);
  });
});
