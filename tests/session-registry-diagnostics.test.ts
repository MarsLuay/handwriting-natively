import { describe, expect, it } from "vitest";
import {
  handwritingSessionMissingPayload,
  missingHandwritingSession,
  missingHandwritingSessionRecoveryWake,
  needsMissingHandwritingSessionRecovery,
  type HandwritingSessionRegistrySnapshot
} from "../src/runtime/HandwritingSessionRegistry";

describe("handwriting session registry diagnostics", () => {
  it("reports a missing active session even when a stale listener remains", () => {
    const snapshot: HandwritingSessionRegistrySnapshot = {
      pdfLeafCount: 1,
      sessions: 0,
      attachingLeaves: 0,
      activePdfPath: "Notes/example.pdf",
      expectedPdfSession: true,
      activeSessionFound: false,
      viewerShellCount: 1,
      handwritingToolbarCount: 0,
      handwritingRailCount: 0,
      physicalContactCollectors: [{
        collectorId: "physical-contact-collector-1",
        listenerRegistered: true,
        registrationScope: "document-capture",
        registrationSource: "ViewerInkSession.installPointerProbe",
        activeContactCount: 0,
        activeOwnerCount: 1,
        ownerIds: ["viewer-session-1"],
        owners: [{ ownerId: "viewer-session-1", sessionId: "Notes/example.pdf", viewerGeneration: 1 }]
      }],
      staleCollectorCount: 1
    };

    expect(missingHandwritingSession(snapshot)).toBe(true);
    expect(handwritingSessionMissingPayload(snapshot)).toMatchObject({
      activePdfPath: "Notes/example.pdf",
      pdfLeafCount: 1,
      sessions: 0,
      attachingLeaves: 0,
      viewerPresent: true,
      toolbarPresent: false,
      physicalContactCollectors: expect.arrayContaining([
        expect.objectContaining({ collectorId: "physical-contact-collector-1", activeOwnerCount: 1 })
      ]),
      staleCollectorCount: 1
    });
    expect(needsMissingHandwritingSessionRecovery(snapshot)).toBe(true);
  });

  it("does not recover while attachment is already in progress or the viewer is absent", () => {
    const base: HandwritingSessionRegistrySnapshot = {
      pdfLeafCount: 1,
      sessions: 0,
      attachingLeaves: 0,
      activePdfPath: "Notes/example.pdf",
      expectedPdfSession: true,
      activeSessionFound: false,
      viewerShellCount: 1,
      handwritingToolbarCount: 0,
      handwritingRailCount: 0
    };

    expect(needsMissingHandwritingSessionRecovery({ ...base, attachingLeaves: 1 })).toBe(false);
    expect(needsMissingHandwritingSessionRecovery({ ...base, viewerShellCount: 0 })).toBe(false);
    expect(needsMissingHandwritingSessionRecovery({ ...base, sessions: 1 })).toBe(false);
  });

  it("schedules one bounded recovery wake and preserves attach backoff", () => {
    const snapshot: HandwritingSessionRegistrySnapshot = {
      pdfLeafCount: 1,
      sessions: 0,
      attachingLeaves: 0,
      activePdfPath: "Notes/example.pdf",
      expectedPdfSession: true,
      activeSessionFound: false,
      viewerShellCount: 1,
      handwritingToolbarCount: 0,
      handwritingRailCount: 0
    };

    const wake = missingHandwritingSessionRecoveryWake(snapshot, "", null);
    expect(wake).toEqual({ key: JSON.stringify(snapshot), retryDelayMs: null });
    expect(missingHandwritingSessionRecoveryWake(snapshot, wake!.key, null)).toBeNull();
    expect(missingHandwritingSessionRecoveryWake(snapshot, "", 800)).toMatchObject({ retryDelayMs: 800 });
    expect(missingHandwritingSessionRecoveryWake({ ...snapshot, attachingLeaves: 1 }, "", null)).toBeNull();
  });

  it("does not report a missing session when the active PDF is registered", () => {
    expect(missingHandwritingSession({
      pdfLeafCount: 1,
      sessions: 1,
      attachingLeaves: 0,
      activePdfPath: "Notes/example.pdf",
      expectedPdfSession: true,
      activeSessionFound: true,
      viewerShellCount: 1,
      handwritingToolbarCount: 1,
      handwritingRailCount: 1
    })).toBe(false);
  });
});
