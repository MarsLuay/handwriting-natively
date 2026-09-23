import type { TFile } from "obsidian";

/** Image types that Obsidian can open in its native image view. */
export const HANDWRITING_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);

export function isSupportedImageExtension(extension: string): boolean {
  return HANDWRITING_IMAGE_EXTENSIONS.has(extension.replace(/^\./, "").toLowerCase());
}

export function isSupportedImageFile(file: Pick<TFile, "extension"> | null | undefined): boolean {
  return Boolean(file && isSupportedImageExtension(file.extension));
}
