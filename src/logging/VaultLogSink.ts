export type VaultLogLevel = "info" | "warn" | "error";

export interface VaultLogWriteOptions {
  /** Emit this event to DevTools even when informational file logging is disabled. */
  forceConsole?: boolean;
}

export interface VaultLogSink {
  write(
    level: VaultLogLevel,
    event: string,
    payload?: Record<string, unknown>,
    options?: VaultLogWriteOptions
  ): void;
  /** Optional immediate flush — used for crash breadcrumbs on Obsidian Mobile. */
  writeUrgent?(
    level: VaultLogLevel,
    event: string,
    payload?: Record<string, unknown>,
    options?: VaultLogWriteOptions
  ): Promise<void>;
}
