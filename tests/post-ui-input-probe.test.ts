import { describe, expect, it } from "vitest";
import { PostUiInputProbe } from "../src/input/PostUiInputProbe";

const context = {
  sessionId: "session-1",
  viewerGeneration: 4,
  pageGeneration: 12,
  mountedPages: [1, 2],
  documentPath: "Notes/example.pdf",
  transition: { kind: "modal", reason: "active-to-closed" }
};

describe("PostUiInputProbe", () => {
  it("reports missing Pencil input when the bounded window expires without a pen document event", () => {
    const probe = new PostUiInputProbe();
    probe.arm(100, context);
    probe.pointerDown(120, 1, "touch");

    const results = probe.expire(1_601);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        correlationId: null,
        outcome: "post-ui-pen-missing-before-document-listener",
        pointerDownCount: 1,
        observedPointerTypes: ["touch"]
      })
    ]));
  });

  it("correlates a successful pen stroke through document, router, claim, and terminal stages", () => {
    const probe = new PostUiInputProbe();
    const armed = probe.arm(1_000, context);
    const contact = probe.pointerDown(1_010, 7, "pen");
    expect(contact?.correlationId).toBe(`${armed.armId}-contact-1`);
    probe.stage(1_011, 7, "hit-test", { page: 2, safeRecoveryPage: 2 });
    probe.stage(1_012, 7, "router-received", { page: 2, routerGeneration: 12 });
    probe.stage(1_013, 7, "route", { route: "draw", routeReason: "stylus-draw" });
    probe.stage(1_014, 7, "claim", { captureSucceeded: true });
    probe.stage(1_015, 7, "stroke-start", { page: 2 });

    const result = probe.finish(1_040, 7, "pointerup", {
      page: 2,
      visibleStrokePoints: 18,
      persistedStrokePoints: null
    });

    expect(result).toMatchObject({
      armId: armed.armId,
      correlationId: `${armed.armId}-contact-1`,
      outcome: "post-ui-pen-success",
      contact: expect.objectContaining({
        pointerType: "pen",
        route: "draw",
        routeReason: "stylus-draw",
        page: 2,
        routerGeneration: 12,
        strokeStarted: true,
        terminal: "pointerup"
      }),
      details: expect.objectContaining({ visibleStrokePoints: 18 })
    });
  });

  it.each([
    ["post-ui-pen-missed-page-router", (probe: PostUiInputProbe) => {
      probe.pointerDown(1_010, 2, "pen");
    }],
    ["post-ui-pen-ui-occluded", (probe: PostUiInputProbe) => {
      probe.pointerDown(1_010, 2, "pen");
      probe.stage(1_011, 2, "hit-test", { pageOccludedByUi: true, occluded: true });
    }],
    ["post-ui-pen-routed-native", (probe: PostUiInputProbe) => {
      probe.pointerDown(1_010, 2, "pen");
      probe.stage(1_011, 2, "router-received", { page: 1, routerGeneration: 3 });
      probe.stage(1_012, 2, "route", { route: "native", routeReason: "annotation-policy" });
    }],
    ["post-ui-pen-entered-pan", (probe: PostUiInputProbe) => {
      probe.pointerDown(1_010, 2, "pen");
      probe.stage(1_011, 2, "router-received", { page: 1 });
      probe.stage(1_012, 2, "pan", { accepted: true, scrollBefore: 10, scrollAfter: 30 });
    }],
    ["post-ui-pen-stale-router", (probe: PostUiInputProbe) => {
      probe.pointerDown(1_010, 2, "pen");
      probe.stage(1_011, 2, "router-rejected", { staleRouter: true });
    }]
  ] as const)("classifies %s", (expected, setup) => {
    const probe = new PostUiInputProbe();
    probe.arm(1_000, context);
    setup(probe);

    const result = probe.expire(2_501).find((candidate) => candidate.contact?.pointerType === "pen");

    expect(result?.outcome).toBe(expected);
  });

  it("correlates an unarmed document Pencil contact through router handoff and native evidence", () => {
    const probe = new PostUiInputProbe();
    const contact = probe.observeDocument(2_000, 42, "pen", {
      page: 3,
      targetWithinPage: false,
      targetWithinOverlay: false,
      fallbackConsidered: true,
      fallbackEligible: true
    });
    expect(contact?.correlationId).toBe("pen-routing-1");
    probe.handoffStage(2_001, 42, "router-received", { page: 3, routerGeneration: 19 });
    probe.handoffStage(2_002, 42, "route", { route: "draw", routeReason: "stylus-draw" });
    probe.handoffStage(2_003, 42, "native-evidence", { nativeMovementObserved: false, maxScrollDeltaPx: 0 });
    const result = probe.finishHandoff(2_010, 42, "pointerup", "post-ui-pen-success", { persistedStrokePoints: 8 });

    expect(result).toMatchObject({
      correlationId: "pen-routing-1",
      outcome: "post-ui-pen-success",
      contact: expect.objectContaining({
        routerReceived: true,
        page: 3,
        routerGeneration: 19,
        nativeScrollDeltaPx: 0,
        terminal: "pointerup"
      }),
      details: expect.objectContaining({ persistedStrokePoints: 8 })
    });
  });

  it("preserves a document-only Pencil outcome when same-dispatch fallback is rejected", () => {
    const probe = new PostUiInputProbe();
    probe.observeDocument(4_000, 9, "pen", { page: 1, fallbackRejected: true });
    probe.handoffStage(4_001, 9, "fallback", {
      fallbackConsidered: true,
      fallbackEligible: false,
      fallbackRejected: true,
      fallbackRejectedReason: "same-dispatch-no-router"
    });

    expect(probe.finishHandoff(4_002, 9, "pointerdown", "pen-seen-document-not-router"))
      .toMatchObject({
        outcome: "pen-seen-document-not-router",
        contact: expect.objectContaining({
          documentSeen: true,
          routerReceived: false,
          fallbackEligible: false,
          fallbackRejectedReason: "same-dispatch-no-router"
        })
      });
  });

  it("bounds contacts and pointer-down accounting without logging move-like state", () => {
    const probe = new PostUiInputProbe();
    probe.arm(0, context);
    for (let pointerId = 1; pointerId <= 10; pointerId += 1) probe.pointerDown(pointerId, pointerId, "pen");

    const results = probe.expire(PostUiInputProbe.WINDOW_MS + 1);

    expect(results[0]?.pointerDownCount).toBe(PostUiInputProbe.MAX_POINTER_DOWNS);
    expect(results[0]?.contactCount).toBe(PostUiInputProbe.MAX_POINTER_DOWNS);
    expect(results.map((result) => result.contact?.pointerId).filter((id): id is number => id !== undefined)).toEqual([1, 2, 3, 4]);
  });

  it("reports claim failure and cancellation before ink", () => {
    const probe = new PostUiInputProbe();
    probe.arm(0, context);
    probe.pointerDown(1, 8, "pen");
    probe.stage(2, 8, "router-received", { page: 1 });
    probe.stage(3, 8, "route", { route: "draw", routeReason: "stylus-draw" });
    probe.stage(4, 8, "claim", { claimFailed: true });
    expect(probe.finish(5, 8, "pointercancel")?.outcome).toBe("post-ui-pen-claim-failed");

    const second = new PostUiInputProbe();
    second.arm(0, context);
    second.pointerDown(1, 9, "pen");
    second.stage(2, 9, "router-received", { page: 1 });
    second.stage(3, 9, "route", { route: "draw", routeReason: "stylus-draw" });
    second.stage(4, 9, "claim", { captureSucceeded: true });
    expect(second.finish(5, 9, "pointercancel")?.outcome).toBe("post-ui-pen-cancelled-before-ink");
  });
});
