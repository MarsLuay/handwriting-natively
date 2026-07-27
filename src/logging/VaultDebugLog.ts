import type { Vault } from "obsidian";
import type { VaultLogSink, VaultLogLevel } from "./VaultLogSink";
import { normalizeVaultRelativePath } from "../storage/VaultFs";

const LOG_RETENTION_MS = 60 * 60 * 1000;

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
  return recent.length ? `${recent.join("\n")}\n` : "";
}

export class VaultDebugLog implements VaultLogSink {
  private readonly buffer: string[] = [];
  private flushTimer: number | null = null;
  private retentionTimer: number | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private destroyed = false;

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

  write(level: VaultLogLevel, event: string, payload: Record<string, unknown> = {}): void {
    if (!this.enabled()) return;
    this.buffer.push(this.serialize(level, event, payload));
    this.scheduleFlush();
  }

  /**
   * Write and flush immediately so breadcrumbs survive Obsidian Mobile crashes
   * that kill the WebView before the 200ms debounce flush runs.
   */
  async writeUrgent(level: VaultLogLevel, event: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled()) return;
    this.buffer.push(this.serialize(level, event, payload));
    await this.flush();
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

  private serialize(level: VaultLogLevel, event: string, payload: Record<string, unknown>): string {
    return JSON.stringify({
      ts: this.now().toISOString(),
      level,
      event,
      ...this.context(),
      ...payload
    });
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
        const existing = await vault.adapter.exists(filePath) ? await vault.adapter.read(filePath) : "";
        const retained = retainRecentEntries(existing, this.now());
        await vault.adapter.write(filePath, `${retained}${chunk}`);
      } catch (error) {
        console.error("[Handwriting Natively] vault debug log write failed", error);
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
        if (retained !== current) await vault.adapter.write(filePath, retained);
      } catch (error) {
        console.error("[Handwriting Natively] vault debug log retention failed", error);
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
