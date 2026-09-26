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

  it("gates PDF session attachment on the durable content-surface switch", () => {
    expect(mainSource).toContain("enabledSurfaces.pdf");
    expect(mainSource).toContain("pdfHandwritingEnabled");
    expect(mainSource).toContain("detachDisabledPdfSessions");
    expect(mainSource).toContain("content-surface-setting-changed");
    expect(mainSource).toContain("this.embedChrome.delete(host)");
  });

  it("gates image sessions on the durable image-surface switch", () => {
    expect(mainSource).toContain("enabledSurfaces.image");
    expect(mainSource).toContain("detachDisabledImageSessions");
    expect(mainSource).toContain("imageHandwritingEnabled");
    expect(mainSource).toContain("ImageViewAdapter.attach");
  });

  it("starts an attach scan even when layout-ready was published before plugin load", () => {
    const onload = mainSource.slice(mainSource.indexOf("async onload()"), mainSource.indexOf("  /** Catch uncaught errors"));
    expect(onload).toContain('"session attach scan requested"');
    expect(onload).toContain('reason: "plugin-onload"');
    expect(onload).toContain("this.scheduleDebouncedScan(0);");
  });

  it("cleans a partially attached adapter when session creation fails", () => {
    expect(mainSource).toContain('"session attach adapter cleanup"');
    expect(mainSource).toContain('reason: "attach-failed-before-session-registration"');
    expect(mainSource).toContain("stage: attachStage");
  });

  it("keeps attach retry wakes separate from in-flight scan requests", () => {
    expect(mainSource).toContain("private scanInProgress = false;");
    expect(mainSource).toContain("private scheduleAttachRetryScan(delayMs: number): void");
    expect(mainSource).toContain("this.scanAgain = true;");
    expect(mainSource).toContain("this.scheduleAttachRetryScan(delayMs);");
    expect(mainSource).toContain("this.scheduleAttachRetryScan(wait);");
  });

  it("wires thumbnail blank-page and delete actions through in-place callbacks", () => {
    expect(mainSource).toContain("onInsertPage: (pageNumber: number) => this.insertPageInPlace(file, pageNumber)");
    expect(mainSource).toContain("onDeletePage: (pageNumber: number) => this.deletePageInPlace(file, pageNumber)");
    expect(mainSource).toContain("onDeletePages: (pageNumbers: readonly number[]) => this.deletePagesInPlace(file, pageNumbers)");
    expect(mainSource).toContain("writePdfAndAnnotationStoresAtomic");
    expect(mainSource).not.toContain("createUnsupportedPdfPageMutationCallbacks");
  });
});
