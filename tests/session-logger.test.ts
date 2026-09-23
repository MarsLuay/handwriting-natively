import { describe, expect, it, vi } from "vitest";
import { SessionLogger } from "../src/logging/SessionLogger";

describe("SessionLogger", () => {
  it("logs zoom in and zoom out with scale deltas", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1.25, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "data-scale");

    expect(debug).toHaveBeenCalledTimes(3);
    expect(debug.mock.calls[0]?.[1]).toBe("pdf zoom");
    expect(debug.mock.calls[0]?.[2]).toMatchObject({ action: "view-change", source: "scalechanging", scale: 1 });
    expect(debug.mock.calls[1]?.[2]).toMatchObject({ action: "zoom-in", previousScale: 1, scale: 1.25 });
    expect(debug.mock.calls[2]?.[2]).toMatchObject({ action: "zoom-out", previousScale: 1.25, scale: 1, source: "data-scale" });
    debug.mockRestore();
  });

  it("logs draw positions with bounds", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.draw({
      phase: "end",
      page: 1,
      tool: "pen",
      displayScale: 1.5,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }]
    });

    expect(debug).toHaveBeenCalledOnce();
    expect(debug.mock.calls[0]?.[1]).toBe("draw position");
    expect(debug.mock.calls[0]?.[2]).toMatchObject({
      phase: "end",
      page: 1,
      pointCount: 2,
      bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 }
    });
    debug.mockRestore();
  });

  it("preserves the full draw count when points are sampled for diagnostics", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.draw({
      phase: "end",
      page: 1,
      tool: "laser",
      displayScale: 1,
      pointCount: 2_000,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      bounds: { minX: 0, minY: 0, maxX: 40, maxY: 50 }
    });

    expect(debug.mock.calls[0]?.[2]).toMatchObject({
      pointCount: 2_000,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      bounds: { minX: 0, minY: 0, maxX: 40, maxY: 50 }
    });
    debug.mockRestore();
  });

  it("logs zoom tick deferral and repaint timing", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.zoomTick({ reason: "view-scalechanging", tick: 1, scale: 1 });
    logger.zoomTick({ reason: "view-scalechanging", tick: 2, scale: 1.1 });
    logger.zoomRepaint({
      reason: "view-scalechanging",
      durationMs: 4.2,
      pagesRepainted: 2,
      canvasesResized: 2,
      strokesRedrawn: 18,
      skippedDisconnected: 0,
      burstTicks: 2,
      burstDurationMs: 180,
      scaleStart: 1,
      scaleEnd: 1.1,
      scale: 1.1
    });

    expect(debug.mock.calls.some((call) => call[1] === "ink zoom tick")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "ink zoom repaint")).toBe(true);
    const repaint = debug.mock.calls.find((call) => call[1] === "ink zoom repaint");
    expect(repaint?.[2]).toMatchObject({
      burstTicks: 2,
      pagesRepainted: 2,
      canvasesResized: 2,
      strokesRedrawn: 18,
      repaintsPerSec: expect.any(Number)
    });
    debug.mockRestore();
  });

  it("logs the compositor handoff around a zoom settle", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.zoomComposite("begin", { pages: 1 });
    logger.zoomComposite("settle-paint", { pages: 1, burstTicks: 8 });
    logger.zoomComposite("release", { pages: 1 });

    expect(debug.mock.calls.filter((call) => call[1] === "ink zoom composite").map((call) => (call[2] as { phase: string }).phase))
      .toEqual(["begin", "settle-paint", "release"]);
    debug.mockRestore();
  });

  it("logs refresh bursts and lasso selection", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    for (let index = 0; index < 12; index += 1) logger.refresh("resize");
    logger.lassoSelection(1, 3, 48, "freeform");
    logger.loopBlocked("refresh", 4);

    expect(debug.mock.calls.some((call) => call[1] === "session refresh")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "lasso selection")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "refresh storm")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "loop blocked")).toBe(true);
    debug.mockRestore();
    warn.mockRestore();
  });

  it("logs mouse pan probes and throttles move events", () => {
    const writes: Array<Record<string, unknown>> = [];
    const vaultLog = { write: (_level: string, _event: string, payload: Record<string, unknown>) => { writes.push(payload); } };
    const logger = new SessionLogger("Notes/example.pdf", vaultLog);

    logger.mousePan("probe", { inBoundary: true, enabled: true });
    logger.mousePan("start", { target: "canvas" });
    for (let index = 0; index < 10; index += 1) {
      logger.mousePan("move", { deltaY: 4, changed: true });
    }

    const moves = writes.filter((entry) => entry.phase === "move");
    expect(writes.some((entry) => entry.phase === "probe")).toBe(true);
    expect(moves.length).toBeLessThan(10);
    expect(moves.length).toBeGreaterThan(0);
  });

  it("logs toolbar placement transitions", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    logger.toolbarPlacement("request", { previousPlacement: "main", requestedPlacement: "left" });
    logger.toolbarPlacement("applied", { previousPlacement: "main", requestedPlacement: "left", resolvedPlacement: "left" });

    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "toolbar placement", payload: expect.objectContaining({ phase: "request", requestedPlacement: "left" }) }),
      expect.objectContaining({ event: "toolbar placement", payload: expect.objectContaining({ phase: "applied", resolvedPlacement: "left" }) })
    ]));
  });

  it("logs thumbnail page actions without annotation content", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    logger.pdfPageAction("insert-start", { requestedPageNumber: 2, dirty: true });
    logger.pdfPageAction("insert-complete", { requestedPageNumber: 2, insertedPage: 2 });
    logger.pdfPageAction("insert-focus", { pageNumber: 2, reason: "pages-dom" });
    logger.pdfPageAction("page-shield-captured", { action: "delete", pageNumber: 3, capturedPages: 2 });
    logger.pdfPageAction("page-shield-released", { action: "delete", pageNumber: 3, reason: "pages-settled" });

    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "pdf page action", payload: expect.objectContaining({ phase: "insert-start", requestedPageNumber: 2 }) }),
      expect.objectContaining({ event: "pdf page action", payload: expect.objectContaining({ phase: "insert-complete", insertedPage: 2 }) }),
      expect.objectContaining({ event: "pdf page action", payload: expect.objectContaining({ phase: "insert-focus", pageNumber: 2 }) }),
      expect.objectContaining({ event: "pdf page action", payload: expect.objectContaining({ phase: "page-shield-captured", action: "delete", pageNumber: 3, capturedPages: 2 }) }),
      expect.objectContaining({ event: "pdf page action", payload: expect.objectContaining({ phase: "page-shield-released", action: "delete", reason: "pages-settled" }) })
    ]));
  });

  it("logs whether a thumbnail action joined Obsidian's native menu", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    logger.thumbnailMenu("native-menu-appended", { kind: "delete", pageNumber: 3 });
    logger.thumbnailMenu("native-menu-missing", { kind: "delete", pageNumber: 3 });

    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "thumbnail menu", payload: expect.objectContaining({ phase: "native-menu-appended", pageNumber: 3 }) }),
      expect.objectContaining({ event: "thumbnail menu", payload: expect.objectContaining({ phase: "native-menu-missing", kind: "delete" }) })
    ]));
  });

  it("logs touch policy and terminal cleanup", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    logger.touchInput("policy", { enabled: true, surfaces: 2 });
    logger.touchInput("pointercancel", { page: 1, pointerId: 7, trackedBefore: 1, trackedAfter: 0 });

    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "touch input", payload: expect.objectContaining({ phase: "policy", enabled: true }) }),
      expect.objectContaining({ event: "touch input", payload: expect.objectContaining({ phase: "pointercancel", pointerId: 7, trackedAfter: 0 }) })
    ]));
  });

  it("logs every pointer route and raw pointer seen types", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.pointerRoute("touch-pan", { pointerType: "touch", page: 1 });
    logger.pointerRoute("ignored", { pointerType: "touch", page: 1 });
    logger.pointerSeen({ source: "pointerdown", pointerType: "pen", within: true });
    logger.pointerSeen({ source: "touchstart", pointerType: "touch", within: true });

    expect(debug.mock.calls.some((call) => call[1] === "pointer route" && (call[2] as { route: string }).route === "touch-pan")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "pointer seen" && (call[2] as { pointerType: string }).pointerType === "touch")).toBe(true);
    debug.mockRestore();
  });

  it("dumps bounded input lifecycle and stroke heartbeat on an anomaly", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    for (let index = 0; index < 45; index += 1) logger.inputLifecycleEvent(`event-${index}`, { index });
    logger.inputStroke("start", { page: 1, routerGeneration: 4 });
    logger.inputStroke("end", { page: 1, routerGeneration: 4 });
    logger.inputAnomaly({ reason: "pen-over-visible-page-not-routed", geometricPageNumber: 1 });

    const anomaly = writes.find((entry) => entry.event === "ink input anomaly");
    expect(anomaly?.payload).toMatchObject({
      reason: "pen-over-visible-page-not-routed",
      lastSuccessfulStroke: {
        lastPage: 1,
        lastRouterGeneration: 4,
        lastStartAt: expect.any(String),
        lastEndAt: expect.any(String)
      },
      firstFailedPenDown: { at: expect.any(String) }
    });
    expect(anomaly?.payload.lifecycle).toHaveLength(40);
    expect((anomaly?.payload.lifecycle as Array<{ event: string }>)[0]?.event).toBe("event-8");
  });

  it("logs renderer parity when an ink stroke commits", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    });

    logger.inkRenderer(1, {
      tool: "pencil",
      pointCount: 12,
      previewRenderer: "tool-renderer",
      committedRenderer: "tool-renderer"
    });

    expect(writes).toEqual([expect.objectContaining({
      event: "ink renderer",
      payload: expect.objectContaining({
        page: 1,
        tool: "pencil",
        previewRenderer: "tool-renderer",
        committedRenderer: "tool-renderer"
      })
    })]);
  });

  it("logs text-tool diagnostics without annotation contents", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const vaultLog = {
      write: (_level: string, event: string, payload: Record<string, unknown>) => writes.push({ event, payload })
    };
    const logger = new SessionLogger("Notes/example.pdf", vaultLog);

    logger.textTool("commit-create", {
      annotationId: "text-1",
      characterCount: 12,
      text: "private annotation text",
      content: "private content",
      html: "<b>private markup</b>",
      value: "private editor value",
      geometry: { width: 240, text: "private nested text" }
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ event: "text tool" });
    expect(writes[0]?.payload).toMatchObject({ phase: "commit-create", annotationId: "text-1", characterCount: 12 });
    expect(writes[0]?.payload).not.toHaveProperty("text");
    expect(writes[0]?.payload).not.toHaveProperty("content");
    expect(writes[0]?.payload).not.toHaveProperty("html");
    expect(writes[0]?.payload).not.toHaveProperty("value");
    expect(writes[0]?.payload).toMatchObject({ geometry: { width: 240 } });
    expect((writes[0]?.payload.geometry as Record<string, unknown> | undefined)?.text).toBeUndefined();
  });

  it("samples high-frequency text-tool phases to avoid vault log floods", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const vaultLog = {
      write: (_level: string, event: string, payload: Record<string, unknown>) => writes.push({ event, payload })
    };
    const logger = new SessionLogger("Notes/example.pdf", vaultLog);

    for (let i = 0; i < 20; i += 1) logger.textTool("render", { annotationId: "t1" });
    logger.textTool("focus", { annotationId: "t1" });

    const renders = writes.filter((row) => row.payload.phase === "render");
    expect(renders.length).toBe(3); // 1st + every 10th (10, 20)
    expect(renders.map((row) => row.payload.sampleN)).toEqual([1, 10, 20]);
    expect(writes.some((row) => row.payload.phase === "focus")).toBe(true);

    // Boundary clears sample counters so the next burst logs its first event again.
    writes.length = 0;
    for (let i = 0; i < 3; i += 1) logger.textTool("selection-snapshot", { annotationId: "t1" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload).toMatchObject({ phase: "selection-snapshot", sampleN: 1 });
  });

  it("records versioned bounded performance profiles and draw-state transitions", () => {
    const writes: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = new SessionLogger("Notes/example.pdf", {
      write: (_level, event, payload) => writes.push({ event, payload: payload ?? {} })
    }, () => true, "0.1.60");

    logger.drawStateChanged({ from: true, to: false, reason: "tool-selected", source: "toolbar" });
    logger.zoomProfile({ durationMs: 524, lateFrameCount: 4, frameIntervalHistogram: { "0-16": 1 } });
    logger.inkStrokeProfile({ p95InputToRenderMs: 24.8, droppedFrameEstimate: 3 });
    logger.panProfile({ pointerMoves: 20, maxFrameMs: 48 });
    logger.renderProfile({ operationCount: 4, totalMs: 12 });
    logger.persistProfile({ serializedBytes: 100, totalMs: 4, overlappedActiveGesture: false });

    expect(writes.map((entry) => entry.event)).toEqual([
      "draw state changed",
      "ink zoom profile",
      "ink stroke profile",
      "ink pan profile",
      "ink render profile",
      "sidecar persist profile"
    ]);
    expect(writes[0]?.payload).toMatchObject({ from: true, to: false, reason: "tool-selected", pluginVersion: "0.1.60" });
    expect(writes[1]?.payload).toMatchObject({ profileSchema: 2, pluginVersion: "0.1.60", durationMs: 524 });
    expect(writes[5]?.payload).toMatchObject({ serializedBytes: 100, totalMs: 4, overlappedActiveGesture: false });
  });

  it("avoids diagnostics and their input-path sampling work when debug is disabled", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const write = vi.fn();
    const logger = new SessionLogger("Notes/example.pdf", { write }, () => false);

    expect(logger.shouldLogPositionAlign("move")).toBe(false);
    logger.pointerRoute("draw", { page: 1 });
    logger.inputPaint(1, 24, "draw", 12);

    expect(debug).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    debug.mockRestore();
  });
});
