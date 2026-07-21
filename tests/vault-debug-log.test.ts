import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { VaultDebugLog } from "../src/logging/VaultDebugLog";

function createVault(): { vault: Vault; files: Map<string, string> } {
  const files = new Map<string, string>();
  const vault = {
    adapter: {
      async exists(path: string) {
        return files.has(path);
      },
      async mkdir() {
        return;
      },
      async write(path: string, data: string) {
        files.set(path, data);
      },
      async append(path: string, data: string) {
        files.set(path, `${files.get(path) ?? ""}${data}`);
      }
    }
  } as unknown as Vault;
  return { vault, files };
}

describe("VaultDebugLog", () => {
  it("flushes all queued events in write order", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(() => vault, () => "logs/debug.log", () => true);

    log.write("info", "first");
    const firstFlush = log.flush();
    log.write("warn", "second");
    await Promise.all([firstFlush, log.flush()]);

    const events = (files.get("logs/debug.log") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["first", "second"]);
  });

  it("persists events accepted before vault logging is disabled", async () => {
    const { vault, files } = createVault();
    let enabled = true;
    const log = new VaultDebugLog(() => vault, () => "debug.log", () => enabled);

    log.write("info", "captured-before-disable");
    enabled = false;
    await log.flush();

    expect(files.get("debug.log")).toContain("captured-before-disable");
  });

  it("merges plugin and Obsidian version context into every event", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(
      () => vault,
      () => "debug.log",
      () => true,
      () => ({ pluginVersion: "0.1.16", obsidianVersion: "1.8.9" })
    );

    log.write("warn", "session attach failed", { document: "a.pdf" });
    await log.flush();

    const event = JSON.parse((files.get("debug.log") ?? "").trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "session attach failed",
      pluginVersion: "0.1.16",
      obsidianVersion: "1.8.9",
      document: "a.pdf"
    });
  });
});
