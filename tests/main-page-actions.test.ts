import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

describe("main PDF page actions", () => {
  it("wires Import page through an explicit source-PDF write callback", () => {
    expect(mainSource).toContain("writeSourcePdf");
    expect(mainSource).toContain("onImportPages");
    expect(mainSource).toContain("prepareImportedPages");
    expect(mainSource).toContain("modifyBinary");
  });

  it("wires thumbnail blank-page and delete actions through in-place callbacks", () => {
    expect(mainSource).toContain("onInsertPage: (pageNumber) => this.insertPageInPlace(file, pageNumber)");
    expect(mainSource).toContain("onDeletePage: (pageNumber) => this.deletePageInPlace(file, pageNumber)");
    expect(mainSource).toContain("onDeletePages: (pageNumbers) => this.deletePagesInPlace(file, pageNumbers)");
    expect(mainSource).toContain("writePdfAndAnnotationStoresAtomic");
    expect(mainSource).not.toContain("createUnsupportedPdfPageMutationCallbacks");
  });
});
