import { getDebugNodeId } from "../dom/debugNodeId";
import {
  PhysicalContactTracker,
  type PhysicalContactRecord,
  type RawPointerContactSample,
  type RawTouchContactEvent,
  type RawTouchPoint
} from "./PhysicalContactTracker";

type PointerEventType = RawPointerContactSample["eventType"];
type TouchEventType = RawTouchContactEvent["eventType"];

const REGISTRATION_SCOPE = "document-capture" as const;
const REGISTRATION_SOURCE = "ViewerInkSession.installPointerProbe" as const;
const SEEN_EVENT_TTL_MS = 30_000;
const MAX_SEEN_EVENTS = 512;
const MAX_DUPLICATE_ANOMALIES = 96;

export interface PhysicalContactCollectorEvent {
  kind: "pointer" | "touch";
  event: PointerEvent | TouchEvent;
  eventType: PointerEventType | TouchEventType;
  collectorId: string;
  ownerId: string;
  sessionId: string;
  viewerGeneration: number;
  sessionGeneration: number;
  observerOwnerIds: readonly string[];
  alreadySeen: boolean;
  shouldLog: boolean;
  records: readonly PhysicalContactRecord[];
  pointerId: number | null;
  pointerContactId: string | null;
  touchIdentifiers: readonly number[];
  chosenPhysicalContactId: string | null;
  registrationScope: typeof REGISTRATION_SCOPE;
  registrationSource: typeof REGISTRATION_SOURCE;
}

export interface PhysicalContactDuplicateObserver {
  collectorId: string;
  ownerCollectorId: string;
  duplicateCollectorIds: readonly string[];
  duplicateObserverOwnerIds: readonly string[];
  sessionId: string;
  viewerGeneration: number;
  sessionGeneration: number;
  eventType: string;
  pointerId: number | null;
  touchIdentifiers: readonly number[];
  eventTimeStamp: number;
  targetId: number | null;
  alreadySeen: boolean;
  chosenPhysicalContactId: string | null;
  physicalContactIds: readonly string[];
  registrationScope: typeof REGISTRATION_SCOPE;
  registrationSource: typeof REGISTRATION_SOURCE;
}

export interface PhysicalContactCollectorOwner {
  ownerId: string;
  sessionId: string;
  viewerGeneration: number;
  isEnabled(): boolean;
  withinTarget(target: EventTarget | null): boolean;
  onPhysicalContactEvent(event: PhysicalContactCollectorEvent): void;
  onPhysicalContactDuplicate(details: PhysicalContactDuplicateObserver): void;
}

export interface PhysicalContactCollectorOwnerSnapshot {
  ownerId: string;
  sessionId: string;
  viewerGeneration: number;
}

export interface PhysicalContactCollectorSnapshot {
  collectorId: string;
  listenerRegistered: boolean;
  registrationScope: typeof REGISTRATION_SCOPE;
  registrationSource: typeof REGISTRATION_SOURCE;
  activeContactCount: number;
  activeOwnerCount: number;
  ownerIds: readonly string[];
  owners: readonly PhysicalContactCollectorOwnerSnapshot[];
}

export interface PhysicalContactCollectorLease {
  readonly collectorId: string;
  readonly ownerId: string;
  snapshot(): PhysicalContactCollectorSnapshot;
  release(): void;
}

const collectorsByDocument = new WeakMap<Document, PhysicalContactCollector>();
let nextCollectorId = 1;

export function acquirePhysicalContactCollector(
  document: Document,
  owner: PhysicalContactCollectorOwner
): PhysicalContactCollectorLease {
  let collector = collectorsByDocument.get(document);
  if (!collector) {
    collector = new PhysicalContactCollector(document);
    collectorsByDocument.set(document, collector);
  }
  return collector.acquire(owner, () => {
    if (collectorsByDocument.get(document) === collector) collectorsByDocument.delete(document);
  });
}

export function getPhysicalContactCollectorSnapshot(
  document: Document
): PhysicalContactCollectorSnapshot | null {
  return collectorsByDocument.get(document)?.snapshot() ?? null;
}

class PhysicalContactCollector {
  readonly collectorId = `physical-contact-collector-${nextCollectorId++}`;
  private readonly abort = new AbortController();
  private readonly tracker = new PhysicalContactTracker(`physical-contact-${this.collectorId}`);
  private readonly owners = new Map<string, PhysicalContactCollectorOwner>();
  private readonly seenEvents = new WeakSet<Event>();
  private readonly seenKeys = new Map<string, number>();
  private readonly duplicateAnomalies = new Map<string, number>();

  constructor(private readonly document: Document) {
    const captureOptions = { capture: true, signal: this.abort.signal };
    document.addEventListener("pointerdown", (event) => this.handlePointer(event, "pointerdown"), { ...captureOptions, passive: false });
    document.addEventListener("pointermove", (event) => this.handlePointer(event, "pointermove"), { ...captureOptions, passive: true });
    document.addEventListener("pointerup", (event) => this.handlePointer(event, "pointerup"), captureOptions);
    document.addEventListener("pointercancel", (event) => this.handlePointer(event, "pointercancel"), captureOptions);
    document.addEventListener("touchstart", (event) => this.handleTouch(event, "touchstart"), { ...captureOptions, passive: true });
    document.addEventListener("touchmove", (event) => this.handleTouch(event, "touchmove"), { ...captureOptions, passive: true });
    document.addEventListener("touchend", (event) => this.handleTouch(event, "touchend"), { ...captureOptions, passive: true });
    document.addEventListener("touchcancel", (event) => this.handleTouch(event, "touchcancel"), { ...captureOptions, passive: true });
  }

  acquire(owner: PhysicalContactCollectorOwner, onEmpty: () => void): PhysicalContactCollectorLease {
    this.owners.set(owner.ownerId, owner);
    let released = false;
    return {
      collectorId: this.collectorId,
      ownerId: owner.ownerId,
      snapshot: () => this.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        this.owners.delete(owner.ownerId);
        if (this.owners.size === 0) {
          this.abort.abort();
          onEmpty();
        }
      }
    };
  }

  snapshot(): PhysicalContactCollectorSnapshot {
    const owners = [...this.owners.values()].map(({ ownerId, sessionId, viewerGeneration }) => ({
      ownerId,
      sessionId,
      viewerGeneration
    }));
    return {
      collectorId: this.collectorId,
      listenerRegistered: !this.abort.signal.aborted,
      registrationScope: REGISTRATION_SCOPE,
      registrationSource: REGISTRATION_SOURCE,
      activeContactCount: this.tracker.activeContactCount,
      activeOwnerCount: owners.length,
      ownerIds: owners.map(({ ownerId }) => ownerId),
      owners
    };
  }

  private handlePointer(event: PointerEvent, eventType: PointerEventType): void {
    const observers = this.activeObservers(event.target);
    const selected = this.selectOwner(observers);
    if (!selected) return;
    const alreadySeen = this.markSeen(event, this.pointerKey(event, eventType));
    const now = Date.now();
    const records = alreadySeen
      ? []
      : this.processPointer(now, selected, event, eventType);
    const pointerContactId = this.tracker.pointerContactId(event.pointerId);
    const chosenPhysicalContactId = records.at(-1)?.contact.physicalContactId ?? pointerContactId;
    this.dispatch({
      kind: "pointer",
      event,
      eventType,
      selected,
      observers,
      alreadySeen,
      records,
      pointerId: event.pointerId,
      pointerContactId,
      touchIdentifiers: [],
      chosenPhysicalContactId,
      eventTimeStamp: event.timeStamp
    });
  }

  private handleTouch(event: TouchEvent, eventType: TouchEventType): void {
    const observers = this.activeObservers(event.target);
    const selected = this.selectOwner(observers);
    if (!selected) return;
    const identifiers = [...event.changedTouches].map((touch) => touch.identifier);
    const alreadySeen = this.markSeen(event, this.touchKey(event, eventType, identifiers));
    const now = Date.now();
    const records = alreadySeen
      ? []
      : this.processTouch(now, selected, event, eventType);
    const touchContactIds = identifiers
      .map((identifier) => this.tracker.touchContactId(identifier))
      .filter((id): id is string => id !== null);
    const chosenPhysicalContactId = records.at(-1)?.contact.physicalContactId ?? touchContactIds[0] ?? null;
    this.dispatch({
      kind: "touch",
      event,
      eventType,
      selected,
      observers,
      alreadySeen,
      records,
      pointerId: null,
      pointerContactId: null,
      touchIdentifiers: identifiers,
      chosenPhysicalContactId,
      eventTimeStamp: event.timeStamp
    });
  }

  private processPointer(
    now: number,
    owner: PhysicalContactCollectorOwner,
    event: PointerEvent,
    eventType: PointerEventType
  ): PhysicalContactRecord[] {
    const sample = rawPointerContactSample(event, eventType);
    const expired = this.tracker.expire(now);
    const current = eventType === "pointerdown"
      ? this.tracker.pointerDown(now, sample)
      : eventType === "pointermove"
        ? this.tracker.pointerMove(now, sample)
        : this.tracker.pointerEnd(now, sample);
    void owner;
    return [...expired, ...current];
  }

  private processTouch(
    now: number,
    owner: PhysicalContactCollectorOwner,
    event: TouchEvent,
    eventType: TouchEventType
  ): PhysicalContactRecord[] {
    const raw = rawTouchContactEvent(event, eventType);
    const expired = this.tracker.expire(now);
    const current = eventType === "touchstart"
      ? this.tracker.touchStart(now, raw)
      : eventType === "touchmove"
        ? this.tracker.touchMove(now, raw)
        : this.tracker.touchEnd(now, raw);
    void owner;
    return [...expired, ...current];
  }

  private dispatch(args: {
    kind: "pointer" | "touch";
    event: PointerEvent | TouchEvent;
    eventType: PointerEventType | TouchEventType;
    selected: PhysicalContactCollectorOwner;
    observers: readonly PhysicalContactCollectorOwner[];
    alreadySeen: boolean;
    records: readonly PhysicalContactRecord[];
    pointerId: number | null;
    pointerContactId: string | null;
    touchIdentifiers: readonly number[];
    chosenPhysicalContactId: string | null;
    eventTimeStamp: number;
  }): void {
    const observerOwnerIds = [...this.owners.keys()];
    const duplicateObserverOwnerIds = args.observers
      .filter((owner) => owner !== args.selected)
      .map(({ ownerId }) => ownerId);
    if (args.alreadySeen || duplicateObserverOwnerIds.length > 0) {
      const anomalyKey = this.anomalyKey(args.eventType, args.pointerId, args.touchIdentifiers, args.eventTimeStamp, args.event.target);
      if (!this.duplicateAnomalies.has(anomalyKey)) {
        this.duplicateAnomalies.set(anomalyKey, Date.now());
        this.trimMap(this.duplicateAnomalies, MAX_DUPLICATE_ANOMALIES);
        args.selected.onPhysicalContactDuplicate({
          collectorId: this.collectorId,
          ownerCollectorId: args.selected.ownerId,
          duplicateCollectorIds: duplicateObserverOwnerIds.length > 0 ? duplicateObserverOwnerIds : [this.collectorId],
          duplicateObserverOwnerIds,
          sessionId: args.selected.sessionId,
          viewerGeneration: args.selected.viewerGeneration,
          sessionGeneration: args.selected.viewerGeneration,
          eventType: args.eventType,
          pointerId: args.pointerId,
          touchIdentifiers: args.touchIdentifiers,
          eventTimeStamp: args.eventTimeStamp,
          targetId: getDebugNodeId(args.event.target),
          alreadySeen: args.alreadySeen,
          chosenPhysicalContactId: args.chosenPhysicalContactId,
          physicalContactIds: uniqueContactIds(args.records, args.chosenPhysicalContactId),
          registrationScope: REGISTRATION_SCOPE,
          registrationSource: REGISTRATION_SOURCE
        });
      }
    }

    for (const owner of this.owners.values()) {
      owner.onPhysicalContactEvent({
        kind: args.kind,
        event: args.event,
        eventType: args.eventType,
        collectorId: this.collectorId,
        ownerId: args.selected.ownerId,
        sessionId: args.selected.sessionId,
        viewerGeneration: args.selected.viewerGeneration,
        sessionGeneration: args.selected.viewerGeneration,
        observerOwnerIds,
        alreadySeen: args.alreadySeen,
        shouldLog: owner === args.selected && !args.alreadySeen,
        records: args.records,
        pointerId: args.pointerId,
        pointerContactId: args.pointerContactId,
        touchIdentifiers: args.touchIdentifiers,
        chosenPhysicalContactId: args.chosenPhysicalContactId,
        registrationScope: REGISTRATION_SCOPE,
        registrationSource: REGISTRATION_SOURCE
      });
    }
  }

  private activeObservers(target: EventTarget | null): PhysicalContactCollectorOwner[] {
    return [...this.owners.values()].filter((owner) => owner.isEnabled() && owner.withinTarget(target));
  }

  private selectOwner(observers: readonly PhysicalContactCollectorOwner[]): PhysicalContactCollectorOwner | null {
    return observers.at(-1) ?? [...this.owners.values()].reverse().find((owner) => owner.isEnabled()) ?? null;
  }

  private markSeen(event: Event, key: string): boolean {
    if (this.seenEvents.has(event)) return true;
    const now = Date.now();
    this.pruneSeen(now);
    const alreadySeen = this.seenKeys.has(key);
    this.seenEvents.add(event);
    this.seenKeys.set(key, now);
    this.trimMap(this.seenKeys, MAX_SEEN_EVENTS);
    return alreadySeen;
  }

  private pruneSeen(now: number): void {
    for (const [key, seenAt] of this.seenKeys) {
      if (now - seenAt > SEEN_EVENT_TTL_MS) this.seenKeys.delete(key);
    }
  }

  private pointerKey(event: PointerEvent, eventType: PointerEventType): string {
    return this.anomalyKey(eventType, event.pointerId, [], event.timeStamp, event.target);
  }

  private touchKey(event: TouchEvent, eventType: TouchEventType, identifiers: readonly number[]): string {
    return this.anomalyKey(eventType, null, identifiers, event.timeStamp, event.target);
  }

  private anomalyKey(
    eventType: string,
    pointerId: number | null,
    touchIdentifiers: readonly number[],
    eventTimeStamp: number,
    target: EventTarget | null
  ): string {
    return [
      eventType,
      pointerId ?? "-",
      touchIdentifiers.join(","),
      eventTimeStamp,
      getDebugNodeId(target) ?? "-"
    ].join("|");
  }

  private trimMap(map: Map<string, number>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}

function rawPointerContactSample(event: PointerEvent, eventType: PointerEventType): RawPointerContactSample {
  return {
    eventType,
    timeStamp: event.timeStamp,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    pressure: event.pressure,
    width: event.width,
    height: event.height,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    buttons: event.buttons,
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    targetId: getDebugNodeId(event.target),
    composedPath: physicalComposedPath(event),
    eventPhase: event.eventPhase,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented
  };
}

function rawTouchContactEvent(event: TouchEvent, eventType: TouchEventType): RawTouchContactEvent {
  const changedCount = event.changedTouches.length;
  const toPoint = (touch: Touch): RawTouchPoint => ({
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    pageX: touch.pageX,
    pageY: touch.pageY,
    radiusX: touch.radiusX,
    radiusY: touch.radiusY,
    force: touch.force
  });
  const activeTouches = [...event.touches].slice(0, 8).map(toPoint);
  const changedTouches = [...event.changedTouches].slice(0, 8).map(toPoint);
  const touches = changedTouches.map((touch) => ({
    eventType,
    timeStamp: event.timeStamp,
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    radiusX: touch.radiusX,
    radiusY: touch.radiusY,
    force: touch.force,
    touchCount: event.touches.length,
    changedCount,
    activeTouches: activeTouches.map((active) => ({ ...active })),
    changedTouches: changedTouches.map((changed) => ({ ...changed })),
    targetId: getDebugNodeId(event.target),
    composedPath: physicalComposedPath(event)
  }));
  return { eventType, touches };
}

function physicalComposedPath(event: Event): string[] {
  const path = typeof event.composedPath === "function" ? event.composedPath().slice(0, 12) : [];
  return path.map((entry) => entry instanceof Element ? String(getDebugNodeId(entry)) : Object.prototype.toString.call(entry));
}

function uniqueContactIds(records: readonly PhysicalContactRecord[], chosen: string | null): string[] {
  const ids = records.map(({ contact }) => contact.physicalContactId);
  if (chosen) ids.push(chosen);
  return [...new Set(ids)];
}
