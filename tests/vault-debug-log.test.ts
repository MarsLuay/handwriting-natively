import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { VaultDebugLog } from "../src/logging/VaultDebugLog";

function createVault(): { vault: Vault; files: Map<string, string>; writes: string[]; appends: string[] } {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const appends: string[] = [];
  const vault = {
    adapter: {
      async exists(path: string) {
        return files.has(path);
      },
      async mkdir() {
        return;
      },
      async write(path: string, data: string) {
        writes.push(data);
        files.set(path, data);
      },
      async read(path: string) {
        const value = files.get(path);
        if (value === undefined) throw new Error(`Missing ${path}`);
        return value;
      },
      async append(path: string, data: string) {
        appends.push(data);
        files.set(path, `${files.get(path) ?? ""}${data}`);
      }
    }
  } as unknown as Vault;
  return { vault, files, writes, appends };
}

describe("VaultDebugLog", () => {
  it("flushes all queued events in write order", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(() => vault, () => "logs/debug.md", () => true);

    log.write("info", "first");
    const firstFlush = log.flush();
    log.write("warn", "second");
    await Promise.all([firstFlush, log.flush()]);

    const events = (files.get("logs/debug.md") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["first", "second"]);
  });

  it("uses append for frequent flushes instead of rewriting the retained log", async () => {
    const { vault, files, writes, appends } = createVault();
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => true);

    log.write("info", "first");
    await log.flush();
    log.write("info", "second");
    await log.flush();

    expect(files.get("debug.md")).toContain('"event":"first"');
    expect(files.get("debug.md")).toContain('"event":"second"');
    expect(writes).toHaveLength(1);
    expect(appends).toHaveLength(1);
  });

  it("persists events accepted before vault logging is disabled", async () => {
    const { vault, files } = createVault();
    let enabled = true;
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => enabled);

    log.write("info", "captured-before-disable");
    enabled = false;
    await log.flush();

    expect(files.get("debug.md")).toContain("captured-before-disable");
  });

  it("clears previous entries before a newly loaded plugin writes diagnostics", async () => {
    const { vault, files } = createVault();
    files.set("logs/debug.md", "old diagnostic\n");
    const log = new VaultDebugLog(() => vault, () => "logs/debug.md", () => true);

    await log.clear();
    log.write("info", "new diagnostic");
    await log.flush();

    expect(files.get("logs/debug.md")).not.toContain("old diagnostic");
    expect(files.get("logs/debug.md")).toContain("new diagnostic");
  });

  it("merges plugin and Obsidian version context into every event", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(
      () => vault,
      () => "debug.md",
      () => true,
      () => ({ pluginVersion: "0.1.16", obsidianVersion: "1.8.9" })
    );

    log.write("warn", "session attach failed", { document: "a.pdf" });
    await log.flush();

    const event = JSON.parse((files.get("debug.md") ?? "").trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "session attach failed",
      pluginVersion: "0.1.16",
      obsidianVersion: "1.8.9",
      document: "a.pdf"
    });
  });

  it("writeUrgent flushes before returning so crash breadcrumbs persist", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(
      () => vault,
      () => "debug.md",
      () => true,
      () => ({ pluginVersion: "0.1.17" })
    );

    await log.writeUrgent("info", "session attach prepare", { document: "big.pdf" });
    expect(files.get("debug.md")).toContain("session attach prepare");
    expect(files.get("debug.md")).toContain("0.1.17");
  });

  it("removes stale or malformed entries while retaining the last hour of diagnostics", async () => {
    const { vault, files } = createVault();
    const now = new Date("2026-07-27T12:00:00.000Z");
    files.set("debug.md", [
      JSON.stringify({ ts: "2026-07-27T10:59:59.999Z", event: "stale" }),
      JSON.stringify({ ts: "2026-07-27T11:00:00.000Z", event: "one-hour-old" }),
      JSON.stringify({ ts: "2026-07-27T11:45:00.000Z", event: "recent" }),
      "not valid JSON"
    ].join("\n").concat("\n"));
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => true, () => ({}), () => now);

    log.write("info", "new");
    await log.flush();

    const events = (files.get("debug.md") ?? "").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["one-hour-old", "recent", "new"]);
    log.destroy();
  });

  it("bounds a retained log during compaction", async () => {
    const { vault, files } = createVault();
    const now = new Date("2026-07-27T12:00:00.000Z");
    files.set("debug.md", Array.from({ length: 100_000 }, (_, index) => JSON.stringify({
      ts: now.toISOString(),
      event: `event-${index}`,
      payload: "x".repeat(100)
    })).join("\n").concat("\n"));
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => true, () => ({}), () => now);

    await log.flush();

    expect((files.get("debug.md") ?? "").length).toBeLessThanOrEqual(8 * 1024 * 1024 + 200);
    expect(files.get("debug.md")).toContain('"event":"event-99999"');
    log.destroy();
  });

  it("drops non-JSON log lines instead of retaining them or crashing", async () => {
    const { vault, files } = createVault();
    const now = new Date("2026-07-27T12:00:00.000Z");
    files.set("debug.md", "this is plain text, not JSON\n");
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => true, () => ({}), () => now);

    log.write("info", "new");
    await log.flush();

    const result = files.get("debug.md") ?? "";
    expect(result).not.toContain("this is plain text");
    const events = result.trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["new"]);
    log.destroy();
  });
});
