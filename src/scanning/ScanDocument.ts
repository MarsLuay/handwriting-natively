import { createDetachedEl } from "../vendor/createDetached";

export interface ScanDocumentPage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export interface ScanPoint {
  x: number;
  y: number;
}

export interface DocumentQuad {
  topLeft: ScanPoint;
  topRight: ScanPoint;
  bottomRight: ScanPoint;
  bottomLeft: ScanPoint;
}

export const MAX_SCAN_IMAGE_EDGE = 2480;

/** A conservative crop used when the camera image has no reliable edge contrast. */
export function defaultDocumentQuad(): DocumentQuad {
  return {
    topLeft: { x: 0.04, y: 0.04 },
    topRight: { x: 0.96, y: 0.04 },
    bottomRight: { x: 0.96, y: 0.96 },
    bottomLeft: { x: 0.04, y: 0.96 }
  };
}

function luminance(red: number, green: number, blue: number): number {
  return red * 0.299 + green * 0.587 + blue * 0.114;
}

/**
 * Finds a bright document against a darker camera background. The result is a
 * reviewable hint, never an irreversible crop: the modal exposes all four
 * corners so the user can correct difficult lighting or backgrounds.
 */
export function detectDocumentBoundary(width: number, height: number, imageData?: ImageData): DocumentQuad {
  const fallback = defaultDocumentQuad();
  if (!imageData || width < 8 || height < 8 || imageData.width < 8 || imageData.height < 8) return fallback;

  const data = imageData.data;
  const sample = (x: number, y: number): number => {
    const offset = (y * imageData.width + x) * 4;
    return luminance(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0);
  };
  const border: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(imageData.width, imageData.height) / 32));
  for (let x = 0; x < imageData.width; x += step) {
    border.push(sample(x, 0), sample(x, imageData.height - 1));
  }
  for (let y = step; y < imageData.height - 1; y += step) {
    border.push(sample(0, y), sample(imageData.width - 1, y));
  }
  const borderAverage = border.reduce((sum, value) => sum + value, 0) / Math.max(1, border.length);
  const threshold = Math.max(150, Math.min(235, borderAverage + 24));
  let minX = imageData.width;
  let minY = imageData.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < imageData.height; y += step) {
    for (let x = 0; x < imageData.width; x += step) {
      if (sample(x, y) < threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX <= minX || maxY <= minY) return fallback;
  const area = ((maxX - minX) * (maxY - minY)) / (imageData.width * imageData.height);
  if (area < 0.2 || area > 0.98) return fallback;
  return {
    topLeft: { x: minX / imageData.width, y: minY / imageData.height },
    topRight: { x: maxX / imageData.width, y: minY / imageData.height },
    bottomRight: { x: maxX / imageData.width, y: maxY / imageData.height },
    bottomLeft: { x: minX / imageData.width, y: maxY / imageData.height }
  };
}

export function rotateQuarterTurns(current: number): number {
  return (current + 1) % 4;
}

function pointDistance(left: ScanPoint, right: ScanPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function lerp(left: ScanPoint, right: ScanPoint, amount: number): ScanPoint {
  return { x: left.x + (right.x - left.x) * amount, y: left.y + (right.y - left.y) * amount };
}

function drawPerspectiveStrip(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  quad: DocumentQuad,
  outputWidth: number,
  outputHeight: number,
  start: number,
  end: number
): void {
  const topLeft = lerp(quad.topLeft, quad.bottomLeft, start);
  const topRight = lerp(quad.topRight, quad.bottomRight, start);
  const bottomLeft = lerp(quad.topLeft, quad.bottomLeft, end);
  const sourceTopLeft = { x: topLeft.x * sourceWidth, y: topLeft.y * sourceHeight };
  const sourceTopRight = { x: topRight.x * sourceWidth, y: topRight.y * sourceHeight };
  const sourceBottomLeft = { x: bottomLeft.x * sourceWidth, y: bottomLeft.y * sourceHeight };
  const determinant = (sourceTopRight.x - sourceTopLeft.x) * (sourceBottomLeft.y - sourceTopLeft.y)
    - (sourceTopRight.y - sourceTopLeft.y) * (sourceBottomLeft.x - sourceTopLeft.x);
  const y = start * outputHeight;
  const stripHeight = Math.max(1, (end - start) * outputHeight);
  if (Math.abs(determinant) < 0.001) return;

  const a = outputWidth * (sourceBottomLeft.y - sourceTopLeft.y) / determinant;
  const c = -outputWidth * (sourceBottomLeft.x - sourceTopLeft.x) / determinant;
  const b = -stripHeight * (sourceTopRight.y - sourceTopLeft.y) / determinant;
  const d = stripHeight * (sourceTopRight.x - sourceTopLeft.x) / determinant;
  const e = -a * sourceTopLeft.x - c * sourceTopLeft.y;
  const f = y - b * sourceTopLeft.x - d * sourceTopLeft.y;

  context.save();
  context.beginPath();
  context.rect(0, y, outputWidth, stripHeight + 1);
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

/**
 * Applies the reviewed quadrilateral and rotation without retaining a camera
 * blob. Horizontal strips keep the implementation WebView-compatible while
 * correcting the perspective of ordinary phone/tablet document photos.
 */
export function renderPerspectiveCrop(
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  quad: DocumentQuad,
  rotation: number,
  ownerDocument: Document = activeDocument
): HTMLCanvasElement {
  const sourceWidth = image.naturalWidth || image.width || 0;
  const sourceHeight = image.naturalHeight || image.height || 0;
  if (!sourceWidth || !sourceHeight) throw new Error("Captured image has no dimensions.");
  const topWidth = pointDistance(quad.topLeft, quad.topRight) * sourceWidth;
  const bottomWidth = pointDistance(quad.bottomLeft, quad.bottomRight) * sourceWidth;
  const leftHeight = pointDistance(quad.topLeft, quad.bottomLeft) * sourceHeight;
  const rightHeight = pointDistance(quad.topRight, quad.bottomRight) * sourceHeight;
  const scale = Math.min(1, MAX_SCAN_IMAGE_EDGE / Math.max(topWidth, bottomWidth, leftHeight, rightHeight));
  const outputWidth = Math.max(1, Math.round(Math.max(topWidth, bottomWidth) * scale));
  const outputHeight = Math.max(1, Math.round(Math.max(leftHeight, rightHeight) * scale));
  const canvas = createDetachedEl(ownerDocument, "canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Camera review is unavailable in this WebView.");
  for (let index = 0; index < 32; index += 1) {
    drawPerspectiveStrip(context, image, sourceWidth, sourceHeight, quad, outputWidth, outputHeight, index / 32, (index + 1) / 32);
  }

  if (rotation % 4 === 0) return canvas;
  const rotated = createDetachedEl(ownerDocument, "canvas");
  const quarterTurns = rotation % 2;
  rotated.width = quarterTurns ? outputHeight : outputWidth;
  rotated.height = quarterTurns ? outputWidth : outputHeight;
  const rotatedContext = rotated.getContext("2d");
  if (!rotatedContext) throw new Error("Camera review is unavailable in this WebView.");
  rotatedContext.translate(rotated.width / 2, rotated.height / 2);
  rotatedContext.rotate((Math.PI / 2) * rotation);
  rotatedContext.drawImage(canvas, -outputWidth / 2, -outputHeight / 2);
  return rotated;
}

export async function canvasToScanPage(canvas: HTMLCanvasElement): Promise<ScanDocumentPage> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare the captured page.")), "image/jpeg", 0.9);
  });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: "image/jpeg",
    width: canvas.width,
    height: canvas.height
  };
}
