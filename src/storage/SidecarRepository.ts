import { MigrationManager } from "./MigrationManager";
import { serializeSidecar, type SidecarSchemaV1 } from "./SidecarSchema";

export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

export type AnnotationStoreKind = "sidecar" | "recovery";

export interface QuarantinedAnnotationFile {
  store: AnnotationStoreKind;
  sourcePath: string;
  quarantinePath: string;
  error: string;
}

export interface AnnotationLoadResult<T> {
  data: T | null;
  quarantined: QuarantinedAnnotationFile | null;
}

export interface AnnotationLoadOptions {
  store: AnnotationStoreKind;
  now?: () => Date;
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

export class SidecarRepository {
  private readonly migration = new MigrationManager();

  constructor(
    private readonly files: TextFileAdapter,
    private readonly folder: string,
    private readonly options: SidecarRepositoryOptions = {}
  ) {}

  pathFor(documentId: string): string {
    const safe = documentId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${this.folder.replace(/\/$/, "")}/${safe}.json`;
  }

  async load(documentId: string): Promise<SidecarSchemaV1 | null> {
    return (await this.loadWithStatus(documentId)).data;
  }

  async loadWithStatus(documentId: string): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const path = this.pathFor(documentId);
    return loadAnnotationFileWithQuarantine(
      this.files,
      path,
      (contents) => this.migration.migrate(contents),
      { store: "sidecar", ...(this.options.now ? { now: this.options.now } : {}) }
    );
  }

  async save(sidecar: SidecarSchemaV1): Promise<void> {
    const path = this.pathFor(sidecar.document.id);
    const next = serializeSidecar(sidecar);
    const previous = await this.files.exists(path) ? await this.files.read(path) : null;

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
        if (previous !== null) await this.files.write(path, previous);
        throw error;
      }
      return;
    }

    try {
      await this.files.write(path, next);
      this.migration.migrate(await this.files.read(path));
    } catch (error) {
      if (previous !== null) await this.files.write(path, previous);
      throw error;
    }
  }

  async remove(documentId: string): Promise<void> {
    const path = this.pathFor(documentId);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}
