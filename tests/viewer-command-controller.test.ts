import { describe, expect, it, vi } from "vitest";
import { ViewerCommandController, type ViewerCommandHost } from "../src/runtime/ViewerCommandController";
import type { ToolId } from "../src/model";

function createMockHost(overrides: Partial<ViewerCommandHost> = {}): {
  host: ViewerCommandHost;
  scale: { current: number };
  page: { current: number; total: number };
  rotation: { current: number };
  tool: { current: ToolId };
  searchState: { open: boolean; query: string | null; findNextCount: number; findPrevCount: number };
  logs: Array<{ name: string; details?: Record<string, unknown> }>;
} {
  const scale = { current: 1.0 };
  const page = { current: 1, total: 5 };
  const rotation = { current: 0 };
  const tool = { current: "pen" as ToolId };
  const searchState = { open: false, query: null as string | null, findNextCount: 0, findPrevCount: 0 };
  const logs: Array<{ name: string; details?: Record<string, unknown> }> = [];

  const host: ViewerCommandHost = {
    getScale: () => scale.current,
    setScale: (s: number) => { scale.current = s; },
    getContainerWidth: () => 800,
    getPageWidth: (_p?: number) => 600,

    getCurrentPage: () => page.current,
    getPageCount: () => page.total,
    focusPage: (p: number) => {
      if (p >= 1 && p <= page.total) {
        page.current = p;
        return true;
      }
      return false;
    },

    getRotation: () => rotation.current,
    setRotation: (deg: number) => { rotation.current = deg; },

    getActiveTool: () => tool.current,
    selectTool: (t: ToolId) => { tool.current = t; },

    isSearchOpen: () => searchState.open,
    openSearch: () => { searchState.open = true; return true; },
    closeSearch: () => { searchState.open = false; return true; },
    findNext: () => { searchState.findNextCount++; return true; },
    findPrevious: () => { searchState.findPrevCount++; return true; },
    search: (q: string) => { searchState.query = q; return true; },

    logCommand: (name: string, details?: Record<string, unknown>) => {
      logs.push(details !== undefined ? { name, details } : { name });
    },
    ...overrides
  };

  return { host, scale, page, rotation, tool, searchState, logs };
}

describe("ViewerCommandController", () => {
  describe("Zoom", () => {
    it("reads and sets zoom with clamping", () => {
      const { host, scale } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.getZoom()).toBe(1.0);
      expect(controller.setZoom(2.5)).toBe(true);
      expect(scale.current).toBe(2.5);

      // Clamp max 10
      expect(controller.setZoom(15)).toBe(true);
      expect(scale.current).toBe(10);

      // Clamp min 0.1
      expect(controller.setZoom(0.01)).toBe(true);
      expect(scale.current).toBe(0.1);

      // Ignore invalid
      expect(controller.setZoom(-1)).toBe(false);
      expect(controller.setZoom(NaN)).toBe(false);
      expect(controller.setZoom(Infinity)).toBe(false);
    });

    it("zooms in and out with default factor 1.25", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      controller.setZoom(1.0);
      controller.zoomIn();
      expect(controller.getZoom()).toBeCloseTo(1.25);

      controller.zoomOut();
      expect(controller.getZoom()).toBeCloseTo(1.0);
    });

    it("resets zoom to 1.0", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      controller.setZoom(3.5);
      expect(controller.resetZoom()).toBe(true);
      expect(controller.getZoom()).toBe(1.0);
    });

    it("fits to width using containerWidth and pageWidth", () => {
      const { host } = createMockHost({
        getContainerWidth: () => 1000,
        getPageWidth: () => 500
      });
      const controller = new ViewerCommandController(host);

      // targetScale = (1000 - 32) / 500 = 968 / 500 = 1.936
      expect(controller.fitWidth()).toBe(true);
      expect(controller.getZoom()).toBeCloseTo(1.936);
    });

    it("delegates fitWidth to host.fitWidth if implemented", () => {
      const fitWidthSpy = vi.fn();
      const { host } = createMockHost({
        fitWidth: fitWidthSpy
      });
      const controller = new ViewerCommandController(host);

      expect(controller.fitWidth()).toBe(true);
      expect(fitWidthSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Page Navigation", () => {
    it("reports page bounds correctly", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.getCurrentPage()).toBe(1);
      expect(controller.getPageCount()).toBe(5);
      expect(controller.canPreviousPage()).toBe(false);
      expect(controller.canNextPage()).toBe(true);
    });

    it("navigates next, previous, first, last, and jumps", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.nextPage()).toBe(true);
      expect(controller.getCurrentPage()).toBe(2);

      expect(controller.previousPage()).toBe(true);
      expect(controller.getCurrentPage()).toBe(1);
      expect(controller.previousPage()).toBe(false);

      expect(controller.lastPage()).toBe(true);
      expect(controller.getCurrentPage()).toBe(5);
      expect(controller.nextPage()).toBe(false);

      expect(controller.firstPage()).toBe(true);
      expect(controller.getCurrentPage()).toBe(1);

      expect(controller.goToPage(3)).toBe(true);
      expect(controller.getCurrentPage()).toBe(3);

      // Clamps out-of-range jumps
      expect(controller.goToPage(99)).toBe(true);
      expect(controller.getCurrentPage()).toBe(5);

      expect(controller.goToPage(-5)).toBe(true);
      expect(controller.getCurrentPage()).toBe(1);
    });
  });

  describe("Rotation", () => {
    it("normalizes rotation modulo 360", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.getRotation()).toBe(0);

      controller.setRotation(90);
      expect(controller.getRotation()).toBe(90);

      controller.setRotation(450);
      expect(controller.getRotation()).toBe(90);

      controller.setRotation(-90);
      expect(controller.getRotation()).toBe(270);
    });

    it("rotates clockwise and counterclockwise in 90 degree increments", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      controller.rotateClockwise();
      expect(controller.getRotation()).toBe(90);

      controller.rotateClockwise();
      expect(controller.getRotation()).toBe(180);

      controller.rotateCounterclockwise();
      expect(controller.getRotation()).toBe(90);

      controller.rotateCounterclockwise();
      expect(controller.getRotation()).toBe(0);

      controller.rotateCounterclockwise();
      expect(controller.getRotation()).toBe(270);
    });
  });

  describe("Hand Mode", () => {
    it("toggles and restores previous tool", () => {
      const { host, tool } = createMockHost();
      tool.current = "highlighter";
      const controller = new ViewerCommandController(host);

      expect(controller.isHandMode()).toBe(false);

      // Activate hand mode
      expect(controller.toggleHandMode()).toBe(true);
      expect(controller.isHandMode()).toBe(true);
      expect(tool.current).toBe("drag");

      // Deactivate hand mode -> restores highlighter
      expect(controller.toggleHandMode()).toBe(true);
      expect(controller.isHandMode()).toBe(false);
      expect(tool.current).toBe("highlighter");
    });

    it("explicitly sets hand mode active / inactive", () => {
      const { host, tool } = createMockHost();
      tool.current = "pencil";
      const controller = new ViewerCommandController(host);

      controller.setHandMode(true);
      expect(tool.current).toBe("drag");

      controller.setHandMode(false);
      expect(tool.current).toBe("pencil");
    });
  });

  describe("Search", () => {
    it("opens, closes, and toggles search", () => {
      const { host, searchState } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.isSearchOpen()).toBe(false);

      expect(controller.openSearch()).toBe(true);
      expect(controller.isSearchOpen()).toBe(true);
      expect(searchState.open).toBe(true);

      expect(controller.closeSearch()).toBe(true);
      expect(controller.isSearchOpen()).toBe(false);

      expect(controller.toggleSearch()).toBe(true);
      expect(controller.isSearchOpen()).toBe(true);

      expect(controller.toggleSearch()).toBe(true);
      expect(controller.isSearchOpen()).toBe(false);

      // Forced toggle
      expect(controller.toggleSearch(true)).toBe(true);
      expect(controller.isSearchOpen()).toBe(true);

      expect(controller.toggleSearch(false)).toBe(true);
      expect(controller.isSearchOpen()).toBe(false);
    });

    it("executes search query and next/previous", () => {
      const { host, searchState } = createMockHost();
      const controller = new ViewerCommandController(host);

      expect(controller.search("hello")).toBe(true);
      expect(searchState.query).toBe("hello");

      expect(controller.findNext()).toBe(true);
      expect(searchState.findNextCount).toBe(1);

      expect(controller.findPrevious()).toBe(true);
      expect(searchState.findPrevCount).toBe(1);
    });
  });

  describe("Keyboard Shortcuts", () => {
    function makeKey(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
      const ev = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...opts
      });
      // Mock preventDefault and stopPropagation spies
      vi.spyOn(ev, "preventDefault");
      vi.spyOn(ev, "stopPropagation");
      return ev;
    }

    it("handles zoom shortcuts", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      const zoomInEv = makeKey("=", { ctrlKey: true });
      expect(controller.handleKeyDown(zoomInEv)).toBe(true);
      expect(zoomInEv.preventDefault).toHaveBeenCalled();
      expect(controller.getZoom()).toBeCloseTo(1.25);

      const zoomOutEv = makeKey("-", { metaKey: true });
      expect(controller.handleKeyDown(zoomOutEv)).toBe(true);
      expect(zoomOutEv.preventDefault).toHaveBeenCalled();
      expect(controller.getZoom()).toBeCloseTo(1.0);

      controller.setZoom(2.0);
      const resetEv = makeKey("0", { ctrlKey: true });
      expect(controller.handleKeyDown(resetEv)).toBe(true);
      expect(controller.getZoom()).toBe(1.0);

      const fitWidthEv = makeKey("9", { metaKey: true });
      expect(controller.handleKeyDown(fitWidthEv)).toBe(true);
    });

    it("handles rotation shortcuts", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      const rotCw = makeKey("r", { ctrlKey: true });
      expect(controller.handleKeyDown(rotCw)).toBe(true);
      expect(controller.getRotation()).toBe(90);

      const rotCcw = makeKey("r", { ctrlKey: true, shiftKey: true });
      expect(controller.handleKeyDown(rotCcw)).toBe(true);
      expect(controller.getRotation()).toBe(0);
    });

    it("handles search shortcut Mod+F", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      const searchEv = makeKey("f", { metaKey: true });
      expect(controller.handleKeyDown(searchEv)).toBe(true);
      expect(controller.isSearchOpen()).toBe(true);
    });

    it("handles navigation and hand mode shortcuts when not text editing", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      const nextEv = makeKey("PageDown");
      expect(controller.handleKeyDown(nextEv, false)).toBe(true);
      expect(controller.getCurrentPage()).toBe(2);

      const prevEv = makeKey("PageUp");
      expect(controller.handleKeyDown(prevEv, false)).toBe(true);
      expect(controller.getCurrentPage()).toBe(1);

      const endEv = makeKey("End");
      expect(controller.handleKeyDown(endEv, false)).toBe(true);
      expect(controller.getCurrentPage()).toBe(5);

      const homeEv = makeKey("Home");
      expect(controller.handleKeyDown(homeEv, false)).toBe(true);
      expect(controller.getCurrentPage()).toBe(1);

      const handEv = makeKey("h");
      expect(controller.handleKeyDown(handEv, false)).toBe(true);
      expect(controller.isHandMode()).toBe(true);
    });

    it("suppresses navigation and hand mode when text editing", () => {
      const { host } = createMockHost();
      const controller = new ViewerCommandController(host);

      const handEv = makeKey("h");
      expect(controller.handleKeyDown(handEv, true)).toBe(false);
      expect(controller.isHandMode()).toBe(false);
      expect(handEv.preventDefault).not.toHaveBeenCalled();

      const pageDownEv = makeKey("PageDown");
      expect(controller.handleKeyDown(pageDownEv, true)).toBe(false);
      expect(controller.getCurrentPage()).toBe(1);
    });
  });
});
