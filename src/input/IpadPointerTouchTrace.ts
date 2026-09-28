/**
 * Passive, bounded evidence for real iPadOS/WKWebView input ordering.
 *
 * This is an observer only. It never prevents, stops, captures, or routes an
 * event, and it deliberately keeps no coordinates or annotation content.
 */

export interface IpadInputTraceEvent {
  sequence: number;
  at: number;
  type: string;
  source: "pointer" | "touch" | "scribble" | "gesture" | "lifecycle";
  eventPhase: number;
  pointerType: string | null;
  pointerId: number | null;
  isPrimary: boolean | null;
  button: number | null;
  buttons: number | null;
  pressure: number | null;
  pointerCapture: boolean | null;
  targetClass: {
    tag: string;
    id: string | null;
    classes: string[];
    role: string | null;
    contentEditable: boolean;
  } | null;
  touchIdentifiers: number[];
  changedTouchIdentifiers: number[];
  activePointerIds: number[];
  activeTouchIdentifiers: number[];
  touchAction: string | null;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  inputType: string | null;
  composing: boolean | null;
}

export interface IpadInputTraceSnapshot {
  schemaVersion: 2;
  platform: "ipad";
  active: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  events: IpadInputTraceEvent[];
  summary: {
    eventCount: number;
    eventTypes: Record<string, number>;
    pointerTypes: Record<string, number>;
    pointerIds: number[];
    touchIdentifiers: number[];
    pointerCaptureObserved: number;
    lostPointerCaptureEvents: number;
    defaultPreventedObserved: number;
    propagationStoppedObserved: number;
    pointerTouchOverlapEvents: number;
    touchActionValues: string[];
    touchActionStyleReads: number;
    lifecycleEvents: number;
    scribbleEvents: number;
    lastSequence: number;
  };
}

type TraceListener = {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options: AddEventListenerOptions;
};

const MAX_EVENTS = 256;
const MAX_IDS = 16;
const MAX_CLASSES = 8;
const HIGH_FREQUENCY_EVENT_TYPES = new Set(["pointermove", "touchmove"]);

export class IpadPointerTouchTrace {
  private static readonly shared = new WeakMap<Document, { trace: IpadPointerTouchTrace; references: number }>();

  static acquire(document: Document): IpadPointerTouchTrace {
    const existing = this.shared.get(document);
    if (existing) {
      existing.references += 1;
      return existing.trace;
    }
    const trace = new IpadPointerTouchTrace(document);
    this.shared.set(document, { trace, references: 1 });
    return trace;
  }

  private readonly listeners: TraceListener[] = [];
  private readonly events: IpadInputTraceEvent[] = [];
  private readonly activePointerIds = new Set<number>();
  private readonly activeTouchIdentifiers = new Set<number>();
  private readonly eventTypes = new Map<string, number>();
  private readonly pointerTypes = new Map<string, number>();
  private readonly pointerIds = new Set<number>();
  private readonly touchIdentifiers = new Set<number>();
  private readonly touchActionValues = new Set<string>();
  private readonly touchActionByTarget = new WeakMap<Element, string | null>();
  private readonly targetSnapshots = new WeakMap<Element, NonNullable<IpadInputTraceEvent["targetClass"]>>();
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private sequence = 0;
  private pointerCaptureObserved = 0;
  private lostPointerCaptureEvents = 0;
  private defaultPreventedObserved = 0;
  private propagationStoppedObserved = 0;
  private pointerTouchOverlapEvents = 0;
  private touchActionStyleReads = 0;
  private lifecycleEvents = 0;
  private scribbleEvents = 0;
  private attached = false;

  private constructor(private readonly document: Document) {}

  start(enabled: boolean): void {
    if (!enabled || this.attached) return;
    this.attached = true;
    this.startedAt = performance.now();
    this.stoppedAt = null;
    const view = this.document.defaultView;
    const pointerEvents = [
      "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"
    ];
    const pointerBoundaryEvents = ["pointerover", "pointerenter", "pointerout", "pointerleave"];
    const touchEvents = ["touchstart", "touchmove", "touchend", "touchcancel"];
    const lifecycleEvents = ["visibilitychange", "pagehide", "pageshow", "orientationchange", "resize"];
    const gestureEvents = ["gesturestart", "gesturechange", "gestureend"];
    for (const type of pointerEvents) this.bind(this.document, type, (event) => this.record(event, "pointer"));
    // Boundary/hover events are frequent and do not affect contact routing.
    // Keep their counts for diagnosis without allocating a full event snapshot.
    for (const type of pointerBoundaryEvents) {
      this.bind(this.document, type, (event) => this.recordPointerBoundary(event));
    }
    for (const type of touchEvents) this.bind(this.document, type, (event) => this.record(event, "touch"));
    for (const type of ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
      this.bind(this.document, type, (event) => this.record(event, "scribble"));
    }
    for (const type of gestureEvents) this.bind(this.document, type, (event) => this.record(event, "gesture"));
    for (const type of lifecycleEvents) {
      this.bind(type === "resize" || type === "orientationchange" ? view ?? this.document : this.document, type, (event) => {
        this.record(event, "lifecycle");
      });
    }
  }

  stop(): void {
    if (!this.attached) return;
    for (const entry of this.listeners) {
      entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    }
    this.listeners.length = 0;
    this.attached = false;
    this.stoppedAt = performance.now();
  }

  release(): void {
    const entry = IpadPointerTouchTrace.shared.get(this.document);
    if (!entry || entry.trace !== this) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.stop();
    IpadPointerTouchTrace.shared.delete(this.document);
  }

  snapshot(): IpadInputTraceSnapshot {
    return {
      schemaVersion: 2,
      platform: "ipad",
      active: this.attached,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      events: this.events.slice(),
      summary: {
        eventCount: this.sequence,
        eventTypes: sortedCounts(this.eventTypes),
        pointerTypes: sortedCounts(this.pointerTypes),
        pointerIds: [...this.pointerIds].slice(-MAX_IDS),
        touchIdentifiers: [...this.touchIdentifiers].slice(-MAX_IDS),
        pointerCaptureObserved: this.pointerCaptureObserved,
        lostPointerCaptureEvents: this.lostPointerCaptureEvents,
        defaultPreventedObserved: this.defaultPreventedObserved,
        propagationStoppedObserved: this.propagationStoppedObserved,
        pointerTouchOverlapEvents: this.pointerTouchOverlapEvents,
        touchActionValues: [...this.touchActionValues].slice(0, MAX_IDS),
        touchActionStyleReads: this.touchActionStyleReads,
        lifecycleEvents: this.lifecycleEvents,
        scribbleEvents: this.scribbleEvents,
        lastSequence: this.sequence
      }
    };
  }

  private bind(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const listener = handler as EventListener;
    const options: AddEventListenerOptions = { capture: true, passive: true };
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  private recordPointerBoundary(event: Event): void {
    const pointer = event as PointerEvent;
    this.sequence += 1;
    increment(this.eventTypes, event.type);
    const pointerType = pointer.pointerType || "(empty)";
    increment(this.pointerTypes, pointerType);
    if (typeof pointer.pointerId === "number") rememberBoundedId(this.pointerIds, pointer.pointerId);
  }

  private record(event: Event, source: IpadInputTraceEvent["source"]): void {
    const pointer = event as PointerEvent;
    const touch = event as TouchEvent;
    const input = event as InputEvent;
    const target = event.target instanceof Element ? event.target : null;
    const pointerEvent = source === "pointer" && typeof pointer.pointerId === "number";
    const touchEvent = source === "touch" && "touches" in event;
    const pointerId = pointerEvent ? pointer.pointerId : null;
    const pointerType = pointerEvent ? pointer.pointerType || "(empty)" : null;
    if (pointerEvent && event.type === "pointerdown") {
      this.activePointerIds.add(pointer.pointerId);
      rememberBoundedId(this.pointerIds, pointer.pointerId);
    }
    if (pointerEvent && (event.type === "pointerup" || event.type === "pointercancel" || event.type === "lostpointercapture")) {
      this.activePointerIds.delete(pointer.pointerId);
      rememberBoundedId(this.pointerIds, pointer.pointerId);
    }
    const touchIdentifiers = touchEvent ? boundedTouchIds(touch.touches) : [];
    const changedTouchIdentifiers = touchEvent ? boundedTouchIds(touch.changedTouches) : [];
    if (touchEvent) {
      for (const identifier of touchIdentifiers) {
        this.activeTouchIdentifiers.add(identifier);
        rememberBoundedId(this.touchIdentifiers, identifier);
      }
      for (const identifier of changedTouchIdentifiers) {
        rememberBoundedId(this.touchIdentifiers, identifier);
        if (event.type === "touchend" || event.type === "touchcancel") this.activeTouchIdentifiers.delete(identifier);
      }
    }
    const touchAction = this.touchActionFor(target, event.type);
    if (touchAction) this.touchActionValues.add(touchAction);
    const targetClass = target ? this.targetSnapshotFor(target, event.type) : null;
    const pointerCapture = pointerEvent && target instanceof Element
      ? safeHasPointerCapture(target, pointer.pointerId)
      : null;
    if (pointerCapture === true) this.pointerCaptureObserved += 1;
    if (event.type === "lostpointercapture") this.lostPointerCaptureEvents += 1;
    if (event.defaultPrevented) this.defaultPreventedObserved += 1;
    if (event.cancelBubble) this.propagationStoppedObserved += 1;
    if (this.activePointerIds.size > 0 && this.activeTouchIdentifiers.size > 0) this.pointerTouchOverlapEvents += 1;
    if (source === "lifecycle") this.lifecycleEvents += 1;
    if (source === "scribble") this.scribbleEvents += 1;
    increment(this.eventTypes, event.type);
    if (pointerType) increment(this.pointerTypes, pointerType);
    const record: IpadInputTraceEvent = {
      sequence: ++this.sequence,
      at: performance.now(),
      type: event.type,
      source,
      eventPhase: event.eventPhase,
      pointerType,
      pointerId,
      isPrimary: pointerEvent ? pointer.isPrimary : null,
      button: pointerEvent ? pointer.button : null,
      buttons: pointerEvent ? pointer.buttons : null,
      pressure: pointerEvent ? finite(pointer.pressure) : null,
      pointerCapture,
      targetClass,
      touchIdentifiers,
      changedTouchIdentifiers,
      activePointerIds: [...this.activePointerIds].slice(0, MAX_IDS),
      activeTouchIdentifiers: [...this.activeTouchIdentifiers].slice(0, MAX_IDS),
      touchAction,
      defaultPrevented: event.defaultPrevented,
      propagationStopped: event.cancelBubble,
      inputType: source === "scribble" ? input.inputType || null : null,
      composing: source === "scribble" ? Boolean(input.isComposing) : null
    };
    this.events.push(record);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private touchActionFor(target: Element | null, eventType: string): string | null {
    if (!target) return null;
    const hasCached = this.touchActionByTarget.has(target);
    if (HIGH_FREQUENCY_EVENT_TYPES.has(eventType) && hasCached) {
      return this.touchActionByTarget.get(target) ?? null;
    }
    const touchAction = target.ownerDocument.defaultView?.getComputedStyle(target).touchAction ?? null;
    this.touchActionByTarget.set(target, touchAction);
    this.touchActionStyleReads += 1;
    return touchAction;
  }

  private targetSnapshotFor(target: Element, eventType: string): NonNullable<IpadInputTraceEvent["targetClass"]> {
    const hasCached = this.targetSnapshots.has(target);
    if (HIGH_FREQUENCY_EVENT_TYPES.has(eventType) && hasCached) {
      return this.targetSnapshots.get(target)!;
    }
    const snapshot = {
      tag: target.tagName.toLowerCase(),
      id: target.id || null,
      classes: [...target.classList].slice(0, MAX_CLASSES),
      role: target.getAttribute("role"),
      contentEditable: target instanceof HTMLElement && target.isContentEditable
    };
    this.targetSnapshots.set(target, snapshot);
    return snapshot;
  }
}

function boundedTouchIds(list: TouchList): number[] {
  const identifiers: number[] = [];
  for (let index = 0; index < Math.min(MAX_IDS, list.length); index += 1) {
    const touch = list.item(index);
    if (touch) identifiers.push(touch.identifier);
  }
  return identifiers;
}

function safeHasPointerCapture(element: Element, pointerId: number): boolean {
  try {
    return element.hasPointerCapture?.(pointerId) ?? false;
  } catch {
    return false;
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function rememberBoundedId(ids: Set<number>, id: number): void {
  ids.delete(id);
  ids.add(id);
  while (ids.size > MAX_IDS * 4) ids.delete(ids.values().next().value as number);
}
