import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePhysicalContactCollector,
  getPhysicalContactCollectorSnapshot,
  type PhysicalContactCollectorEvent,
  type PhysicalContactDuplicateObserver
} from "../src/input/PhysicalContactCollector";

interface TestOwner {
  events: PhysicalContactCollectorEvent[];
  duplicates: PhysicalContactDuplicateObserver[];
  release: () => void;
}

const ownedDocuments: Document[] = [];

afterEach(() => {
  for (const document of ownedDocuments) document.body.replaceChildren();
  ownedDocuments.length = 0;
});

function createDocument(): { document: Document; target: HTMLElement } {
  const document = window.document.implementation.createHTMLDocument("physical-contact-test");
  const target = document.createElement("div");
  target.className = "page";
  document.body.append(target);
  ownedDocuments.push(document);
  return { document, target };
}

function createOwner(document: Document, target: HTMLElement, ownerId: string, viewerGeneration: number): TestOwner {
  const events: PhysicalContactCollectorEvent[] = [];
  const duplicates: PhysicalContactDuplicateObserver[] = [];
  const lease = acquirePhysicalContactCollector(document, {
    ownerId,
    sessionId: `session-${ownerId}`,
    viewerGeneration,
    isEnabled: () => true,
    withinTarget: (eventTarget) => eventTarget instanceof Element && target.contains(eventTarget),
    onPhysicalContactEvent: (event) => events.push(event),
    onPhysicalContactDuplicate: (details) => duplicates.push(details)
  });
  return { events, duplicates, release: lease.release };
}

function defineEventProperties(event: Event, properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
}

function pointerEvent(
  type: "pointerdown" | "pointerup" | "pointermove" | "pointercancel",
  pointerId: number,
  timeStamp: number,
  clientX = 100,
  clientY = 200
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  defineEventProperties(event, {
    pointerId,
    pointerType: "pen",
    isPrimary: true,
    pressure: type === "pointerup" || type === "pointercancel" ? 0 : 0.8,
    width: 2,
    height: 3,
    tiltX: 0,
    tiltY: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    button: 0,
    clientX,
    clientY,
    timeStamp
  });
  return event as PointerEvent;
}

interface TestTouch {
  identifier: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  pageX: number;
  pageY: number;
  radiusX: number;
  radiusY: number;
  force: number;
}

function touchEvent(
  type: "touchstart" | "touchend" | "touchmove" | "touchcancel",
  identifier: number,
  timeStamp: number,
  clientX = 102,
  clientY = 202
): TouchEvent {
  const point: TestTouch = {
    identifier,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    pageX: clientX,
    pageY: clientY,
    radiusX: 8,
    radiusY: 9,
    force: 0.5
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  defineEventProperties(event, {
    touches: type === "touchend" || type === "touchcancel" ? [] : [point],
    changedTouches: [point],
    timeStamp
  });
  return event as TouchEvent;
}

function dispatch(target: HTMLElement, event: Event): void {
  target.dispatchEvent(event);
}

describe("PhysicalContactCollector", () => {
  it("shares one document listener across owners and deduplicates the same raw event", () => {
    const { document, target } = createDocument();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const first = createOwner(document, target, "viewer-session-1", 1);
    const listenerCountAfterFirstOwner = addEventListener.mock.calls.length;
    const second = createOwner(document, target, "viewer-session-2", 2);

    const firstSnapshot = getPhysicalContactCollectorSnapshot(document);
    expect(firstSnapshot).toMatchObject({
      listenerRegistered: true,
      activeOwnerCount: 2,
      owners: [
        { ownerId: "viewer-session-1", viewerGeneration: 1 },
        { ownerId: "viewer-session-2", viewerGeneration: 2 }
      ]
    });
    expect(addEventListener.mock.calls.length).toBe(listenerCountAfterFirstOwner);

    const down = pointerEvent("pointerdown", 309615810, 22851);
    dispatch(target, down);
    dispatch(target, down);
    dispatch(target, pointerEvent("pointerdown", 309615810, 22851));

    expect(first.events.filter((event) => event.shouldLog)).toHaveLength(0);
    const started = second.events.filter((event) => event.shouldLog && event.eventType === "pointerdown");
    expect(started).toHaveLength(1);
    expect(started[0]?.records).toHaveLength(1);
    expect(started[0]?.records[0]?.contact.physicalContactId).toContain(firstSnapshot?.collectorId);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]).toMatchObject({
      ownerCollectorId: "viewer-session-2",
      duplicateObserverOwnerIds: ["viewer-session-1"],
      pointerId: 309615810,
      eventTimeStamp: 22851,
      alreadySeen: false
    });
    expect(second.events.filter((event) => event.alreadySeen)).toHaveLength(2);
    expect(second.events.filter((event) => event.alreadySeen && event.shouldLog)).toHaveLength(0);

    dispatch(target, pointerEvent("pointerup", 309615810, 22852));
    expect(second.events.filter((event) => event.eventType === "pointerup" && event.records.length > 0)).toHaveLength(1);

    dispatch(target, pointerEvent("pointerdown", 309615811, 22853));
    dispatch(target, pointerEvent("pointerup", 309615811, 22854));
    const contactIds = second.events
      .flatMap((event) => event.records)
      .filter(({ phase }) => phase === "start")
      .map(({ contact }) => contact.physicalContactId);
    expect(new Set(contactIds).size).toBe(2);

    second.release();
    first.release();
    expect(getPhysicalContactCollectorSnapshot(document)).toBeNull();
    const staleEventCount = first.events.length + second.events.length;
    dispatch(target, pointerEvent("pointerdown", 309615811, 22853));
    expect(first.events.length + second.events.length).toBe(staleEventCount);
  });

  it("keeps paired PointerEvent and TouchEvent streams in one lifecycle", () => {
    const { document, target } = createDocument();
    const owner = createOwner(document, target, "viewer-session-paired", 3);

    dispatch(target, pointerEvent("pointerdown", 77, 100, 100, 200));
    dispatch(target, touchEvent("touchstart", 77, 110, 102, 202));
    dispatch(target, pointerEvent("pointerup", 77, 120, 104, 204));
    dispatch(target, touchEvent("touchend", 77, 130, 104, 204));

    const records = owner.events.flatMap((event) => event.records);
    const starts = records.filter(({ phase }) => phase === "start");
    const terminals = records.filter(({ phase }) => phase === "terminal");
    expect(starts).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.contact.physicalContactId).toBe(starts[0]?.contact.physicalContactId);
    expect(terminals[0]?.contact.representation).toBe("paired-pen-touch");
    expect(terminals[0]?.contact.classification).toBe("paired");
    expect(terminals[0]?.contact.pairedStreams).toBe(true);
    owner.release();
  });

  it("uses one collector for multiple page owners in the same document", () => {
    const { document, target: firstPage } = createDocument();
    const secondPage = document.createElement("div");
    secondPage.className = "page";
    document.body.append(secondPage);
    const first = createOwner(document, firstPage, "viewer-page-1", 6);
    const second = createOwner(document, secondPage, "viewer-page-2", 6);

    const snapshot = getPhysicalContactCollectorSnapshot(document);
    expect(snapshot?.activeOwnerCount).toBe(2);
    expect(snapshot?.owners).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: "viewer-page-1", viewerGeneration: 6 }),
      expect.objectContaining({ ownerId: "viewer-page-2", viewerGeneration: 6 })
    ]));

    dispatch(firstPage, pointerEvent("pointerdown", 201, 201));
    dispatch(firstPage, pointerEvent("pointerup", 201, 202));
    dispatch(secondPage, pointerEvent("pointerdown", 202, 203));
    dispatch(secondPage, pointerEvent("pointerup", 202, 204));

    expect(first.events.filter((event) => event.shouldLog && event.records.length > 0)).toHaveLength(2);
    expect(second.events.filter((event) => event.shouldLog && event.records.length > 0)).toHaveLength(2);
    first.release();
    second.release();
  });

  it("retires the old document collector before a replacement owner attaches", () => {
    const firstDocument = createDocument();
    const first = createOwner(firstDocument.document, firstDocument.target, "viewer-session-old", 4);
    const oldCollectorId = getPhysicalContactCollectorSnapshot(firstDocument.document)?.collectorId;
    first.release();
    expect(getPhysicalContactCollectorSnapshot(firstDocument.document)).toBeNull();

    const replacementDocument = createDocument();
    const replacement = createOwner(replacementDocument.document, replacementDocument.target, "viewer-session-new", 5);
    const newCollectorId = getPhysicalContactCollectorSnapshot(replacementDocument.document)?.collectorId;
    expect(newCollectorId).not.toBe(oldCollectorId);

    dispatch(firstDocument.target, pointerEvent("pointerdown", 1, 1));
    dispatch(replacementDocument.target, pointerEvent("pointerdown", 1, 1));
    expect(first.events).toHaveLength(0);
    expect(replacement.events.filter((event) => event.shouldLog && event.records.length > 0)).toHaveLength(1);
    const replacementId = replacement.events.find((event) => event.records.length > 0)?.records[0]?.contact.physicalContactId;
    expect(replacementId).toContain(newCollectorId);
    replacement.release();
  });
});
