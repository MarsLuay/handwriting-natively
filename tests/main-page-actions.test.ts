import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

describe("main PDF page actions", () => {
  it("does not retain an in-place source-PDF write path", () => {
    expect(mainSource).not.toContain("modifyBinary");
    expect(mainSource).not.toMatch(/insertPageInPlace|deletePageInPlace|deletePagesInPlace/);
  });

  it("wires page actions to the explicit unsupported policy", () => {
    expect(mainSource).toContain("createUnsupportedPdfPageMutationCallbacks");
    expect(mainSource).toContain("...createUnsupportedPdfPageMutationCallbacks()");
  });
});
