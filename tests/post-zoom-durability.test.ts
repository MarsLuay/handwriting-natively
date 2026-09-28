import { describe, expect, it } from "vitest";
import { PostZoomInputTrace } from "../src/runtime/PostZoomInputTrace";
import {
  POST_ZOOM_DURABILITY_CONTACT_LIMIT,
  POST_ZOOM_DURABILITY_WINDOW_MS,
  PostZoomDurabilityTrace,
  type PostZoomDurabilityNote
} from "../src/runtime/PostZoomDurabilityTrace";

const settleAt = 1_700_000_000_000;

function contact(overrides: Partial<PostZoomDurabilityNote> & Pick<PostZoomDurabilityNote, "atMs" | "physicalContactId">): PostZoomDurabilityNote {
  return {
    pointerType: "pen",
    pointerEventPenSeen: true,
    pointerEventTouchSeen: false,
    touchEventSeen: false,
    classification: "pen-only",
    pressure: 0.4,
    width: 1,
    height: 1,
    stylusIdentity: "established",
    pageNumber: 1,
    pageMountGeneration: 3,
    pageElementId: 9,
    overlayId: 10,
    routerGeneration: 1,
    routerReceived: true,
    routerRejected: false,
    routerRejectReason: null,
    route: "draw",
    routeReason: "stylus-draw",
    strokeStarted: true,
    strokeEnded: true,
    scrollLeftAtStart: 0,
    scrollTopAtStart: 0,
    scrollLeftAtEnd: 0,
    scrollTopAtEnd: 0,
    nativeScrollDeltaPx: 0,
    panObserved: false,
    panAccepted: null,
    target: "canvas",
    composedPath: ["canvas"],
    touchActionClasses: [],
    activeElement: null,
    ...overrides
  };
}

function pen(id: string, atMs: number): PostZoomDurabilityNote {
  return contact({ physicalContactId: id, atMs });
}

function genericTouch(id: string, atMs: number, overrides: Partial<PostZoomDurabilityNote> = {}): PostZoomDurabilityNote {
  return contact({
    physicalContactId: id,
    atMs,
    pointerType: "touch",
    pointerEventPenSeen: false,
    pointerEventTouchSeen: true,
    touchEventSeen: true,
    classification: "paired",
    pressure: 0,
    width: 62.5305,
    height: 62.5305,
    stylusIdentity: "absent",
    routerReceived: false,
    routerRejected: false,
    routerRejectReason: null,
    route: null,
    routeReason: null,
    strokeStarted: false,
    strokeEnded: false,
    ...overrides
  });
}

function openTrace(): PostZoomDurabilityTrace {
  const trace = new PostZoomDurabilityTrace();
  trace.onZoomBegin("zoom-1");
  trace.onZoomSettle("zoom-1", settleAt);
  return trace;
}

describe("PostZoomDurabilityTrace", () => {
  it("keeps page touches after settle even when the Pencil never returns as pen", () => {
    const trace = openTrace();
    const events = trace.note(genericTouch("page-touch", settleAt + 1_200, {
      nativeScrollDeltaPx: 40,
      panObserved: true,
      composedPath: ["canvas.page", "div.pdf-page"]
    }));
    expect(events).toEqual([]);
    const copy = trace.snapshot(settleAt + 2_000);
    expect(copy.firstSuccessfulPostZoomPenAt).toBeNull();
    expect(copy.contacts).toHaveLength(1);
    expect(copy.contacts[0]).toMatchObject({
      physicalContactId: "page-touch",
      pointerType: "touch",
      nativeScrollDeltaPx: 40,
      composedPath: ["canvas.page", "div.pdf-page"]
    });
    expect(copy.firstLaterGenericTouchAfterPenRecovery).toBeNull();
    expect(copy.firstLaterPageDragAfterPenRecovery).toBeNull();
  });

  it("keeps a later generic touch after three successful pens, separate from the 8-second anomaly", () => {
    const durability = openTrace();
    const immediate = new PostZoomInputTrace();
    immediate.begin();
    immediate.settle(settleAt);
    for (const [index, id] of ["pen-1", "pen-2", "pen-3"].entries()) {
      durability.note(pen(id, settleAt + 400 + index * 300));
      immediate.notePageContact(settleAt + 400 + index * 300, true, id);
    }
    const later = genericTouch("touch-later", settleAt + 120_000);
    const events = durability.note(later);
    expect(immediate.notePageContact(settleAt + 120_000, true, "touch-later")).toBeNull();
    expect(immediate.anomaly({
      overAnnotatablePage: true,
      stylusIdentity: "absent",
      physicalContactId: "touch-later",
      strokeStarted: false,
      routerReceived: false,
      routerRejected: false,
      stalePageBinding: false,
      inputOwnerMismatch: false,
      fallbackRejected: false,
      nativePanWon: false,
      pointerCaptureStale: false
    }, settleAt + 120_000)).toBeNull();

    expect(events).toEqual([expect.objectContaining({
      event: "post-zoom-recovery-regressed",
      previousSuccessfulPenAt: new Date(settleAt + 400).toISOString(),
      currentPointerType: "touch",
      currentStylusIdentity: "absent",
      physicalToolClaimed: false
    })]);
    const copy = durability.snapshot(settleAt + 120_000);
    expect(copy.successfulPenContactsAfterZoom).toBe(3);
    expect(copy.firstLaterGenericTouchAfterPenRecovery).toMatchObject({
      physicalContactId: "touch-later",
      pointerType: "touch",
      pointerEventPenSeen: false,
      physicalToolClaimed: false,
      physicalTool: null,
      width: 62.5305
    });
    expect(copy.firstLaterRouterFailureAfterPenRecovery).toBeNull();
    expect(copy.durabilityWindowExpired).toBe(false);
  });

  it("records a later router failure without calling it a generic touch", () => {
    const trace = openTrace();
    trace.note(pen("pen-1", settleAt + 500));
    const events = trace.note(contact({
      physicalContactId: "pen-miss",
      atMs: settleAt + 50_000,
      strokeStarted: false,
      strokeEnded: false,
      routerReceived: false,
      routerRejected: true,
      routerRejectReason: "inactive-owner",
      route: "ignored",
      routeReason: "inactive-owner"
    }));
    expect(events).toEqual([]);
    const copy = trace.snapshot(settleAt + 50_000);
    expect(copy.firstLaterRouterFailureAfterPenRecovery).toMatchObject({
      physicalContactId: "pen-miss",
      pointerType: "pen",
      stylusIdentity: "established",
      routerReceived: false,
      routerRejected: true,
      routerRejectReason: "inactive-owner",
      route: "ignored",
      routeReason: "inactive-owner"
    });
    expect(copy.firstLaterGenericTouchAfterPenRecovery).toBeNull();
    expect(copy.firstLaterPageDragAfterPenRecovery).toBeNull();
  });

  it("preserves the actual route and reason when a pen reaches the router but does not start", () => {
    for (const [route, routeReason] of [
      ["draw", "stylus-draw"],
      ["edit", "stylus-edit"],
      ["text", "text-tool"],
      ["native", "unsupported-pointer"],
      ["ignored", "already-handled"]
    ] as const) {
      const trace = openTrace();
      trace.note(pen("pen-1", settleAt + 500));
      trace.note(contact({
        physicalContactId: `pen-${route}`,
        atMs: settleAt + 50_000,
        strokeStarted: false,
        strokeEnded: false,
        routerReceived: true,
        routerRejected: false,
        route,
        routeReason
      }));
      expect(trace.snapshot(settleAt + 50_000).contacts.at(-1)).toMatchObject({
        route,
        routeReason,
        routerReceived: true,
        routerRejected: false,
        strokeStarted: false
      });
    }
  });

  it("records a later page drag with scroll delta", () => {
    const trace = openTrace();
    trace.note(pen("pen-1", settleAt + 500));
    const events = trace.note(genericTouch("drag", settleAt + 90_000, {
      scrollLeftAtStart: 10,
      scrollTopAtStart: 20,
      scrollLeftAtEnd: 28,
      scrollTopAtEnd: 20,
      nativeScrollDeltaPx: 18,
      panObserved: true
    }));
    expect(events.map((event) => event.event)).toEqual([
      "post-zoom-recovery-regressed",
      "post-zoom-page-drag-contact"
    ]);
    const drag = events[1];
    expect(drag).toMatchObject({
      event: "post-zoom-page-drag-contact",
      pointerType: "touch",
      routerReceived: false,
      strokeStarted: false,
      nativeScrollDeltaPx: 18,
      panObserved: true,
      physicalToolClaimed: false
    });
    expect(trace.snapshot(settleAt + 90_000).firstLaterPageDragAfterPenRecovery).toMatchObject({
      physicalContactId: "drag",
      nativeScrollDeltaPx: 18,
      scrollLeftAtStart: 10,
      scrollLeftAtEnd: 28
    });
  });

  it("stops accepting contacts after three minutes and still keeps the regression for Copy Logs", () => {
    const trace = openTrace();
    trace.note(pen("pen-1", settleAt + 500));
    trace.note(genericTouch("late", settleAt + 60_000));
    expect(trace.note(genericTouch("too-late", settleAt + POST_ZOOM_DURABILITY_WINDOW_MS + 1))).toEqual([]);
    const copy = trace.snapshot(settleAt + POST_ZOOM_DURABILITY_WINDOW_MS + 5_000);
    expect(copy.durabilityWindowExpired).toBe(true);
    expect(copy.durabilityWindowAgeMs).toBe(POST_ZOOM_DURABILITY_WINDOW_MS + 5_000);
    expect(copy.firstLaterGenericTouchAfterPenRecovery?.physicalContactId).toBe("late");
    expect(copy.contacts.map((entry) => entry.physicalContactId)).toEqual(["pen-1", "late"]);
  });

  it("replaces the active window when the next zoom begins", () => {
    const trace = openTrace();
    trace.note(pen("pen-1", settleAt + 500));
    trace.note(genericTouch("late", settleAt + 60_000));
    trace.onZoomBegin("zoom-2");
    const replaced = trace.snapshot(settleAt + 61_000);
    expect(replaced.zoomBurstId).toBe("zoom-2");
    expect(replaced.zoomSettledAt).toBeNull();
    expect(replaced.contacts).toEqual([]);
    expect(replaced.firstLaterGenericTouchAfterPenRecovery).toBeNull();
    expect(replaced.successfulPenContactsAfterZoom).toBe(0);
    trace.onZoomSettle("zoom-2", settleAt + 70_000);
    trace.note(pen("next-pen", settleAt + 70_500));
    expect(trace.snapshot(settleAt + 70_500).zoomBurstId).toBe("zoom-2");
    expect(trace.snapshot(settleAt + 70_500).successfulPenContactsAfterZoom).toBe(1);
  });

  it("keeps the contact ring bounded", () => {
    const trace = openTrace();
    for (let index = 0; index < POST_ZOOM_DURABILITY_CONTACT_LIMIT + 10; index += 1) {
      trace.note(pen(`pen-${index}`, settleAt + 100 + index));
    }
    const copy = trace.snapshot(settleAt + 1_000);
    expect(copy.contacts).toHaveLength(POST_ZOOM_DURABILITY_CONTACT_LIMIT);
    expect(copy.contacts[0]?.physicalContactId).toBe("pen-10");
    expect(copy.contacts.at(-1)?.physicalContactId).toBe(`pen-${POST_ZOOM_DURABILITY_CONTACT_LIMIT + 9}`);
    expect(copy.successfulPenContactsAfterZoom).toBe(POST_ZOOM_DURABILITY_CONTACT_LIMIT + 10);
    expect(copy.firstSuccessfulPostZoomPenAt).toBe(new Date(settleAt + 100).toISOString());
  });

  it("does not label a finger as Pencil unless the user claims that tool", () => {
    const trace = openTrace();
    trace.note(pen("pen-1", settleAt + 500));
    trace.note(genericTouch("finger", settleAt + 40_000, { classification: "touch-only" }));
    const before = trace.snapshot(settleAt + 40_000).firstLaterGenericTouchAfterPenRecovery;
    expect(before).toMatchObject({
      pointerType: "touch",
      physicalToolClaimed: false,
      physicalTool: null,
      stylusIdentity: "absent"
    });
    trace.claimPhysicalTool("finger", "apple-pencil");
    const after = trace.snapshot(settleAt + 40_000).firstLaterGenericTouchAfterPenRecovery;
    expect(after).toMatchObject({
      pointerType: "touch",
      pointerEventPenSeen: false,
      physicalToolClaimed: true,
      physicalTool: "apple-pencil"
    });
  });
});
