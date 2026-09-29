import { describe, expect, it } from "vitest";
import type { AnnotationPageInfo, AnnotationViewState } from "../src/runtime/AnnotationSurface";
import { MobilePdfZoomHandoff, type MobilePdfZoomHandoffHost } from "../src/integration/MobilePdfZoomHandoff";

function pageInfo(element: HTMLElement, rotation: 0 | 90 | 180 | 270 = 0): AnnotationPageInfo {
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    scale: 1,
    rotation,
    coordinateOrigin: "bottom-left",
    element,
    mountGeneration: 1,
    geometryConfidence: "authoritative",
    geometrySafe: true,
    identityConfidence: "authoritative",
    identitySafe: true,
    candidateCount: 1
  };
}

function hostFor(page: AnnotationPageInfo, rect: { left: number; top: number; width: number; height: number }) {
  let generation = 4;
  let state: AnnotationViewState = { pageNumber: 1, scrollFraction: 0, scale: 1, rotation: page.rotation };
  const scroll = document.createElement("div");
  let committed = true;
  let currentPage = page;
  let currentRect = { ...rect };
  Object.defineProperty(page.element, "getBoundingClientRect", { configurable: true, value: () => ({
    ...currentRect,
    right: currentRect.left + currentRect.width,
    bottom: currentRect.top + currentRect.height,
    x: currentRect.left,
    y: currentRect.top,
    toJSON: () => ({})
  }) });
  const host: MobilePdfZoomHandoffHost = {
    viewerGeneration: () => generation,
    getViewState: () => state,
    page: () => currentPage,
    scrollElement: () => scroll,
    commitScale: (scale) => {
      if (!committed) return false;
      state = { ...state, scale };
      return true;
    }
  };
  return {
    host,
    scroll,
    setGeneration: (value: number) => { generation = value; },
    setPage: (value: AnnotationPageInfo) => { currentPage = value; },
    setRect: (value: typeof rect) => { currentRect = { ...value }; },
    setScale: (value: number) => { state = { ...state, scale: value }; },
    setCommitAvailable: (value: boolean) => { committed = value; }
  };
}

describe("mobile PDF native zoom handoff", () => {
  it("waits for canonical scale and delayed render evidence, then preserves the focal page point", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const page = pageInfo(element);
    const fixture = hostFor(page, { left: 100, top: 100, width: 600, height: 800 });
    const handoff = new MobilePdfZoomHandoff(fixture.host);
    let cancelled = 0;

    expect(handoff.begin({ pageNumber: 1, focalPoint: { x: 300, y: 300 }, compositor: { cancel: () => { cancelled += 1; } } })).toBe(true);
    expect(handoff.commit(2)).toEqual({ phase: "committing", accepted: true });
    fixture.setRect({ left: 100, top: 100, width: 1200, height: 1600 });
    handoff.observe("scale-settled");
    expect(handoff.release().released).toBe(false);
    handoff.observe("render");
    expect(handoff.release().released).toBe(true);
    expect(fixture.scroll.scrollLeft).toBeCloseTo(200);
    expect(fixture.scroll.scrollTop).toBeCloseTo(200);
    expect(cancelled).toBe(1);
    expect(handoff.currentPhase()).toBe("settled");
  });

  it("handles rotated page geometry without mutating page-space annotations", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const page = pageInfo(element, 90);
    const fixture = hostFor(page, { left: 40, top: 60, width: 800, height: 600 });
    const handoff = new MobilePdfZoomHandoff(fixture.host);
    const originalPageGeometry = { width: page.width, height: page.height, rotation: page.rotation };

    expect(handoff.begin({ pageNumber: 1, focalPoint: { x: 440, y: 360 } })).toBe(true);
    expect(handoff.commit(1.5).accepted).toBe(true);
    handoff.observe("geometry");
    handoff.observe("scale-settled");
    expect(handoff.release().released).toBe(true);
    expect(page.width).toBe(originalPageGeometry.width);
    expect(page.height).toBe(originalPageGeometry.height);
    expect(page.rotation).toBe(originalPageGeometry.rotation);
  });

  it("cancels the compositor before a stale generation can commit or release", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const page = pageInfo(element);
    const fixture = hostFor(page, { left: 0, top: 0, width: 600, height: 800 });
    const handoff = new MobilePdfZoomHandoff(fixture.host);
    let cancelled = 0;

    handoff.begin({ pageNumber: 1, focalPoint: { x: 200, y: 200 }, compositor: { cancel: () => { cancelled += 1; } } });
    expect(handoff.commit(1.5).accepted).toBe(true);
    fixture.setGeneration(5);
    expect(handoff.observe("render")).toBe("cancelled");
    expect(handoff.currentCancelReason()).toBe("viewer-replaced");
    expect(cancelled).toBe(1);
    expect(handoff.release().released).toBe(false);
  });

  it("rejects page replacement, unsafe geometry, and unavailable native commits", () => {
    const element = document.createElement("div");
    const replacement = document.createElement("div");
    document.body.append(element, replacement);
    const page = pageInfo(element);
    const fixture = hostFor(page, { left: 0, top: 0, width: 600, height: 800 });
    const handoff = new MobilePdfZoomHandoff(fixture.host);
    expect(handoff.begin({ pageNumber: 1, focalPoint: { x: 100, y: 100 } })).toBe(true);
    expect(handoff.commit(1.2).accepted).toBe(true);
    fixture.setPage({ ...page, element: replacement, mountGeneration: 2 });
    expect(handoff.observe("mutation")).toBe("cancelled");
    expect(handoff.currentCancelReason()).toBe("page-identity-changed");

    const unavailable = new MobilePdfZoomHandoff(fixture.host);
    fixture.setPage(page);
    fixture.setCommitAvailable(false);
    expect(unavailable.begin({ pageNumber: 1, focalPoint: { x: 100, y: 100 } })).toBe(true);
    expect(unavailable.commit(1.2)).toEqual({ phase: "cancelled", accepted: false, reason: "native-scale-commit-unavailable" });
  });
});
