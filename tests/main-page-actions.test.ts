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

  it("keeps legacy blank-page and delete actions on the explicit unsupported policy", () => {
    expect(mainSource).toContain("createUnsupportedPdfPageMutationCallbacks");
    expect(mainSource).toContain("...createUnsupportedPdfPageMutationCallbacks()");
  });
});
