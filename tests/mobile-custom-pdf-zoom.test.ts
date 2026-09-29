import { describe, expect, it } from "vitest";
import {
  cancellationReason,
  decideGenerationReplacement,
  planMobileCustomPdfZoom,
  type MobileCustomPdfZoomGateInput
} from "../src/integration/MobileCustomPdfZoom";
import { GestureOwnership } from "../src/input/GestureOwnership";
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

function gateInput(overrides: Partial<MobileCustomPdfZoomGateInput> = {}): MobileCustomPdfZoomGateInput {
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
    nativeScaleCommitAvailable: true,
    ...overrides
  };
}

describe("mobile custom PDF zoom contract", () => {
  it("enables direct mobile pinch only with explicit host and viewer evidence", () => {
    const plan = planMobileCustomPdfZoom(gateInput());

    expect(plan).toEqual({
      mode: "custom-mobile",
      adapter: "direct",
      fallbackReasons: [],
      zoomSignalSource: "event-bus",
      pageLifecycleSignalSource: "event-bus"
    });
  });

  it("keeps embedded PDFs separate while allowing the DOM fallback for optional signals", () => {
    const embedded = profile("embedded");
    embedded.capabilities.eventBus = false;
    embedded.capabilities.pageRenderEvent = false;

    const plan = planMobileCustomPdfZoom(gateInput({ profile: embedded }));

    expect(plan.mode).toBe("custom-mobile");
    expect(plan.adapter).toBe("embedded");
    expect(plan.zoomSignalSource).toBe("dom-geometry");
    expect(plan.pageLifecycleSignalSource).toBe("dom-geometry");
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
    ["non-PDF", gateInput({ surfaceType: "image" }), "non-pdf-surface"]
  ] as const)("falls back for %s", (_label, input, reason) => {
    const plan = planMobileCustomPdfZoom(input);

    expect(plan.mode).toBe("native-fallback");
    expect(plan.fallbackReasons).toContain(reason);
  });

  it("fails closed when pointer/touch pairing, page evidence, or native commit is unavailable", () => {
    const input = gateInput();
    input.platform = probePlatformCapabilities({
      platform: "ipad",
      obsidianVersion: "1.8.10",
      isMobile: true,
      runtime: { pointerEvents: false, touchEvents: false }
    });
    input.profile.capabilities.privateViewer = false;
    input.page = { geometrySafe: false, identitySafe: false };
    input.nativeScaleCommitAvailable = false;

    const plan = planMobileCustomPdfZoom(input);

    expect(plan.mode).toBe("native-fallback");
    expect(plan.fallbackReasons).toEqual(expect.arrayContaining([
      "pointer-events-unavailable",
      "touch-events-unavailable",
      "private-viewer-unavailable",
      "page-geometry-unsafe",
      "page-identity-unsafe",
      "native-scale-commit-unavailable"
    ]));
  });

  it("keeps one-finger navigation and pen-plus-finger input out of custom pinch", () => {
    const ownership = new GestureOwnership({ customPinchEnabled: true });
    expect(ownership.pointerDown({ pointerId: 1, pointerType: "touch" }).state.owner)
      .toBe("native-touch-navigation");
    expect(ownership.pointerDown({ pointerId: 2, pointerType: "touch" }).state.owner)
      .toBe("custom-touch-pinch");

    const penOwnership = new GestureOwnership({ customPinchEnabled: true });
    penOwnership.pointerDown({ pointerId: 3, pointerType: "pen", target: "page", inkToolSelected: true });
    expect(penOwnership.pointerDown({ pointerId: 4, pointerType: "touch", target: "page" }).state.owner)
      .toBe("pen-ink");
  });

  it("turns every cancellation signal into a compositor release decision", () => {
    expect(cancellationReason("pointer-cancel")).toBe("pointer-cancel");
    expect(cancellationReason("visibility-hidden")).toBe("visibility-hidden");
    expect(cancellationReason(null)).toBeNull();
    const ownership = new GestureOwnership({ customPinchEnabled: true });
    ownership.pointerDown({ pointerId: 1, pointerType: "touch" });
    ownership.pointerDown({ pointerId: 2, pointerType: "touch" });
    expect(ownership.pointerCancel({ pointerId: 2, pointerType: "touch" }).action).toBe("preview");
  });

  it("never carries a temporary transform across a viewer generation replacement", () => {
    expect(decideGenerationReplacement({
      expectedViewerGeneration: 4,
      observedViewerGeneration: 4,
      pageIdentityMatches: true,
      pageGeometrySafe: true
    })).toEqual({ action: "continue", reason: "same-generation" });
    expect(decideGenerationReplacement({
      expectedViewerGeneration: 4,
      observedViewerGeneration: 5,
      pageIdentityMatches: true,
      pageGeometrySafe: true
    })).toEqual({ action: "cancel-native", reason: "viewer-replaced" });
    expect(decideGenerationReplacement({
      expectedViewerGeneration: 4,
      observedViewerGeneration: 4,
      pageIdentityMatches: false,
      pageGeometrySafe: true
    })).toEqual({ action: "cancel-native", reason: "page-identity-changed" });
    expect(decideGenerationReplacement({
      expectedViewerGeneration: 4,
      observedViewerGeneration: 4,
      pageIdentityMatches: true,
      pageGeometrySafe: false
    })).toEqual({ action: "cancel-native", reason: "page-geometry-unsafe" });
  });
});
