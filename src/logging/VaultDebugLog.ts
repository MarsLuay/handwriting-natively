import type { Vault } from "obsidian";
import type { VaultLogSink, VaultLogLevel } from "./VaultLogSink";
import { normalizeVaultRelativePath } from "../storage/VaultFs";

async function ensureParentFolder(vault: Vault, filePath: string): Promise<void> {
  const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  if (!parent) return;
  let current = "";
  for (const part of parent.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!await vault.adapter.exists(current)) await vault.adapter.mkdir(current);
  }
}

export class VaultDebugLog implements VaultLogSink {
  private readonly buffer: string[] = [];
  private flushTimer: number | null = null;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: () => Vault,
    private readonly path: () => string,
    private readonly enabled: () => boolean,
    /** Merged into every event before the call-site payload (e.g. plugin + Obsidian versions). */
    private readonly context: () => Record<string, unknown> = () => ({})
  ) {}

  write(level: VaultLogLevel, event: string, payload: Record<string, unknown> = {}): void {
    if (!this.enabled()) return;
    this.buffer.push(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...this.context(),
      ...payload
    }));
    this.scheduleFlush();
  }

  destroy(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
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
        if (await vault.adapter.exists(filePath)) await vault.adapter.append(filePath, chunk);
        else await vault.adapter.write(filePath, chunk);
      } catch (error) {
        console.error("[Handwriting Natively] vault debug log write failed", error);
      }
    });
    return this.flushQueue;
  }
}
