import {
  loadAnnotationFileWithQuarantine,
  type AnnotationLoadResult,
  type DocumentIdentityMatch,
  type TextFileAdapter
} from "./SidecarRepository";
import {
  createDocumentIdentity,
  documentIdentityCandidates,
  normalizeVaultPath,
  type DocumentIdentityInput
} from "./DocumentIdentity";
import { MigrationManager } from "./MigrationManager";
import { serializeSidecar, type SidecarDocumentIdentity, type SidecarSchemaV1 } from "./SidecarSchema";

export interface RecoveryRepositoryOptions {
  now?: () => Date;
}

export class RecoveryRepository {
  private readonly migration = new MigrationManager();

  constructor(
    private readonly files: TextFileAdapter,
    private readonly folder: string,
    private readonly options: RecoveryRepositoryOptions = {}
  ) {}

  pathFor(id: string): string {
    return `${this.folder.replace(/\/$/, "")}/${id.replace(/[^\w.-]/g, "_")}.recovery.json`;
  }

  private path(id: string): string { return this.pathFor(id); }

  async save(data: SidecarSchemaV1): Promise<void> {
    const path = this.path(data.document.id);
    const next = serializeSidecar(data);
    const previous = await this.files.exists(path) ? await this.files.read(path) : null;
    const temp = `${path}.tmp`;
    if (this.files.rename || this.files.remove) {
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
      return;
    }
    try {
      await this.files.write(path, next);
      this.migration.migrate(await this.files.read(path));
    } catch (error) {
      if (previous !== null) await this.files.write(path, previous).catch(() => undefined);
      throw error;
    }
  }
  async load(id: string): Promise<SidecarSchemaV1 | null> {
    return (await this.loadWithStatus(id)).data;
  }

  async loadForDocument(input: DocumentIdentityInput): Promise<SidecarSchemaV1 | null> {
    return (await this.loadForDocumentWithStatus(input)).data;
  }

  /**
   * Recovery uses the same content-first lookup as sidecars. This keeps a
   * crash snapshot available after a PDF is renamed or after a legacy
   * path-based recovery file is discovered through a known prior path.
   */
  async loadForDocumentWithStatus(input: DocumentIdentityInput): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const requested = createDocumentIdentity(input);
    const candidates = documentIdentityCandidates(input);
    const candidatePaths = new Set(candidates.map((candidate) => this.pathFor(candidate.identity.id)));
    const matches: Array<{ data: SidecarSchemaV1; path: string; matchedBy: DocumentIdentityMatch["matchedBy"] }> = [];
    let quarantined: AnnotationLoadResult<SidecarSchemaV1>["quarantined"] = null;

    for (const candidate of candidates) {
      const result = await this.loadWithStatus(candidate.identity.id);
      quarantined ??= result.quarantined;
      if (result.data && matchesRecoveryCandidate(result.data.document, candidate.source, input, candidate.identity.vaultPath)) {
        matches.push({ data: result.data, path: this.pathFor(candidate.identity.id), matchedBy: candidate.source });
      }
    }

    if (this.files.list) {
      for (const path of await this.files.list(this.folder)) {
        if (candidatePaths.has(path) || !path.endsWith(".recovery.json") || path.includes(".corrupt-") || path.endsWith(".tmp")) continue;
        let data: SidecarSchemaV1;
        try {
          data = this.migration.migrate(await this.files.read(path));
        } catch {
          continue;
        }
        if (matchesRecoveryDocument(data.document, input)) {
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
      const first = matches[0]!.data;
      const samePayload = matches.slice(1).every((match) => annotationPayload(match.data) === annotationPayload(first));
      const aliasesAccountForExtras = matches.slice(1).every((match) =>
        first.document.aliases?.some((alias) => normalizeVaultPath(alias) === normalizeVaultPath(match.data.document.vaultPath)) === true
      );
      if (!samePayload || !aliasesAccountForExtras) {
        return { data: null, quarantined, conflict: { paths: distinctPaths, reason: "duplicate-content" } };
      }
    }

    const match = matches[0]!;
    const stored = match.data.document;
    return {
      data: match.data,
      quarantined,
      identity: {
        requested,
        stored,
        sourcePath: match.path,
        matchedBy: match.matchedBy,
        requiresPathRebind: normalizeVaultPath(stored.vaultPath) !== normalizeVaultPath(requested.vaultPath) &&
          !(stored.aliases ?? []).some((alias) => normalizeVaultPath(alias) === normalizeVaultPath(requested.vaultPath))
      }
    };
  }
  async loadWithStatus(id: string): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const path = this.path(id);
    return loadAnnotationFileWithQuarantine(
      this.files,
      path,
      (contents) => this.migration.migrate(contents),
      { store: "recovery", ...(this.options.now ? { now: this.options.now } : {}) }
    );
  }
  async clear(id: string): Promise<void> {
    const path = this.path(id);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}

function matchesRecoveryDocument(document: SidecarDocumentIdentity, input: DocumentIdentityInput): boolean {
  const contentHash = input.contentHash?.trim().toLowerCase();
  if (contentHash) return document.contentHash?.trim().toLowerCase() === contentHash;
  const fingerprint = input.fingerprint?.trim().toLowerCase();
  if (fingerprint) return document.fingerprint?.trim().toLowerCase() === fingerprint;
  const paths = [input.vaultPath, ...(input.legacyPaths ?? [])].map(normalizeVaultPath);
  return paths.includes(normalizeVaultPath(document.vaultPath)) ||
    (document.aliases ?? []).some((alias) => paths.includes(normalizeVaultPath(alias)));
}

function matchesRecoveryCandidate(
  document: SidecarDocumentIdentity,
  source: DocumentIdentityMatch["matchedBy"],
  input: DocumentIdentityInput,
  candidatePath: string
): boolean {
  const contentHash = input.contentHash?.trim().toLowerCase();
  const storedHash = document.contentHash?.trim().toLowerCase();
  if (contentHash && storedHash && contentHash !== storedHash) return false;
  if (source === "content") return contentHash !== undefined && storedHash === contentHash;
  if (source === "fingerprint") return input.fingerprint !== undefined &&
    document.fingerprint?.trim().toLowerCase() === input.fingerprint.trim().toLowerCase();
  const path = normalizeVaultPath(candidatePath);
  return normalizeVaultPath(document.vaultPath) === path ||
    (document.aliases ?? []).some((alias) => normalizeVaultPath(alias) === path);
}

function annotationPayload(sidecar: SidecarSchemaV1): string {
  return JSON.stringify({
    pages: sidecar.pages,
    createdAt: sidecar.createdAt,
    updatedAt: sidecar.updatedAt,
    ...(sidecar.extensions === undefined ? {} : { extensions: sidecar.extensions })
  });
}
