import type { PhysicalContactCollectorSnapshot } from "../input/PhysicalContactCollector";

/** Bounded plugin-level state used when the active PDF has no session object. */
export interface HandwritingSessionRegistrySnapshot {
  pdfLeafCount: number;
  sessions: number;
  attachingLeaves: number;
  activePdfPath: string | null;
  expectedPdfSession: boolean;
  activeSessionFound: boolean;
  viewerShellCount: number;
  handwritingToolbarCount: number;
  handwritingRailCount: number;
  physicalContactCollectors?: readonly PhysicalContactCollectorSnapshot[];
  /** Kept optional because stale collectors are only knowable while a session exists. */
  staleCollectorCount?: number | null;
  documentInputCollectorCount?: number;
  documentInputCollectorIds?: string[];
  documentInputOwners?: Array<Record<string, unknown>>;
}

export function missingHandwritingSession(
  snapshot: HandwritingSessionRegistrySnapshot
): boolean {
  return snapshot.expectedPdfSession && !snapshot.activeSessionFound;
}

/**
 * A visible supported PDF with no registered session is an attach invariant
 * failure. Keep this stricter than `missingHandwritingSession` so a transient
 * pre-viewer state is diagnosed without forcing an attach storm.
 */
export function needsMissingHandwritingSessionRecovery(
  snapshot: HandwritingSessionRegistrySnapshot
): boolean {
  return snapshot.pdfLeafCount > 0
    && snapshot.viewerShellCount > 0
    && snapshot.expectedPdfSession
    && snapshot.sessions === 0
    && snapshot.attachingLeaves === 0
    && !snapshot.activeSessionFound;
}

export interface MissingHandwritingSessionRecoveryWake {
  key: string;
  retryDelayMs: number | null;
}

/**
 * Return one bounded wake for a settled visible-PDF/session-absent state.
 * The caller supplies the current attach cooldown so a recovery wake never
 * turns backoff into a zero-delay attach loop.
 */
export function missingHandwritingSessionRecoveryWake(
  snapshot: HandwritingSessionRegistrySnapshot,
  previousKey: string,
  retryDelayMs: number | null
): MissingHandwritingSessionRecoveryWake | null {
  if (!needsMissingHandwritingSessionRecovery(snapshot) || !snapshot.activePdfPath) return null;
  const key = JSON.stringify(snapshot);
  if (key === previousKey) return null;
  return { key, retryDelayMs };
}

export function handwritingSessionMissingPayload(
  snapshot: HandwritingSessionRegistrySnapshot
): Record<string, unknown> {
  return {
    ...snapshot,
    viewerPresent: snapshot.viewerShellCount > 0,
    toolbarPresent: snapshot.handwritingToolbarCount > 0,
    ...(snapshot.physicalContactCollectors ? { physicalContactCollectors: snapshot.physicalContactCollectors } : {}),
    ...(snapshot.staleCollectorCount !== undefined ? { staleCollectorCount: snapshot.staleCollectorCount } : {})
  };
}
