import { describe, expect, it } from "vitest";
import { createDefaultSettings, mergeSettings } from "../src/model";
import { resolveFloatingToolbarPosition } from "../src/runtime/FloatingToolbarPosition";

describe("floating toolbar position", () => {
  it("defaults to the viewer's top-left and restores a shared saved position", () => {
    expect(createDefaultSettings("config").floatingToolbarPosition).toBeNull();
    expect(mergeSettings({ floatingToolbarPosition: { left: 320, top: 84 } }).floatingToolbarPosition)
      .toEqual({ left: 320, top: 84 });
  });

  it("rejects invalid saved coordinates", () => {
    expect(mergeSettings({ floatingToolbarPosition: { left: -1, top: 84 } }).floatingToolbarPosition).toBeNull();
    expect(mergeSettings({ floatingToolbarPosition: { left: Number.NaN, top: 84 } }).floatingToolbarPosition).toBeNull();
  });

  it("starts at the viewer's top-left when no saved or current position exists", () => {
    expect(resolveFloatingToolbarPosition({
      savedPosition: null,
      currentPosition: null,
      hostPosition: { left: 240, top: 32 },
      viewport: { width: 1280, height: 800 },
      toolbarSize: { width: 400, height: 80 }
    })).toEqual({ left: 240, top: 32 });
  });

  it("restores the shared position ahead of a session's previous position and clamps it to the viewport", () => {
    expect(resolveFloatingToolbarPosition({
      savedPosition: { left: 1200, top: 760 },
      currentPosition: { left: 40, top: 40 },
      hostPosition: { left: 0, top: 0 },
      viewport: { width: 1280, height: 800 },
      toolbarSize: { width: 400, height: 80 }
    })).toEqual({ left: 880, top: 720 });
  });

  it("keeps a mounted toolbar's position when no shared position has been saved", () => {
    expect(resolveFloatingToolbarPosition({
      savedPosition: null,
      currentPosition: { left: 510, top: 210 },
      hostPosition: { left: 240, top: 32 },
      viewport: { width: 1280, height: 800 },
      toolbarSize: { width: 400, height: 80 }
    })).toEqual({ left: 510, top: 210 });
  });
});
