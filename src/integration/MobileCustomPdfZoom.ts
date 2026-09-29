import type { AnnotationPageInfo, AnnotationSurfaceType } from "../runtime/AnnotationSurface";
import type { PdfIntegrationProfile } from "./PdfViewerCompatibility";
import type { PlatformCapabilityReport } from "./PlatformCapabilities";

/** The only two outcomes of the mobile custom-zoom gate. */
export type MobileCustomPdfZoomMode = "custom-mobile" | "native-fallback";

/** Bounded reasons why the native host must retain zoom ownership. */
export type MobileCustomPdfZoomFallbackReason =
  | "setting-disabled"
  | "non-pdf-surface"
  | "platform-not-mobile"
  | "platform-unknown"
  | "pointer-events-unavailable"
  | "touch-events-unavailable"
  | "viewer-root-unavailable"
  | "page-elements-unavailable"
  | "page-lifecycle-unavailable"
  | "scroll-root-unavailable"
  | "geometry-unavailable"
  | "page-identity-unavailable"
  | "page-geometry-unsafe"
  | "page-identity-unsafe"
  | "private-viewer-unavailable"
  | "scale-unavailable"
  | "native-scale-commit-unavailable";

export type MobileCustomPdfZoomSignalSource = "event-bus" | "dom-geometry";

/**
 * The explicit evidence needed before a session may own mobile PDF pinch.
 *
 * `nativeScaleCommitAvailable` is supplied by the adapter after probing the
 * private viewer. Keeping it separate from the profile prevents this policy
 * from guessing that a readable scale is also writable.
 */
export interface MobileCustomPdfZoomGateInput {
  enabled: boolean;
  surfaceType: AnnotationSurfaceType;
  platform: PlatformCapabilityReport;
  profile: PdfIntegrationProfile;
  page: Pick<AnnotationPageInfo, "geometrySafe" | "identitySafe"> | null;
  nativeScaleCommitAvailable: boolean;
}

export interface MobileCustomPdfZoomPlan {
  mode: MobileCustomPdfZoomMode;
  adapter: "direct" | "embedded";
  fallbackReasons: readonly MobileCustomPdfZoomFallbackReason[];
  /** Optional private EventBus is preferred but never a gate by itself. */
  zoomSignalSource: MobileCustomPdfZoomSignalSource;
  /** Page replacement/render observation uses the same safe fallback rule. */
  pageLifecycleSignalSource: MobileCustomPdfZoomSignalSource;
}

const requiredProfileCapabilities = [
  ["viewerRoot", "viewer-root-unavailable"],
  ["pageElements", "page-elements-unavailable"],
  ["scrollRoot", "scroll-root-unavailable"],
  ["geometryReadable", "geometry-unavailable"],
  ["trustworthyPageNumbers", "page-identity-unavailable"],
  ["pageReplacementObservable", "page-lifecycle-unavailable"],
  ["privateViewer", "private-viewer-unavailable"],
  ["scaleReadable", "scale-unavailable"]
] as const;

function isMobilePlatform(platform: PlatformCapabilityReport): boolean | null {
  if (platform.platform === "desktop") return false;
  if (platform.platform !== "android" && platform.platform !== "ipad") return null;
  if (platform.platform === "ipad" && platform.isPhone === true) return null;
  if (platform.isMobile === false) return false;
  if (platform.isMobile !== true) return null;
  return true;
}

/**
 * Resolve the feature gate without inspecting user-agent, viewport, or DOM
 * shape. The native fallback is the safe result for every unknown condition.
 */
export function planMobileCustomPdfZoom(input: MobileCustomPdfZoomGateInput): MobileCustomPdfZoomPlan {
  const fallbackReasons: MobileCustomPdfZoomFallbackReason[] = [];
  if (!input.enabled) fallbackReasons.push("setting-disabled");
  if (input.surfaceType !== "pdf") fallbackReasons.push("non-pdf-surface");

  const mobile = isMobilePlatform(input.platform);
  if (mobile === false) fallbackReasons.push("platform-not-mobile");
  else if (mobile === null) fallbackReasons.push("platform-unknown");

  if (input.platform.runtime.pointerEvents !== "available") {
    fallbackReasons.push("pointer-events-unavailable");
  }
  if (input.platform.runtime.touchEvents !== "available") {
    fallbackReasons.push("touch-events-unavailable");
  }

  for (const [capability, reason] of requiredProfileCapabilities) {
    if (input.profile.capabilities[capability] !== true) fallbackReasons.push(reason);
  }
  if (input.page === null) {
    fallbackReasons.push("page-elements-unavailable");
  } else {
    if (input.page.geometrySafe === false) fallbackReasons.push("page-geometry-unsafe");
    if (input.page.identitySafe === false) fallbackReasons.push("page-identity-unsafe");
  }
  if (!input.nativeScaleCommitAvailable) {
    fallbackReasons.push("native-scale-commit-unavailable");
  }

  const uniqueReasons = [...new Set(fallbackReasons)];
  const hasEventBus = input.profile.capabilities.eventBus === true;
  const hasPageRenderEvent = input.profile.capabilities.pageRenderEvent === true;
  return {
    mode: uniqueReasons.length === 0 ? "custom-mobile" : "native-fallback",
    adapter: input.profile.adapter,
    fallbackReasons: uniqueReasons,
    zoomSignalSource: hasEventBus ? "event-bus" : "dom-geometry",
    pageLifecycleSignalSource: hasPageRenderEvent ? "event-bus" : "dom-geometry"
  };
}

export type MobileCustomPdfZoomCancellationReason =
  | "pointer-cancel"
  | "touch-cancel"
  | "lost-pointer-capture"
  | "visibility-hidden"
  | "page-replaced"
  | "capability-lost"
  | "native-scroll-observed"
  | "handoff-failed";

/** A cancellation signal always releases the temporary compositor state. */
export function cancellationReason(
  signal: MobileCustomPdfZoomCancellationReason | null | undefined
): MobileCustomPdfZoomCancellationReason | null {
  return signal ?? null;
}

export interface MobileCustomPdfZoomGenerationInput {
  expectedViewerGeneration: number;
  observedViewerGeneration: number;
  pageIdentityMatches: boolean;
  pageGeometrySafe: boolean;
}

export interface MobileCustomPdfZoomGenerationDecision {
  action: "continue" | "cancel-native";
  reason: "same-generation" | "viewer-replaced" | "page-identity-changed" | "page-geometry-unsafe";
}

/**
 * A temporary transform never crosses a viewer generation boundary. The
 * later handoff implementation can reconcile the new page before retrying.
 */
export function decideGenerationReplacement(
  input: MobileCustomPdfZoomGenerationInput
): MobileCustomPdfZoomGenerationDecision {
  if (!Number.isFinite(input.expectedViewerGeneration)
    || !Number.isFinite(input.observedViewerGeneration)
    || input.expectedViewerGeneration !== input.observedViewerGeneration) {
    return { action: "cancel-native", reason: "viewer-replaced" };
  }
  if (!input.pageIdentityMatches) {
    return { action: "cancel-native", reason: "page-identity-changed" };
  }
  if (!input.pageGeometrySafe) {
    return { action: "cancel-native", reason: "page-geometry-unsafe" };
  }
  return { action: "continue", reason: "same-generation" };
}
