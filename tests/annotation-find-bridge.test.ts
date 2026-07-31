import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationFindBridge,
  HN_FIND_BRIDGE_FLAG,
  HN_FIND_GHOST_ATTR,
  HN_FIND_HIT_CLASS,
  HN_FIND_SELECTED_CLASS,
  annotationIdsForPageMatch,
  buildAnnotationFindSuffix,
  composePageContentsWithAnnotations
} from "../src/integration/AnnotationFindBridge";
import type { PdfFindControllerLike, PdfJsEventBus } from "../src/integration/PdfViewerCompatibility";
import type { PdfTextAnnotation } from "../src/model";

afterEach(() => {
  document.body.replaceChildren();
});

function textAnnotation(partial: Partial<PdfTextAnnotation> & Pick<PdfTextAnnotation, "id" | "text">): PdfTextAnnotation {
  return {
    page: 1,
    x: 10,
    y: 20,
    width: 100,
    height: 24,
    color: "#000",
    fontSize: 12,
    fontFamily: "sans-serif",
    bold: false,
    italic: false,
    strikethrough: false,
    runs: [],
    sourceRuns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  };
}

describe("AnnotationFindBridge helpers", () => {
  it("builds a suffix blob with per-annotation ranges", () => {
    const suffix = buildAnnotationFindSuffix([
      { id: "a", text: "Hello  world", runs: [] },
      { id: "b", text: "  ", runs: [] },
      { id: "c", text: "Next", runs: [] }
    ]);
    expect(suffix.blob).toBe("Hello world\nNext");
    expect(suffix.ranges).toEqual([
      { id: "a", start: 0, end: 11 },
      { id: "c", start: 12, end: 16 }
    ]);
  });

  it("does not double-append when composing with a remembered native prefix", () => {
    const first = composePageContentsWithAnnotations("native", "ann");
    expect(first.contents).toBe("native\nann");
    expect(first.suffixOffset).toBe(7);
    const again = composePageContentsWithAnnotations("native", "ann");
    expect(again.contents).toBe("native\nann");
  });

  it("maps match offsets onto annotation ids", () => {
    const state = {
      suffixOffset: 10,
      suffix: buildAnnotationFindSuffix([
        { id: "a", text: "alpha", runs: [] },
        { id: "b", text: "beta", runs: [] }
      ])
    };
    // "alpha\nbeta" — match overlapping "beta"
    expect(annotationIdsForPageMatch(10 + 6, 4, state)).toEqual(["b"]);
    expect(annotationIdsForPageMatch(10, 5, state)).toEqual(["a"]);
    expect(annotationIdsForPageMatch(0, 3, state)).toEqual([]);
  });
});

describe("AnnotationFindBridge DOM", () => {
  function pageWithTextLayer(): { page: HTMLElement; textLayer: HTMLElement } {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const hnBox = document.createElement("div");
    hnBox.className = "native-pdf-handwriting-text-box";
    hnBox.dataset.annotationId = "a1";
    hnBox.textContent = "Hello";
    page.append(textLayer, hnBox);
    document.body.append(page);
    return { page, textLayer };
  }

  function mockController(pageContents: Array<string | undefined>): PdfFindControllerLike & {
    _pageContents: Array<string | undefined>;
    _pageDiffs: Array<unknown>;
    _pageMatches: unknown[];
    _pageMatchesLength: unknown[];
    _selected: { pageIdx: number; matchIdx: number };
    _extractTextPromises: Array<Promise<unknown> | undefined>;
    _state: { query: string };
    eventBus: PdfJsEventBus;
  } {
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const eventBus: PdfJsEventBus = {
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      off(name, handler) {
        const list = handlers.get(name) ?? [];
        handlers.set(
          name,
          list.filter((entry) => entry !== handler)
        );
      },
      dispatch(name, data) {
        for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
      }
    };
    const controller = {
      _pageContents: pageContents,
      _pageDiffs: pageContents.map(() => ({ fake: "diff-map" })),
      _pageMatches: [] as unknown[],
      _pageMatchesLength: [] as unknown[],
      _selected: { pageIdx: -1, matchIdx: -1 },
      _extractTextPromises: pageContents.map(() => undefined),
      _state: { query: "" },
      eventBus
    };
    return controller as typeof controller & PdfFindControllerLike;
  }

  it("no-ops when findController is missing", () => {
    const { page, textLayer } = pageWithTextLayer();
    const warning = vi.fn();
    const bridge = new AnnotationFindBridge({
      getFindController: () => null,
      getEventBus: () => null,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      layoutForAnnotation: () => ({
        left: 10,
        top: 20,
        width: 80,
        height: 20,
        fontSize: 12,
        fontFamily: "sans-serif"
      }),
      onWarning: warning
    });
    bridge.syncPage(1, [textAnnotation({ id: "a1", text: "Hello" })]);
    expect(textLayer.querySelectorAll(`[${HN_FIND_GHOST_ATTR}]`)).toHaveLength(0);
    expect(warning).toHaveBeenCalledOnce();
    bridge.destroy();
  });

  it("injects ghosts and rewrites _pageContents without double-append on resync", () => {
    const { page, textLayer } = pageWithTextLayer();
    const controller = mockController(["native pdf text"]);
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      layoutForAnnotation: () => ({
        left: 10,
        top: 20,
        width: 80,
        height: 20,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });
    const annotations = [textAnnotation({ id: "a1", text: "Hello" })];
    bridge.syncPage(1, annotations);
    expect(controller._pageContents[0]).toBe("native pdf text\nHello");
    expect(controller._pageDiffs[0]).toBeNull();
    expect(textLayer.querySelectorAll(`[${HN_FIND_GHOST_ATTR}="a1"]`)).toHaveLength(1);

    bridge.syncPage(1, annotations);
    expect(controller._pageContents[0]).toBe("native pdf text\nHello");
    expect(textLayer.querySelectorAll(`[${HN_FIND_GHOST_ATTR}]`)).toHaveLength(1);

    bridge.syncPage(1, [textAnnotation({ id: "a1", text: "Hello" }), textAnnotation({ id: "a2", text: "World" })]);
    expect(controller._pageContents[0]).toBe("native pdf text\nHello\nWorld");
    expect(textLayer.querySelectorAll(`[${HN_FIND_GHOST_ATTR}]`)).toHaveLength(2);

    bridge.clearPage(1);
    expect(controller._pageContents[0]).toBe("native pdf text");
    expect(textLayer.querySelectorAll(`[${HN_FIND_GHOST_ATTR}]`)).toHaveLength(0);
    bridge.destroy();
  });

  it("clears stale _pageDiffs on find even when contents already include HN text", async () => {
    const { page, textLayer } = pageWithTextLayer();
    const controller = mockController(["native\nsidecar"]);
    // Simulate extract diffs still pointing at native-only text.
    controller._pageDiffs[0] = { ranges: [0, 6] };
    const annotations = [textAnnotation({ id: "a1", text: "sidecar" })];
    const findDispatches: unknown[] = [];
    const originalDispatch = controller.eventBus.dispatch!.bind(controller.eventBus);
    controller.eventBus.dispatch = (name, data) => {
      if (name === "find") findDispatches.push(data);
      originalDispatch(name, data);
    };
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      textsForPage: () => annotations,
      annotatedPageNumbers: () => [1],
      layoutForAnnotation: () => ({
        left: 0,
        top: 0,
        width: 40,
        height: 16,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });
    // Seed page state without going through sync (contents already composed).
    bridge.patchPageContents(controller, 1, annotations);
    // Re-introduce stale diffs as if extract just finished with native-only maps
    // while contents were later extended.
    controller._pageContents[0] = "native\nsidecar";
    controller._pageDiffs[0] = { ranges: [0, 6] };

    originalDispatch("find", { type: "", query: "sidecar", highlightAll: true });
    await vi.waitFor(() => {
      expect(controller._pageDiffs[0]).toBeNull();
    });
    await vi.waitFor(() => {
      expect(
        findDispatches.some(
          (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>)[HN_FIND_BRIDGE_FLAG]
        )
      ).toBe(true);
    });
    bridge.destroy();
  });

  it("paints HN box find-hit classes from match events", () => {
    const { page, textLayer } = pageWithTextLayer();
    const controller = mockController(["prefix"]);
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      layoutForAnnotation: () => ({
        left: 0,
        top: 0,
        width: 40,
        height: 16,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });
    bridge.syncPage(1, [textAnnotation({ id: "a1", text: "Hello" })]);
    // contents = "prefix\nHello" → Hello starts at offset 7
    controller.eventBus.dispatch?.("updatetextlayermatches", {
      pageIndex: 0,
      matches: [7],
      matchesLength: [5]
    });
    const box = page.querySelector<HTMLElement>(".native-pdf-handwriting-text-box")!;
    expect(box.classList.contains(HN_FIND_HIT_CLASS)).toBe(true);
    expect(box.classList.contains(HN_FIND_SELECTED_CLASS)).toBe(false);
    bridge.destroy();
  });

  it("scrolls the selected HN text box into view on find control update", async () => {
    const { page, textLayer } = pageWithTextLayer();
    const box = page.querySelector<HTMLElement>(".native-pdf-handwriting-text-box")!;
    const scrollIntoView = vi.fn();
    box.scrollIntoView = scrollIntoView;

    const controller = mockController(["prefix"]);
    controller._pageDiffs[0] = null;
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      layoutForAnnotation: () => ({
        left: 0,
        top: 0,
        width: 40,
        height: 16,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });
    bridge.syncPage(1, [textAnnotation({ id: "a1", text: "Hello" })]);
    // contents = "prefix\nHello" → Hello at offset 7
    controller._pageMatches = [[7]];
    controller._pageMatchesLength = [[5]];
    controller._selected = { pageIdx: 0, matchIdx: 0 };
    // PDF.js FindState.FOUND === 0
    controller.eventBus.dispatch?.("updatefindcontrolstate", {
      state: 0,
      previous: false,
      matchesCount: { current: 1, total: 1 }
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(box.classList.contains(HN_FIND_SELECTED_CLASS)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ block: "center" });
    bridge.destroy();
  });

  it("patches _pageContents after lazy extract on find, then redispatches once", async () => {
    const { page, textLayer } = pageWithTextLayer();
    const controller = mockController([undefined]);
    let resolveExtract!: () => void;
    const extractPromise = new Promise<void>((resolve) => {
      resolveExtract = resolve;
    });
    controller._extractTextPromises[0] = extractPromise.then(() => {
      controller._pageContents[0] = "native only";
    });

    const annotations = [textAnnotation({ id: "a1", text: "sidecar" })];
    const findDispatches: unknown[] = [];
    const originalDispatch = controller.eventBus.dispatch!.bind(controller.eventBus);
    controller.eventBus.dispatch = (name, data) => {
      if (name === "find") findDispatches.push(data);
      originalDispatch(name, data);
    };

    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      textsForPage: () => annotations,
      annotatedPageNumbers: () => [1],
      layoutForAnnotation: () => ({
        left: 0,
        top: 0,
        width: 40,
        height: 16,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });

    // Sync before extract — cannot write contents yet.
    bridge.syncPage(1, annotations);
    expect(controller._pageContents[0]).toBeUndefined();

    originalDispatch("find", { type: "", query: "sidecar", highlightAll: true });
    expect(controller._pageContents[0]).toBeUndefined();

    resolveExtract();
    await vi.waitFor(() => {
      expect(controller._pageContents[0]).toBe("native only\nsidecar");
    });
    await vi.waitFor(() => {
      expect(findDispatches.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>)[HN_FIND_BRIDGE_FLAG])).toBe(true);
    });
    // Flagged redispatch must not loop into another patch cycle with another flag.
    const flagged = findDispatches.filter(
      (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>)[HN_FIND_BRIDGE_FLAG]
    );
    expect(flagged).toHaveLength(1);
    bridge.destroy();
  });

  it("patches contents on find even when textLayer is missing", async () => {
    const controller = mockController(["native"]);
    const annotations = [textAnnotation({ id: "a1", text: "ghostless" })];
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => null,
      getNativeTextLayer: () => null,
      textsForPage: () => annotations,
      annotatedPageNumbers: () => [1],
      layoutForAnnotation: () => null
    });
    controller.eventBus.dispatch?.("find", { type: "", query: "ghostless" });
    await vi.waitFor(() => {
      expect(controller._pageContents[0]).toBe("native\nghostless");
    });
    bridge.destroy();
  });

  it("does not redispatch find on no-op scroll resync while find is open", async () => {
    const { page, textLayer } = pageWithTextLayer();
    const controller = mockController(["native pdf text"]);
    controller._state.query = "Hello";
    const findDispatches: unknown[] = [];
    const originalDispatch = controller.eventBus.dispatch!.bind(controller.eventBus);
    controller.eventBus.dispatch = (name, data) => {
      if (name === "find") findDispatches.push(data);
      originalDispatch(name, data);
    };
    const bridge = new AnnotationFindBridge({
      getFindController: () => controller,
      getEventBus: () => controller.eventBus,
      getPageElement: () => page,
      getNativeTextLayer: () => textLayer,
      layoutForAnnotation: () => ({
        left: 10,
        top: 20,
        width: 80,
        height: 20,
        fontSize: 12,
        fontFamily: "sans-serif"
      })
    });
    const annotations = [textAnnotation({ id: "a1", text: "Hello" })];
    bridge.syncPage(1, annotations);
    await vi.waitFor(() => {
      expect(findDispatches.length).toBeGreaterThan(0);
    });
    const afterFirst = findDispatches.length;
    // Scroll-style resync: same contents, diffs already cleared.
    bridge.syncPage(1, annotations);
    bridge.syncPage(1, annotations);
    bridge.syncPage(1, annotations);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(findDispatches.length).toBe(afterFirst);
    bridge.destroy();
  });
});
