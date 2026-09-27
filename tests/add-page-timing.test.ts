import { describe, expect, it } from "vitest";
import { AddPageTiming } from "../src/ui/AddPageTiming";

describe("AddPageTiming", () => {
  it("attributes rewrite time separately from control remount time", () => {
    const timing = new AddPageTiming("op-1", 1_000);
    timing.mark("add-page-ui-click", 1_000);
    timing.mark("add-page-ui-busy", 1_004);
    timing.mark("mutation-start", 1_010);
    timing.mark("pdf-read-complete", 1_040);
    timing.mark("pdf-lib-load-complete", 1_080);
    timing.mark("pdf-lib-save-complete", 1_140);
    timing.mark("sidecar-load-complete", 1_150);
    timing.mark("recovery-load-complete", 1_160);
    timing.mark("pdf-write-complete", 1_300);
    timing.mark("page-dom-became-empty", 1_310);
    timing.mark("first-replacement-page-observed", 1_360);
    timing.mark("add-page-control-remounted", 1_365);
    timing.mark("mutation-complete", 1_400);
    timing.mark("pdf-write-complete", 9_999);

    expect(timing.report(1_400)).toMatchObject({
      addPageOperationId: "op-1",
      clickToBusyUiMs: 4,
      clickToPdfWriteMs: 300,
      pdfWriteToFirstReplacementPageMs: 60,
      firstReplacementPageToControlMountedMs: 5,
      clickToControlReappearedMs: 365,
      totalMutationMs: 400,
      marks: { "pdf-write-complete": 1_300 }
    });
  });
});
