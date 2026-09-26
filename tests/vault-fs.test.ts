import { describe, expect, it } from "vitest";
import { createVaultFsTextAdapter, createVaultSyncWriter, resolveVaultAbsolutePath } from "../src/storage/VaultFs";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository } from "../src/storage/SidecarRepository";
import type { Vault } from "obsidian";

const MISSING_FOLDER = "The file “annotations” couldn’t be opened because there is no such file.";

function vaultWith(options: {
  files?: Map<string, string>;
  exists?: (path: string) => Promise<boolean>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
}): Vault {
  const files = options.files ?? new Map<string, string>();
  return {
    adapter: {
      async exists(path: string) {
        if (options.exists) return options.exists(path);
        if (files.has(path)) return true;
        return [...files.keys()].some((key) => key.startsWith(`${path}/`));
      },
      async read(path: string) {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
      async write(path: string, data: string) {
        files.set(path, data);
      },
      async remove(path: string) {
        files.delete(path);
      },
      async mkdir() {
        return;
      },
      async rename(from: string, to: string) {
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.set(to, value);
        files.delete(from);
      },
      async list(path: string) {
        if (options.list) return options.list(path);
        return { files: [...files.keys()].filter((key) => key.startsWith(`${path}/`)), folders: [] };
      }
    }
  } as unknown as Vault;
}

describe("vault fs sidecar I/O", () => {
  it("refuses paths that escape the vault root", () => {
    expect(() => resolveVaultAbsolutePath("/vault", "../outside.txt")).toThrow(/outside vault root/);
  });

  it("adapter text I/O writes and reads through DataAdapter", async () => {
    const files = new Map<string, string>();
    const vault = {
      adapter: {
        async exists(path: string) {
          if (files.has(path)) return true;
          // folders
          return [...files.keys()].some((key) => key.startsWith(`${path}/`));
        },
        async read(path: string) {
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        },
        async write(path: string, data: string) {
          files.set(path, data);
        },
        async remove(path: string) {
          files.delete(path);
        },
        async mkdir() {
          return;
        },
        async rename(from: string, to: string) {
          const value = files.get(from);
          if (value === undefined) throw new Error(`missing ${from}`);
          files.set(to, value);
          files.delete(from);
        }
      }
    } as unknown as Vault;

    const writeSync = createVaultSyncWriter(vault);
    expect(writeSync).not.toBeNull();
    const text = createVaultFsTextAdapter(vault);

    const path = "annotations/doc.json";
    const next = JSON.stringify({ updatedAt: "2026-07-13T22:08:34.000Z", strokes: 1 });
    writeSync!(path, next);
    for (let i = 0; i < 10 && !files.has(path); i += 1) {
      await Promise.resolve();
    }
    expect(files.has(path)).toBe(true);
    expect(await text.read(path)).toBe(next);

    await text.write(path, JSON.stringify({ updatedAt: "later", strokes: 0 }));
    expect(JSON.parse(await text.read(path)).strokes).toBe(0);
  });

  it("treats a missing annotations directory as an empty sidecar and recovery store", async () => {
    let listed = 0;
    const vault = vaultWith({
      exists: async () => false,
      list: async (path) => {
        listed += 1;
        throw new Error(path === "annotations" || path === "recovery"
          ? MISSING_FOLDER
          : "unexpected list");
      }
    });
    const text = createVaultFsTextAdapter(vault);
    expect(await text.list!("annotations")).toEqual([]);
    expect(await text.list!("recovery")).toEqual([]);
    expect(listed).toBe(0);
    expect(await text.exists("annotations")).toBe(false);

    const sidecars = new SidecarRepository(text, "annotations");
    const recovery = new RecoveryRepository(text, "recovery");
    const input = { vaultPath: "Notes/example.pdf" };
    expect((await sidecars.loadForDocumentWithStatus(input)).data).toBeNull();
    expect((await recovery.loadForDocumentWithStatus(input)).data).toBeNull();
  });

  it("still lists an existing folder and does not swallow a real list failure", async () => {
    const files = new Map([["annotations/pdf-1.json", "{}"]]);
    const existing = vaultWith({ files });
    expect(await createVaultFsTextAdapter(existing).list!("annotations")).toEqual(["annotations/pdf-1.json"]);

    const broken = vaultWith({
      exists: async () => true,
      list: async () => {
        throw new Error("EIO");
      }
    });
    await expect(createVaultFsTextAdapter(broken).list!("annotations")).rejects.toThrow("EIO");

    const missingProbe = vaultWith({
      exists: async () => {
        throw new Error("EIO");
      }
    });
    await expect(createVaultFsTextAdapter(missingProbe).exists("annotations")).rejects.toThrow("EIO");
  });
});
