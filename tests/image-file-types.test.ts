import { describe, expect, it } from "vitest";
import { isSupportedImageExtension, isSupportedImageFile } from "../src/integration/ImageFileTypes";

describe("supported image annotation formats", () => {
  it("accepts only static PNG and JPEG extensions", () => {
    for (const extension of ["png", ".PNG", "jpg", "JPG", "jpeg", ".JPEG"]) {
      expect(isSupportedImageExtension(extension)).toBe(true);
    }
  });

  it("leaves unsupported native image formats unannotated", () => {
    for (const extension of ["webp", "heic", "heif", "gif", "svg", "bmp", "avif"]) {
      expect(isSupportedImageExtension(extension)).toBe(false);
    }
    expect(isSupportedImageFile({ extension: "webp" })).toBe(false);
    expect(isSupportedImageFile(null)).toBe(false);
    expect(isSupportedImageFile(undefined)).toBe(false);
  });
});
