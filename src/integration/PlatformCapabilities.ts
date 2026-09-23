export type IntegrationPlatform = "desktop" | "android" | "ipad" | "unknown";

export type CapabilityState = "available" | "unavailable" | "unknown";

export type ViewerGraphEra = "obsidian-wrapper" | "raw-pdfjs" | "unknown";

export interface PlatformRuntimeCapabilities {
  pointerEvents?: boolean;
  touchEvents?: boolean;
  mutationObserver?: boolean;
  resizeObserver?: boolean;
}

/**
 * Host-owned values that may be passed into the integration boundary.
 *
 * `platform` is deliberately explicit. User-agent strings and viewport
 * guesses are not reliable evidence for an Obsidian host build, especially
 * for iPad WebViews. Missing values remain unknown in the report.
 */
export interface PlatformCapabilityInput {
  platform?: IntegrationPlatform;
  obsidianVersion?: string;
  isMobile?: boolean;
  isPhone?: boolean;
  viewerGraphEra?: ViewerGraphEra;
  runtime?: PlatformRuntimeCapabilities;
}

export interface PlatformCapabilityReport {
  platform: IntegrationPlatform;
  platformEvidence: "explicit-host-signal" | "unknown";
  obsidianVersion: string | null;
  versionEvidence: "explicit-api-version" | "unknown";
  isMobile: boolean | null;
  isPhone: boolean | null;
  viewerGraphEra: ViewerGraphEra;
  viewerGraphEvidence: "explicit-object-observation" | "version-reference" | "unknown";
  runtime: {
    pointerEvents: CapabilityState;
    touchEvents: CapabilityState;
    mutationObserver: CapabilityState;
    resizeObserver: CapabilityState;
  };
  /** True only when the report contains an explicit platform and API version. */
  isIdentified: boolean;
}

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim();
  return VERSION_PATTERN.test(version) ? version : null;
}

function capabilityState(value: boolean | undefined): CapabilityState {
  if (typeof value !== "boolean") return "unknown";
  return value ? "available" : "unavailable";
}

function runtimeDefaults(): PlatformRuntimeCapabilities {
  if (typeof window !== "object" || window === null) return {};
  const root = window as Window & {
    PointerEvent?: unknown;
    TouchEvent?: unknown;
    MutationObserver?: unknown;
    ResizeObserver?: unknown;
  };
  const view = root;
  return {
    pointerEvents: typeof root.PointerEvent === "function",
    touchEvents: typeof root.TouchEvent === "function" || Boolean(view && "ontouchstart" in view),
    mutationObserver: typeof root.MutationObserver === "function",
    resizeObserver: typeof root.ResizeObserver === "function"
  };
}

function versionViewerGraphEra(version: string | null): ViewerGraphEra {
  if (!version) return "unknown";
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return "unknown";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor >= 8) return "raw-pdfjs";
  if (major === 1 && minor < 8) return "obsidian-wrapper";
  return "unknown";
}

/**
 * Build a diagnostic-only host capability report.
 *
 * This function does not claim that a platform is supported. The adapter still
 * requires a real viewer root and rendered PDF page before attaching. An
 * unidentified platform or version is intentionally represented as unknown so
 * callers can require manual validation instead of silently enabling a guess.
 */
export function probePlatformCapabilities(input: PlatformCapabilityInput = {}): PlatformCapabilityReport {
  const platform = input.platform === "desktop"
    || input.platform === "android"
    || input.platform === "ipad"
    ? input.platform
    : "unknown";
  const version = normalizeVersion(input.obsidianVersion);
  const explicitGraph = input.viewerGraphEra;
  const graph = explicitGraph === "obsidian-wrapper" || explicitGraph === "raw-pdfjs"
    ? explicitGraph
    : versionViewerGraphEra(version);
  const runtime = { ...runtimeDefaults(), ...input.runtime };
  return {
    platform,
    platformEvidence: platform === "unknown" ? "unknown" : "explicit-host-signal",
    obsidianVersion: version,
    versionEvidence: version === null ? "unknown" : "explicit-api-version",
    isMobile: typeof input.isMobile === "boolean" ? input.isMobile : null,
    isPhone: typeof input.isPhone === "boolean" ? input.isPhone : null,
    viewerGraphEra: graph,
    viewerGraphEvidence: explicitGraph
      ? "explicit-object-observation"
      : graph === "unknown" ? "unknown" : "version-reference",
    runtime: {
      pointerEvents: capabilityState(runtime.pointerEvents),
      touchEvents: capabilityState(runtime.touchEvents),
      mutationObserver: capabilityState(runtime.mutationObserver),
      resizeObserver: capabilityState(runtime.resizeObserver)
    },
    isIdentified: platform !== "unknown" && version !== null
  };
}

export class PlatformCapabilities {
  static probe(input: PlatformCapabilityInput = {}): PlatformCapabilityReport {
    return probePlatformCapabilities(input);
  }
}
