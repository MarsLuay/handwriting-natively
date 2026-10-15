import { percentile } from "../logging/PerformanceMetrics";
import { getDebugNodeId } from "../dom/debugNodeId";
import { describeTarget } from "../dom/describeElement";
import {
  PhysicalContactTracker,
  rawSampleCloneCount,
  resetRawSampleCloneCount,
  type PhysicalContactRecord,
  type RawPointerContactSample,
  type RawTouchContactEvent,
  type RawTouchPoint
} from "./PhysicalContactTracker";

type PointerEventType = RawPointerContactSample["eventType"];
type TouchEventType = RawTouchContactEvent["eventType"];

const REGISTRATION_SCOPE = "document-capture" as const;
const REGISTRATION_SOURCE = "ViewerInkSession.installPointerProbe" as const;
const HOT_PATH_LONG_TASK_MS = 2;
const HOT_PATH_LONG_TASK_INTERVAL_MS = 1_000;
const HOT_PATH_PERCENTILE_INTERVAL = 16;
const HOT_PATH_SAMPLE_LIMIT = 200;
const HOT_PATH_PHASES = ["owner-selection", "deduplication", "tracking", "dispatch"] as const;

export interface PhysicalContactHotPathStats {
  pointerMoveCount: number;
  touchMoveCount: number;
  pathLabelBuildCount: number;
  pathLabelBuildOnMoveCount: number;
  rawSampleCloneCount: number;
  maxCollectorMoveMs: number;
  p95CollectorMoveMs: number;
}

const hotPathMoveSamples: number[] = [];
let hotPathMoveCount = 0;
const hotPathStats: PhysicalContactHotPathStats = {
  pointerMoveCount: 0,
  touchMoveCount: 0,
  pathLabelBuildCount: 0,
  pathLabelBuildOnMoveCount: 0,
  rawSampleCloneCount: 0,
  maxCollectorMoveMs: 0,
  p95CollectorMoveMs: 0
};
let lastHotPathLongTaskAt = 0;

export function physicalContactHotPathStats(): PhysicalContactHotPathStats {
  return { ...hotPathStats, rawSampleCloneCount: rawSampleCloneCount() };
}

export function resetPhysicalContactHotPathStats(): void {
  hotPathMoveSamples.length = 0;
  hotPathMoveCount = 0;
  lastHotPathLongTaskAt = 0;
  resetRawSampleCloneCount();
  Object.assign(hotPathStats, {
    pointerMoveCount: 0,
    touchMoveCount: 0,
    pathLabelBuildCount: 0,
    pathLabelBuildOnMoveCount: 0,
    rawSampleCloneCount: 0,
    maxCollectorMoveMs: 0,
    p95CollectorMoveMs: 0
  });
}

const SEEN_EVENT_TTL_MS = 30_000;
const SEEN_EVENT_PRUNE_INTERVAL_MS = 1_000;
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
  host: HTMLElement;
  isEnabled(): boolean;
  withinTarget(target: EventTarget | null): boolean;
  onPhysicalContactEvent(event: PhysicalContactCollectorEvent): void;
  onPhysicalContactDuplicate(details: PhysicalContactDuplicateObserver): void;
  onInputHotPathLongTask?(details: Record<string, unknown>): void;
}

export interface PhysicalContactCollectorOwnerSnapshot {
  ownerId: string;
  sessionId: string;
  viewerGeneration: number;
  hostDebugId: number | null;
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
  private readonly trackers = new Map<string, PhysicalContactTracker>();
  private readonly owners = new Map<string, { owner: PhysicalContactCollectorOwner; token: object }>();
  private readonly pointerOwners = new Map<number, string>();
  private readonly touchOwners = new Map<number, string>();
  private readonly seenEvents = new WeakMap<Event, Set<string>>();
  private readonly seenKeys = new Map<string, number>();
  private readonly duplicateAnomalies = new Map<string, number>();
  private lastSeenPruneAt = 0;

  constructor(private readonly document: Document) {
    const captureOptions = { capture: true, signal: this.abort.signal };
    document.addEventListener("pointerdown", (event) => this.handlePointer(event, "pointerdown"), { ...captureOptions, passive: false });
    document.addEventListener("pointermove", (event) => this.handlePointer(event, "pointermove"), { ...captureOptions, passive: true });
    document.addEventListener("pointerup", (event) => this.handlePointer(event, "pointerup"), captureOptions);
    document.addEventListener("pointercancel", (event) => this.handlePointer(event, "pointercancel"), captureOptions);
    document.addEventListener("lostpointercapture", (event) => this.handlePointer(event, "lostpointercapture"), captureOptions);
    document.addEventListener("touchstart", (event) => this.handleTouch(event, "touchstart"), { ...captureOptions, passive: true });
    document.addEventListener("touchmove", (event) => this.handleTouch(event, "touchmove"), { ...captureOptions, passive: true });
    document.addEventListener("touchend", (event) => this.handleTouch(event, "touchend"), { ...captureOptions, passive: true });
    document.addEventListener("touchcancel", (event) => this.handleTouch(event, "touchcancel"), { ...captureOptions, passive: true });
  }

  acquire(owner: PhysicalContactCollectorOwner, onEmpty: () => void): PhysicalContactCollectorLease {
    const token = {};
    this.owners.set(owner.ownerId, { owner, token });
    let released = false;
    return {
      collectorId: this.collectorId,
      ownerId: owner.ownerId,
      snapshot: () => this.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        if (this.owners.get(owner.ownerId)?.token !== token) return;
        this.owners.delete(owner.ownerId);
        this.trackers.delete(owner.ownerId);
        for (const [pointerId, ownerId] of this.pointerOwners) {
          if (ownerId === owner.ownerId) this.pointerOwners.delete(pointerId);
        }
        for (const [touchId, ownerId] of this.touchOwners) {
          if (ownerId === owner.ownerId) this.touchOwners.delete(touchId);
        }
        if (this.owners.size === 0) {
          this.abort.abort();
          onEmpty();
        }
      }
    };
  }

  snapshot(): PhysicalContactCollectorSnapshot {
    const owners = [...this.owners.values()].map(({ owner }) => ({
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      viewerGeneration: owner.viewerGeneration,
      hostDebugId: getDebugNodeId(owner.host)
    }));
    return {
      collectorId: this.collectorId,
      listenerRegistered: !this.abort.signal.aborted,
      registrationScope: REGISTRATION_SCOPE,
      registrationSource: REGISTRATION_SOURCE,
      activeContactCount: [...this.trackers.values()].reduce((total, tracker) => total + tracker.activeContactCount, 0),
      activeOwnerCount: owners.length,
      ownerIds: owners.map(({ ownerId }) => ownerId),
      owners
    };
  }

  private trackerFor(ownerId: string): PhysicalContactTracker {
    let tracker = this.trackers.get(ownerId);
    if (!tracker) {
      tracker = new PhysicalContactTracker(`physical-contact-${this.collectorId}-${ownerId}`);
      this.trackers.set(ownerId, tracker);
    }
    return tracker;
  }

  private handlePointer(event: PointerEvent, eventType: PointerEventType): void {
    if (!this.hasEnabledOwner()) return;
    const started = performance.now();
    const selectionStarted = started;
    const observers = this.activeObservers(event.target);
    const selected = this.selectOwner(
      observers,
      eventType === "pointerdown" ? undefined : this.pointerOwners.get(event.pointerId)
    );
    const ownerSelectionMs = performance.now() - selectionStarted;
    if (!selected) {
      if (eventType === "pointerup" || eventType === "pointercancel") this.pointerOwners.delete(event.pointerId);
      return;
    }
    const tracker = this.trackerFor(selected.ownerId);
    const deduplicationStarted = performance.now();
    const alreadySeen = this.markSeen(
      event,
      `${selected.ownerId}|${this.pointerKey(event, eventType)}`,
      eventType === "pointerdown" && tracker.pointerContactId(event.pointerId) === null
    );
    const deduplicationMs = performance.now() - deduplicationStarted;
    const now = Date.now();
    const trackingStarted = performance.now();
    const records = alreadySeen
      ? []
      : this.processPointer(selected.ownerId, tracker, now, event, eventType);
    const trackingMs = performance.now() - trackingStarted;
    const pointerContactId = tracker.pointerContactId(event.pointerId);
    if ((eventType === "pointerdown" || eventType === "pointermove") && pointerContactId !== null) {
      this.pointerOwners.set(event.pointerId, selected.ownerId);
    }
    const chosenPhysicalContactId = records.at(-1)?.contact.physicalContactId ?? pointerContactId;
    const dispatchStarted = performance.now();
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
      eventTimeStamp: event.timeStamp,
    });
    if (eventType === "pointerup" || eventType === "pointercancel") this.pointerOwners.delete(event.pointerId);
    const dispatchMs = performance.now() - dispatchStarted;
    this.noteMoveCost(selected, eventType, event.pointerType || "", {
      "owner-selection": ownerSelectionMs,
      deduplication: deduplicationMs,
      tracking: trackingMs,
      dispatch: dispatchMs
    }, performance.now() - started);
  }

  private handleTouch(event: TouchEvent, eventType: TouchEventType): void {
    if (!this.hasEnabledOwner()) return;
    const started = performance.now();
    const groups = new Map<string, {
      selected: PhysicalContactCollectorOwner;
      observers: Set<PhysicalContactCollectorOwner>;
      changed: Touch[];
      ownerSelectionMs: number;
    }>();
    for (const touch of [...event.changedTouches]) {
      const selectionStarted = performance.now();
      const target = touch.target ?? event.target;
      const observers = this.activeObservers(target);
      const selected = this.selectOwner(
        observers,
        eventType === "touchstart" ? undefined : this.touchOwners.get(touch.identifier)
      );
      const ownerSelectionMs = performance.now() - selectionStarted;
      if (!selected) {
        if (eventType === "touchend" || eventType === "touchcancel") this.touchOwners.delete(touch.identifier);
        continue;
      }
      let group = groups.get(selected.ownerId);
      if (!group) {
        group = { selected, observers: new Set(), changed: [], ownerSelectionMs: 0 };
        groups.set(selected.ownerId, group);
      }
      for (const observer of observers) group.observers.add(observer);
      group.changed.push(touch);
      group.ownerSelectionMs += ownerSelectionMs;
    }

    for (const group of groups.values()) {
      const { selected, changed } = group;
      const identifiers = changed.map((touch) => touch.identifier);
      const changedIds = new Set(identifiers);
      const active = [...event.touches].filter((touch) => {
        const ownerId = this.touchOwners.get(touch.identifier);
        return ownerId === selected.ownerId
          || (ownerId === undefined && changedIds.has(touch.identifier));
      });
      const tracker = this.trackerFor(selected.ownerId);
      const deduplicationStarted = performance.now();
      const alreadySeen = this.markSeen(
        event,
        `${selected.ownerId}|${this.touchKey(event, eventType, identifiers)}`,
        eventType === "touchstart" && identifiers.every((identifier) => tracker.touchContactId(identifier) === null)
      );
      const deduplicationMs = performance.now() - deduplicationStarted;
      const now = Date.now();
      const trackingStarted = performance.now();
      const records = alreadySeen
        ? []
        : this.processTouch(selected.ownerId, tracker, now, event, eventType, changed, active);
      const trackingMs = performance.now() - trackingStarted;
      const touchContactIds = identifiers
        .map((identifier) => tracker.touchContactId(identifier))
        .filter((id): id is string => id !== null);
      const chosenPhysicalContactId = records.at(-1)?.contact.physicalContactId ?? touchContactIds[0] ?? null;
      const dispatchStarted = performance.now();
      this.dispatch({
        kind: "touch",
        event,
        eventType,
        selected,
        observers: [...group.observers],
        alreadySeen,
        records,
        pointerId: null,
        pointerContactId: null,
        touchIdentifiers: identifiers,
        chosenPhysicalContactId,
        eventTimeStamp: event.timeStamp,
      });
      if (eventType === "touchend" || eventType === "touchcancel") {
        for (const identifier of identifiers) this.touchOwners.delete(identifier);
      }
      const dispatchMs = performance.now() - dispatchStarted;
      this.noteMoveCost(selected, eventType, "touch", {
        "owner-selection": group.ownerSelectionMs,
        deduplication: deduplicationMs,
        tracking: trackingMs,
        dispatch: dispatchMs
      }, performance.now() - started);
    }
  }

  private noteMoveCost(
    owner: PhysicalContactCollectorOwner,
    eventType: string,
    pointerType: string,
    phaseDurations: Record<(typeof HOT_PATH_PHASES)[number], number>,
    collectorWorkMs: number
  ): void {
    if (eventType !== "pointermove" && eventType !== "touchmove") return;
    if (eventType === "pointermove") hotPathStats.pointerMoveCount += 1;
    else hotPathStats.touchMoveCount += 1;
    hotPathMoveCount += 1;
    if (hotPathMoveSamples.length < HOT_PATH_SAMPLE_LIMIT) {
      hotPathMoveSamples.push(collectorWorkMs);
    } else {
      // Order does not matter to the percentile calculation; overwrite the
      // oldest slot instead of shifting the whole bounded window per move.
      hotPathMoveSamples[(hotPathMoveCount - 1) % HOT_PATH_SAMPLE_LIMIT] = collectorWorkMs;
    }
    hotPathStats.maxCollectorMoveMs = Math.max(hotPathStats.maxCollectorMoveMs, collectorWorkMs);
    // The sample window is diagnostic-only. Sorting it for every move adds
    // avoidable work to the same high-frequency path being measured.
    if (hotPathMoveCount <= 4 || hotPathMoveCount % HOT_PATH_PERCENTILE_INTERVAL === 0) {
      const sorted = [...hotPathMoveSamples].sort((a, b) => a - b);
      hotPathStats.p95CollectorMoveMs = percentile(sorted, 0.95);
    }
    if (collectorWorkMs <= HOT_PATH_LONG_TASK_MS) return;
    const now = Date.now();
    if (now - lastHotPathLongTaskAt < HOT_PATH_LONG_TASK_INTERVAL_MS) return;
    lastHotPathLongTaskAt = now;
    const slowPhases = HOT_PATH_PHASES
      .filter((phase) => phaseDurations[phase] > HOT_PATH_LONG_TASK_MS)
      .map((phase) => ({ phase, durationMs: phaseDurations[phase], thresholdMs: HOT_PATH_LONG_TASK_MS }));
    owner.onInputHotPathLongTask?.({
      event: "input-hot-path-long-task",
      eventType,
      pointerType,
      collectorWorkMs,
      phaseDurations,
      slowPhases
    });
  }

  private processPointer(
    ownerId: string,
    tracker: PhysicalContactTracker,
    now: number,
    event: PointerEvent,
    eventType: PointerEventType
  ): PhysicalContactRecord[] {
    const sample = rawPointerContactSample(event, eventType);
    const expired = tracker.expire(now);
    this.clearTerminalOwnerMaps(ownerId, expired);
    const current = eventType === "pointerdown"
      ? tracker.pointerDown(now, sample)
      : eventType === "pointermove"
        ? tracker.pointerMove(now, sample)
        : eventType === "lostpointercapture"
          ? tracker.pointerLostCapture(now, sample)
          : tracker.pointerEnd(now, sample);
    this.clearTerminalOwnerMaps(ownerId, current);
    return [...expired, ...current];
  }

  private processTouch(
    ownerId: string,
    tracker: PhysicalContactTracker,
    now: number,
    event: TouchEvent,
    eventType: TouchEventType,
    changedTouches: readonly Touch[],
    activeTouches: readonly Touch[]
  ): PhysicalContactRecord[] {
    const expired = tracker.expire(now);
    this.clearTerminalOwnerMaps(ownerId, expired);
    if (eventType === "touchstart" || eventType === "touchmove") {
      for (const touch of changedTouches) this.touchOwners.set(touch.identifier, ownerId);
    }
    const raw = rawTouchContactEvent(event, eventType, activeTouches, changedTouches);
    const current = eventType === "touchstart"
      ? tracker.touchStart(now, raw)
      : eventType === "touchmove"
        ? tracker.touchMove(now, raw)
        : tracker.touchEnd(now, raw);
    this.clearTerminalOwnerMaps(ownerId, current);
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
    const observerOwnerIds = [...new Set([...args.observers, args.selected].map(({ ownerId }) => ownerId))];
    const duplicateObserverOwnerIds = args.observers
      .filter((owner) => owner !== args.selected)
      .map(({ ownerId }) => ownerId);
    const isMove = args.eventType === "pointermove" || args.eventType === "touchmove";
    if (!isMove && duplicateObserverOwnerIds.length > 0) {
      const anomalyKey = this.anomalyKey(args.eventType, args.pointerId, args.touchIdentifiers, args.eventTimeStamp, args.event.target);
      if (!this.duplicateAnomalies.has(anomalyKey)) {
        this.duplicateAnomalies.set(anomalyKey, Date.now());
        this.trimMap(this.duplicateAnomalies, MAX_DUPLICATE_ANOMALIES);
        args.selected.onPhysicalContactDuplicate({
          collectorId: this.collectorId,
          ownerCollectorId: args.selected.ownerId,
          duplicateCollectorIds: duplicateObserverOwnerIds,
          duplicateObserverOwnerIds,
          sessionId: args.selected.sessionId,
          viewerGeneration: args.selected.viewerGeneration,
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

    args.selected.onPhysicalContactEvent({
      kind: args.kind,
      event: args.event,
      eventType: args.eventType,
      collectorId: this.collectorId,
      ownerId: args.selected.ownerId,
      sessionId: args.selected.sessionId,
      viewerGeneration: args.selected.viewerGeneration,
      observerOwnerIds,
      alreadySeen: args.alreadySeen,
      shouldLog: !args.alreadySeen,
      records: args.records,
      pointerId: args.pointerId,
      pointerContactId: args.pointerContactId,
      touchIdentifiers: args.touchIdentifiers,
      chosenPhysicalContactId: args.chosenPhysicalContactId,
      registrationScope: REGISTRATION_SCOPE,
      registrationSource: REGISTRATION_SOURCE
    });
  }

  private hasEnabledOwner(): boolean {
    for (const { owner } of this.owners.values()) {
      if (owner.isEnabled()) return true;
    }
    return false;
  }

  private activeObservers(target: EventTarget | null): PhysicalContactCollectorOwner[] {
    return [...this.owners.values()]
      .map(({ owner }) => owner)
      .filter((owner) => owner.isEnabled() && owner.withinTarget(target));
  }

  private selectOwner(
    observers: readonly PhysicalContactCollectorOwner[],
    preferredOwnerId?: string
  ): PhysicalContactCollectorOwner | null {
    if (preferredOwnerId !== undefined) {
      const preferred = this.owners.get(preferredOwnerId)?.owner;
      return preferred?.isEnabled() ? preferred : null;
    }
    return observers.reduce<PhysicalContactCollectorOwner | null>((selected, candidate) => {
      if (!selected) return candidate;
      const selectedContainsCandidate = selected.host.contains(candidate.host);
      const candidateContainsSelected = candidate.host.contains(selected.host);
      if (selectedContainsCandidate && !candidateContainsSelected) return candidate;
      if (candidateContainsSelected && !selectedContainsCandidate) return selected;
      if (candidate.viewerGeneration > selected.viewerGeneration) return candidate;
      if (candidate.viewerGeneration === selected.viewerGeneration && candidate.ownerId < selected.ownerId) return candidate;
      return selected;
    }, null);
  }

  private markSeen(event: Event, key: string, allowKeyReuse = false): boolean {
    const eventKeys = this.seenEvents.get(event) ?? new Set<string>();
    if (eventKeys.has(key)) return true;
    const now = Date.now();
    this.pruneSeen(now);
    const alreadySeen = !allowKeyReuse && this.seenKeys.has(key);
    eventKeys.add(key);
    this.seenEvents.set(event, eventKeys);
    this.seenKeys.set(key, now);
    this.trimMap(this.seenKeys, MAX_SEEN_EVENTS);
    return alreadySeen;
  }

  private clearTerminalOwnerMaps(ownerId: string, records: readonly PhysicalContactRecord[]): void {
    for (const { phase, contact } of records) {
      if (phase !== "terminal") continue;
      for (const pointerId of contact.pointerIds) {
        if (this.pointerOwners.get(pointerId) === ownerId) this.pointerOwners.delete(pointerId);
      }
      for (const touchIdentifier of contact.touchIdentifiers) {
        if (this.touchOwners.get(touchIdentifier) === ownerId) this.touchOwners.delete(touchIdentifier);
      }
    }
  }

  private pruneSeen(now: number): void {
    if (this.lastSeenPruneAt !== 0 && now - this.lastSeenPruneAt < SEEN_EVENT_PRUNE_INTERVAL_MS) return;
    this.lastSeenPruneAt = now;
    for (const [key, seenAt] of this.seenKeys) {
      if (now - seenAt > SEEN_EVENT_TTL_MS) this.seenKeys.delete(key);
    }
  }

  private pointerKey(event: PointerEvent, eventType: PointerEventType): string {
    if (eventType === "pointermove") {
      return [
        eventType,
        event.pointerId,
        event.timeStamp,
        event.clientX,
        event.clientY,
        getDebugNodeId(event.target) ?? "-"
      ].join("|");
    }
    return this.anomalyKey(eventType, event.pointerId, [], event.timeStamp, event.target);
  }

  private touchKey(event: TouchEvent, eventType: TouchEventType, identifiers: readonly number[]): string {
    if (eventType === "touchmove") {
      const first = event.changedTouches[0];
      return [
        eventType,
        identifiers.join(","),
        event.timeStamp,
        first ? `${first.clientX},${first.clientY}` : "-",
        getDebugNodeId(event.target) ?? "-"
      ].join("|");
    }
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

export function rawPointerContactSample(event: PointerEvent, eventType: PointerEventType): RawPointerContactSample {
  const path = eventType === "pointermove" ? emptyPath() : pathSnapshot(event, eventType);
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
    targetId: eventType === "pointermove" ? null : getDebugNodeId(event.target),
    composedPath: path.ids,
    composedPathLabels: path.labels,
    eventPhase: event.eventPhase,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented
  };
}

export function rawTouchContactEvent(
  event: TouchEvent,
  eventType: TouchEventType,
  activeTouchList: readonly Touch[] = [...event.touches],
  changedTouchList: readonly Touch[] = [...event.changedTouches]
): RawTouchContactEvent {
  const changedCount = changedTouchList.length;
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
  const activeTouches = activeTouchList.slice(0, 8).map(toPoint);
  const changedTouches = changedTouchList.slice(0, 8).map(toPoint);
  const path = eventType === "touchmove" ? emptyPath() : pathSnapshot(event, eventType);
  const touches = changedTouches.map((touch) => ({
    eventType,
    timeStamp: event.timeStamp,
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    radiusX: touch.radiusX,
    radiusY: touch.radiusY,
    force: touch.force,
    touchCount: activeTouchList.length,
    changedCount,
    activeTouches,
    changedTouches,
    targetId: eventType === "touchmove" ? null : getDebugNodeId(event.target),
    composedPath: path.ids,
    composedPathLabels: path.labels
  }));
  return { eventType, touches };
}

function emptyPath(): { ids: string[]; labels: string[] } {
  return { ids: [], labels: [] };
}

function pathSnapshot(event: Event, eventType: string): { ids: string[]; labels: string[] } {
  if (eventType === "pointermove" || eventType === "touchmove") {
    hotPathStats.pathLabelBuildOnMoveCount += 1;
    return emptyPath();
  }
  const entries = composedPathEntries(event);
  hotPathStats.pathLabelBuildCount += 1;
  return {
    ids: entries.map((entry) => entry instanceof Element ? String(getDebugNodeId(entry)) : Object.prototype.toString.call(entry)),
    labels: entries.map((entry) => describeTarget(entry))
  };
}

function composedPathEntries(event: Event): EventTarget[] {
  return typeof event.composedPath === "function" ? event.composedPath().slice(0, 12) : [];
}

function uniqueContactIds(records: readonly PhysicalContactRecord[], chosen: string | null): string[] {
  const ids = records.map(({ contact }) => contact.physicalContactId);
  if (chosen) ids.push(chosen);
  return [...new Set(ids)];
}
