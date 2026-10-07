import { describe, expect, it, vi } from "vitest";
import {
  createViewerState,
  cloneViewerState,
  normalizeScaleMode,
  normalizeRotation,
  ensureViewerState,
  type ViewerState,
  type ViewerViewportState
} from "../src/runtime/ViewerState";
import { HandwritingViewport } from "../src/integration/HandwritingViewport";
import { ViewerCommandController, type ViewerCommandHost } from "../src/runtime/ViewerCommandController";

describe("Canonical ViewerState", () => {
  describe("ViewerState helpers and normalizers", () => {
    it("normalizes scaleMode to canonical variants", () => {
      expect(normalizeScaleMode("fit-width")).toBe("fit-width");
      expect(normalizeScaleMode("page-width")).toBe("fit-width");
      expect(normalizeScaleMode("auto")).toBe("fit-width");

      expect(normalizeScaleMode("fit-page")).toBe("fit-page");
      expect(normalizeScaleMode("page-fit")).toBe("fit-page");

      expect(normalizeScaleMode("custom")).toBe("custom");
      expect(normalizeScaleMode(1.5)).toBe("custom");
      expect(normalizeScaleMode(undefined)).toBe("custom");
      expect(normalizeScaleMode(null)).toBe("custom");
      expect(normalizeScaleMode("unknown")).toBe("custom");
    });

    it("normalizes rotation to [0, 360) right-angle degrees", () => {
      expect(normalizeRotation(0)).toBe(0);
      expect(normalizeRotation(90)).toBe(90);
      expect(normalizeRotation(360)).toBe(0);
      expect(normalizeRotation(-90)).toBe(270);
      expect(normalizeRotation(450)).toBe(90);
      expect(normalizeRotation("invalid")).toBe(0);
    });

    it("creates a canonical ViewerState with defaults", () => {
      const state = createViewerState();
      expect(state).toEqual({
        viewport: { scale: 1, x: 0, y: 0 },
        pageNumber: 1,
        rotation: 0,
        scaleMode: "custom",
        scale: 1
      });
    });

    it("creates a canonical ViewerState from partial input", () => {
      const state = createViewerState({
        viewport: { scale: 2.5, x: 10, y: 20 },
        pageNumber: 3,
        rotation: 90,
        scaleMode: "page-width",
        scrollFraction: 0.4
      });
      expect(state).toEqual({
        viewport: { scale: 2.5, x: 10, y: 20 },
        pageNumber: 3,
        rotation: 90,
        scaleMode: "fit-width",
        scrollFraction: 0.4,
        scale: 2.5
      });
    });

    it("clones a ViewerState into an independent object", () => {
      const original = createViewerState({
        viewport: { scale: 1.5, x: 100, y: 200 },
        pageNumber: 2,
        rotation: 180,
        scaleMode: "fit-page"
      });
      const clone = cloneViewerState(original);
      expect(clone).toEqual(original);
      expect(clone).not.toBe(original);
      expect(clone.viewport).not.toBe(original.viewport);

      clone.viewport.x = 999;
      expect(original.viewport.x).toBe(100);
    });

    it("ensures canonical ViewerState from legacy objects lacking viewport", () => {
      const legacy = {
        pageNumber: 4,
        scale: 1.75,
        rotation: 270,
        scrollFraction: 0.65,
        scaleMode: "page-fit"
      };
      const canonical = ensureViewerState(legacy);
      expect(canonical).toEqual({
        viewport: { scale: 1.75, x: 0, y: 0 },
        pageNumber: 4,
        rotation: 270,
        scaleMode: "fit-page",
        scrollFraction: 0.65,
        scale: 1.75
      });
    });
  });

  describe("HandwritingViewport integration", () => {
    it("operates directly on ViewerViewportState coordinates", () => {
      const viewport = new HandwritingViewport({
        getContainerRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
        getContentSize: () => ({ width: 1200, height: 1600 }),
        initialState: { scale: 1.25, x: 50, y: 75 }
      });

      const state: ViewerViewportState = viewport.getState();
      expect(state).toEqual({ scale: 1.25, x: 50, y: 75 });

      viewport.setState({ scale: 2.0, x: 100, y: 150 });
      expect(viewport.getState()).toEqual({ scale: 2.0, x: 100, y: 150 });
    });
  });

  describe("ViewerCommandController canonical operations", () => {
    it("operates directly on host ViewerState when host exposes getViewerState and setViewerState", () => {
      let state: ViewerState = {
        viewport: { scale: 1.0, x: 0, y: 0 },
        pageNumber: 1,
        rotation: 0,
        scaleMode: "custom",
        scale: 1.0
      };
      const logs: Array<{ name: string; details?: Record<string, unknown> | undefined }> = [];

      const host: ViewerCommandHost = {
        getViewerState: () => ({ ...state, viewport: { ...state.viewport } }),
        setViewerState: (patch) => {
          state = {
            ...state,
            ...patch,
            viewport: {
              ...state.viewport,
              ...(patch.viewport ?? (patch.scale !== undefined ? { scale: patch.scale } : {}))
            },
            scale: patch.viewport?.scale ?? patch.scale ?? state.scale
          };
        },
        getScale: () => state.viewport.scale,
        setScale: (s: number) => { state.viewport.scale = s; state.scale = s; },
        getContainerWidth: () => 1000,
        getPageWidth: () => 500,
        getCurrentPage: () => state.pageNumber,
        getPageCount: () => 10,
        focusPage: (p: number) => { state.pageNumber = p; return true; },
        getRotation: () => state.rotation,
        setRotation: (r: number) => { state.rotation = r; },
        getActiveTool: () => "pen",
        selectTool: vi.fn(),
        logCommand: (name, details) => { logs.push(details !== undefined ? { name, details } : { name }); }
      };

      const controller = new ViewerCommandController(host);

      // Initial state query
      expect(controller.getViewerState()).toEqual(state);
      expect(controller.getZoom()).toBe(1.0);
      expect(controller.getCurrentPage()).toBe(1);
      expect(controller.getRotation()).toBe(0);

      // setZoom updates canonical viewport and scaleMode
      controller.setZoom(2.0);
      expect(state.viewport.scale).toBe(2.0);
      expect(state.scaleMode).toBe("custom");

      // fitWidth sets canonical scaleMode to fit-width
      controller.fitWidth();
      expect(state.viewport.scale).toBeCloseTo((1000 - 32) / 500);
      expect(state.scaleMode).toBe("fit-width");

      // fitPage sets canonical scaleMode to fit-page
      controller.fitPage();
      expect(state.scaleMode).toBe("fit-page");

      // Page navigation updates canonical pageNumber
      controller.goToPage(5);
      expect(state.pageNumber).toBe(5);

      // Rotation updates canonical rotation
      controller.rotateClockwise();
      expect(state.rotation).toBe(90);

      // setViewerState directly updates partial canonical fields
      controller.setViewerState({
        viewport: { scale: 3.0, x: 40, y: 60 },
        rotation: 180,
        scaleMode: "custom"
      });
      expect(state.viewport).toEqual({ scale: 3.0, x: 40, y: 60 });
      expect(state.rotation).toBe(180);
      expect(state.scaleMode).toBe("custom");
    });

    it("falls back gracefully when host only implements individual getter/setter methods", () => {
      let scale = 1.0;
      let page = 1;
      let rotation = 0;

      const host: ViewerCommandHost = {
        getScale: () => scale,
        setScale: (s: number) => { scale = s; },
        getContainerWidth: () => 800,
        getPageWidth: () => 400,
        getCurrentPage: () => page,
        getPageCount: () => 5,
        focusPage: (p: number) => { page = p; return true; },
        getRotation: () => rotation,
        setRotation: (r: number) => { rotation = r; },
        getActiveTool: () => "pen",
        selectTool: vi.fn()
      };

      const controller = new ViewerCommandController(host);

      // getViewerState constructs canonical ViewerState from individual getters
      const state = controller.getViewerState();
      expect(state).toEqual({
        viewport: { scale: 1.0, x: 0, y: 0 },
        pageNumber: 1,
        rotation: 0,
        scaleMode: "custom",
        scale: 1.0
      });

      // setViewerState dispatches to individual host methods
      controller.setViewerState({
        viewport: { scale: 2.2, x: 0, y: 0 },
        pageNumber: 3,
        rotation: 90
      });
      expect(scale).toBe(2.2);
      expect(page).toBe(3);
      expect(rotation).toBe(90);
    });
  });
});
