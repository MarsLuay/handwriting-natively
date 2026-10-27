import type { AnnotationPageInfo, AnnotationSurfaceType } from "../runtime/AnnotationSurface";
import type { PdfIntegrationProfile } from "./PdfViewerCompatibility";
import type { PlatformCapabilityReport } from "./PlatformCapabilities";

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
  | "scale-unavailable";

export interface MobileCustomPdfZoomInput {
  enabled: boolean;
  surfaceType: AnnotationSurfaceType;
  platform: PlatformCapabilityReport;
  profile: PdfIntegrationProfile;
  page: Pick<AnnotationPageInfo, "geometrySafe" | "identitySafe"> | null;
}

export interface MobileCustomPdfZoomPlan {
  mode: "custom-mobile" | "native-fallback";
  fallbackReasons: readonly MobileCustomPdfZoomFallbackReason[];
}

export type MobileCustomPdfZoomMode = MobileCustomPdfZoomPlan["mode"];

const requiredProfileCapabilities = [
  ["viewerRoot", "viewer-root-unavailable"],
  ["pageElements", "page-elements-unavailable"],
  ["scrollRoot", "scroll-root-unavailable"],
  ["geometryReadable", "geometry-unavailable"],
  ["trustworthyPageNumbers", "page-identity-unavailable"],
  ["pageReplacementObservable", "page-lifecycle-unavailable"],
  ["privateViewer", "private-viewer-unavailable"],
  ["scaleReadable", "scale-unavailable"]
] as const satisfies readonly (readonly [keyof PdfIntegrationProfile["capabilities"], MobileCustomPdfZoomFallbackReason])[];

function mobilePlatform(platform: PlatformCapabilityReport): boolean | null {
  if (platform.platform === "desktop") return false;
  if (platform.platform === "ios") {
    if (platform.isPhone !== true) return null;
    return platform.isMobile === true ? true : platform.isMobile === false ? false : null;
  }
  if (platform.platform !== "android" && platform.platform !== "ipad") return null;
  if (platform.platform === "ipad" && platform.isPhone === true) return null;
  if (platform.isMobile === false) return false;
  return platform.isMobile === true ? true : null;
}

/** Custom PDF navigation owns a page only when host, platform, and page evidence are all current. */
export function planMobileCustomPdfZoom(input: MobileCustomPdfZoomInput): MobileCustomPdfZoomPlan {
  const reasons: MobileCustomPdfZoomFallbackReason[] = [];
  if (!input.enabled) reasons.push("setting-disabled");
  if (input.surfaceType !== "pdf") reasons.push("non-pdf-surface");
  const mobile = mobilePlatform(input.platform);
  if (mobile === false) reasons.push("platform-not-mobile");
  else if (mobile === null) reasons.push("platform-unknown");
  if (input.platform.runtime.pointerEvents !== "available") reasons.push("pointer-events-unavailable");
  if (input.platform.runtime.touchEvents !== "available") reasons.push("touch-events-unavailable");
  for (const [capability, reason] of requiredProfileCapabilities) {
    if (input.profile.capabilities[capability] !== true) reasons.push(reason);
  }
  if (input.page === null) {
    reasons.push("page-elements-unavailable");
  } else {
    if (input.page.geometrySafe === false) reasons.push("page-geometry-unsafe");
    if (input.page.identitySafe === false) reasons.push("page-identity-unsafe");
  }
  const fallbackReasons = [...new Set(reasons)];
  return {
    mode: fallbackReasons.length === 0 ? "custom-mobile" : "native-fallback",
    fallbackReasons
  };
}
