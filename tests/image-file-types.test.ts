import { describe, expect, it } from "vitest";
import { isSupportedImageExtension, isSupportedImageFile } from "../src/integration/ImageFileTypes";

describe("supported image annotation formats", () => {
  it("accepts static PNG, JPEG, and WebP extensions", () => {
    for (const extension of ["png", ".PNG", "jpg", "JPG", "jpeg", ".JPEG", "webp", ".WEBP"]) {
      expect(isSupportedImageExtension(extension)).toBe(true);
    }
  });

  it("leaves unsupported native image formats unannotated", () => {
    for (const extension of ["heic", "heif", "gif", "svg", "bmp", "avif"]) {
      expect(isSupportedImageExtension(extension)).toBe(false);
    }
    expect(isSupportedImageFile({ extension: "heic" })).toBe(false);
    expect(isSupportedImageFile(null)).toBe(false);
    expect(isSupportedImageFile(undefined)).toBe(false);
  });
});
