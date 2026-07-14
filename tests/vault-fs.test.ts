import { describe, expect, it } from "vitest";
import { createVaultFsTextAdapter, createVaultSyncWriter, resolveVaultAbsolutePath } from "../src/storage/VaultFs";
import type { Vault } from "obsidian";

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
});
