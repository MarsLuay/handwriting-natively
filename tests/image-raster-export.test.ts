import { describe, expect, it, vi } from "vitest";
import {
  ImageRasterExportError,
  ImageRasterExportService,
  boundedImageRasterDimensions
} from "../src/image/ImageRasterExportService";
import { PageCoordinateMapper, type PageRotation } from "../src/runtime/PageCoordinateMapper";

function fakeCanvas() {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn()
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type?: string) => callback(type ? new Blob(["encoded"], { type }) : new Blob(["encoded"])))
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

function sourceImage(): CanvasImageSource & { complete: boolean; decode: () => Promise<void> } {
  return {
    complete: true,
    decode: vi.fn(async () => undefined)
  } as unknown as CanvasImageSource & { complete: boolean; decode: () => Promise<void> };
}

describe("ImageRasterExportService", () => {
  it("keeps PNG alpha and applies asymmetric output scale to the render target", async () => {
    const { canvas, context } = fakeCanvas();
    const ownerDocument = { createElement: vi.fn(() => canvas) } as unknown as Document;
    const render = vi.fn();

    const result = await new ImageRasterExportService().export({
      source: sourceImage(),
      width: 1200,
      height: 800,
      format: "png",
      ownerDocument,
      limits: { maxDimension: 600, maxPixels: 1_000_000 },
      render
    });

    expect(canvas.getContext).toHaveBeenCalledWith("2d", { alpha: true });
    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 600, 400);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ width: 600, height: 400, scaleX: 0.5, scaleY: 0.5 }));
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toEqual(new Uint8Array([101, 110, 99, 111, 100, 101, 100]));
  });

  it("paints an opaque background before JPEG output", async () => {
    const { canvas, context } = fakeCanvas();
    const ownerDocument = { createElement: vi.fn(() => canvas) } as unknown as Document;

    const result = await new ImageRasterExportService().export({
      source: sourceImage(),
      width: 300,
      height: 200,
      format: "jpeg",
      ownerDocument,
      render: () => undefined
    });

    expect(context.fillStyle).toBe("#ffffff");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(canvas.getContext).toHaveBeenCalledWith("2d", { alpha: false });
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("bounds dimensions without changing the logical aspect ratio", () => {
    expect(boundedImageRasterDimensions(1_000, 2_000, { maxDimension: 1_000, maxPixels: 400_000 })).toEqual({
      width: 447,
      height: 894,
      scaleX: 0.447,
      scaleY: 0.447
    });
  });

  it.each<[PageRotation, { x: number; y: number }]>([
    [0, { x: 54.75, y: 110.5 }],
    [90, { x: 59.25, y: 36.5 }],
    [180, { x: 245.25, y: 39.5 }],
    [270, { x: 165.75, y: 163.5 }]
  ])("maps an off-center image mark without mirroring or double rotation (%i)", (rotation, expected) => {
    const mapper = new PageCoordinateMapper({
      width: 400,
      height: 300,
      scale: 0.5,
      scaleX: 0.75,
      scaleY: 0.5,
      rotation,
      origin: "top-left"
    });
    expect(mapper.toViewport({ x: 73, y: 221 })).toEqual(expected);
  });

  it("fails with an actionable error when encoding is unavailable", async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => callback(null))
    } as unknown as HTMLCanvasElement;
    const ownerDocument = { createElement: vi.fn(() => canvas) } as unknown as Document;

    await expect(new ImageRasterExportService().export({
      source: sourceImage(),
      width: 10,
      height: 10,
      format: "png",
      ownerDocument,
      render: () => undefined
    })).rejects.toBeInstanceOf(ImageRasterExportError);
  });
});
