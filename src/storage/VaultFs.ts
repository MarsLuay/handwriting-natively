import type { DataAdapter, Vault } from "obsidian";
import { withAnnotationWriteLock } from "./AnnotationWriteLock";
import type { TextFileAdapter } from "./SidecarRepository";

export type VaultSyncWriter = (relativePath: string, contents: string) => void;

/** Match Obsidian normalizePath enough for vault-relative sidecar paths. */
export function normalizeVaultRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such file|ENOENT|does not exist|doesn't exist|couldn't be opened/i.test(message);
}

export interface VaultFsOperationRecord {
  readonly storeKind: "sidecar" | "recovery" | "unknown";
  readonly operation: "exists" | "list" | "read" | "mkdir" | "write" | "rename" | "remove";
  readonly logicalPath: string;
  readonly pathKindExpected: "file" | "directory";
  readonly exists?: boolean;
  readonly missingAllowed: boolean;
  readonly outcome: "missing-recovered" | "error";
  readonly documentId?: string;
  readonly errorName?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly recoveryResult: "treated-as-empty" | "propagated";
}

export type VaultFsProbe = (record: VaultFsOperationRecord) => void;

function storeKindFor(path: string): VaultFsOperationRecord["storeKind"] {
  if (path === "recovery" || path.endsWith("/recovery") || path.includes("/recovery/")) return "recovery";
  if (path === "annotations" || path.startsWith("annotations/")) return "sidecar";
  return "unknown";
}

function documentIdFromPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const match = /^((?:pdf-)?[A-Za-z0-9._-]+)\.json$/i.exec(name);
  return match?.[1];
}

function pathKindFor(operation: VaultFsOperationRecord["operation"], path: string): "file" | "directory" {
  if (operation === "list" || operation === "mkdir") return "directory";
  return path.endsWith(".json") ? "file" : "directory";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z]:\\[^\s"]+/g, "[path]")
    .replace(/\/(?:Users|home|private|var)\/[^\s"]+/g, "[path]");
}

function noteFs(
  probe: VaultFsProbe | undefined,
  operation: VaultFsOperationRecord["operation"],
  logicalPath: string,
  outcome: VaultFsOperationRecord["outcome"],
  extra: Partial<VaultFsOperationRecord> = {}
): void {
  const documentId = documentIdFromPath(logicalPath);
  probe?.({
    storeKind: storeKindFor(logicalPath),
    operation,
    logicalPath,
    pathKindExpected: pathKindFor(operation, logicalPath),
    missingAllowed: outcome === "missing-recovered",
    outcome,
    recoveryResult: outcome === "missing-recovered" ? "treated-as-empty" : "propagated",
    ...(documentId ? { documentId } : {}),
    ...extra
  });
}

async function pathExists(
  adapter: MutableAdapter,
  path: string,
  probe?: VaultFsProbe
): Promise<boolean> {
  try {
    return await adapter.exists(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      noteFs(probe, "exists", path, "missing-recovered", { exists: false, ...errorFields(error) });
      return false;
    }
    noteFs(probe, "exists", path, "error", errorFields(error));
    throw error;
  }
}

function errorFields(error: unknown): Pick<VaultFsOperationRecord, "errorName" | "errorCode" | "errorMessage"> {
  const errorName = error instanceof Error ? error.name : undefined;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
  return {
    errorMessage: safeErrorMessage(error),
    ...(errorName ? { errorName } : {}),
    ...(code ? { errorCode: code } : {})
  };
}

async function ensureVaultFolder(vault: Vault, path: string, probe?: VaultFsProbe): Promise<void> {
  if (!path) return;
  let current = "";
  for (const part of normalizeVaultRelativePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (await pathExists(vault.adapter as MutableAdapter, current, probe)) continue;
    try {
      await vault.adapter.mkdir(current);
    } catch (error) {
      noteFs(probe, "mkdir", current, "error", errorFields(error));
      throw error;
    }
  }
}

/**
 * Resolve a vault-relative path and refuse escapes (string-only; no Node path/fs).
 * Kept for unit tests of containment logic.
 */
export function resolveVaultAbsolutePath(basePath: string, relativePath: string): string {
  const normalizedBase = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalizeVaultRelativePath(relativePath);
  const parts = relative.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`Refusing path outside vault root: ${relativePath}`);
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${normalizedBase}/${stack.join("/")}`;
}

type MutableAdapter = DataAdapter & {
  write: (path: string, data: string) => Promise<void>;
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
};

function annotationDocumentLockKey(path: string): string {
  const filename = path.split("/").at(-1) ?? path;
  return filename.replace(/\.recovery\.json$/i, "").replace(/\.json$/i, "");
}

function comparePersistedSnapshotFreshness(incoming: string, current: string): number {
  try {
    const incomingValue = JSON.parse(incoming) as { updatedAt?: unknown };
    const currentValue = JSON.parse(current) as { updatedAt?: unknown };
    if (typeof incomingValue.updatedAt !== "string" || typeof currentValue.updatedAt !== "string") return 0;
    const incomingTime = Date.parse(incomingValue.updatedAt);
    const currentTime = Date.parse(currentValue.updatedAt);
    if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) {
      return incomingTime === currentTime ? 0 : incomingTime > currentTime ? 1 : -1;
    }
    return incomingValue.updatedAt === currentValue.updatedAt
      ? 0
      : incomingValue.updatedAt > currentValue.updatedAt ? 1 : -1;
  } catch {
    return 0;
  }
}

/**
 * Sync unload writer using only the Obsidian vault adapter (no Node `fs`).
 * Fire-and-forget write; prefer normal async saves while the plugin is alive.
 */
export function createVaultSyncWriter(vault: Vault): VaultSyncWriter | null {
  const adapter = vault.adapter as MutableAdapter;
  if (typeof adapter.write !== "function") return null;
  return (relativePath, contents) => {
    const normalized = normalizeVaultRelativePath(relativePath);
    void withAnnotationWriteLock(adapter, annotationDocumentLockKey(normalized), async () => {
      await ensureVaultFolder(vault, parentPath(normalized));

      // beforeunload/onunload cannot await the vault adapter. Stage the exact
      // snapshot first and retain the previous primary before replacing it so
      // a process termination during the final write leaves a recoverable
      // candidate instead of a blank/truncated JSON document.
      const emergencyTemp = `${normalized}.emergency.tmp`;
      const lastGood = `${normalized}.last-good`;
      const hadPrevious = await adapter.exists(normalized);
      const previous = hadPrevious ? await adapter.read(normalized) : null;
      if (previous !== null) await adapter.write(lastGood, previous);
      await adapter.write(emergencyTemp, contents);
      if (await adapter.read(emergencyTemp) !== contents) throw new Error("Emergency annotation staging verification failed");

      // A normal autosave or another live session may have committed while
      // this fire-and-forget unload write was staging. Never replace a newer
      // canonical snapshot with an older stale session; leave the staged
      // bytes for recovery instead.
      const currentExists = await adapter.exists(normalized);
      const current = currentExists ? await adapter.read(normalized) : null;
      if (current !== previous && current !== contents) {
        if (current === null || comparePersistedSnapshotFreshness(contents, current) <= 0) return;
      }

      await adapter.write(normalized, contents);
      if (await adapter.read(normalized) !== contents) throw new Error("Emergency annotation commit verification failed");
      await adapter.remove(emergencyTemp);
    }).catch(() => undefined);
  };
}

/** Sidecar/recovery I/O via Obsidian DataAdapter only (mobile-safe, catalog-safe). */
export function createVaultFsTextAdapter(vault: Vault, probe?: VaultFsProbe): TextFileAdapter {
  const adapter = vault.adapter as MutableAdapter;
  return {
    lockOwner: adapter,
    exists: (path) => pathExists(adapter, normalizeVaultRelativePath(path), probe),
    async read(path) {
      const normalized = normalizeVaultRelativePath(path);
      try {
        return await adapter.read(normalized);
      } catch (error) {
        noteFs(probe, "read", normalized, "error", errorFields(error));
        throw error;
      }
    },
    async write(path, contents) {
      const normalized = normalizeVaultRelativePath(path);
      await ensureVaultFolder(vault, parentPath(normalized), probe);
      try {
        await adapter.write(normalized, contents);
      } catch (error) {
        noteFs(probe, "write", normalized, "error", errorFields(error));
        throw error;
      }
    },
    async rename(from, to) {
      const src = normalizeVaultRelativePath(from);
      const dest = normalizeVaultRelativePath(to);
      await ensureVaultFolder(vault, parentPath(dest), probe);
      try {
        // Obsidian refuses adapter.rename when dest already exists.
        if (await adapter.exists(dest)) {
          const contents = await adapter.read(src);
          await adapter.write(dest, contents);
          if (await adapter.exists(src)) await adapter.remove(src);
          return;
        }
        if (typeof adapter.rename === "function") {
          await adapter.rename(src, dest);
          return;
        }
        const contents = await adapter.read(src);
        await adapter.write(dest, contents);
        if (await adapter.exists(src)) await adapter.remove(src);
      } catch (error) {
        noteFs(probe, "rename", dest, "error", errorFields(error));
        throw error;
      }
    },
    async remove(path) {
      const normalized = normalizeVaultRelativePath(path);
      try {
        if (await adapter.exists(normalized)) await adapter.remove(normalized);
      } catch (error) {
        noteFs(probe, "remove", normalized, "error", errorFields(error));
        throw error;
      }
    },
    async list(folder) {
      if (typeof adapter.list !== "function") return [];
      const normalized = normalizeVaultRelativePath(folder);
      if (!await pathExists(adapter, normalized, probe)) {
        noteFs(probe, "list", normalized, "missing-recovered", { exists: false });
        return [];
      }
      try {
        return (await adapter.list(normalized)).files;
      } catch (error) {
        if (isMissingPathError(error) && !await pathExists(adapter, normalized, probe)) {
          noteFs(probe, "list", normalized, "missing-recovered", { exists: false, ...errorFields(error) });
          return [];
        }
        noteFs(probe, "list", normalized, "error", errorFields(error));
        throw error;
      }
    }
  };
}
