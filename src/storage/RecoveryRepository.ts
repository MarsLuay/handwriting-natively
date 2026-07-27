import {
  loadAnnotationFileWithQuarantine,
  type AnnotationLoadResult,
  type TextFileAdapter
} from "./SidecarRepository";
import { parseSidecar, serializeSidecar, type SidecarSchemaV1 } from "./SidecarSchema";

export interface RecoveryRepositoryOptions {
  now?: () => Date;
}

export class RecoveryRepository {
  constructor(
    private readonly files: TextFileAdapter,
    private readonly folder: string,
    private readonly options: RecoveryRepositoryOptions = {}
  ) {}

  pathFor(id: string): string {
    return `${this.folder.replace(/\/$/, "")}/${id.replace(/[^\w.-]/g, "_")}.recovery.json`;
  }

  private path(id: string): string { return this.pathFor(id); }

  async save(data: SidecarSchemaV1): Promise<void> { await this.files.write(this.path(data.document.id), serializeSidecar(data)); }
  async load(id: string): Promise<SidecarSchemaV1 | null> {
    return (await this.loadWithStatus(id)).data;
  }
  async loadWithStatus(id: string): Promise<AnnotationLoadResult<SidecarSchemaV1>> {
    const path = this.path(id);
    return loadAnnotationFileWithQuarantine(
      this.files,
      path,
      parseSidecar,
      { store: "recovery", ...(this.options.now ? { now: this.options.now } : {}) }
    );
  }
  async clear(id: string): Promise<void> {
    const path = this.path(id);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}
