import { describe, expect, it } from "vitest";
import type { HandwritingViewport } from "../src/integration/HandwritingViewport";
import { createViewerState, type ViewerState } from "../src/runtime/ViewerState";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";

interface MobilePinchStatePersistenceHarness {
  canonicalViewerState: ViewerState;
  handwritingViewport: Pick<HandwritingViewport, "getState" | "getRenderedScale">;
  options: {
    adapter: {
      getViewState(): { pageNumber: number; rotation: number; scale: number; scaleMode: string };
      scrollElement(): HTMLElement;
    };
  };
  getViewerState(): ViewerState;
  persistMobilePinchScale(scale: number): void;
  updateViewerStateFromAdapter(): void;
}

describe("mobile pinch view-state persistence", () => {
  it("retains the settled viewport zoom as a custom view mode without changing its position", () => {
    const session = Object.create(ViewerInkSession.prototype) as MobilePinchStatePersistenceHarness;
    session.canonicalViewerState = createViewerState({
      viewport: { scale: 1, x: 240, y: 520 },
      pageNumber: 3,
      rotation: 90,
      scaleMode: "fit-width"
    });
    session.handwritingViewport = {
      getState: () => ({ scale: 1.85, x: -240, y: -520 }),
      getRenderedScale: () => 1
    };
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, {
      scrollLeft: { configurable: true, value: 240 },
      scrollTop: { configurable: true, value: 520 }
    });
    session.options = {
      adapter: {
        getViewState: () => ({ pageNumber: 3, rotation: 90, scale: 1, scaleMode: "fit-width" }),
        scrollElement: () => scroll
      }
    };

    session.persistMobilePinchScale(1.85);
    session.updateViewerStateFromAdapter();

    expect(session.getViewerState()).toEqual({
      viewport: { scale: 1.85, x: 240, y: 520 },
      pageNumber: 3,
      rotation: 90,
      scaleMode: "custom",
      scale: 1.85
    });
  });
});
