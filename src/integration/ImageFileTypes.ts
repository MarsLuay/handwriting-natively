import type { TFile } from "obsidian";

/** Static image types supported by the shared annotation surface. */
export const HANDWRITING_IMAGE_EXTENSIONS = new Set([
  "jpeg",
  "jpg",
  "png"
]);

export function isSupportedImageExtension(extension: string): boolean {
  return HANDWRITING_IMAGE_EXTENSIONS.has(extension.replace(/^\./, "").toLowerCase());
}

export function isSupportedImageFile(file: Pick<TFile, "extension"> | null | undefined): boolean {
  return Boolean(file && isSupportedImageExtension(file.extension));
}
