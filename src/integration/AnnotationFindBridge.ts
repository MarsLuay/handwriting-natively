import { createDetachedEl } from "../vendor/createDetached";
import type { PdfTextAnnotation } from "../model";
import { plainTextFromRuns } from "../text/RichTextRuns";
import type { PdfFindControllerLike, PdfJsEventBus } from "./PdfViewerCompatibility";

export const HN_FIND_GHOST_ATTR = "data-hn-find-annotation-id";
export const HN_FIND_HIT_CLASS = "is-find-hit";
export const HN_FIND_SELECTED_CLASS = "is-find-selected";
/** Marks a find redispatch that we already patched — prevents infinite loops. */
export const HN_FIND_BRIDGE_FLAG = "hnFindBridge";

export interface AnnotationFindRange {
  id: string;
  /** Inclusive start offset within the annotation suffix blob. */
  start: number;
  /** Exclusive end offset within the annotation suffix blob. */
  end: number;
}

export interface AnnotationFindSuffix {
  blob: string;
  ranges: AnnotationFindRange[];
}

export interface AnnotationFindPageLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
}

export interface AnnotationFindBridgeCallbacks {
  getFindController(): PdfFindControllerLike | null;
  getEventBus(): PdfJsEventBus | null;
  getPageElement(pageNumber: number): HTMLElement | null;
  getNativeTextLayer(pageNumber: number): HTMLElement | null;
  layoutForAnnotation(pageNumber: number, annotation: PdfTextAnnotation): AnnotationFindPageLayout | null;
  /** Texts for a page when native textLayer re-renders (zoom / page remount). */
  textsForPage?(pageNumber: number): readonly PdfTextAnnotation[];
  /** One-indexed pages that currently have typed annotations. */
  annotatedPageNumbers?(): readonly number[];
  onWarning?(message: string): void;
  onDebug?(phase: string, details: Record<string, unknown>): void;
}

interface PageFindState {
  nativePrefix: string;
  suffix: AnnotationFindSuffix;
  /** Absolute start of the annotation suffix inside `_pageContents[pageIndex]`. */
  suffixOffset: number;
}

/** Build the searchable plain-text blob appended after native PDF page text. */
export function buildAnnotationFindSuffix(
  annotations: readonly Pick<PdfTextAnnotation, "id" | "text" | "runs">[]
): AnnotationFindSuffix {
  const ranges: AnnotationFindRange[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const annotation of annotations) {
    const text = annotationPlainText(annotation).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (parts.length) {
      parts.push("\n");
      cursor += 1;
    }
    const start = cursor;
    parts.push(text);
    cursor += text.length;
    ranges.push({ id: annotation.id, start, end: cursor });
  }
  return { blob: parts.join(""), ranges };
}

export function annotationPlainText(annotation: Pick<PdfTextAnnotation, "text" | "runs">): string {
  const fromRuns = plainTextFromRuns(annotation.runs ?? []);
  if (fromRuns) return fromRuns;
  return annotation.text ?? "";
}

/**
 * Absolute character ranges that fall inside annotation suffix matches.
 * `matchStart`/`matchLength` are offsets into the full page contents string.
 */
export function annotationIdsForPageMatch(
  matchStart: number,
  matchLength: number,
  state: Pick<PageFindState, "suffixOffset" | "suffix">
): string[] {
  if (matchLength <= 0) return [];
  const matchEnd = matchStart + matchLength;
  const ids: string[] = [];
  for (const range of state.suffix.ranges) {
    const absStart = state.suffixOffset + range.start;
    const absEnd = state.suffixOffset + range.end;
    if (matchStart < absEnd && matchEnd > absStart) ids.push(range.id);
  }
  return ids;
}

export function composePageContentsWithAnnotations(nativePrefix: string, suffixBlob: string): {
  contents: string;
  suffixOffset: number;
} {
  if (!suffixBlob) return { contents: nativePrefix, suffixOffset: nativePrefix.length };
  if (!nativePrefix) return { contents: suffixBlob, suffixOffset: 0 };
  return { contents: `${nativePrefix}\n${suffixBlob}`, suffixOffset: nativePrefix.length + 1 };
}

/** Strip a previously appended annotation suffix so resync does not stack. */
export function nativePrefixFromExisting(
  existing: string,
  prior: Pick<PageFindState, "nativePrefix" | "suffix"> | undefined
): string {
  if (!prior) return existing;
  if (prior.nativePrefix.length > 0 && existing.startsWith(prior.nativePrefix)) {
    return prior.nativePrefix;
  }
  if (prior.suffix.blob && existing.endsWith(prior.suffix.blob)) {
    const cut = existing.length - prior.suffix.blob.length;
    return existing.slice(0, Math.max(0, cut - (cut > 0 && existing[cut - 1] === "\n" ? 1 : 0)));
  }
  return existing;
}

function readPageContents(controller: PdfFindControllerLike, pageIndex: number): string | null {
  const pages = controller._pageContents ?? controller.pageContents;
  if (!Array.isArray(pages) || pageIndex < 0 || pageIndex >= pages.length) return null;
  const value = pages[pageIndex];
  return typeof value === "string" ? value : null;
}

function writePageContents(controller: PdfFindControllerLike, pageIndex: number, value: string): boolean {
  const pages = controller._pageContents ?? controller.pageContents;
  if (!Array.isArray(pages) || pageIndex < 0 || pageIndex >= pages.length) return false;
  pages[pageIndex] = value;
  return true;
}

function clearPageDiffs(controller: PdfFindControllerLike, pageIndex: number): boolean {
  // PDF.js `calculateMatch` maps hits through `_pageDiffs` via `getOriginalIndex`.
  // Extending `_pageContents` without updating diffs drops every suffix match
  // (`if (length)` fails). Null diffs → identity mapping, which keeps HN hits.
  const diffs = controller._pageDiffs;
  if (!Array.isArray(diffs) || pageIndex < 0 || pageIndex >= diffs.length) return false;
  if (diffs[pageIndex] == null) return false;
  diffs[pageIndex] = null;
  return true;
}

function pageDiffsAreSet(controller: PdfFindControllerLike, pageIndex: number): boolean {
  const diffs = controller._pageDiffs;
  if (!Array.isArray(diffs) || pageIndex < 0 || pageIndex >= diffs.length) return false;
  return diffs[pageIndex] != null;
}

function activeFindQuery(controller: PdfFindControllerLike | null): string {
  const state = controller?._state ?? controller?.state;
  const query = state?.query;
  if (typeof query === "string") return query;
  if (Array.isArray(query)) return query.filter((part) => typeof part === "string").join(" ");
  return "";
}

function textLayerItemArrays(textLayer: HTMLElement): {
  textDivs: HTMLElement[] | null;
  textContentItemsStr: string[] | null;
} {
  const owner = textLayer as HTMLElement & {
    textDivs?: HTMLElement[];
    textContentItemsStr?: string[];
  };
  // PDF.js keeps these on the TextLayer/TextLayerBuilder instance, often reachable
  // via the DOM node in Obsidian builds; fall closed when absent.
  const textDivs = Array.isArray(owner.textDivs) ? owner.textDivs : null;
  const textContentItemsStr = Array.isArray(owner.textContentItemsStr) ? owner.textContentItemsStr : null;
  return { textDivs, textContentItemsStr };
}

function extractPromiseList(controller: PdfFindControllerLike): Array<Promise<unknown> | undefined> | null {
  const raw = controller._extractTextPromises;
  return Array.isArray(raw) ? (raw as Array<Promise<unknown> | undefined>) : null;
}

/**
 * Bridges sidecar typed text into Obsidian's native PDF find bar.
 * Capability-checked: no-ops when findController / textLayer internals are missing.
 */
export class AnnotationFindBridge {
  private readonly pageState = new Map<number, PageFindState>();
  private readonly abort = new AbortController();
  private warnedMissingController = false;
  private selectedAnnotationId: string | null = null;
  private listenersInstalled = false;
  private findPatchGeneration = 0;
  private redispatchTimer: number | null = null;
  private findBus: PdfJsEventBus | null = null;
  private findBusHandlers: {
    onMatches: (event: unknown) => void;
    onControl: (event: unknown) => void;
    onTextLayer: (event: unknown) => void;
    onFind: (event: unknown) => void;
  } | null = null;

  constructor(private readonly callbacks: AnnotationFindBridgeCallbacks) {
    this.installFindListeners();
  }

  destroy(): void {
    this.abort.abort();
    if (this.redispatchTimer !== null) {
      window.clearTimeout(this.redispatchTimer);
      this.redispatchTimer = null;
    }
    this.uninstallFindListeners();
    for (const pageNumber of [...this.pageState.keys()]) this.clearPage(pageNumber);
    this.pageState.clear();
  }

  /** Re-sync one page after text CRUD, zoom text-layer rebuild, or textlayerrendered. */
  syncPage(pageNumber: number, annotations: readonly PdfTextAnnotation[]): void {
    const controller = this.callbacks.getFindController();
    if (!controller) {
      if (!this.warnedMissingController) {
        this.warnedMissingController = true;
        this.callbacks.onWarning?.(
          "PDF find controller unavailable; Handwriting Natively text will not appear in the PDF find bar"
        );
      }
      this.clearPage(pageNumber);
      return;
    }

    this.installFindListeners();
    const changed = this.patchPageContents(controller, pageNumber, annotations);
    this.injectGhosts(pageNumber, annotations);
    this.callbacks.onDebug?.("sync-page", {
      pageNumber,
      annotationCount: this.pageState.get(pageNumber)?.suffix.ranges.length ?? 0,
      suffixLength: this.pageState.get(pageNumber)?.suffix.blob.length ?? 0,
      contentsChanged: changed
    });

    // Only redispatch when searchable index actually changed. No-op scroll/textLayer
    // resync must not poke PDF.js find — that rematch storm freezes/refreshes on scroll.
    if (changed) this.scheduleRedispatchActiveFind(controller);
  }

  clearPage(pageNumber: number): void {
    const textLayer = this.callbacks.getNativeTextLayer(pageNumber);
    if (textLayer) this.removeGhosts(textLayer);
    this.clearHitsOnPage(pageNumber);
    const prior = this.pageState.get(pageNumber);
    this.pageState.delete(pageNumber);
    const controller = this.callbacks.getFindController();
    if (!controller || !prior) return;
    const pageIndex = pageNumber - 1;
    const existing = readPageContents(controller, pageIndex);
    if (existing === null) return;
    if (prior.suffix.blob && existing.endsWith(prior.suffix.blob)) {
      writePageContents(controller, pageIndex, prior.nativePrefix);
    }
  }

  /**
   * Append annotation plain text onto PDF.js `_pageContents` for one page.
   * Returns true only when the searchable index actually changed (string or diffs).
   */
  patchPageContents(
    controller: PdfFindControllerLike,
    pageNumber: number,
    annotations: readonly PdfTextAnnotation[]
  ): boolean {
    const pageIndex = pageNumber - 1;
    const suffix = buildAnnotationFindSuffix(annotations);
    const existing = readPageContents(controller, pageIndex);
    const prior = this.pageState.get(pageNumber);
    let nativePrefix = "";
    if (existing !== null) {
      nativePrefix = nativePrefixFromExisting(existing, prior);
    } else if (prior) {
      // Extract not finished — keep prior native prefix for suffixOffset bookkeeping.
      nativePrefix = prior.nativePrefix;
    }

    const composed = composePageContentsWithAnnotations(nativePrefix, suffix.blob);
    let contentsChanged = false;
    let clearedDiffs = false;
    if (existing !== null) {
      if (existing !== composed.contents) {
        contentsChanged = writePageContents(controller, pageIndex, composed.contents);
      }
      // Only clear diffs when HN text is present and diffs are still set.
      if (suffix.blob) clearedDiffs = clearPageDiffs(controller, pageIndex);
    }

    this.pageState.set(pageNumber, {
      nativePrefix,
      suffix,
      suffixOffset: composed.suffixOffset
    });
    return contentsChanged || clearedDiffs;
  }

  private injectGhosts(pageNumber: number, annotations: readonly PdfTextAnnotation[]): void {
    const textLayer = this.callbacks.getNativeTextLayer(pageNumber);
    if (!textLayer) return;
    this.removeGhosts(textLayer);
    const { textDivs, textContentItemsStr } = textLayerItemArrays(textLayer);
    for (const annotation of annotations) {
      const text = annotationPlainText(annotation).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const layout = this.callbacks.layoutForAnnotation(pageNumber, annotation);
      if (!layout) continue;
      const ghost = createDetachedEl(textLayer.ownerDocument, "span");
      ghost.className = "native-pdf-handwriting-find-ghost";
      ghost.setAttribute(HN_FIND_GHOST_ATTR, annotation.id);
      ghost.textContent = text;
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${layout.left}px`,
        top: `${layout.top}px`,
        width: `${Math.max(layout.width, 8)}px`,
        minHeight: `${Math.max(layout.height, layout.fontSize * 1.2)}px`,
        fontSize: `${layout.fontSize}px`,
        fontFamily: layout.fontFamily,
        lineHeight: "1.2",
        opacity: "0.01",
        color: "transparent",
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
        overflow: "hidden",
        zIndex: "0"
      });
      textLayer.append(ghost);
      textDivs?.push(ghost);
      textContentItemsStr?.push(text);
    }
  }

  private removeGhosts(textLayer: HTMLElement): void {
    const ghosts = [...textLayer.querySelectorAll<HTMLElement>(`[${HN_FIND_GHOST_ATTR}]`)];
    if (!ghosts.length) return;
    const { textDivs, textContentItemsStr } = textLayerItemArrays(textLayer);
    for (const ghost of ghosts) {
      if (textDivs) {
        const index = textDivs.indexOf(ghost);
        if (index >= 0) {
          textDivs.splice(index, 1);
          textContentItemsStr?.splice(index, 1);
        }
      }
      ghost.remove();
    }
  }

  private uninstallFindListeners(): void {
    const bus = this.findBus;
    const handlers = this.findBusHandlers;
    if (bus?.off && handlers) {
      bus.off("updatetextlayermatches", handlers.onMatches);
      bus.off("updatefindcontrolstate", handlers.onControl);
      bus.off("textlayerrendered", handlers.onTextLayer);
      bus.off("find", handlers.onFind);
    }
    this.findBus = null;
    this.findBusHandlers = null;
    this.listenersInstalled = false;
  }

  private installFindListeners(): void {
    if (this.listenersInstalled || this.abort.signal.aborted) return;
    const bus = this.callbacks.getEventBus();
    if (!bus?.on || !bus.off) return;
    const onMatches = (event: unknown): void => this.applyMatchesFromEvent(event);
    const onControl = (event: unknown): void => this.applyControlState(event);
    const onTextLayer = (event: unknown): void => {
      const pageNumber = extractPageNumber(event);
      if (pageNumber === null) return;
      this.callbacks.onDebug?.("textlayerrendered", { pageNumber });
      const texts = this.callbacks.textsForPage?.(pageNumber);
      if (texts) this.syncPage(pageNumber, texts);
    };
    const onFind = (event: unknown): void => {
      void this.onFindEvent(event);
    };
    bus.on("updatetextlayermatches", onMatches);
    bus.on("updatefindcontrolstate", onControl);
    bus.on("textlayerrendered", onTextLayer);
    bus.on("find", onFind);
    this.findBus = bus;
    this.findBusHandlers = { onMatches, onControl, onTextLayer, onFind };
    this.listenersInstalled = true;
    this.callbacks.onDebug?.("listeners-installed", {});
  }

  /**
   * PDF.js extracts `_pageContents` lazily on the first find. Patch after those
   * promises settle, then re-run find once so matches include HN text.
   */
  private async onFindEvent(event: unknown): Promise<void> {
    if (this.abort.signal.aborted) return;
    if (event && typeof event === "object" && (event as Record<string, unknown>)[HN_FIND_BRIDGE_FLAG]) {
      this.callbacks.onDebug?.("find-skip-flagged", {});
      return;
    }
    const controller = this.callbacks.getFindController();
    if (!controller) {
      this.callbacks.onDebug?.("find-no-controller", {});
      return;
    }

    const generation = ++this.findPatchGeneration;
    const pages = this.pagesToPatch(controller);
    this.callbacks.onDebug?.("find-received", {
      pageCount: pages.length,
      queryType: event && typeof event === "object" ? typeof (event as Record<string, unknown>).query : "none"
    });
    if (!pages.length) return;

    const changed = await this.waitExtractAndPatch(controller, pages);
    if (this.abort.signal.aborted || generation !== this.findPatchGeneration) return;
    if (!changed) {
      this.callbacks.onDebug?.("find-unchanged", { pages: pages.length });
      return;
    }

    this.callbacks.onDebug?.("find-patched", { pages: pages.length, changed });
    this.redispatchFind(controller, event);
  }

  private pagesToPatch(controller: PdfFindControllerLike): number[] {
    const annotated = this.callbacks.annotatedPageNumbers?.() ?? [...this.pageState.keys()];
    if (annotated.length) return [...new Set(annotated)].sort((a, b) => a - b);
    const contents = controller._pageContents ?? controller.pageContents;
    if (!Array.isArray(contents)) return [];
    return contents.map((_, index) => index + 1);
  }

  private async waitExtractAndPatch(
    controller: PdfFindControllerLike,
    pageNumbers: readonly number[]
  ): Promise<boolean> {
    const promises = extractPromiseList(controller);
    const waits: Array<Promise<unknown>> = [];
    if (promises) {
      for (const pageNumber of pageNumbers) {
        const pending = promises[pageNumber - 1];
        if (pending && typeof pending.then === "function") {
          waits.push(pending.catch(() => undefined));
        }
      }
    }
    if (waits.length) await Promise.all(waits);

    // First find: extractText may create promises after the find handler starts.
    // Yield once so those promises can register, then wait again.
    if (!waits.length) {
      await Promise.resolve();
      const again = extractPromiseList(controller);
      if (again) {
        const second: Array<Promise<unknown>> = [];
        for (const pageNumber of pageNumbers) {
          const pending = again[pageNumber - 1];
          if (pending && typeof pending.then === "function") {
            second.push(pending.catch(() => undefined));
          }
        }
        if (second.length) await Promise.all(second);
      }
    }

    let changed = false;
    for (const pageNumber of pageNumbers) {
      const pageIndex = pageNumber - 1;
      const texts = this.callbacks.textsForPage?.(pageNumber) ?? [];
      const before = readPageContents(controller, pageIndex);
      const hadDiffs = pageDiffsAreSet(controller, pageIndex);
      let written = this.patchPageContents(controller, pageNumber, texts);
      this.injectGhosts(pageNumber, texts);
      if (!written) {
        // Extract may have finished between read and patch — try once more.
        written = this.patchPageContents(controller, pageNumber, texts);
      }
      const after = readPageContents(controller, pageIndex);
      // Redispatch when searchable string changed, or when we had to clear
      // stale `_pageDiffs` so suffix matches stop being dropped.
      if (written && (before !== after || hadDiffs)) changed = true;
    }
    return changed;
  }

  private redispatchFind(controller: PdfFindControllerLike, sourceEvent: unknown): void {
    const bus = this.callbacks.getEventBus() ?? controller.eventBus ?? controller._eventBus;
    if (!bus?.dispatch) return;
    const state = controller._state ?? controller.state ?? {};
    const source = sourceEvent && typeof sourceEvent === "object"
      ? (sourceEvent as Record<string, unknown>)
      : {};
    const query = typeof source.query === "string" || Array.isArray(source.query)
      ? source.query
      : state.query;
    if (query === undefined || query === null || query === "") return;
    bus.dispatch("find", {
      type: typeof source.type === "string" ? source.type : "",
      query,
      caseSensitive: Boolean(source.caseSensitive ?? state.caseSensitive),
      entireWord: Boolean(source.entireWord ?? state.entireWord),
      highlightAll: source.highlightAll !== false && state.highlightAll !== false,
      findPrevious: Boolean(source.findPrevious),
      matchDiacritics: Boolean(source.matchDiacritics ?? state.matchDiacritics),
      [HN_FIND_BRIDGE_FLAG]: true
    });
  }

  private redispatchActiveFind(controller: PdfFindControllerLike): void {
    const query = activeFindQuery(controller);
    if (!query) return;
    this.redispatchFind(controller, { type: "", query });
  }

  /** Coalesce bursty page syncs (scroll remounts) into one find rematch. */
  private scheduleRedispatchActiveFind(controller: PdfFindControllerLike): void {
    if (!activeFindQuery(controller)) return;
    if (this.redispatchTimer !== null) window.clearTimeout(this.redispatchTimer);
    this.redispatchTimer = window.setTimeout(() => {
      this.redispatchTimer = null;
      if (this.abort.signal.aborted) return;
      const live = this.callbacks.getFindController() ?? controller;
      this.redispatchActiveFind(live);
    }, 120);
  }

  private applyMatchesFromEvent(event: unknown): void {
    const pageIndex = numberField(event, "pageIndex");
    if (pageIndex === null) return;
    const pageNumber = pageIndex + 1;
    const state = this.pageState.get(pageNumber);
    this.clearHitsOnPage(pageNumber);
    if (!state?.suffix.ranges.length) return;

    const matches = arrayField(event, "matches") ?? arrayField(event, "pageMatches");
    const lengths = arrayField(event, "matchesLength") ?? arrayField(event, "pageMatchesLength");
    if (!matches?.length) return;

    const hitIds = new Set<string>();
    for (let i = 0; i < matches.length; i += 1) {
      const start = Number(matches[i]);
      const length = Number(lengths?.[i] ?? 0);
      if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) continue;
      for (const id of annotationIdsForPageMatch(start, length, state)) hitIds.add(id);
    }
    this.paintHits(pageNumber, hitIds, this.selectedAnnotationId);
    if (this.selectedAnnotationId && hitIds.has(this.selectedAnnotationId)) {
      this.scrollAnnotationIntoView(pageNumber, this.selectedAnnotationId);
    }
  }

  private applyControlState(event: unknown): void {
    // PDF.js dispatches `{ state: FindState, ... }` — not pageIdx/matchIdx.
    // FindState: FOUND=0, NOT_FOUND=1, WRAPPED=2, PENDING=3.
    const stateCode = numberField(event, "state") ?? numberField(event, "selected");
    if (stateCode === 1 /* NOT_FOUND */ || stateCode === 3 /* PENDING */) {
      if (stateCode === 1) {
        this.selectedAnnotationId = null;
        for (const pageNumber of this.pageState.keys()) this.repaintPageSelection(pageNumber);
      }
      return;
    }
    if (stateCode !== 0 /* FOUND */ && stateCode !== 2 /* WRAPPED */) {
      // Legacy / alternate payloads with explicit indices (tests + older hosts).
      const pageIdx = numberField(event, "pageIdx") ?? numberField(event, "pageIndex");
      const matchIdx = numberField(event, "matchIdx") ?? numberField(event, "matchIndex");
      if (pageIdx === null || matchIdx === null) return;
      this.selectMatchAt(pageIdx, matchIdx);
      return;
    }
    const controller = this.callbacks.getFindController();
    const selected = controller?.selected ?? controller?._selected;
    const pageIdx = typeof selected === "object" && selected
      ? numberField(selected, "pageIdx") ?? numberField(selected, "pageIndex")
      : null;
    const matchIdx = typeof selected === "object" && selected
      ? numberField(selected, "matchIdx") ?? numberField(selected, "matchIndex")
      : null;
    if (pageIdx === null || matchIdx === null || pageIdx < 0 || matchIdx < 0) return;
    this.selectMatchAt(pageIdx, matchIdx);
  }

  private selectMatchAt(pageIdx: number, matchIdx: number): void {
    const pageNumber = pageIdx + 1;
    const state = this.pageState.get(pageNumber);
    if (!state) return;
    const controller = this.callbacks.getFindController();
    const pageMatches = controller?._pageMatches ?? controller?.pageMatches;
    const pageLengths = controller?._pageMatchesLength ?? controller?.pageMatchesLength;
    const starts = Array.isArray(pageMatches) ? pageMatches[pageIdx] : null;
    const lens = Array.isArray(pageLengths) ? pageLengths[pageIdx] : null;
    if (!Array.isArray(starts) || matchIdx < 0 || matchIdx >= starts.length) return;
    const start = Number(starts[matchIdx]);
    const length = Number(Array.isArray(lens) ? lens[matchIdx] : 0);
    const ids = annotationIdsForPageMatch(start, length, state);
    const nextId = ids[0] ?? null;
    this.selectedAnnotationId = nextId;
    for (const pn of this.pageState.keys()) this.repaintPageSelection(pn);
    if (nextId) this.scrollAnnotationIntoView(pageNumber, nextId);
  }

  /**
   * PDF.js scrolls to text-layer spans for native matches. HN hits live on overlay
   * boxes (suffix offsets), so native scroll often stops a page-chunk short — bring
   * the selected box to the viewport center after PDF.js finishes its own scroll.
   */
  private scrollAnnotationIntoView(pageNumber: number, annotationId: string): void {
    const page = this.callbacks.getPageElement(pageNumber);
    if (!page) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(annotationId)
      : annotationId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const box = page.querySelector<HTMLElement>(
      `.native-pdf-handwriting-text-box[data-annotation-id="${escaped}"]`
    );
    if (!box) {
      this.callbacks.onDebug?.("find-scroll-miss", { pageNumber, annotationId });
      return;
    }
    const run = (): void => {
      if (this.abort.signal.aborted) return;
      box.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      this.callbacks.onDebug?.("find-scroll", { pageNumber, annotationId });
    };
    // Two rAFs: after PDF.js page change + scrollMatchIntoView.
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.requestAnimationFrame(run));
    } else {
      window.setTimeout(run, 0);
    }
  }

  private clearHitsOnPage(pageNumber: number): void {
    const page = this.callbacks.getPageElement(pageNumber);
    if (!page) return;
    for (const box of page.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
      box.classList.remove(HN_FIND_HIT_CLASS, HN_FIND_SELECTED_CLASS);
    }
  }

  private paintHits(pageNumber: number, hitIds: ReadonlySet<string>, selectedId: string | null): void {
    const page = this.callbacks.getPageElement(pageNumber);
    if (!page) return;
    for (const box of page.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
      const id = box.dataset.annotationId ?? "";
      const hit = hitIds.has(id);
      box.classList.toggle(HN_FIND_HIT_CLASS, hit);
      box.classList.toggle(HN_FIND_SELECTED_CLASS, Boolean(selectedId && id === selectedId));
    }
  }

  private repaintPageSelection(pageNumber: number): void {
    const page = this.callbacks.getPageElement(pageNumber);
    if (!page) return;
    for (const box of page.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
      const id = box.dataset.annotationId ?? "";
      box.classList.toggle(
        HN_FIND_SELECTED_CLASS,
        Boolean(this.selectedAnnotationId && id === this.selectedAnnotationId)
      );
    }
  }
}

function extractPageNumber(event: unknown): number | null {
  const pageNumber = numberField(event, "pageNumber");
  if (pageNumber !== null) return pageNumber;
  const pageIndex = numberField(event, "pageIndex");
  return pageIndex === null ? null : pageIndex + 1;
}

function numberField(event: unknown, key: string): number | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayField(event: unknown, key: string): unknown[] | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}
