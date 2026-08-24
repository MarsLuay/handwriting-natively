import { describe, expect, it } from "vitest";
import { normalizeVaultPath } from "../src/storage/DocumentIdentity";

describe("normalizeVaultPath", () => {
  it("leaves standard paths unchanged", () => {
    expect(normalizeVaultPath("folder/file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("file.pdf")).toBe("file.pdf");
    expect(normalizeVaultPath("a/b/c/d.txt")).toBe("a/b/c/d.txt");
  });

  it("replaces backslashes with forward slashes", () => {
    expect(normalizeVaultPath("folder\\file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("a\\b\\c\\d.txt")).toBe("a/b/c/d.txt");
  });

  it("removes leading ./", () => {
    expect(normalizeVaultPath("./folder/file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("./file.pdf")).toBe("file.pdf");
  });

  it("replaces consecutive duplicate slashes with a single slash", () => {
    expect(normalizeVaultPath("folder//file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("a///b////c.txt")).toBe("a/b/c.txt");
  });

  it("handles a combination of edge cases", () => {
    expect(normalizeVaultPath(".\\folder\\\\subfolder//file.pdf")).toBe("folder/subfolder/file.pdf");
    expect(normalizeVaultPath("./a\\b///c\\\\d.txt")).toBe("a/b/c/d.txt");
  });
});
