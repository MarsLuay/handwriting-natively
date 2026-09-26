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

    expect(results).toEqual([
      expect.objectContaining({
        correlationId: null,
        outcome: "post-ui-probe-expired-no-pen",
        pointerDownCount: 1,
        observedPointerTypes: ["touch"],
        details: expect.objectContaining({ penObserved: false, contactCount: 1 })
      })
    ]);
    expect(results.some(({ outcome }) => outcome.startsWith("post-ui-pen-"))).toBe(false);
  });

  it("reports a neutral expiry when no pointer input arrives", () => {
    const probe = new PostUiInputProbe();
    probe.arm(100, context);

    const [result] = probe.expire(1_601);

    expect(result).toMatchObject({
      outcome: "post-ui-probe-expired-no-pen",
      pointerDownCount: 0,
      observedPointerTypes: [],
      contactCount: 0,
      details: expect.objectContaining({ penObserved: false, contactCount: 0 })
    });
  });

  it("keeps repeated touch-only contacts out of Pencil failure outcomes", () => {
    const probe = new PostUiInputProbe();
    probe.arm(100, context);
    probe.pointerDown(120, 1, "touch");
    probe.pointerDown(130, 2, "touch");

    const results = probe.expire(1_601);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: "post-ui-probe-expired-no-pen",
      observedPointerTypes: ["touch"],
      contactCount: 2
    });
  });

  it("does not emit a Pencil terminal outcome for a touch contact that ends before expiry", () => {
    const probe = new PostUiInputProbe();
    probe.arm(1_000, context);
    probe.pointerDown(1_010, 7, "touch");

    expect(probe.finish(1_040, 7, "pointerup")).toBeNull();
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

  it("keeps touch context while a mixed window classifies only the real pen contact", () => {
    const probe = new PostUiInputProbe();
    probe.arm(1_000, context);
    probe.pointerDown(1_010, 1, "touch");
    probe.pointerDown(1_020, 2, "pen");

    const [result] = probe.expire(2_501);

    expect(result).toMatchObject({
      outcome: "post-ui-pen-missed-page-router",
      observedPointerTypes: ["touch", "pen"],
      contactCount: 2,
      contact: expect.objectContaining({ pointerType: "pen" })
    });
    expect(result?.outcome.startsWith("post-ui-pen-")).toBe(true);
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
    expect(contact?.penContactId).toBe("pen-routing-1");
    probe.handoffStage(2_001, 42, "router-received", { page: 3, routerGeneration: 19 });
    probe.handoffStage(2_002, 42, "route", { route: "draw", routeReason: "stylus-draw" });
    probe.handoffStage(2_003, 42, "native-evidence", { nativeMovementObserved: false, maxScrollDeltaPx: 0 });
    const result = probe.finishHandoff(2_010, 42, "pointerup", "post-ui-pen-success", { persistedStrokePoints: 8 });

    expect(result).toMatchObject({
      correlationId: "pen-routing-1",
      penContactId: "pen-routing-1",
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
        penContactId: "pen-routing-1",
        contact: expect.objectContaining({
          documentSeen: true,
          routerReceived: false,
          fallbackEligible: false,
          fallbackRejectedReason: "same-dispatch-no-router"
        })
      });
  });

  it("keeps physical identity, fallback reason, generations, and bounded terminal context", () => {
    const probe = new PostUiInputProbe();
    probe.observeDocument(5_000, 12, "pen", {
      physicalContactId: "physical-contact-9",
      page: 4,
      pageMountGeneration: 22,
      viewerGeneration: 8,
      routerGeneration: 31,
      routerAlive: false,
      routerListenerAborted: true
    });
    for (let index = 0; index < 10; index += 1) {
      probe.handoffStage(5_001 + index, 12, "hit-test", { page: 4, composedPath: ["page-4", "viewer"] });
    }
    probe.handoffStage(5_020, 12, "fallback", {
      fallbackConsidered: true,
      fallbackEligible: false,
      fallbackRejected: true,
      fallbackRejectedReason: "same-dispatch-no-router"
    });

    const result = probe.finishHandoff(5_030, 12, "pointerup");

    expect(result).toMatchObject({
      outcome: "post-ui-pen-fallback-rejected",
      outcomeClass: "routing",
      contact: expect.objectContaining({
        physicalContactId: "physical-contact-9",
        fallbackRejectedReason: "same-dispatch-no-router",
        lastObservedStage: "terminal"
      }),
      details: expect.objectContaining({
        pageMountGeneration: 22,
        viewerGeneration: 8,
        trace: expect.objectContaining({
          physicalContactId: "physical-contact-9",
          fallbackRejectedReason: "same-dispatch-no-router",
          rollingContext: expect.any(Array)
        })
      })
    });
    expect(result?.contact?.rollingContext).toHaveLength(PostUiInputProbe.MAX_TRACE_CONTEXT);
    expect(result?.contact?.rollingContext.at(-2)).toMatchObject({
      stage: "fallback",
      details: expect.objectContaining({ fallbackRejectedReason: "same-dispatch-no-router" })
    });
    expect(result?.contact?.rollingContext.at(-1)?.stage).toBe("terminal");
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

  it("keeps penContactId null for a touch-only contact", () => {
    const probe = new PostUiInputProbe();
    probe.arm(3_000, context);
    const contact = probe.pointerDown(3_010, 11, "touch", { page: 2 });
    expect(contact?.correlationId).toBeTruthy();
    expect(contact?.pointerType).toBe("touch");
    expect(contact?.penContactId).toBeNull();
    const [expired] = probe.expire(3_000 + PostUiInputProbe.WINDOW_MS + 1);
    expect(expired?.penContactId).toBeNull();
    expect(expired?.outcome).toBe("post-ui-probe-expired-no-pen");
  });
});
