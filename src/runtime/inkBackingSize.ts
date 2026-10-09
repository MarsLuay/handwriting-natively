/**
 * Cap ink canvas backing-store size.
 * Overlay CSS grows with PDF zoom; full css×dpr at high pinch allocates huge buffers
 * (canvas + inkLayer + draft). Too-low caps CSS-stretch a soft bitmap → blurry/pixely ink.
 * Native PDF rasterization may allocate large buffers at high zoom; ink keeps a
 * separate per-surface ceiling.
 */
export const MAX_INK_EDGE_PX = 8192;
export const MAX_INK_PIXELS = 8192 * 6144;

/** Tighter budget on phones (multiple surfaces + WebView memory). */
export const MOBILE_MAX_INK_EDGE_PX = 4096;
export const MOBILE_MAX_INK_PIXELS = 4096 * 3072;

/** Markdown uses one tall canvas; allow long notes to retain DPR before the area budget applies. */
export const MARKDOWN_MAX_INK_EDGE_PX = 32767;
export const MOBILE_MARKDOWN_MAX_INK_EDGE_PX = 8192;

export interface InkBackingBudget {
  maxEdge: number;
  maxPixels: number;
}

export function inkBackingBudget(mobile: boolean): InkBackingBudget {
  return mobile
    ? { maxEdge: MOBILE_MAX_INK_EDGE_PX, maxPixels: MOBILE_MAX_INK_PIXELS }
    : { maxEdge: MAX_INK_EDGE_PX, maxPixels: MAX_INK_PIXELS };
}

/** Taller edge limits for a note-wide canvas; retain each platform's pixel cap. */
export function markdownInkBackingBudget(mobile: boolean): InkBackingBudget {
  return mobile
    ? { maxEdge: MOBILE_MARKDOWN_MAX_INK_EDGE_PX, maxPixels: MOBILE_MAX_INK_PIXELS }
    : { maxEdge: MARKDOWN_MAX_INK_EDGE_PX, maxPixels: MAX_INK_PIXELS };
}

export interface InkBackingSize {
  pixelWidth: number;
  pixelHeight: number;
  /** Context transform scale: CSS layout px → backing pixels. */
  backingScale: number;
}

export function inkBackingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxEdge = MAX_INK_EDGE_PX,
  maxPixels = MAX_INK_PIXELS
): InkBackingSize {
  const cssW = Math.max(1, cssWidth);
  const cssH = Math.max(1, cssHeight);
  const dpr = Math.max(0.5, devicePixelRatio || 1);
  let pixelWidth = cssW * dpr;
  let pixelHeight = cssH * dpr;
  const edge = Math.max(pixelWidth, pixelHeight);
  let shrink = 1;
  if (edge > maxEdge) shrink = Math.min(shrink, maxEdge / edge);
  const area = pixelWidth * pixelHeight * shrink * shrink;
  if (area > maxPixels) shrink = Math.min(shrink, Math.sqrt(maxPixels / (pixelWidth * pixelHeight)));
  pixelWidth = Math.max(1, Math.round(pixelWidth * shrink));
  pixelHeight = Math.max(1, Math.round(pixelHeight * shrink));
  return {
    pixelWidth,
    pixelHeight,
    backingScale: pixelWidth / cssW
  };
}
