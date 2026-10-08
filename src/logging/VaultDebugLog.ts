import type { Vault } from "obsidian";
import type { VaultLogSink, VaultLogLevel, VaultLogWriteOptions } from "./VaultLogSink";
import { normalizeVaultRelativePath } from "../storage/VaultFs";

const LOG_RETENTION_MS = 60 * 60 * 1000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const LOG_COMPACTION_INTERVAL_MS = 5 * 60 * 1000;
const LOG_COMPACTION_BYTES = 512 * 1024;
const COPY_CONSOLE_LOG_MAX_ENTRIES = 120;
const COPY_CONSOLE_LOG_MAX_CHARACTERS = 64 * 1024;
const COPY_CONSOLE_LOG_MAX_ENTRY_CHARACTERS = 12 * 1024;

async function ensureParentFolder(vault: Vault, filePath: string): Promise<void> {
  const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  if (!parent) return;
  let current = "";
  for (const part of parent.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!await vault.adapter.exists(current)) await vault.adapter.mkdir(current);
  }
}

/** Keep the on-disk JSONL debug log bounded without retaining stale diagnostics. */
function retainRecentEntries(contents: string, now: Date): string {
  const cutoff = now.getTime() - LOG_RETENTION_MS;
  const recent = contents.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    try {
      const entry = JSON.parse(line) as { ts?: unknown };
      const timestamp = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    } catch {
      // A non-JSON line has no trustworthy timestamp and must not bypass retention.
      return false;
    }
  });
  const bounded: string[] = [];
  let bytes = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const line = recent[index]!;
    const lineBytes = line.length + 1;
    if (bounded.length > 0 && bytes + lineBytes > LOG_MAX_BYTES) break;
    bounded.push(line);
    bytes += lineBytes;
  }
  bounded.reverse();
  return bounded.length ? `${bounded.join("\n")}\n` : "";
}

export class VaultDebugLog implements VaultLogSink {
  private readonly buffer: string[] = [];
  private readonly recentConsoleEntries: string[] = [];
  private recentConsoleCharacters = 0;
  private flushTimer: number | null = null;
  private retentionTimer: number | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private lastCompactionAtMs = 0;
  private uncompactedBytes = 0;

  constructor(
    private readonly vault: () => Vault,
    private readonly path: () => string,
    private readonly enabled: () => boolean,
    /** Merged into every event before the call-site payload (e.g. plugin + Obsidian versions). */
    private readonly context: () => Record<string, unknown> = () => ({}),
    private readonly now: () => Date = () => new Date()
  ) {
    void this.pruneExpired();
    this.scheduleRetentionPrune();
  }

  write(
    level: VaultLogLevel,
    event: string,
    payload: Record<string, unknown> = {},
    options: VaultLogWriteOptions = {}
  ): void {
    const line = this.capture(level, event, payload, options);
    if (line === null) return;
    this.buffer.push(line);
    this.scheduleFlush();
  }

  /**
   * Write and flush immediately so breadcrumbs survive Obsidian Mobile crashes
   * that kill the WebView before the 200ms debounce flush runs.
   */
  async writeUrgent(
    level: VaultLogLevel,
    event: string,
    payload: Record<string, unknown> = {},
    options: VaultLogWriteOptions = {}
  ): Promise<void> {
    const line = this.capture(level, event, payload, options);
    if (line === null) return;
    this.buffer.push(line);
    await this.flush();
  }

  /** Recent plugin records actually emitted through the DevTools console sink. */
  recentConsoleLog(): string {
    return this.recentConsoleEntries.join("\n");
  }

  /** Start a newly loaded plugin with a clean debug log. */
  clear(): Promise<void> {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer.splice(0);
    this.recentConsoleEntries.splice(0);
    this.recentConsoleCharacters = 0;
    this.flushQueue = this.flushQueue.then(async () => {
      try {
        const vault = this.vault();
        const filePath = normalizeVaultRelativePath(this.path());
        await ensureParentFolder(vault, filePath);
        await vault.adapter.write(filePath, "");
        this.lastCompactionAtMs = this.now().getTime();
        this.uncompactedBytes = 0;
      } catch (error) {
        this.reportConsoleFailure("vault debug log clear failed", error);
      }
    });
    return this.flushQueue;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retentionTimer !== null) {
      window.clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
    void this.flush();
  }

  private capture(
    level: VaultLogLevel,
    event: string,
    payload: Record<string, unknown>,
    options: VaultLogWriteOptions
  ): string | null {
    const enabled = this.enabled();
    const record = {
      ts: this.now().toISOString(),
      level,
      event,
      ...this.context(),
      ...payload
    };
    // Errors and warnings stay visible in DevTools even when file diagnostics
    // are off. Informational diagnostics follow the existing opt-in setting.
    const emitToConsole = enabled || level !== "info" || options.forceConsole;
    let line: string | null = null;
    if (enabled || emitToConsole) {
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({
          ts: record.ts,
          level,
          event,
          logRecordSerialization: "failed",
          payload: "[omitted from copied diagnostics]"
        });
      }
    }
    if (emitToConsole) {
      const prefix = "[Handwriting Natively]";
      if (level === "info") console.debug(prefix, event, record);
      else if (level === "warn") console.warn(prefix, event, record);
      else console.error(prefix, event, record);
      if (line !== null) this.retainRecentConsoleEntry(line, record);
    }
    return enabled ? line : null;
  }

  private retainRecentConsoleEntry(line: string, record: Record<string, unknown>): void {
    let entry = line;
    if (entry.length > COPY_CONSOLE_LOG_MAX_ENTRY_CHARACTERS) {
      entry = JSON.stringify({
        ts: record.ts,
        level: record.level,
        event: record.event,
        truncatedForCopy: true,
        originalCharacters: line.length,
        preview: line.slice(0, 1024)
      });
    }
    this.recentConsoleEntries.push(entry);
    this.recentConsoleCharacters += entry.length;
    while (
      this.recentConsoleEntries.length > COPY_CONSOLE_LOG_MAX_ENTRIES
      || this.recentConsoleCharacters > COPY_CONSOLE_LOG_MAX_CHARACTERS
    ) {
      const removed = this.recentConsoleEntries.shift();
      if (removed === undefined) break;
      this.recentConsoleCharacters -= removed.length;
    }
  }

  private reportConsoleFailure(event: string, error: unknown): void {
    const errorRecord = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 4096) }
      : { message: String(error) };
    const record = {
      ts: this.now().toISOString(),
      level: "error",
      event,
      error: errorRecord
    };
    console.error("[Handwriting Natively]", event, error);
    this.retainRecentConsoleEntry(JSON.stringify(record), record);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 200);
  }

  /** Persist every event written before this call, in write order. */
  flush(): Promise<void> {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.buffer.length) return this.flushQueue;
    const chunk = `${this.buffer.splice(0).join("\n")}\n`;
    this.flushQueue = this.flushQueue.then(async () => {
      try {
        const vault = this.vault();
        const filePath = normalizeVaultRelativePath(this.path());
        await ensureParentFolder(vault, filePath);
        const now = this.now();
        const shouldCompact = this.lastCompactionAtMs === 0
          || now.getTime() - this.lastCompactionAtMs >= LOG_COMPACTION_INTERVAL_MS
          || this.uncompactedBytes + chunk.length >= LOG_COMPACTION_BYTES;
        const exists = await vault.adapter.exists(filePath);
        if (shouldCompact) {
          const existing = exists ? await vault.adapter.read(filePath) : "";
          const retained = retainRecentEntries(`${existing}${chunk}`, now);
          await vault.adapter.write(filePath, retained);
          this.lastCompactionAtMs = now.getTime();
          this.uncompactedBytes = 0;
        } else if (exists) {
          await vault.adapter.append(filePath, chunk);
          this.uncompactedBytes += chunk.length;
        } else {
          await vault.adapter.write(filePath, chunk);
          this.lastCompactionAtMs = now.getTime();
          this.uncompactedBytes = 0;
        }
      } catch (error) {
        this.reportConsoleFailure("vault debug log write failed", error);
      }
    });
    return this.flushQueue;
  }

  private pruneExpired(): Promise<void> {
    this.flushQueue = this.flushQueue.then(async () => {
      try {
        const vault = this.vault();
        const filePath = normalizeVaultRelativePath(this.path());
        if (!await vault.adapter.exists(filePath)) return;
        const current = await vault.adapter.read(filePath);
        const retained = retainRecentEntries(current, this.now());
        if (retained !== current) {
          await vault.adapter.write(filePath, retained);
          this.lastCompactionAtMs = this.now().getTime();
          this.uncompactedBytes = 0;
        }
      } catch (error) {
        this.reportConsoleFailure("vault debug log retention failed", error);
      }
    });
    return this.flushQueue;
  }

  private scheduleRetentionPrune(): void {
    if (this.destroyed || this.retentionTimer !== null) return;
    this.retentionTimer = window.setTimeout(() => {
      this.retentionTimer = null;
      void this.pruneExpired().finally(() => this.scheduleRetentionPrune());
    }, LOG_RETENTION_MS);
  }
}
