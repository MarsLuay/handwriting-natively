import { createDetachedEl } from "../vendor/createDetached";

export type ImageRasterFormat = "png" | "jpeg";

export interface ImageRasterExportLimits {
  /** Maximum width or height of the generated raster. */
  maxDimension?: number;
  /** Maximum number of output pixels. */
  maxPixels?: number;
}

export interface ImageRasterRenderTarget {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Independent output scales preserve the exact logical aspect ratio after capping. */
  scaleX: number;
  scaleY: number;
}

export interface ImageRasterExportInput {
  source: CanvasImageSource;
  width: number;
  height: number;
  format: ImageRasterFormat;
  render(target: ImageRasterRenderTarget): void;
  ownerDocument?: Document;
  limits?: ImageRasterExportLimits;
  jpegQuality?: number;
}

export interface ImageRasterExportResult {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

export class ImageRasterExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRasterExportError";
  }
}

const DEFAULT_MAX_DIMENSION = 16_384;
const DEFAULT_MAX_PIXELS = 32_000_000;

export class ImageRasterExportService {
  async export(input: ImageRasterExportInput): Promise<ImageRasterExportResult> {
    const dimensions = boundedDimensions(input.width, input.height, input.limits);
    const ownerDocument = input.ownerDocument
      ?? (input.source as CanvasImageSource & { ownerDocument?: Document }).ownerDocument
      ?? (typeof activeDocument !== "undefined" ? activeDocument : undefined);
    if (!ownerDocument) throw new ImageRasterExportError("Image export needs a document canvas; reload the image and try again.");

    await decodeImage(input.source);
    const canvas = createDetachedEl(ownerDocument, "canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: input.format === "png" });
    if (!context) throw new ImageRasterExportError("Image export could not create a raster canvas.");

    if (input.format === "jpeg") {
      context.save();
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, dimensions.width, dimensions.height);
      context.restore();
    }
    try {
      context.drawImage(input.source, 0, 0, dimensions.width, dimensions.height);
      input.render({
        context,
        width: dimensions.width,
        height: dimensions.height,
        scaleX: dimensions.scaleX,
        scaleY: dimensions.scaleY
      });
      const blob = await canvasToBlob(canvas, input.format, input.jpegQuality);
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: input.format === "png" ? "image/png" : "image/jpeg",
        width: dimensions.width,
        height: dimensions.height,
        scaleX: dimensions.scaleX,
        scaleY: dimensions.scaleY
      };
    } catch (error) {
      if (error instanceof ImageRasterExportError) throw error;
      throw new ImageRasterExportError(`Image export could not read or encode the source pixels: ${errorMessage(error)}`);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export function boundedImageRasterDimensions(
  width: number,
  height: number,
  limits: ImageRasterExportLimits = {}
): { width: number; height: number; scaleX: number; scaleY: number } {
  return boundedDimensions(width, height, limits);
}

function boundedDimensions(
  width: number,
  height: number,
  limits: ImageRasterExportLimits = {}
): { width: number; height: number; scaleX: number; scaleY: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ImageRasterExportError("Image export needs a loaded image with valid dimensions.");
  }
  const maxDimension = finiteLimit(limits.maxDimension, DEFAULT_MAX_DIMENSION, "dimension");
  const maxPixels = finiteLimit(limits.maxPixels, DEFAULT_MAX_PIXELS, "pixel");
  const scale = Math.min(
    1,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / (width * height))
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new ImageRasterExportError("Image is too large to export safely; reduce its dimensions and try again.");
  }
  const outputWidth = Math.max(1, Math.floor(width * scale));
  const outputHeight = Math.max(1, Math.floor(height * scale));
  if (outputWidth > maxDimension || outputHeight > maxDimension || outputWidth * outputHeight > maxPixels) {
    throw new ImageRasterExportError("Image is too large to export safely; reduce its dimensions and try again.");
  }
  return {
    width: outputWidth,
    height: outputHeight,
    scaleX: outputWidth / width,
    scaleY: outputHeight / height
  };
}

async function decodeImage(source: CanvasImageSource & { complete?: boolean; decode?: () => Promise<void> }): Promise<void> {
  if (typeof source.decode === "function") {
    try {
      await source.decode();
    } catch (error) {
      if (!source.complete) throw new ImageRasterExportError(`Image is not ready for export: ${errorMessage(error)}`);
    }
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, format: ImageRasterFormat, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new ImageRasterExportError("Image export could not encode the generated raster.")),
        format === "png" ? "image/png" : "image/jpeg",
        format === "jpeg" ? clampQuality(quality ?? 0.92) : undefined
      );
    } catch (error) {
      reject(new ImageRasterExportError(errorMessage(error)));
    }
  });
}

function finiteLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ImageRasterExportError(`Image export ${label} limit must be a positive finite number.`);
  }
  return Math.floor(value);
}

function clampQuality(value: number): number {
  return Math.max(0.1, Math.min(1, Number.isFinite(value) ? value : 0.92));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
