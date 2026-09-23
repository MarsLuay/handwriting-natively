import type { SidecarSchemaV1 } from "../storage/SidecarSchema";

export interface AtomicPdfPageMutation {
  sourceBytes: Uint8Array;
  updatedBytes: Uint8Array;
  sidecarBefore: SidecarSchemaV1 | null;
  sidecarAfter: SidecarSchemaV1 | null;
  recoveryBefore: SidecarSchemaV1 | null;
  recoveryAfter: SidecarSchemaV1 | null;
  writePdf(bytes: Uint8Array): Promise<void>;
  saveSidecar(sidecar: SidecarSchemaV1): Promise<void>;
  saveRecovery(recovery: SidecarSchemaV1): Promise<void>;
  onStage?(stage: "pdf" | "sidecar" | "recovery"): void;
}

/** Replaces a source PDF and its page stores with best-effort compensation. */
export async function writePdfAndAnnotationStoresAtomic(options: AtomicPdfPageMutation): Promise<void> {
  let pdfWriteAttempted = false;
  try {
    options.onStage?.("pdf");
    pdfWriteAttempted = true;
    await options.writePdf(options.updatedBytes.slice());
    if (options.sidecarAfter) {
      options.onStage?.("sidecar");
      await options.saveSidecar(options.sidecarAfter);
    }
    if (options.recoveryAfter) {
      options.onStage?.("recovery");
      await options.saveRecovery(options.recoveryAfter);
    }
  } catch (error) {
    if (pdfWriteAttempted) await options.writePdf(options.sourceBytes.slice()).catch(() => undefined);
    if (options.sidecarBefore) await options.saveSidecar(options.sidecarBefore).catch(() => undefined);
    if (options.recoveryBefore) await options.saveRecovery(options.recoveryBefore).catch(() => undefined);
    throw error;
  }
}
