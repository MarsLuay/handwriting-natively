import { describe, expect, it } from "vitest";
import type { InkStroke, PdfTextAnnotation } from "../src/model";
import { createDocumentIdentity, createLegacyPathIdentity } from "../src/storage/DocumentIdentity";
import { MigrationManager } from "../src/storage/MigrationManager";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarConflictError, SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";
import { parseSidecar, pickNewerSidecar, serializeSidecar, type SidecarSchemaV1 } from "../src/storage/SidecarSchema";

const stroke: InkStroke = { id: "s1", page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen", points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const sidecar = (): SidecarSchemaV1 => ({ schemaVersion: 1, document: { id: "doc", vaultPath: "a.pdf" }, pages: [{ page: 1, width: 100, height: 200, rotation: 0, strokes: [stroke] }], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const text: PdfTextAnnotation = {
  id: "t1", page: 1, text: "Note", x: 10, y: 50, width: 40, height: 20,
  color: "#000000", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
  runs: [{ text: "Note", color: "#000000", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
  sourceRuns: [{ text: "Note", color: "#000000", fontSize: 12, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
};

class MemoryFiles implements TextFileAdapter {
  data = new Map<string, string>();
  failRename = false;
  failWritePath: string | null = null;
  async exists(path: string) { return this.data.has(path); }
  async read(path: string) { const value = this.data.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, contents: string) {
    if (this.failWritePath === path) throw new Error("write failed");
    this.data.set(path, contents);
  }
  async rename(from: string, to: string) {
    if (this.failRename) throw new Error("rename failed");
    // Match Obsidian: rename cannot replace an existing destination.
    if (this.data.has(to)) throw new Error("Destination file already exists!");
    this.data.set(to, await this.read(from));
    this.data.delete(from);
  }
  async remove(path: string) { this.data.delete(path); }
  async list(folder: string) {
    const prefix = `${folder.replace(/[\\/]$/, "")}/`;
    return [...this.data.keys()].filter((path) => path.startsWith(prefix));
  }
}

describe("sidecar storage", () => {
  it("round-trips schema v1 and rejects invalid JSON", () => {
    expect(parseSidecar(serializeSidecar(sidecar()))).toEqual(sidecar());
    expect(() => parseSidecar("{}")) .toThrow("invalid sidecar");
  });

  it("accepts highlighter strokes in sidecar schema", () => {
    const highlight: InkStroke = {
      ...stroke,
      id: "h1",
      tool: "highlighter",
      color: "#facc15",
      width: 14,
      opacity: 0.35
    };
    const doc = sidecar();
    doc.pages[0]!.strokes = [highlight];
    expect(parseSidecar(serializeSidecar(doc)).pages[0]?.strokes[0]?.tool).toBe("highlighter");
  });

  it("round-trips highlighter erase masks", () => {
    const highlight: InkStroke = {
      ...stroke,
      id: "hl-mask",
      tool: "highlighter",
      width: 40,
      eraseMasks: [{ points: [{ x: 5, y: 5 }], radius: 8 }]
    };
    const doc = sidecar();
    doc.pages[0]!.strokes = [highlight];
    expect(parseSidecar(serializeSidecar(doc)).pages[0]?.strokes[0]?.eraseMasks).toEqual(highlight.eraseMasks);
  });

  it("round-trips editable text annotations and normalizes PR-era text geometry", () => {
    const document = sidecar();
    document.pages[0]!.texts = [text];
    expect(parseSidecar(serializeSidecar(document)).pages[0]?.texts).toEqual([text]);
    const prEra = structuredClone(document) as unknown as { pages: Array<{ texts: Array<Record<string, unknown>> }> };
    const annotation = prEra.pages[0]!.texts[0]!;
    delete annotation.width;
    delete annotation.height;
    delete annotation.fontFamily;
    delete annotation.strikethrough;
    delete annotation.sourceRuns;
    for (const run of annotation.runs as Array<Record<string, unknown>>) delete run.strikethrough;
    const normalized = parseSidecar(JSON.stringify(prEra)).pages[0]!.texts![0]!;
    expect(normalized).toMatchObject({ width: expect.any(Number), height: expect.any(Number), fontFamily: "sans-serif", strikethrough: false });
    expect(normalized.runs[0]).toMatchObject({ strikethrough: false });
    expect(normalized.sourceRuns).toEqual(normalized.runs);

    delete annotation.fontSize;
    expect(() => parseSidecar(JSON.stringify(prEra))).toThrow("invalid sidecar");
  });

  it("migrates v0 pages to schema v1 with default rotation", () => {
    const migrated = new MigrationManager().migrate({ version: 0, pdf: { id: "doc", path: "a.pdf" }, pages: [{ page: 1, width: 100, height: 200, strokes: [stroke] }] }, "now");
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.pages[0]?.rotation).toBe(0);
    expect(migrated.pages[0]?.strokes).toEqual([stroke]);
  });

  it("canonicalizes legacy content identities while preserving their path metadata", () => {
    const migrated = new MigrationManager().migrate({
      schemaVersion: 1,
      document: { id: createLegacyPathIdentity("old/a.pdf").id, vaultPath: "old/a.pdf", contentHash: "ABC" },
      pages: [],
      createdAt: "now",
      updatedAt: "now"
    });
    expect(migrated.document.id).toBe(createDocumentIdentity({ vaultPath: "old/a.pdf", contentHash: "abc" }).id);
    expect(migrated.document.vaultPath).toBe("old/a.pdf");
    expect(migrated.document.contentHash).toBe("abc");
  });

  it("prefers the newer sidecar or recovery snapshot when both exist", () => {
    const older = sidecar();
    const newer = sidecar();
    newer.updatedAt = "2026-02-01";
    expect(pickNewerSidecar(older, newer)).toBe(newer);
    expect(pickNewerSidecar(newer, older)).toBe(newer);
    expect(pickNewerSidecar(older, null)).toBe(older);
    expect(pickNewerSidecar(null, newer)).toBe(newer);
  });

  it("atomically renames the first save and overwrites later saves without rename-replace", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    await repository.save(sidecar());
    expect(files.data.has("annotations/doc.json.tmp")).toBe(false);

    const changed = sidecar();
    changed.updatedAt = "later";
    await repository.save(changed);
    expect(parseSidecar(await files.read("annotations/doc.json")).updatedAt).toBe("later");
    expect(parseSidecar(await files.read("annotations/doc.json.last-good")).updatedAt).toBe("2026-01-01");
    expect(files.data.has("annotations/doc.json.tmp")).toBe(false);
  });

  it("writes validated sidecar and recovery backups to the configured folder", async () => {
    const files = new MemoryFiles();
    const options = { backupFolder: "debug" };
    const sidecars = new SidecarRepository(files, "annotations", options);
    const recovery = new RecoveryRepository(files, "annotations/recovery", options);

    await sidecars.save(sidecar());
    await recovery.save(sidecar());

    expect(parseSidecar(await files.read("debug/sidecar-doc.json.backup"))).toEqual(sidecar());
    expect(parseSidecar(await files.read("debug/recovery-doc.recovery.json.backup"))).toEqual(sidecar());
  });

  it("automatically restores the newest validated external backup after quarantine", async () => {
    const files = new MemoryFiles();
    const now = () => new Date("2026-02-01T03:04:05.678Z");
    const repository = new SidecarRepository(files, "annotations", { backupFolder: "debug", now });
    await repository.save(sidecar());
    const latest = sidecar();
    latest.updatedAt = "later";
    await repository.save(latest);
    const path = repository.pathFor("doc");
    files.data.set(path, "\u0000\u0000");

    const result = await repository.loadWithStatus("doc");

    expect(result.data?.updatedAt).toBe("later");
    expect(result.repaired).toMatchObject({
      store: "sidecar",
      sourcePath: path,
      backupPath: "debug/sidecar-doc.json.backup"
    });
    expect(await files.read(path)).toBe(await files.read("debug/sidecar-doc.json.backup"));
    expect(await files.read(`${path}.corrupt-20260201T030405678Z`)).toBe("\u0000\u0000");
  });

  it("automatically restores a corrupt recovery snapshot from its validated backup", async () => {
    const files = new MemoryFiles();
    const repository = new RecoveryRepository(files, "recovery", {
      backupFolder: "debug",
      now: () => new Date("2026-02-01T03:04:05.678Z")
    });
    await repository.save(sidecar());
    const latest = sidecar();
    latest.updatedAt = "later";
    await repository.save(latest);
    const path = repository.pathFor("doc");
    files.data.set(path, "{");

    const result = await repository.loadWithStatus("doc");

    expect(result.data?.updatedAt).toBe("later");
    expect(result.repaired).toMatchObject({
      store: "recovery",
      backupPath: "debug/recovery-doc.recovery.json.backup"
    });
  });

  it("keeps quarantine-only behavior when automatic recovery is disabled", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations", {
      backupFolder: "debug",
      automaticRecovery: false,
      now: () => new Date("2026-02-01T03:04:05.678Z")
    });
    const path = repository.pathFor("doc");
    files.data.set(path, "{");
    await files.write("debug/sidecar-doc.json.backup", serializeSidecar(sidecar()));

    const result = await repository.loadWithStatus("doc");

    expect(result.data).toBeNull();
    expect(result.repaired).toBeUndefined();
    expect(files.data.has(path)).toBe(false);
  });

  it("finds a moved legacy sidecar and reports the explicit path rebind", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    const content = createDocumentIdentity({ vaultPath: "old/a.pdf", contentHash: "same" });
    const legacyPath = createLegacyPathIdentity("old/a.pdf").id;
    const legacy = sidecar();
    legacy.document = { ...content, id: legacyPath };
    await files.write(repository.pathFor(legacyPath), serializeSidecar(legacy));

    const result = await repository.loadForDocumentWithStatus({ vaultPath: "new/a.pdf", contentHash: "same" });
    expect(result.data).toMatchObject({
      document: { id: content.id, vaultPath: "old/a.pdf", contentHash: "same", legacyIds: [legacyPath] },
      pages: legacy.pages
    });
    expect(result.identity).toMatchObject({ matchedBy: "content", requiresPathRebind: true });
    expect(result.identity?.sourcePath).toBe(repository.pathFor(legacyPath));
  });

  it("finds a legacy recovery snapshot through the known prior path", async () => {
    const files = new MemoryFiles();
    const repository = new RecoveryRepository(files, "recovery");
    const legacyPath = createLegacyPathIdentity("old/a.pdf").id;
    const legacy = sidecar();
    legacy.document = { ...createDocumentIdentity({ vaultPath: "old/a.pdf", contentHash: "same" }), id: legacyPath };
    await files.write(repository.pathFor(legacyPath), serializeSidecar(legacy));

    const result = await repository.loadForDocumentWithStatus({
      vaultPath: "new/a.pdf",
      contentHash: "same",
      legacyPaths: ["old/a.pdf"]
    });

    expect(result.data).toMatchObject({
      document: { id: createDocumentIdentity({ vaultPath: "old/a.pdf", contentHash: "same" }).id, vaultPath: "old/a.pdf", contentHash: "same", legacyIds: [legacyPath] },
      pages: legacy.pages
    });
    expect(result.identity).toMatchObject({ matchedBy: "path", requiresPathRebind: true });
    expect(result.identity?.sourcePath).toBe(repository.pathFor(legacyPath));
  });

  it("does not merge two distinct sidecars for duplicate content", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    const first = sidecar();
    first.document = { ...createDocumentIdentity({ vaultPath: "one.pdf", contentHash: "same" }), id: createLegacyPathIdentity("one.pdf").id };
    const second = structuredClone(first);
    second.document = { ...createDocumentIdentity({ vaultPath: "two.pdf", contentHash: "same" }), id: createLegacyPathIdentity("two.pdf").id };
    second.pages[0]!.strokes[0]!.id = "different";
    await files.write(repository.pathFor(first.document.id), serializeSidecar(first));
    await files.write(repository.pathFor(second.document.id), serializeSidecar(second));

    const result = await repository.loadForDocumentWithStatus({ vaultPath: "current.pdf", contentHash: "same" });
    expect(result.data).toBeNull();
    expect(result.conflict).toMatchObject({ reason: "duplicate-content" });
  });

  it("filters a content candidate whose stored hash does not match the opened PDF", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    const candidateId = createDocumentIdentity({ vaultPath: "current.pdf", contentHash: "same" }).id;
    const wrong = sidecar();
    wrong.document = createDocumentIdentity({ vaultPath: "other.pdf", contentHash: "different" });
    await files.write(repository.pathFor(candidateId), serializeSidecar(wrong));

    const result = await repository.loadForDocumentWithStatus({ vaultPath: "current.pdf", contentHash: "same" });
    expect(result.data).toBeNull();
    expect(result.identity).toBeUndefined();
  });

  it("checks listed duplicates even when the canonical content candidate exists", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    const canonical = sidecar();
    canonical.document = createDocumentIdentity({ vaultPath: "one.pdf", contentHash: "same" });
    const duplicate = structuredClone(canonical);
    duplicate.document = { ...createDocumentIdentity({ vaultPath: "two.pdf", contentHash: "same" }), legacyIds: [createLegacyPathIdentity("two.pdf").id] };
    await files.write(repository.pathFor(canonical.document.id), serializeSidecar(canonical));
    await files.write(repository.pathFor(createLegacyPathIdentity("two.pdf").id), serializeSidecar(duplicate));

    const result = await repository.loadForDocumentWithStatus({ vaultPath: "one.pdf", contentHash: "same" });
    expect(result.data).toBeNull();
    expect(result.conflict).toMatchObject({ reason: "duplicate-content" });
  });

  it("preserves an external sidecar change in a conflict file instead of overwriting it", async () => {
    const files = new MemoryFiles();
    const now = () => new Date("2026-02-01T03:04:05.678Z");
    const repository = new SidecarRepository(files, "annotations", { now });
    await repository.save(sidecar());
    await repository.load("doc");
    const external = sidecar();
    external.updatedAt = "external";
    external.pages[0]!.strokes[0]!.id = "external";
    await files.write(repository.pathFor("doc"), serializeSidecar(external));
    const local = sidecar();
    local.updatedAt = "local";
    await expect(repository.save(local)).rejects.toBeInstanceOf(SidecarConflictError);
    expect(parseSidecar(await files.read(repository.pathFor("doc"))).pages[0]!.strokes[0]!.id).toBe("external");
    expect([...files.data.keys()]).toContain(`${repository.pathFor("doc")}.conflict-20260201T030405678Z`);
  });

  it("preserves the last valid sidecar when the first rename fails", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    files.failRename = true;
    await expect(repository.save(sidecar())).rejects.toThrow("rename failed");
    expect(files.data.has("annotations/doc.json")).toBe(false);
    expect(files.data.has("annotations/doc.json.tmp")).toBe(false);
  });

  it("preserves the last valid sidecar when an overwrite write fails", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    await repository.save(sidecar());
    const original = await files.read("annotations/doc.json");
    files.failWritePath = "annotations/doc.json";
    const changed = sidecar();
    changed.updatedAt = "later";
    await expect(repository.save(changed)).rejects.toThrow("write failed");
    expect(await files.read("annotations/doc.json")).toBe(original);
    expect(await files.read("annotations/doc.json.last-good")).toBe(original);
    expect(files.data.has("annotations/doc.json.tmp")).toBe(false);
  });

  it.each([
    ["sidecar", "{"],
    ["sidecar", "{}"],
    ["recovery", "{"]
  ] as const)("deletes malformed %s JSON when no validated recovery candidate exists", async (store, contents) => {
    const files = new MemoryFiles();
    const now = () => new Date("2026-02-01T03:04:05.678Z");
    const repository = store === "sidecar"
      ? new SidecarRepository(files, "annotations", { now })
      : new RecoveryRepository(files, "annotations/recovery", { now });
    const path = repository.pathFor("doc");
    files.data.set(path, contents);

    const result = await repository.loadWithStatus("doc");

    const quarantinePath = `${path}.corrupt-20260201T030405678Z`;
    expect(result.data).toBeNull();
    expect(result.quarantined).toMatchObject({
      store,
      sourcePath: path,
      quarantinePath,
      error: expect.any(String),
      artifactDeleted: true
    });
    expect(files.data.has(path)).toBe(false);
    expect(files.data.has(quarantinePath)).toBe(false);
  });

  it("never overwrites an earlier corrupt-sidecar quarantine", async () => {
    const files = new MemoryFiles();
    const now = () => new Date("2026-02-01T03:04:05.678Z");
    const repository = new SidecarRepository(files, "annotations", { now });
    const path = repository.pathFor("doc");
    const baseQuarantinePath = `${path}.corrupt-20260201T030405678Z`;
    files.data.set(path, "{");
    files.data.set(baseQuarantinePath, "earlier corrupt bytes");

    const result = await repository.loadWithStatus("doc");

    expect(result.quarantined?.quarantinePath).toBe(`${baseQuarantinePath}-2`);
    expect(await files.read(baseQuarantinePath)).toBe("earlier corrupt bytes");
    expect(files.data.has(`${baseQuarantinePath}-2`)).toBe(false);
  });

  it("does not enter empty mode when malformed data cannot be quarantined", async () => {
    const files = new MemoryFiles();
    const repository = new SidecarRepository(files, "annotations");
    const path = repository.pathFor("doc");
    files.data.set(path, "{");
    files.failRename = true;

    await expect(repository.loadWithStatus("doc")).rejects.toThrow("rename failed");
    expect(await files.read(path)).toBe("{");
  });
});
