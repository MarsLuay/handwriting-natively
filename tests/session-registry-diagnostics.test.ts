import { describe, expect, it } from "vitest";
import {
  handwritingSessionMissingPayload,
  missingHandwritingSession,
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
      staleCollectorCount: 1
    });
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
