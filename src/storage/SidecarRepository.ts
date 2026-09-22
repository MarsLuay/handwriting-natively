import {
  createDocumentIdentity,
  documentIdentityCandidates,
  normalizeVaultPath,
  type DocumentIdentityInput
} from "./DocumentIdentity";
import { MigrationManager } from "./MigrationManager";
import { serializeSidecar, type SidecarDocumentIdentity, type SidecarSchemaV1 } from "./SidecarSchema";

export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  /** Optional vault listing used only to find a moved legacy sidecar. */
  list?(folder: string): Promise<string[]>;
}

export type AnnotationStoreKind = "sidecar" | "recovery";

export interface QuarantinedAnnotationFile {
  store: AnnotationStoreKind;
  sourcePath: string;
  quarantinePath: string;
  error: string;
}

export interface DocumentIdentityMatch {
  requested: SidecarDocumentIdentity;
  stored: SidecarDocumentIdentity;
  sourcePath: string;
  matchedBy: "content" | "fingerprint" | "path";
  /** A caller must explicitly confirm this path rebind before saving. */
  requiresPathRebind: boolean;
}

export interface IdentityConflict {
  paths: string[];
  reason: "duplicate-content" | "external-change";
}

export interface AnnotationLoadResult<T> {
  data: T | null;
  quarantined: QuarantinedAnnotationFile | null;
  identity?: DocumentIdentityMatch;
  conflict?: IdentityConflict;
}

export interface AnnotationLoadOptions {
  store: AnnotationStoreKind;
  now?: () => Date;
}

export class SidecarConflictError extends Error {
  readonly sidecarPath: string;
  readonly conflictPath: string | null;

  constructor(message: string, sidecarPath: string, conflictPath: string | null = null) {
    super(message);
    this.name = "SidecarConflictError";
    this.sidecarPath = sidecarPath;
    this.conflictPath = conflictPath;
  }
}

/**
 * Read a canonical annotation file without ever silently replacing malformed
 * user data. Parse failures move the exact original bytes aside first, then
 * let the caller continue with an empty store.
 */
export async function loadAnnotationFileWithQuarantine<T>(
  files: TextFileAdapter,
  path: string,
  parse: (contents: string) => T,
  options: AnnotationLoadOptions
): Promise<AnnotationLoadResult<T>> {
  if (!await files.exists(path)) return { data: null, quarantined: null };
  // Do not classify I/O failures as corruption: the source has not been read
  // and must remain authoritative until the adapter error is resolved.
  const contents = await files.read(path);
  try {
    return { data: parse(contents), quarantined: null };
  } catch (error) {
    const quarantinePath = await nextCorruptPath(files, path, options.now?.() ?? new Date());
    await moveWithoutOverwrite(files, path, quarantinePath, contents);
    return {
      data: null,
      quarantined: {
        store: options.store,
        sourcePath: path,
        quarantinePath,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function nextCorruptPath(files: TextFileAdapter, path: string, now: Date): Promise<string> {
  const base = `${path}.corrupt-${safeTimestamp(now)}`;
  let candidate = base;
  let suffix = 2;
  while (await files.exists(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

async function moveWithoutOverwrite(
  files: TextFileAdapter,
  sourcePath: string,
  destinationPath: string,
  contents: string
): Promise<void> {
  if (files.rename) {
    await files.rename(sourcePath, destinationPath);
    return;
  }
  if (!files.remove) {
    throw new Error(`Cannot quarantine malformed annotation file: adapter cannot move ${sourcePath}`);
  }
  // Fallback preserves the source until the copy has been fully written.
  await files.write(destinationPath, contents);
  await files.remove(sourcePath);
}

export interface SidecarRepositoryOptions {
  now?: () => Date;
}

export interface SaveForDocumentOptions {
  /** Required to turn a content match at another path into an explicit move. */
  allowPathRebind?: boolean;
}

export class SidecarRepository {
  private readonly migration = new MigrationManager();
  /** Raw bytes last observed by this repository; used as an optimistic lock. */
  private readonly knownContents = new Map<string, string>();

  constructor(
    private readonly files: TextFileAdapter,
    private readonly folder: string,
    private readonly options: SidecarRepositoryOptions = {}
  ) {}

  pathFor(documentId: string): string {
    const safe = documentId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${this.folder.replace(/[\\/]$/, "")}/${safe}.json`;
  }

  async load(documentId: string): Promise<SidecarSchemaV1 | null> {
    return (await this.loadWithStatus(documentId)).data;
  }

  async loadWithStatus(documentId: string): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const path = this.pathFor(documentId);
    const result = await loadAnnotationFileWithQuarantine(
      this.files,
      path,
      (contents) => this.migration.migrate(contents),
      { store: "sidecar", ...(this.options.now ? { now: this.options.now } : {}) }
    );
    if (result.data) this.knownContents.set(path, await this.files.read(path));
    else if (result.quarantined) this.knownContents.delete(path);
    return result;
  }

  /**
   * Look up content identity first, then the optional fingerprint and finally
   * the legacy path key. A content match at another path is returned with an
   * explicit rebind marker; it is never silently treated as a duplicate.
   */
  async loadForDocument(input: DocumentIdentityInput): Promise<SidecarSchemaV1 | null> {
    return (await this.loadForDocumentWithStatus(input)).data;
  }

  async loadForDocumentWithStatus(input: DocumentIdentityInput): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const requested = createDocumentIdentity(input);
    const candidates = documentIdentityCandidates(input);
    const candidatePaths = new Set(candidates.map((candidate) => this.pathFor(candidate.identity.id)));
    const matches: Array<{ data: SidecarSchemaV1; path: string; matchedBy: DocumentIdentityMatch["matchedBy"] }> = [];
    let quarantined: QuarantinedAnnotationFile | null = null;

    for (const candidate of candidates) {
      const path = this.pathFor(candidate.identity.id);
      const result = await this.loadWithStatus(candidate.identity.id);
      quarantined ??= result.quarantined;
      if (result.data && matchesCandidate(result.data.document, candidate.source, input, candidate.identity.vaultPath)) {
        matches.push({ data: result.data, path, matchedBy: candidate.source });
      }
    }

    // The optional list is what makes a moved legacy sidecar discoverable when
    // the old path is no longer derivable from the current PDF path.
    if (this.files.list) {
      const listed = await this.files.list(this.folder);
      for (const path of listed) {
        if (candidatePaths.has(path) || !path.endsWith(".json") || path.includes(".corrupt-") || path.endsWith(".tmp")) continue;
        let data: SidecarSchemaV1;
        try {
          data = this.migration.migrate(await this.files.read(path));
        } catch {
          continue;
        }
        if (matchesDocumentIdentity(data.document, input)) {
          this.knownContents.set(path, await this.files.read(path));
          matches.push({
            data,
            path,
            matchedBy: input.contentHash ? "content" : input.fingerprint ? "fingerprint" : "path"
          });
        }
      }
    }

    if (!matches.length) return { data: null, quarantined };
    const distinctPaths = [...new Set(matches.map((match) => match.path))];
    if (distinctPaths.length > 1) {
      const primary = matches[0]!.data.document;
      const aliasesAccountForExtras = matches.slice(1).every((match) =>
        primary.aliases?.some((alias) => normalizeVaultPath(alias) === normalizeVaultPath(match.data.document.vaultPath)) === true
      );
      const payload = annotationPayload(matches[0]!.data);
      const samePayload = matches.slice(1).every((match) => annotationPayload(match.data) === payload);
      if (!samePayload || !aliasesAccountForExtras) {
        return {
          data: null,
          quarantined,
          conflict: { paths: distinctPaths, reason: "duplicate-content" }
        };
      }
    }

    const match = matches[0]!;
    const stored = match.data.document;
    const requiresPathRebind = normalizeVaultPath(stored.vaultPath) !== normalizeVaultPath(requested.vaultPath) &&
      !(stored.aliases ?? []).some((alias) => normalizeVaultPath(alias) === normalizeVaultPath(requested.vaultPath));
    return {
      data: match.data,
      quarantined,
      identity: {
        requested,
        stored,
        sourcePath: match.path,
        matchedBy: match.matchedBy,
        requiresPathRebind
      }
    };
  }

  async save(sidecar: SidecarSchemaV1): Promise<void> {
    await this.saveAtPath(sidecar, this.pathFor(sidecar.document.id), false);
  }

  /** Save under the canonical content key after an explicit move/rebind. */
  async saveForDocument(
    input: DocumentIdentityInput,
    sidecar: SidecarSchemaV1,
    options: SaveForDocumentOptions = {}
  ): Promise<SidecarSchemaV1> {
    const canonical = createDocumentIdentity(input);
    const aliases = new Set(sidecar.document.aliases ?? []);
    if (normalizeVaultPath(sidecar.document.vaultPath) !== canonical.vaultPath) {
      aliases.add(normalizeVaultPath(sidecar.document.vaultPath));
    }
    const normalized: SidecarSchemaV1 = {
      ...sidecar,
      document: {
        ...canonical,
        ...(aliases.size ? { aliases: [...aliases] } : {})
      }
    };
    await this.saveAtPath(normalized, this.pathFor(canonical.id), options.allowPathRebind === true);
    return normalized;
  }

  async remove(documentId: string): Promise<void> {
    const path = this.pathFor(documentId);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
    this.knownContents.delete(path);
  }

  private async saveAtPath(sidecar: SidecarSchemaV1, path: string, allowPathRebind: boolean): Promise<void> {
    const next = serializeSidecar(sidecar);
    const previous = await this.files.exists(path) ? await this.files.read(path) : null;
    const expected = this.knownContents.get(path);

    if (previous !== null && expected !== undefined && previous !== expected) {
      await this.preserveConflict(path, next, "the sidecar changed outside this repository");
    }

    if (previous !== null) {
      let existing: SidecarSchemaV1;
      try {
        existing = this.migration.migrate(previous);
      } catch {
        await this.preserveConflict(path, next, "the existing sidecar is not readable");
        return;
      }
      const sameContent = existing.document.contentHash !== undefined &&
        sidecar.document.contentHash !== undefined &&
        existing.document.contentHash.trim().toLowerCase() === sidecar.document.contentHash.trim().toLowerCase();
      if (sameContent && existing.document.vaultPath !== sidecar.document.vaultPath && !allowPathRebind) {
        await this.preserveConflict(path, next, "duplicate content has a different vault path");
      }
      if (expected === undefined && existing.updatedAt > sidecar.updatedAt) {
        await this.preserveConflict(path, next, "the on-disk sidecar is newer than this snapshot");
      }
    }

    // Stage + validate via temp, then commit. Obsidian's adapter.rename throws
    // "Destination file already exists!" when replacing, so overwriting dest uses
    // write (not rename) whenever the sidecar path is already present.
    if (this.files.rename || this.files.remove) {
      const temp = `${path}.tmp`;
      await this.files.write(temp, next);
      try {
        this.migration.migrate(await this.files.read(temp));
        if (previous !== null) {
          await this.files.write(path, next);
          if (this.files.remove) await this.files.remove(temp);
        } else if (this.files.rename) {
          await this.files.rename(temp, path);
        } else {
          await this.files.write(path, next);
          if (this.files.remove) await this.files.remove(temp);
        }
      } catch (error) {
        if (this.files.remove && await this.files.exists(temp)) await this.files.remove(temp);
        if (previous !== null) await this.files.write(path, previous).catch(() => undefined);
        throw error;
      }
      this.knownContents.set(path, next);
      return;
    }

    try {
      await this.files.write(path, next);
      this.migration.migrate(await this.files.read(path));
      this.knownContents.set(path, next);
    } catch (error) {
      if (previous !== null) await this.files.write(path, previous).catch(() => undefined);
      throw error;
    }
  }

  private async preserveConflict(path: string, contents: string, reason: string): Promise<never> {
    const conflictPath = await nextConflictPath(this.files, path, this.options.now?.() ?? new Date());
    try {
      await this.files.write(conflictPath, contents);
    } catch {
      throw new SidecarConflictError(`${reason}; recovery snapshot must remain authoritative`, path, null);
    }
    throw new SidecarConflictError(`${reason}; preserved this snapshot at ${conflictPath}`, path, conflictPath);
  }
}

async function nextConflictPath(files: TextFileAdapter, path: string, now: Date): Promise<string> {
  const base = `${path}.conflict-${safeTimestamp(now)}`;
  let candidate = base;
  let suffix = 2;
  while (await files.exists(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function matchesDocumentIdentity(document: SidecarDocumentIdentity, input: DocumentIdentityInput): boolean {
  const contentHash = input.contentHash?.trim().toLowerCase();
  if (contentHash) {
    return document.contentHash?.trim().toLowerCase() === contentHash;
  }
  const fingerprint = input.fingerprint?.trim().toLowerCase();
  if (fingerprint) {
    return document.fingerprint?.trim().toLowerCase() === fingerprint;
  }
  const paths = [input.vaultPath, ...(input.legacyPaths ?? [])]
    .map(normalizeVaultPath);
  const storedPath = normalizeVaultPath(document.vaultPath);
  return paths.includes(storedPath) || (document.aliases ?? []).some((alias) => paths.includes(normalizeVaultPath(alias)));
}

function matchesCandidate(
  document: SidecarDocumentIdentity,
  source: DocumentIdentityMatch["matchedBy"],
  input: DocumentIdentityInput,
  candidatePath: string
): boolean {
  const requestedContentHash = input.contentHash?.trim().toLowerCase();
  const storedContentHash = document.contentHash?.trim().toLowerCase();
  if (requestedContentHash && storedContentHash && requestedContentHash !== storedContentHash) return false;
  if (source === "content") return requestedContentHash !== undefined && storedContentHash === requestedContentHash;
  if (source === "fingerprint") {
    const requestedFingerprint = input.fingerprint?.trim().toLowerCase();
    return requestedFingerprint !== undefined &&
      document.fingerprint?.trim().toLowerCase() === requestedFingerprint;
  }
  const normalizedCandidatePath = normalizeVaultPath(candidatePath);
  return normalizeVaultPath(document.vaultPath) === normalizedCandidatePath ||
    (document.aliases ?? []).some((alias) => normalizeVaultPath(alias) === normalizedCandidatePath) ||
    (document.legacyIds ?? []).includes(createDocumentIdentity({ vaultPath: candidatePath }).id);
}

function annotationPayload(sidecar: SidecarSchemaV1): string {
  return JSON.stringify({
    pages: sidecar.pages,
    createdAt: sidecar.createdAt,
    updatedAt: sidecar.updatedAt,
    ...(sidecar.extensions === undefined ? {} : { extensions: sidecar.extensions })
  });
}
