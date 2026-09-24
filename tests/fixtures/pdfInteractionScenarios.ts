export const PDF_INTERACTION_FIXTURE_VERSION = 1 as const;

export type PdfFixtureAdapter = "direct" | "embedded";

export interface PdfInteractionScenario {
  readonly id: string;
  readonly adapters: readonly PdfFixtureAdapter[];
  readonly requiresHardware: false;
  readonly actions: readonly string[];
  readonly assertions: readonly string[];
  readonly coverage: readonly string[];
}

/**
 * Reusable, hardware-independent scenario contract for adapter/session tests.
 * Physical pen latency, palm rejection, and device resume remain manual-only.
 */
export const PDF_INTERACTION_SCENARIOS: readonly PdfInteractionScenario[] = [
  {
    id: "open-write-pan",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["open", "write", "pan", "reopen"],
    assertions: ["sidecar-integrity", "generation-safe-remount", "bounded-diagnostics"],
    coverage: ["tests/runtime-viewer-session.test.ts", "tests/pdf-scroll-root.test.ts"]
  },
  {
    id: "pinch-zoom-and-zoom-fallback",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["pinch", "zoom", "replacement"],
    assertions: ["wet-ink-preserved", "single-settle-paint", "no-inner-layer-remount"],
    coverage: ["tests/zoom-ink-compositing.test.ts", "tests/pdf-zoom-boost.test.ts"]
  },
  {
    id: "erase-and-select",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["write", "erase", "select", "undo", "redo"],
    assertions: ["sidecar-integrity", "selection-command-round-trip"],
    coverage: ["tests/runtime-viewer-session.test.ts", "tests/input-pointer-routing.test.ts"]
  },
  {
    id: "mount-boundary-scroll",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["scroll", "replace-page-shell", "scroll-back"],
    assertions: ["page-generation-revalidation", "active-wet-ink-preserved", "stale-work-cancelled"],
    coverage: ["tests/runtime-viewer-session.test.ts", "tests/pdf-page-locator.test.ts", "tests/select-pages-for-ink-mount.test.ts"]
  },
  {
    id: "sidebar-transition",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["open-sidebar", "resize", "close-sidebar", "zoom"],
    assertions: ["geometry-fallback", "zoom-follow-suppressed", "cleanup"],
    coverage: ["tests/pdf-sidebar-rail-offset.test.ts", "tests/integration-adapters-focus.test.ts"]
  },
  {
    id: "page-actions-restart-export",
    adapters: ["direct", "embedded"],
    requiresHardware: false,
    actions: ["insert-page", "delete-page", "restart", "reopen", "export"],
    assertions: ["sidecar-integrity", "export-reopen", "generation-safe-remount"],
    coverage: ["tests/pdf-page-actions.test.ts", "tests/pdf-page-mutation.test.ts", "tests/core-export.test.ts"]
  }
] as const;
