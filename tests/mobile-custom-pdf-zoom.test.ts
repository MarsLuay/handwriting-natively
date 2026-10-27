import { describe, expect, it } from "vitest";
import {
  planMobileCustomPdfZoom,
  type MobileCustomPdfZoomInput
} from "../src/integration/MobileCustomPdfZoom";
import { GestureNavigationController } from "../src/input/GestureNavigationController";
import type { PdfIntegrationProfile } from "../src/integration/PdfViewerCompatibility";
import { probePlatformCapabilities } from "../src/integration/PlatformCapabilities";

function profile(adapter: "direct" | "embedded" = "direct"): PdfIntegrationProfile {
  return {
    schemaVersion: 1,
    adapter,
    status: "supported",
    viewerGeneration: 4,
    strategies: {
      viewerRoot: "validated-dom-selector",
      pages: "numbered-dom-shell",
      scrollRoot: "adapter-fallback-chain",
      scale: "private-viewer",
      zoomEvents: "optional-event-bus",
      pageLifecycle: "bounded-dom-observation",
      sidebar: "native-toolbar-or-geometry"
    },
    capabilities: {
      viewerRoot: true,
      pageElements: true,
      trustworthyPageNumbers: true,
      geometryReadable: true,
      scrollRoot: true,
      toolbarHost: true,
      privateViewer: true,
      eventBus: true,
      pageRenderEvent: true,
      scaleReadable: true,
      scaleEvent: true,
      rotationReadable: true,
      pageReplacementObservable: true,
      sidebarObservable: true,
      embedded: adapter === "embedded"
    },
    counters: {
      rebinds: 0,
      viewerReplacements: 0,
      pageReplacements: 0,
      fallbackUses: 0,
      attachRetries: 0
    },
    failedProbes: [],
    warnings: []
  };
}

function gateInput(overrides: Partial<MobileCustomPdfZoomInput> = {}): MobileCustomPdfZoomInput {
  return {
    enabled: true,
    surfaceType: "pdf",
    platform: probePlatformCapabilities({
      platform: "ipad",
      obsidianVersion: "1.8.10",
      isMobile: true,
      runtime: { pointerEvents: true, touchEvents: true }
    }),
    profile: profile(),
    page: { geometrySafe: true, identitySafe: true },
    ...overrides
  };
}

describe("mobile custom PDF zoom contract", () => {
  it("enables mobile pinch only with explicit host and viewer evidence", () => {
    expect(planMobileCustomPdfZoom(gateInput())).toEqual({
      mode: "custom-mobile",
      fallbackReasons: []
    });
  });

  it("does not require optional event-bus signals when host and viewer evidence is safe", () => {
    const embedded = profile("embedded");
    embedded.capabilities.eventBus = false;
    embedded.capabilities.pageRenderEvent = false;

    const plan = planMobileCustomPdfZoom(gateInput({ profile: embedded }));

    expect(plan).toEqual({ mode: "custom-mobile", fallbackReasons: [] });
  });

  it.each([
    ["disabled", gateInput({ enabled: false }), "setting-disabled"],
    ["desktop", gateInput({
      platform: probePlatformCapabilities({
        platform: "desktop",
        obsidianVersion: "1.8.10",
        isMobile: false,
        runtime: { pointerEvents: true, touchEvents: false }
      })
    }), "platform-not-mobile"],
    ["unknown platform", gateInput({
      platform: probePlatformCapabilities({ runtime: { pointerEvents: true, touchEvents: true } })
    }), "platform-unknown"],
    ["iPhone host", gateInput({
      platform: probePlatformCapabilities({
        platform: "ipad",
        obsidianVersion: "1.8.10",
        isMobile: true,
        isPhone: true,
        runtime: { pointerEvents: true, touchEvents: true }
      })
    }), "platform-unknown"],
    ["non-PDF", gateInput({ surfaceType: "image" }), "non-pdf-surface"]
  ] as const)("falls back for %s", (_label, input, reason) => {
    const plan = planMobileCustomPdfZoom(input);

    expect(plan.mode).toBe("native-fallback");
    expect(plan.fallbackReasons).toContain(reason);
  });

  it("fails closed when pointer/touch pairing or page evidence is unavailable", () => {
    const input = gateInput();
    input.platform = probePlatformCapabilities({
      platform: "ipad",
      obsidianVersion: "1.8.10",
      isMobile: true,
      runtime: { pointerEvents: false, touchEvents: false }
    });
    input.profile.capabilities.privateViewer = false;
    input.page = { geometrySafe: false, identitySafe: false };
    const plan = planMobileCustomPdfZoom(input);

    expect(plan.mode).toBe("native-fallback");
    expect(plan.fallbackReasons).toEqual(expect.arrayContaining([
      "pointer-events-unavailable",
      "touch-events-unavailable",
      "private-viewer-unavailable",
      "page-geometry-unsafe",
      "page-identity-unsafe"
    ]));
  });

  it("keeps a companion touch pointer native during stylus contact", () => {
    const surface = document.createElement("div");
    const controller = new GestureNavigationController({
      getScale: () => 1,
      onPinchStart: () => ({ accepted: true, scale: 1 }),
      onPinchPreview: () => undefined,
      onPinchEnd: () => undefined
    });
    const event = (pointerType: "touch", pointerId: number): PointerEvent => {
      const pointer = new Event("pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
      Object.assign(pointer, { pointerType, pointerId, button: 0, isPrimary: true, clientX: 20, clientY: 30 });
      return pointer;
    };

    controller.reconcilePenContacts([3]);
    const companion = event("touch", 4);
    const result = controller.handlePointerDown(companion, {
      surface,
      route: "touch-pan",
      pointerType: "touch",
      customNavigationEnabled: true
    });

    expect(result).toMatchObject({ handled: true, route: "native", reason: "stylus-active" });
    expect(companion.defaultPrevented).toBe(false);
    expect(controller.activePointerIds()).toEqual([]);
    controller.destroy();
  });
});
