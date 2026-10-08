/**
 * ViewerCommandController
 *
 * Single authoritative command surface for PDF/handwriting viewer interactions:
 * - Zoom in / out / reset / set
 * - Fit width
 * - Page navigation (next, previous, first, last, jump to page)
 * - Rotation (clockwise, counterclockwise, set rotation)
 * - Hand mode (drag tool toggle / set)
 * - Search (open, close, toggle, find next, find previous, search query)
 *
 * All toolbar buttons, hotkeys, context menus, and Obsidian commands
 * invoke the exact same methods on this controller.
 */

import type { ToolId } from "../model";
import { VIEWER_ZOOM_STEP, type ViewerState } from "./ViewerState";

export interface ViewerCommandHost {
  // Canonical state
  getViewerState?(): ViewerState;
  setViewerState?(patch: Partial<ViewerState>): void;

  // Zoom
  getScale(): number;
  setScale(scale: number): void;
  fitWidth?(): void;
  fitPage?(): void;
  getContainerWidth(): number;
  getPageWidth(pageNumber?: number): number;

  // Pages
  getCurrentPage(): number;
  getPageCount(): number;
  focusPage(pageNumber: number): boolean;

  // Rotation
  getRotation(): number;
  setRotation(degrees: number): void;

  // Hand mode / tools
  getActiveTool(): ToolId;
  selectTool(tool: ToolId): void;

  // Search
  openSearch?(): boolean;
  closeSearch?(): boolean;
  isSearchOpen?(): boolean;
  findNext?(): boolean;
  findPrevious?(): boolean;
  search?(query: string): boolean;

  // Telemetry / logging
  logCommand?(name: string, details?: Record<string, unknown>): void;
}

export class ViewerCommandController {
  private previousTool: ToolId = "pen";

  constructor(private readonly host: ViewerCommandHost) {
    try {
      const active = host.getActiveTool?.();
      if (active && active !== "drag") {
        this.previousTool = active;
      }
    } catch {
      // The optional active-tool query can fail before an adapter is mounted.
    }
  }

  // --------------------------------------------------------------------------
  // Canonical ViewerState
  // --------------------------------------------------------------------------

  getViewerState(): ViewerState {
    if (typeof this.host.getViewerState === "function") {
      return this.host.getViewerState();
    }
    const scale = this.getZoom();
    return {
      viewport: { scale, x: 0, y: 0 },
      pageNumber: this.getCurrentPage(),
      rotation: this.getRotation(),
      scaleMode: "custom",
      scale
    };
  }

  setViewerState(patch: Partial<ViewerState>): boolean {
    if (typeof this.host.setViewerState === "function") {
      this.host.setViewerState(patch);
      this.host.logCommand?.("viewer-state-set", { patch });
      return true;
    }
    const nextScale = patch.viewport?.scale ?? patch.scale;
    if (nextScale !== undefined) {
      this.setZoom(nextScale);
    }
    if (patch.pageNumber !== undefined) {
      this.goToPage(patch.pageNumber);
    }
    if (patch.rotation !== undefined) {
      this.setRotation(patch.rotation);
    }
    this.host.logCommand?.("viewer-state-set", { patch });
    return true;
  }

  // --------------------------------------------------------------------------
  // Zoom
  // --------------------------------------------------------------------------

  getZoom(): number {
    if (typeof this.host.getViewerState === "function") {
      return this.host.getViewerState().viewport.scale;
    }
    return this.host.getScale();
  }

  setZoom(scale: number): boolean {
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const clamped = Math.max(0.1, Math.min(10, scale));
    if (typeof this.host.setViewerState === "function") {
      const current = this.getViewerState();
      this.host.setViewerState({
        viewport: { ...current.viewport, scale: clamped },
        scale: clamped,
        scaleMode: "custom"
      });
    } else {
      this.host.setScale(clamped);
    }
    this.host.logCommand?.("zoom-set", { scale: clamped });
    return true;
  }

  zoomIn(factor = VIEWER_ZOOM_STEP): boolean {
    const current = this.getZoom();
    const next = current * factor;
    this.host.logCommand?.("zoom-in", { from: current, to: next });
    return this.setZoom(next);
  }

  zoomOut(factor = VIEWER_ZOOM_STEP): boolean {
    const current = this.getZoom();
    const next = current / factor;
    this.host.logCommand?.("zoom-out", { from: current, to: next });
    return this.setZoom(next);
  }

  resetZoom(): boolean {
    this.host.logCommand?.("zoom-reset", { to: 1.0 });
    return this.setZoom(1.0);
  }

  fitWidth(): boolean {
    if (typeof this.host.fitWidth === "function") {
      this.host.fitWidth();
      this.host.logCommand?.("fit-width", { method: "host" });
      return true;
    }
    const containerWidth = this.host.getContainerWidth();
    const pageWidth = this.host.getPageWidth(this.getCurrentPage());
    if (containerWidth <= 0 || pageWidth <= 0) return false;
    // Allow small padding (32px) for side margins
    const targetScale = Math.max(0.1, Math.min(10, (containerWidth - 32) / pageWidth));
    if (typeof this.host.setViewerState === "function") {
      const current = this.getViewerState();
      this.host.setViewerState({
        viewport: { scale: targetScale, x: 0, y: current.viewport.y },
        scale: targetScale,
        scaleMode: "fit-width"
      });
    } else {
      this.host.setScale(targetScale);
    }
    this.host.logCommand?.("fit-width", { containerWidth, pageWidth, scale: targetScale });
    return true;
  }

  fitPage(): boolean {
    if (typeof this.host.fitPage === "function") {
      this.host.fitPage();
      this.host.logCommand?.("fit-page", { method: "host" });
      return true;
    }
    const containerWidth = this.host.getContainerWidth();
    const pageWidth = this.host.getPageWidth(this.getCurrentPage());
    if (containerWidth <= 0 || pageWidth <= 0) return false;
    const targetScale = Math.max(0.1, Math.min(10, (containerWidth - 32) / pageWidth));
    if (typeof this.host.setViewerState === "function") {
      this.host.setViewerState({
        viewport: { scale: targetScale, x: 0, y: 0 },
        scale: targetScale,
        scaleMode: "fit-page"
      });
    } else {
      this.host.setScale(targetScale);
    }
    this.host.logCommand?.("fit-page", { scale: targetScale });
    return true;
  }

  // --------------------------------------------------------------------------
  // Page Navigation
  // --------------------------------------------------------------------------

  getCurrentPage(): number {
    if (typeof this.host.getViewerState === "function") {
      return Math.max(1, this.host.getViewerState().pageNumber);
    }
    return Math.max(1, this.host.getCurrentPage());
  }

  getPageCount(): number {
    return Math.max(1, this.host.getPageCount());
  }

  canNextPage(): boolean {
    return this.getCurrentPage() < this.getPageCount();
  }

  canPreviousPage(): boolean {
    return this.getCurrentPage() > 1;
  }

  goToPage(pageNumber: number): boolean {
    const total = this.getPageCount();
    const target = Math.max(1, Math.min(total, Math.round(pageNumber)));
    const ok = this.host.focusPage(target);
    if (ok) {
      if (typeof this.host.setViewerState === "function") {
        this.host.setViewerState({ pageNumber: target });
      }
      this.host.logCommand?.("page-nav", { target, total });
    }
    return ok;
  }

  nextPage(): boolean {
    if (!this.canNextPage()) return false;
    return this.goToPage(this.getCurrentPage() + 1);
  }

  previousPage(): boolean {
    if (!this.canPreviousPage()) return false;
    return this.goToPage(this.getCurrentPage() - 1);
  }

  firstPage(): boolean {
    return this.goToPage(1);
  }

  lastPage(): boolean {
    return this.goToPage(this.getPageCount());
  }

  // --------------------------------------------------------------------------
  // Rotation
  // --------------------------------------------------------------------------

  getRotation(): number {
    const raw = typeof this.host.getViewerState === "function"
      ? this.host.getViewerState().rotation
      : this.host.getRotation();
    return ((raw % 360) + 360) % 360;
  }

  setRotation(degrees: number): boolean {
    const normalized = ((degrees % 360) + 360) % 360;
    if (typeof this.host.setViewerState === "function") {
      this.host.setViewerState({ rotation: normalized });
    } else {
      this.host.setRotation(normalized);
    }
    this.host.logCommand?.("rotate-set", { rotation: normalized });
    return true;
  }

  rotateClockwise(): boolean {
    const next = (this.getRotation() + 90) % 360;
    return this.setRotation(next);
  }

  rotateCounterclockwise(): boolean {
    const next = (this.getRotation() - 90 + 360) % 360;
    return this.setRotation(next);
  }

  // --------------------------------------------------------------------------
  // Hand Mode (Drag Tool)
  // --------------------------------------------------------------------------

  isHandMode(): boolean {
    return this.host.getActiveTool() === "drag";
  }

  setHandMode(active: boolean): boolean {
    const current = this.host.getActiveTool();
    if (active) {
      if (current === "drag") return true;
      this.previousTool = current;
      this.host.selectTool("drag");
      this.host.logCommand?.("hand-mode", { active: true, previousTool: this.previousTool });
      return true;
    } else {
      if (current !== "drag") return true;
      const target = (this.previousTool && this.previousTool !== "drag") ? this.previousTool : "pen";
      this.host.selectTool(target);
      this.host.logCommand?.("hand-mode", { active: false, restoredTool: target });
      return true;
    }
  }

  toggleHandMode(): boolean {
    return this.setHandMode(!this.isHandMode());
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  isSearchOpen(): boolean {
    return this.host.isSearchOpen?.() ?? false;
  }

  openSearch(): boolean {
    const ok = this.host.openSearch?.() ?? false;
    this.host.logCommand?.("search-open", { success: ok });
    return ok;
  }

  closeSearch(): boolean {
    const ok = this.host.closeSearch?.() ?? false;
    this.host.logCommand?.("search-close", { success: ok });
    return ok;
  }

  toggleSearch(force?: boolean): boolean {
    if (force === true) return this.openSearch();
    if (force === false) return this.closeSearch();
    return this.isSearchOpen() ? this.closeSearch() : this.openSearch();
  }

  findNext(): boolean {
    const ok = this.host.findNext?.() ?? false;
    this.host.logCommand?.("find-next", { success: ok });
    return ok;
  }

  findPrevious(): boolean {
    const ok = this.host.findPrevious?.() ?? false;
    this.host.logCommand?.("find-previous", { success: ok });
    return ok;
  }

  search(query: string): boolean {
    const ok = this.host.search?.(query) ?? false;
    this.host.logCommand?.("search-query", { query, success: ok });
    return ok;
  }

  // --------------------------------------------------------------------------
  // Keyboard Shortcut Dispatcher
  // --------------------------------------------------------------------------

  handleKeyDown(event: KeyboardEvent, isTextEditing = false): boolean {
    const isMod = event.ctrlKey || event.metaKey;

    // Mod + = or Mod + + -> Zoom in
    if (isMod && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      event.stopPropagation();
      return this.zoomIn();
    }

    // Mod + - -> Zoom out
    if (isMod && event.key === "-") {
      event.preventDefault();
      event.stopPropagation();
      return this.zoomOut();
    }

    // Mod + 0 -> Reset zoom
    if (isMod && event.key === "0") {
      event.preventDefault();
      event.stopPropagation();
      return this.resetZoom();
    }

    // Mod + 9 or Mod + Alt + 0 -> Fit width
    if (isMod && (event.key === "9" || (event.altKey && event.key === "0"))) {
      event.preventDefault();
      event.stopPropagation();
      return this.fitWidth();
    }

    // Mod + R -> Rotate clockwise (Mod + Shift + R -> Rotate counterclockwise)
    if (isMod && event.key.toLowerCase() === "r") {
      event.preventDefault();
      event.stopPropagation();
      return event.shiftKey ? this.rotateCounterclockwise() : this.rotateClockwise();
    }

    // Mod + F -> Search
    if (isMod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      return this.toggleSearch(true);
    }

    // Page navigation (when not typing in an editor)
    if (!isTextEditing) {
      if (event.key === "PageDown" || (isMod && event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopPropagation();
        return this.nextPage();
      }
      if (event.key === "PageUp" || (isMod && event.key === "ArrowUp")) {
        event.preventDefault();
        event.stopPropagation();
        return this.previousPage();
      }
      if (event.key === "Home" || (isMod && event.key === "ArrowLeft" && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        return this.firstPage();
      }
      if (event.key === "End" || (isMod && event.key === "ArrowRight" && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        return this.lastPage();
      }

      // 'h' key -> Toggle Hand mode
      if (!isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        event.stopPropagation();
        return this.toggleHandMode();
      }
    }

    return false;
  }
}
