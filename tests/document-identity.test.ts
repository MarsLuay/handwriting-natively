import { describe, expect, it } from "vitest";
import {
  createDocumentIdentity,
  createLegacyPathIdentity,
  documentIdentityCandidates,
  hashDocumentContent,
  normalizeVaultPath
} from "../src/storage/DocumentIdentity";

describe("content-derived document identity", () => {
  it("keeps the same primary id across rename and move when content is available", () => {
    const original = createDocumentIdentity({ vaultPath: "old/lecture.pdf", contentHash: "ABCD" });
    const moved = createDocumentIdentity({ vaultPath: "new/lecture.pdf", contentHash: "abcd" });

    expect(moved.id).toBe(original.id);
    expect(moved.vaultPath).toBe("new/lecture.pdf");
    expect(moved.contentHash).toBe("abcd");
    expect(moved.id).not.toBe(createLegacyPathIdentity(moved.vaultPath).id);
  });

  it("produces deterministic local content hashes without network state", () => {
    expect(hashDocumentContent(new Uint8Array([0, 1, 2, 255]))).toBe(hashDocumentContent(new Uint8Array([0, 1, 2, 255])));
    expect(hashDocumentContent("same bytes")).not.toBe(hashDocumentContent("different bytes"));
  });

  it("exposes content, fingerprint, and legacy path candidates in priority order", () => {
    const candidates = documentIdentityCandidates({ vaultPath: "renamed.pdf", fingerprint: "fp", contentHash: "hash" });
    expect(candidates.map((candidate) => candidate.source)).toEqual(["content", "fingerprint", "path"]);
    expect(candidates[0]?.legacy).toBe(false);
    expect(candidates[2]?.identity).toEqual(createLegacyPathIdentity("renamed.pdf"));
  });
});

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
