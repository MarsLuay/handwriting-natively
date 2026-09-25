export type PhysicalContactRepresentation =
  | "pointer-pen"
  | "pointer-touch"
  | "pointer-other"
  | "touch-only"
  | "paired-pen-touch"
  | "paired-pointer-touch";

export type PhysicalContactClassification = "pen-only" | "touch-only" | "paired" | "unknown";

export interface PhysicalClassificationTransition {
  at: number;
  classification: PhysicalContactClassification;
  reason: string;
}

export interface RawPointerContactSample {
  eventType: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  pressure: number;
  width: number;
  height: number;
  tiltX: number;
  tiltY: number;
  buttons: number;
  button: number;
  clientX: number;
  clientY: number;
  targetId: number | string | null;
  composedPath: string[];
  eventPhase: number;
  cancelable: boolean;
  defaultPrevented: boolean;
}

export interface RawTouchPoint {
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

export interface RawTouchContactSample {
  eventType: "touchstart" | "touchmove" | "touchend" | "touchcancel";
  timeStamp: number;
  identifier: number;
  clientX: number;
  clientY: number;
  radiusX: number;
  radiusY: number;
  force: number;
  touchCount: number;
  changedCount: number;
  activeTouches: RawTouchPoint[];
  changedTouches: RawTouchPoint[];
  targetId: number | string | null;
  composedPath: string[];
}

export interface RawTouchContactEvent {
  eventType: RawTouchContactSample["eventType"];
  touches: RawTouchContactSample[];
}

export interface PhysicalContactSnapshot {
  physicalContactId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  pointerIds: number[];
  touchIdentifiers: number[];
  penContactId: string | null;
  classification: PhysicalContactClassification;
  classificationReason: string;
  classificationTransitions: PhysicalClassificationTransition[];
  pointerEventPenSeen: boolean;
  pointerEventTouchSeen: boolean;
  touchEventSeen: boolean;
  pairedStreams: boolean;
  representation: PhysicalContactRepresentation;
  pointerMoveCount: number;
  touchMoveCount: number;
  maxDisplacementPx: number;
  firstPoint: { x: number; y: number } | null;
  lastPoint: { x: number; y: number } | null;
  pointerTerminal: "pointerup" | "pointercancel" | null;
  touchTerminal: "touchend" | "touchcancel" | null;
  terminal: string | null;
  rawPointer: {
    first: RawPointerContactSample | null;
    last: RawPointerContactSample | null;
  };
  rawTouch: {
    first: RawTouchContactSample | null;
    last: RawTouchContactSample | null;
  };
}

export interface PhysicalContactRecord {
  phase: "start" | "terminal";
  contact: PhysicalContactSnapshot;
}

interface ContactState {
  physicalContactId: string;
  startedAt: number;
  lastEventAt: number;
  pointerIds: Set<number>;
  activePointerIds: Set<number>;
  touchIdentifiers: Set<number>;
  classification: PhysicalContactClassification;
  classificationReason: string;
  classificationTransitions: PhysicalClassificationTransition[];
  activeTouchIdentifiers: Set<number>;
  pointerEventPenSeen: boolean;
  pointerEventTouchSeen: boolean;
  touchEventSeen: boolean;
  pointerMoveCount: number;
  touchMoveCount: number;
  maxDisplacementPx: number;
  firstPoint: { x: number; y: number } | null;
  lastPoint: { x: number; y: number } | null;
  pointerTerminal: "pointerup" | "pointercancel" | null;
  touchTerminal: "touchend" | "touchcancel" | null;
  terminal: string | null;
  rawPointerFirst: RawPointerContactSample | null;
  rawPointerLast: RawPointerContactSample | null;
  rawTouchFirst: RawTouchContactSample | null;
  rawTouchLast: RawTouchContactSample | null;
}

/**
 * Correlates bounded browser input evidence without changing routing ownership.
 * Move samples update one in-memory summary; only start/terminal records escape.
 */
export class PhysicalContactTracker {
  static readonly PAIR_WINDOW_MS = 160;
  static readonly PAIR_DISTANCE_PX = 96;
  static readonly CONTACT_TIMEOUT_MS = 30_000;
  static readonly MAX_ACTIVE_CONTACTS = 24;

  private sequence = 0;
  private readonly contacts = new Set<ContactState>();
  private readonly pointerContacts = new Map<number, ContactState>();
  private readonly touchContacts = new Map<number, ContactState>();

  pointerDown(now: number, sample: RawPointerContactSample): PhysicalContactRecord[] {
    return this.startPointer(now, sample);
  }

  pointerMove(now: number, sample: RawPointerContactSample): PhysicalContactRecord[] {
    const contact = this.pointerContacts.get(sample.pointerId);
    if (!contact) return this.startPointer(now, sample);
    this.updatePointer(contact, now, sample);
    return [];
  }

  pointerEnd(now: number, sample: RawPointerContactSample): PhysicalContactRecord[] {
    const contact = this.pointerContacts.get(sample.pointerId);
    if (!contact) return [];
    this.updatePointer(contact, now, sample);
    contact.activePointerIds.delete(sample.pointerId);
    const terminal = sample.eventType === "pointercancel" ? "pointercancel" : "pointerup";
    contact.pointerTerminal = terminal;
    if (contact.activeTouchIdentifiers.size > 0) return [];
    return [{ phase: "terminal", contact: this.finish(contact, now, terminal) }];
  }

  touchStart(now: number, event: RawTouchContactEvent): PhysicalContactRecord[] {
    const records: PhysicalContactRecord[] = [];
    for (const sample of event.touches) {
      const existing = this.touchContacts.get(sample.identifier);
      if (existing) {
        this.updateTouch(existing, now, sample);
        continue;
      }
      const paired = this.findPair(now, sample);
      if (paired) {
        this.attachTouch(paired, now, sample);
        continue;
      }
      const evicted = this.evictIfNeeded(now);
      if (evicted) records.push({ phase: "terminal", contact: evicted });
      const contact = this.createContact(now);
      this.attachTouch(contact, now, sample);
      records.push({ phase: "start", contact: this.snapshot(contact, now) });
    }
    return records;
  }

  touchMove(now: number, event: RawTouchContactEvent): PhysicalContactRecord[] {
    const records: PhysicalContactRecord[] = [];
    for (const sample of event.touches) {
      const existing = this.touchContacts.get(sample.identifier);
      if (existing) {
        this.updateTouch(existing, now, sample);
        continue;
      }
      const evicted = this.evictIfNeeded(now);
      if (evicted) records.push({ phase: "terminal", contact: evicted });
      const contact = this.createContact(now);
      this.attachTouch(contact, now, sample);
      records.push({ phase: "start", contact: this.snapshot(contact, now) });
    }
    return records;
  }

  touchEnd(now: number, event: RawTouchContactEvent): PhysicalContactRecord[] {
    const records: PhysicalContactRecord[] = [];
    for (const sample of event.touches) {
      const contact = this.touchContacts.get(sample.identifier);
      if (!contact) continue;
      this.updateTouch(contact, now, sample);
      contact.activeTouchIdentifiers.delete(sample.identifier);
      const terminal = sample.eventType === "touchcancel" ? "touchcancel" : "touchend";
      contact.touchTerminal = terminal;
      this.touchContacts.delete(sample.identifier);
      // A TouchEvent terminal is sufficient when WebKit omitted the paired
      // pointerup. This preserves one physical lifecycle instead of leaking it.
      if (contact.activeTouchIdentifiers.size === 0) {
        records.push({ phase: "terminal", contact: this.finish(contact, now, terminal) });
      }
    }
    return records;
  }

  expire(now: number): PhysicalContactRecord[] {
    const records: PhysicalContactRecord[] = [];
    for (const contact of [...this.contacts]) {
      if (now - contact.lastEventAt < PhysicalContactTracker.CONTACT_TIMEOUT_MS) continue;
      records.push({ phase: "terminal", contact: this.finish(contact, now, "timeout") });
    }
    return records;
  }

  private startPointer(now: number, sample: RawPointerContactSample): PhysicalContactRecord[] {
    const existing = this.pointerContacts.get(sample.pointerId);
    if (existing) {
      this.updatePointer(existing, now, sample);
      return [];
    }
    const paired = this.findPair(now, sample);
    if (paired) {
      this.attachPointer(paired, now, sample);
      return [];
    }
    const evicted = this.evictIfNeeded(now);
    const contact = this.createContact(now);
    this.attachPointer(contact, now, sample);
    return [
      ...(evicted ? [{ phase: "terminal" as const, contact: evicted }] : []),
      { phase: "start", contact: this.snapshot(contact, now) }
    ];
  }

  constructor(private readonly contactIdPrefix = "physical-contact") {}

  private createContact(now: number): ContactState {
    const contact: ContactState = {
      physicalContactId: `${this.contactIdPrefix}-${++this.sequence}`,
      startedAt: now,
      lastEventAt: now,
      pointerIds: new Set<number>(),
      activePointerIds: new Set<number>(),
      touchIdentifiers: new Set<number>(),
      classification: "unknown",
      classificationReason: "no stylus identity established",
      classificationTransitions: [],
      activeTouchIdentifiers: new Set<number>(),
      pointerEventPenSeen: false,
      pointerEventTouchSeen: false,
      touchEventSeen: false,
      pointerMoveCount: 0,
      touchMoveCount: 0,
      maxDisplacementPx: 0,
      firstPoint: null,
      lastPoint: null,
      pointerTerminal: null,
      touchTerminal: null,
      terminal: null,
      rawPointerFirst: null,
      rawPointerLast: null,
      rawTouchFirst: null,
      rawTouchLast: null
    };
    this.contacts.add(contact);
    return contact;
  }

  private attachPointer(contact: ContactState, now: number, sample: RawPointerContactSample): void {
    contact.pointerIds.add(sample.pointerId);
    contact.activePointerIds.add(sample.pointerId);
    this.pointerContacts.set(sample.pointerId, contact);
    this.updatePointer(contact, now, sample);
  }

  private attachTouch(contact: ContactState, now: number, sample: RawTouchContactSample): void {
    contact.touchIdentifiers.add(sample.identifier);
    contact.activeTouchIdentifiers.add(sample.identifier);
    this.touchContacts.set(sample.identifier, contact);
    this.updateTouch(contact, now, sample);
  }

  private cloneTouchSample(sample: RawTouchContactSample): RawTouchContactSample {
    return {
      ...sample,
      activeTouches: sample.activeTouches.map((touch) => ({ ...touch })),
      changedTouches: sample.changedTouches.map((touch) => ({ ...touch })),
      composedPath: [...sample.composedPath]
    };
  }

  private updatePointer(contact: ContactState, now: number, sample: RawPointerContactSample): void {
    contact.lastEventAt = now;
    if (sample.pointerType === "pen") contact.pointerEventPenSeen = true;
    if (sample.pointerType === "touch") contact.pointerEventTouchSeen = true;
    this.refreshClassification(contact, now);
    if (sample.eventType === "pointermove") contact.pointerMoveCount += 1;
    if (!contact.rawPointerFirst) contact.rawPointerFirst = { ...sample, composedPath: [...sample.composedPath] };
    contact.rawPointerLast = { ...sample, composedPath: [...sample.composedPath] };
    this.updatePoint(contact, sample);
  }

  private updateTouch(contact: ContactState, now: number, sample: RawTouchContactSample): void {
    contact.lastEventAt = now;
    contact.touchEventSeen = true;
    this.refreshClassification(contact, now);
    if (sample.eventType === "touchmove") contact.touchMoveCount += 1;
    if (!contact.rawTouchFirst) contact.rawTouchFirst = this.cloneTouchSample(sample);
    contact.rawTouchLast = this.cloneTouchSample(sample);
    this.updatePoint(contact, sample);
  }

  private refreshClassification(contact: ContactState, now: number): void {
    const next = contact.pointerIds.size > 0 && contact.touchEventSeen
      ? { classification: "paired" as const, reason: contact.pointerEventPenSeen
        ? "pen PointerEvent and TouchEvent evidence paired within bounded window"
        : "PointerEvent and TouchEvent evidence paired within bounded window" }
      : contact.pointerEventPenSeen
        ? { classification: "pen-only" as const, reason: "PointerEvent pointerType=pen established stylus identity" }
        : contact.touchEventSeen && contact.pointerIds.size === 0
          ? { classification: "touch-only" as const, reason: "TouchEvent evidence without a paired PointerEvent" }
          : { classification: "unknown" as const, reason: "raw contact has no established stylus identity" };
    if (next.classification === contact.classification && next.reason === contact.classificationReason) return;
    contact.classification = next.classification;
    contact.classificationReason = next.reason;
    contact.classificationTransitions.push({
      at: now,
      classification: next.classification,
      reason: next.reason
    });
    if (contact.classificationTransitions.length > 6) {
      contact.classificationTransitions.splice(0, contact.classificationTransitions.length - 6);
    }
  }

  private updatePoint(
    contact: ContactState,
    sample: Pick<RawPointerContactSample, "eventType" | "clientX" | "clientY">
      | Pick<RawTouchContactSample, "eventType" | "clientX" | "clientY">
  ): void {
    if (!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) return;
    if (
      sample.eventType === "pointercancel"
      && sample.clientX === 0
      && sample.clientY === 0
      && contact.lastPoint !== null
      && (contact.lastPoint.x !== 0 || contact.lastPoint.y !== 0)
    ) return;
    const point = { x: sample.clientX, y: sample.clientY };
    if (!contact.firstPoint) contact.firstPoint = point;
    contact.lastPoint = point;
    contact.maxDisplacementPx = Math.max(
      contact.maxDisplacementPx,
      Math.hypot(point.x - contact.firstPoint.x, point.y - contact.firstPoint.y)
    );
  }

  private findPair(now: number, sample: RawPointerContactSample | RawTouchContactSample): ContactState | null {
    if (!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) return null;
    const point = { x: sample.clientX, y: sample.clientY };
    let best: ContactState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const contact of this.contacts) {
      if (now - contact.lastEventAt > PhysicalContactTracker.PAIR_WINDOW_MS) continue;
      if (!contact.lastPoint) continue;
      const distance = Math.hypot(point.x - contact.lastPoint.x, point.y - contact.lastPoint.y);
      if (distance > PhysicalContactTracker.PAIR_DISTANCE_PX || distance >= bestDistance) continue;
      const pointerCandidate = "pointerType" in sample;
      const compatible = pointerCandidate
        ? contact.touchEventSeen && !contact.pointerIds.has(sample.pointerId)
        : (contact.pointerEventPenSeen || contact.pointerEventTouchSeen) && !contact.touchIdentifiers.has(sample.identifier);
      if (!compatible) continue;
      best = contact;
      bestDistance = distance;
    }
    return best;
  }

  private evictIfNeeded(now: number): PhysicalContactSnapshot | null {
    if (this.contacts.size < PhysicalContactTracker.MAX_ACTIVE_CONTACTS) return null;
    const oldest = [...this.contacts].sort((left, right) => left.lastEventAt - right.lastEventAt)[0];
    return oldest ? this.finish(oldest, now, "evicted") : null;
  }

  private finish(contact: ContactState, now: number, terminal: string): PhysicalContactSnapshot {
    contact.terminal = terminal;
    contact.lastEventAt = now;
    const snapshot = this.snapshot(contact, now);
    for (const pointerId of contact.pointerIds) {
      if (this.pointerContacts.get(pointerId) === contact) this.pointerContacts.delete(pointerId);
    }
    for (const identifier of contact.touchIdentifiers) {
      if (this.touchContacts.get(identifier) === contact) this.touchContacts.delete(identifier);
    }
    this.contacts.delete(contact);
    return snapshot;
  }

  private snapshot(contact: ContactState, now: number): PhysicalContactSnapshot {
    const hasPointer = contact.pointerIds.size > 0;
    const hasTouch = contact.touchEventSeen;
    const representation: PhysicalContactRepresentation = hasPointer && hasTouch
      ? (contact.pointerEventPenSeen ? "paired-pen-touch" : "paired-pointer-touch")
      : hasTouch
        ? "touch-only"
        : contact.pointerEventPenSeen
          ? "pointer-pen"
          : contact.pointerEventTouchSeen
            ? "pointer-touch"
            : "pointer-other";
    const endedAt = contact.terminal === null ? null : now;
    return {
      physicalContactId: contact.physicalContactId,
      startedAt: contact.startedAt,
      endedAt,
      durationMs: endedAt === null ? null : Math.max(0, endedAt - contact.startedAt),
      pointerIds: [...contact.pointerIds],
      touchIdentifiers: [...contact.touchIdentifiers],
      penContactId: contact.pointerEventPenSeen ? contact.physicalContactId : null,
      classification: contact.classification,
      classificationReason: contact.classificationReason,
      classificationTransitions: contact.classificationTransitions.map((transition) => ({ ...transition })),
      pointerEventPenSeen: contact.pointerEventPenSeen,
      pointerEventTouchSeen: contact.pointerEventTouchSeen,
      touchEventSeen: contact.touchEventSeen,
      pairedStreams: hasPointer && hasTouch,
      representation,
      pointerMoveCount: contact.pointerMoveCount,
      touchMoveCount: contact.touchMoveCount,
      maxDisplacementPx: contact.maxDisplacementPx,
      firstPoint: contact.firstPoint ? { ...contact.firstPoint } : null,
      lastPoint: contact.lastPoint ? { ...contact.lastPoint } : null,
      pointerTerminal: contact.pointerTerminal,
      touchTerminal: contact.touchTerminal,
      terminal: contact.terminal,
      rawPointer: {
        first: contact.rawPointerFirst ? { ...contact.rawPointerFirst, composedPath: [...contact.rawPointerFirst.composedPath] } : null,
        last: contact.rawPointerLast ? { ...contact.rawPointerLast, composedPath: [...contact.rawPointerLast.composedPath] } : null
      },
      rawTouch: {
        first: contact.rawTouchFirst ? this.cloneTouchSample(contact.rawTouchFirst) : null,
        last: contact.rawTouchLast ? this.cloneTouchSample(contact.rawTouchLast) : null
      }
    };
  }
}
