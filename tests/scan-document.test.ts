import { describe, expect, it } from "vitest";
import {
  defaultDocumentQuad,
  detectDocumentBoundary,
  rotateQuarterTurns
} from "../src/scanning/ScanDocument";
import { ScanDocumentModal } from "../src/ui/ScanDocumentModal";

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
