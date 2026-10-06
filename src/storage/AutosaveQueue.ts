import type { SaveStatus } from "../model";

export const DEFAULT_AUTOSAVE_DELAY_MS = 750;
export const DEFAULT_AUTOSAVE_MAX_DIRTY_INTERVAL_MS = 5_000;
export const DEFAULT_AUTOSAVE_MAX_RETRIES = 3;
export const DEFAULT_AUTOSAVE_MAX_RETRY_DELAY_MS = 30_000;
/** Timer lateness and sidecar writes above this need a bounded diagnostic. */
export const AUTOSAVE_SLOW_PHASE_MS = 100;

export interface AutosaveSlowPhase {
  phase: "timer-lateness" | "retry-timer-lateness" | "wait-for-active-write" | "sidecar-write" | "dirty-budget-overrun";
  durationMs: number;
  thresholdMs: number;
}

/** One terminal, threshold-gated autosave operation summary. */
export interface AutosaveSlowOperation {
  event: "autosave-slow";
  documentId: string;
  outcome: "saved" | "failed";
  durationMs: number;
  writeAttempts: number;
  phaseDurations: Record<string, number>;
  slowPhases: AutosaveSlowPhase[];
}

export interface AutosaveQueueOptions<T> {
  write(documentId: string, snapshot: T): Promise<void>;
  delayMs?: number;
  retryFailed?: boolean;
  retryDelayMs?: number;
  /** Prevent a stream of completed commands from postponing the first save forever. */
  maxDirtyIntervalMs?: number;
  /** Automatic retries are finite; explicit retry() remains available afterwards. */
  maxRetries?: number;
  /** Dense snapshots may request a longer quiet period without changing user settings. */
  delayMsForSnapshot?: (snapshot: T) => number;
  maxRetryDelayMs?: number;
  onStatus?: (documentId: string, status: SaveStatus, error?: unknown) => void;
  /** Receives only terminal operations with an actionable slow phase. */
  onSlowOperation?: (operation: AutosaveSlowOperation) => void;
  /** Injectable clock keeps scheduler-lateness diagnostics deterministic in tests. */
  now?: () => number;
}

interface AutosaveTiming {
  debounceTimerWaitMs: number;
  debounceTimerLatenessMs: number;
  retryTimerWaitMs: number;
  retryTimerLatenessMs: number;
  waitForActiveWriteMs: number;
  writeMs: number;
  writeAttempts: number;
  reported: boolean;
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
  timing: AutosaveTiming;
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
      retries: 0,
      timing: this.createTiming()
    };
    if (entry.savedVersion >= entry.version) {
      entry.dirtySince = this.now();
      entry.retries = 0;
      entry.timing = this.createTiming();
    } else if (entry.dirtySince === undefined) {
      entry.dirtySince = this.now();
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
    this.clearTimer(entry);
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
      this.clearTimer(entry);
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
    this.clearTimer(entry);
    entry.retries = 0;
    if (entry.timing.reported) entry.timing = this.createTiming();
    await this.drain(documentId, entry);
  }

  async flush(documentId?: string): Promise<void> {
    if (this.closed) return;
    if (documentId !== undefined) {
      const entry = this.entries.get(documentId);
      if (!entry) return;
      this.clearTimer(entry);
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
    if (entry.running) {
      const waitStartedAt = this.now();
      await entry.running;
      entry.timing.waitForActiveWriteMs = Math.max(entry.timing.waitForActiveWriteMs, this.now() - waitStartedAt);
      if (!this.closed && entry.savedVersion < entry.version) await this.drain(documentId, entry);
      return;
    }
    if (entry.savedVersion >= entry.version || this.closed) return;
    const targetVersion = entry.version;
    const snapshot = entry.snapshot;
    const writeStartedAt = this.now();
    entry.timing.writeAttempts += 1;
    this.setStatus(documentId, entry, "saving");
    entry.running = this.options.write(documentId, snapshot).then(() => {
      entry.timing.writeMs = Math.max(entry.timing.writeMs, this.now() - writeStartedAt);
      if (this.closed) return;
      entry.savedVersion = Math.max(entry.savedVersion, targetVersion);
      if (entry.savedVersion < entry.version) {
        this.setStatus(documentId, entry, "dirty");
      } else {
        const dirtyAge = this.dirtyAge(entry);
        entry.dirtySince = undefined;
        entry.retries = 0;
        this.setStatus(documentId, entry, "saved");
        this.reportSlowOperation(documentId, entry, "saved", dirtyAge);
      }
    }).catch((error: unknown) => {
      entry.timing.writeMs = Math.max(entry.timing.writeMs, this.now() - writeStartedAt);
      if (this.closed) return;
      this.setStatus(documentId, entry, "failed", error);
      const dirtyAge = this.dirtyAge(entry);
      const remainingDirtyInterval = Math.max(0, this.maxDirtyIntervalMs - dirtyAge);
      if (this.options.retryFailed && entry.retries < this.maxRetries && remainingDirtyInterval > 0) {
        entry.retries += 1;
        const baseDelay = this.options.retryDelayMs ?? this.delayMs;
        const retryDelay = Math.min(
          Math.max(0, baseDelay) * (2 ** (entry.retries - 1)),
          Math.max(0, this.options.maxRetryDelayMs ?? DEFAULT_AUTOSAVE_MAX_RETRY_DELAY_MS),
          remainingDirtyInterval
        );
        this.scheduleTimer(documentId, entry, retryDelay, "retry");
      } else {
        this.reportSlowOperation(documentId, entry, "failed", dirtyAge);
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
    const remaining = Math.max(0, this.maxDirtyIntervalMs - this.dirtyAge(entry));
    const requestedDelay = this.options.delayMsForSnapshot?.(entry.snapshot) ?? this.delayMs;
    const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : this.delayMs;
    this.scheduleTimer(documentId, entry, Math.min(delay, remaining), "debounce");
  }

  private scheduleTimer(
    documentId: string,
    entry: Entry<T>,
    delayMs: number,
    kind: "debounce" | "retry"
  ): void {
    this.clearTimer(entry);
    const scheduledAt = this.now();
    entry.timer = window.setTimeout(() => {
      entry.timer = undefined;
      const elapsedMs = Math.max(0, this.now() - scheduledAt);
      const latenessMs = Math.max(0, elapsedMs - delayMs);
      if (kind === "debounce") {
        entry.timing.debounceTimerWaitMs = Math.max(entry.timing.debounceTimerWaitMs, elapsedMs);
        entry.timing.debounceTimerLatenessMs = Math.max(entry.timing.debounceTimerLatenessMs, latenessMs);
      } else {
        entry.timing.retryTimerWaitMs = Math.max(entry.timing.retryTimerWaitMs, elapsedMs);
        entry.timing.retryTimerLatenessMs = Math.max(entry.timing.retryTimerLatenessMs, latenessMs);
      }
      void this.drain(documentId, entry).catch(() => undefined);
    }, delayMs);
  }

  private clearTimer(entry: Entry<T>): void {
    if (entry.timer !== undefined) window.clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private dirtyAge(entry: Entry<T>): number {
    return entry.dirtySince === undefined ? 0 : Math.max(0, this.now() - entry.dirtySince);
  }

  private createTiming(): AutosaveTiming {
    return {
      debounceTimerWaitMs: 0,
      debounceTimerLatenessMs: 0,
      retryTimerWaitMs: 0,
      retryTimerLatenessMs: 0,
      waitForActiveWriteMs: 0,
      writeMs: 0,
      writeAttempts: 0,
      reported: false
    };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private reportSlowOperation(
    documentId: string,
    entry: Entry<T>,
    outcome: AutosaveSlowOperation["outcome"],
    dirtyAgeMs: number
  ): void {
    if (entry.timing.reported) return;
    entry.timing.reported = true;
    const dirtyBudgetOverrunMs = Math.max(0, dirtyAgeMs - this.maxDirtyIntervalMs);
    const phaseDurations = {
      "debounce-timer-wait": roundMs(entry.timing.debounceTimerWaitMs),
      "timer-lateness": roundMs(entry.timing.debounceTimerLatenessMs),
      "retry-timer-wait": roundMs(entry.timing.retryTimerWaitMs),
      "retry-timer-lateness": roundMs(entry.timing.retryTimerLatenessMs),
      "wait-for-active-write": roundMs(entry.timing.waitForActiveWriteMs),
      "sidecar-write": roundMs(entry.timing.writeMs),
      "dirty-budget-overrun": roundMs(dirtyBudgetOverrunMs)
    };
    const phaseCandidates: Array<[AutosaveSlowPhase["phase"], number]> = [
      ["timer-lateness", entry.timing.debounceTimerLatenessMs],
      ["retry-timer-lateness", entry.timing.retryTimerLatenessMs],
      ["wait-for-active-write", entry.timing.waitForActiveWriteMs],
      ["sidecar-write", entry.timing.writeMs],
      ["dirty-budget-overrun", dirtyBudgetOverrunMs]
    ];
    const slowPhases: AutosaveSlowPhase[] = phaseCandidates.flatMap(([phase, durationMs]) => durationMs >= AUTOSAVE_SLOW_PHASE_MS
      ? [{ phase, durationMs: roundMs(durationMs), thresholdMs: AUTOSAVE_SLOW_PHASE_MS }]
      : []);
    if (slowPhases.length === 0) return;
    this.options.onSlowOperation?.({
      event: "autosave-slow",
      documentId,
      outcome,
      durationMs: roundMs(dirtyAgeMs),
      writeAttempts: entry.timing.writeAttempts,
      phaseDurations,
      slowPhases
    });
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}
