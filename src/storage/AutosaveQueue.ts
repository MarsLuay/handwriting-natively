import type { SaveStatus } from "../model";

export const DEFAULT_AUTOSAVE_DELAY_MS = 750;
export const DEFAULT_AUTOSAVE_MAX_DIRTY_INTERVAL_MS = 5_000;
export const DEFAULT_AUTOSAVE_MAX_RETRIES = 3;
export const DEFAULT_AUTOSAVE_MAX_RETRY_DELAY_MS = 30_000;

export interface AutosaveQueueOptions<T> {
  write(documentId: string, snapshot: T): Promise<void>;
  delayMs?: number;
  retryFailed?: boolean;
  retryDelayMs?: number;
  /** Prevent a stream of completed commands from postponing the first save forever. */
  maxDirtyIntervalMs?: number;
  /** Automatic retries are finite; explicit retry() remains available afterwards. */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onStatus?: (documentId: string, status: SaveStatus, error?: unknown) => void;
}

interface Entry<T> {
  snapshot: T;
  version: number;
  savedVersion: number;
  timer: number | undefined;
  running: Promise<void> | undefined;
  status: SaveStatus;
  dirtySince: number | undefined;
  retries: number;
}

export class AutosaveQueue<T> {
  readonly delayMs: number;
  readonly maxDirtyIntervalMs: number;
  readonly maxRetries: number;
  private readonly entries = new Map<string, Entry<T>>();
  private closed = false;

  constructor(private readonly options: AutosaveQueueOptions<T>) {
    this.delayMs = Math.max(0, options.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS);
    this.maxDirtyIntervalMs = Math.max(
      0,
      options.maxDirtyIntervalMs ?? Math.max(DEFAULT_AUTOSAVE_MAX_DIRTY_INTERVAL_MS, this.delayMs)
    );
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_AUTOSAVE_MAX_RETRIES));
  }

  schedule(documentId: string, snapshot: T): void {
    if (this.closed) throw new Error("AutosaveQueue is closed");
    const previous = this.entries.get(documentId);
    const entry: Entry<T> = previous ?? {
      snapshot,
      version: 0,
      savedVersion: 0,
      timer: undefined,
      running: undefined,
      status: "saved",
      dirtySince: undefined,
      retries: 0
    };
    if (entry.savedVersion >= entry.version) {
      entry.dirtySince = Date.now();
      entry.retries = 0;
    } else if (entry.dirtySince === undefined) {
      entry.dirtySince = Date.now();
    }
    entry.snapshot = snapshot;
    entry.version += 1;
    this.setStatus(documentId, entry, "dirty");
    this.scheduleDrain(documentId, entry);
    this.entries.set(documentId, entry);
  }

  getStatus(documentId: string): SaveStatus { return this.entries.get(documentId)?.status ?? "saved"; }
  isDirty(documentId: string): boolean {
    const entry = this.entries.get(documentId);
    return entry !== undefined && entry.savedVersion < entry.version;
  }

  /** Mark current queued snapshot as saved without writing (after a sync emergency persist). */
  markClean(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (!entry) return;
    if (entry.timer !== undefined) {
      window.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.savedVersion = entry.version;
    entry.dirtySince = undefined;
    entry.retries = 0;
    this.setStatus(documentId, entry, "saved");
  }

  /**
   * Stop timers and refuse further drains/writes without flushing.
   * Used when a newer session owns the document or plugin unload already synced disk.
   */
  abandon(): void {
    this.closed = true;
    for (const [documentId, entry] of this.entries) {
      if (entry.timer !== undefined) {
        window.clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.savedVersion = entry.version;
      entry.dirtySince = undefined;
      entry.retries = 0;
      this.setStatus(documentId, entry, "saved");
    }
  }

  async retry(documentId: string): Promise<void> {
    if (this.closed) return;
    const entry = this.entries.get(documentId);
    if (!entry || !this.isDirty(documentId)) return;
    if (entry.timer !== undefined) { window.clearTimeout(entry.timer); entry.timer = undefined; }
    entry.retries = 0;
    await this.drain(documentId, entry);
  }

  async flush(documentId?: string): Promise<void> {
    if (this.closed) return;
    if (documentId !== undefined) {
      const entry = this.entries.get(documentId);
      if (!entry) return;
      if (entry.timer !== undefined) { window.clearTimeout(entry.timer); entry.timer = undefined; }
      await this.drain(documentId, entry);
      return;
    }
    await Promise.all([...this.entries.keys()].map((id) => this.flush(id)));
  }

  async close(): Promise<void> {
    // Flush only if still open and dirty; abandoned queues must not write.
    if (!this.closed) await this.flush();
    this.closed = true;
  }

  private async drain(documentId: string, entry: Entry<T>): Promise<void> {
    if (this.closed) return;
    if (entry.running) { await entry.running; if (!this.closed && entry.savedVersion < entry.version) await this.drain(documentId, entry); return; }
    if (entry.savedVersion >= entry.version) return;
    if (this.closed) return;
    const targetVersion = entry.version;
    const snapshot = entry.snapshot;
    this.setStatus(documentId, entry, "saving");
    entry.running = this.options.write(documentId, snapshot).then(() => {
      if (this.closed) return;
      entry.savedVersion = Math.max(entry.savedVersion, targetVersion);
      if (entry.savedVersion < entry.version) {
        this.setStatus(documentId, entry, "dirty");
      } else {
        entry.dirtySince = undefined;
        entry.retries = 0;
        this.setStatus(documentId, entry, "saved");
      }
    }).catch((error: unknown) => {
      if (this.closed) return;
      this.setStatus(documentId, entry, "failed", error);
      const dirtyAge = entry.dirtySince === undefined ? 0 : Math.max(0, Date.now() - entry.dirtySince);
      const remainingDirtyInterval = Math.max(0, this.maxDirtyIntervalMs - dirtyAge);
      if (this.options.retryFailed && entry.retries < this.maxRetries && remainingDirtyInterval > 0) {
        entry.retries += 1;
        const baseDelay = this.options.retryDelayMs ?? this.delayMs;
        const retryDelay = Math.min(
          Math.max(0, baseDelay) * (2 ** (entry.retries - 1)),
          Math.max(0, this.options.maxRetryDelayMs ?? DEFAULT_AUTOSAVE_MAX_RETRY_DELAY_MS),
          remainingDirtyInterval
        );
        entry.timer = window.setTimeout(() => {
          entry.timer = undefined;
          void this.drain(documentId, entry).catch(() => undefined);
        }, retryDelay);
      }
      throw error;
    }).finally(() => { entry.running = undefined; });
    await entry.running;
    if (!this.closed && entry.savedVersion < entry.version && entry.status !== "failed") await this.drain(documentId, entry);
  }

  private setStatus(documentId: string, entry: Entry<T>, status: SaveStatus, error?: unknown): void {
    entry.status = status;
    this.options.onStatus?.(documentId, status, error);
  }

  private scheduleDrain(documentId: string, entry: Entry<T>): void {
    if (entry.timer !== undefined) window.clearTimeout(entry.timer);
    const dirtyAge = entry.dirtySince === undefined ? 0 : Math.max(0, Date.now() - entry.dirtySince);
    const remaining = Math.max(0, this.maxDirtyIntervalMs - dirtyAge);
    const delay = Math.min(this.delayMs, remaining);
    entry.timer = window.setTimeout(() => {
      entry.timer = undefined;
      void this.drain(documentId, entry).catch(() => undefined);
    }, delay);
  }
}
