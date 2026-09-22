import { describe, expect, it } from "vitest";
import { writePdfAndAnnotationStoresAtomic } from "../src/pdf/PdfPageMutation";
import type { SidecarSchemaV1 } from "../src/storage/SidecarSchema";

function store(page: number): SidecarSchemaV1 {
  return {
    schemaVersion: 1,
    document: { id: "pdf-a", vaultPath: "note.pdf" },
    pages: [{ page, width: 400, height: 600, rotation: 0, strokes: [] }],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  };
}

describe("atomic PDF page mutation", () => {
  it("restores the PDF and both stores when a later write fails", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const updated = new Uint8Array([4, 5, 6]);
    const before = store(1);
    const after = store(2);
    let currentPdf = source.slice();
    let currentSidecar = before;
    let currentRecovery = before;
    let sidecarAttempt = 0;
    const stages: string[] = [];

    await expect(writePdfAndAnnotationStoresAtomic({
      sourceBytes: source,
      updatedBytes: updated,
      sidecarBefore: before,
      sidecarAfter: after,
      recoveryBefore: before,
      recoveryAfter: after,
      onStage: (stage) => stages.push(stage),
      writePdf: async (bytes) => { currentPdf = bytes; },
      saveSidecar: async (value) => {
        sidecarAttempt += 1;
        if (sidecarAttempt === 1) {
          currentSidecar = value;
          throw new Error("sidecar write failed");
        }
        currentSidecar = value;
      },
      saveRecovery: async (value) => { currentRecovery = value; }
    })).rejects.toThrow("sidecar write failed");

    expect([...currentPdf]).toEqual([...source]);
    expect(currentSidecar).toEqual(before);
    expect(currentRecovery).toEqual(before);
    expect(stages).toEqual(["pdf", "sidecar"]);
  });
});
