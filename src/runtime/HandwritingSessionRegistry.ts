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
  /** Kept optional because stale collectors are only knowable while a session exists. */
  staleCollectorCount?: number | null;
}

export function missingHandwritingSession(
  snapshot: HandwritingSessionRegistrySnapshot
): boolean {
  return snapshot.expectedPdfSession && !snapshot.activeSessionFound;
}

export function handwritingSessionMissingPayload(
  snapshot: HandwritingSessionRegistrySnapshot
): Record<string, unknown> {
  return {
    ...snapshot,
    viewerPresent: snapshot.viewerShellCount > 0,
    toolbarPresent: snapshot.handwritingToolbarCount > 0,
    ...(snapshot.staleCollectorCount !== undefined ? { staleCollectorCount: snapshot.staleCollectorCount } : {})
  };
}
