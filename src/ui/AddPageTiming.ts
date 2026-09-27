/** Timestamps for one Add Page mutation, keyed by operation id. */

export class AddPageTiming {
  private readonly marks = new Map<string, number>();

  constructor(
    private operationId: string,
    readonly startedAt = Date.now()
  ) {}

  setOperationId(operationId: string): void {
    this.operationId = operationId;
  }

  /** Records the first time a stage is seen. Returns true when newly recorded. */
  mark(stage: string, at = Date.now()): boolean {
    if (this.marks.has(stage)) return false;
    this.marks.set(stage, at);
    return true;
  }

  report(at = Date.now()): Record<string, unknown> {
    const click = this.marks.get("add-page-ui-click") ?? this.startedAt;
    const busy = this.marks.get("add-page-ui-busy");
    const write = this.marks.get("pdf-write-complete");
    const firstPage = this.marks.get("first-replacement-page-observed");
    const mounted = this.marks.get("add-page-control-remounted");
    const done = this.marks.get("mutation-complete") ?? at;
    const delta = (end: number | undefined, start: number | undefined): number | null =>
      end === undefined || start === undefined ? null : Math.max(0, end - start);
    return {
      addPageOperationId: this.operationId,
      clickToBusyUiMs: delta(busy, click),
      clickToPdfWriteMs: delta(write, click),
      pdfWriteToFirstReplacementPageMs: delta(firstPage, write),
      firstReplacementPageToControlMountedMs: delta(mounted, firstPage),
      clickToControlReappearedMs: delta(mounted, click),
      totalMutationMs: delta(done, click),
      marks: Object.fromEntries(this.marks)
    };
  }
}
