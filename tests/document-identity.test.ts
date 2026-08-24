import { describe, expect, it } from "vitest";
import { createDocumentIdentity, normalizeVaultPath } from "../src/storage/DocumentIdentity";

describe("normalizeVaultPath", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeVaultPath("folder\\file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("a\\b\\c.pdf")).toBe("a/b/c.pdf");
  });

  it("removes leading ./", () => {
    expect(normalizeVaultPath("./folder/file.pdf")).toBe("folder/file.pdf");
  });

  it("reduces multiple slashes to a single slash", () => {
    expect(normalizeVaultPath("folder//file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("a///b//c.pdf")).toBe("a/b/c.pdf");
  });

  it("handles combinations of issues", () => {
    expect(normalizeVaultPath(".\\folder\\\\file.pdf")).toBe("folder/file.pdf");
    // ./ replaced with "" -> \/folder//file.pdf -> //folder//file.pdf -> /folder/file.pdf
    expect(normalizeVaultPath("./\\/folder//file.pdf")).toBe("/folder/file.pdf");
  });

  it("leaves already normalized paths unchanged", () => {
    expect(normalizeVaultPath("folder/file.pdf")).toBe("folder/file.pdf");
    expect(normalizeVaultPath("file.pdf")).toBe("file.pdf");
  });
});

describe("createDocumentIdentity", () => {
  it("generates an id starting with pdf- and 16 hex characters", () => {
    const identity = createDocumentIdentity({ vaultPath: "test.pdf" });
    expect(identity.id).toMatch(/^pdf-[0-9a-f]{16}$/);
  });

  it("returns stable determinist IDs based on inputs", () => {
    const id1 = createDocumentIdentity({ vaultPath: "test.pdf" }).id;
    const id2 = createDocumentIdentity({ vaultPath: "test.pdf" }).id;
    expect(id1).toBe(id2);

    const id3 = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1" }).id;
    const id4 = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1" }).id;
    expect(id3).toBe(id4);

    const id5 = createDocumentIdentity({ vaultPath: "test.pdf", contentHash: "c1" }).id;
    const id6 = createDocumentIdentity({ vaultPath: "test.pdf", contentHash: "c1" }).id;
    expect(id5).toBe(id6);
  });

  it("prioritizes contentHash over fingerprint and vaultPath", () => {
    const fromContent = createDocumentIdentity({ vaultPath: "test.pdf", contentHash: "c1" }).id;

    const withFingerprint = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1", contentHash: "c1" }).id;
    expect(withFingerprint).toBe(fromContent);

    const withDifferentPath = createDocumentIdentity({ vaultPath: "other.pdf", contentHash: "c1" }).id;
    expect(withDifferentPath).toBe(fromContent);
  });

  it("prioritizes fingerprint over vaultPath", () => {
    const fromFingerprint = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1" }).id;

    const withDifferentPath = createDocumentIdentity({ vaultPath: "other.pdf", fingerprint: "f1" }).id;
    expect(withDifferentPath).toBe(fromFingerprint);
  });

  it("falls back to vaultPath when no contentHash or fingerprint is provided", () => {
    const id1 = createDocumentIdentity({ vaultPath: "test.pdf" }).id;
    const id2 = createDocumentIdentity({ vaultPath: "other.pdf" }).id;
    expect(id1).not.toBe(id2);
  });

  it("normalizes vaultPath in the returned object and for ID generation", () => {
    const normalizedId = createDocumentIdentity({ vaultPath: "folder/file.pdf" }).id;
    const unnormalized = createDocumentIdentity({ vaultPath: "folder//file.pdf" });

    expect(unnormalized.vaultPath).toBe("folder/file.pdf");
    expect(unnormalized.id).toBe(normalizedId);
  });

  it("conditionally includes fingerprint and contentHash", () => {
    const onlyPath = createDocumentIdentity({ vaultPath: "test.pdf" });
    expect(onlyPath).not.toHaveProperty("fingerprint");
    expect(onlyPath).not.toHaveProperty("contentHash");

    const withFingerprint = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1" });
    expect(withFingerprint.fingerprint).toBe("f1");
    expect(withFingerprint).not.toHaveProperty("contentHash");

    const withBoth = createDocumentIdentity({ vaultPath: "test.pdf", fingerprint: "f1", contentHash: "c1" });
    expect(withBoth.fingerprint).toBe("f1");
    expect(withBoth.contentHash).toBe("c1");
  });
});
