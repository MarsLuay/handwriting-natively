import { describe, expect, it, vi } from "vitest";
import { LaserOverlayController, type LaserSurface } from "../src/runtime/LaserOverlayController";

describe("LaserOverlayController", () => {
  it("tracks trails, clears them, and invokes host blits on repaint", () => {
    const canvas = document.createElement("canvas");
    const overlay = document.createElement("div");

    const mockContext = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "round",
      lineJoin: "round"
    } as unknown as CanvasRenderingContext2D;

    const mockSurface: LaserSurface = {
      page: { pageNumber: 1 },
      overlay,
      context: mockContext,
      laserDraft: false,
      laserDiscardedPoints: 0,
      inkLayerValid: true,
      inkLayer: canvas,
      inkLayerBurstCapture: false,
      rasterFallbackReady: false,
      settleUpgradePending: false
    };

    const host = {
      getSurface: vi.fn().mockReturnValue(mockSurface),
      getAllSurfaces: vi.fn().mockReturnValue([mockSurface]),
      toViewport: vi.fn((_surface, pt) => ({ x: pt.x, y: pt.y })),
      displayScale: vi.fn().mockReturnValue(1),
      pageLayout: vi.fn().mockReturnValue({ contentWidth: 600, contentHeight: 800 }),
      resolveInkBacking: vi.fn().mockReturnValue({ pixelWidth: 600, pixelHeight: 800, backingScale: 1 }),
      blitInkLayerToCanvas: vi.fn(),
      renderPage: vi.fn(),
      getLaserPreferences: vi.fn().mockReturnValue({
        color: "#ef4444",
        width: 4,
        opacity: 0.9,
        holdMs: 800,
        fadeMs: 1200
      }),
      isDestroyed: vi.fn().mockReturnValue(false),
      defaultView: vi.fn().mockReturnValue(window)
    };

    const controller = new LaserOverlayController(host);

    controller.addTrail({
      id: "trail-1",
      page: 1,
      points: [{ x: 10, y: 10, pressure: 0.5, time: 100 }],
      color: "#ef4444",
      width: 4,
      opacity: 0.9,
      holdMs: 800,
      fadeMs: 1200
    });

    expect(controller.getTrails()).toHaveLength(1);

    controller.repaintOverlay(1);
    expect(host.blitInkLayerToCanvas).toHaveBeenCalled();
    expect(mockContext.save).toHaveBeenCalled();

    controller.clearTrails();
    expect(controller.getTrails()).toHaveLength(0);

    controller.destroy();
  });
});
