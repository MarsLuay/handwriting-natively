import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

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
