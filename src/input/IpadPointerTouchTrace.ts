import { isHTMLElement } from "../dom/typeGuards";

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
  /** DOMHighResTimeStamp supplied by the browser for this input event. */
  eventTimeStamp: number | null;
  isPrimary: boolean | null;
  button: number | null;
  buttons: number | null;
  pressure: number | null;
  width: number | null;
  height: number | null;
  tiltX: number | null;
  tiltY: number | null;
  twist: number | null;
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

export interface IpadPenHoverSample {
  sequence: number;
  at: number;
  eventTimeStamp: number | null;
  pointerId: number;
  buttons: number | null;
  pressure: number | null;
  width: number | null;
  height: number | null;
  tiltX: number | null;
  tiltY: number | null;
  twist: number | null;
}

export interface IpadInputTraceSnapshot {
  schemaVersion: 5;
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
    passivePenHoverMoves: number;
    passivePenHoverSamples: { first: IpadPenHoverSample | null; last: IpadPenHoverSample | null };
    gestureChangeEvents: number;
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
const HIGH_FREQUENCY_EVENT_TYPES = new Set(["pointermove", "touchmove", "gesturechange"]);

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
  private passivePenHoverMoves = 0;
  private passivePenHoverFirst: IpadPenHoverSample | null = null;
  private passivePenHoverLast: IpadPenHoverSample | null = null;
  private gestureChangeEvents = 0;
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
    // Boundary order matters for hover/contact and capture diagnosis. Hover
    // pointermove remains summarized to first/last sensor samples below.
    for (const type of pointerBoundaryEvents) {
      this.bind(this.document, type, (event) => this.recordPointerBoundary(event));
    }
    for (const type of touchEvents) this.bind(this.document, type, (event) => this.record(event, "touch"));
    for (const type of ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
      this.bind(this.document, type, (event) => this.record(event, "scribble"));
    }
    for (const type of gestureEvents) {
      this.bind(this.document, type, (event) => {
        if (type === "gesturechange") this.recordGestureChange(event);
        else this.record(event, "gesture");
      });
    }
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
      schemaVersion: 5,
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
        passivePenHoverMoves: this.passivePenHoverMoves,
        passivePenHoverSamples: {
          first: this.passivePenHoverFirst ? { ...this.passivePenHoverFirst } : null,
          last: this.passivePenHoverLast ? { ...this.passivePenHoverLast } : null
        },
        gestureChangeEvents: this.gestureChangeEvents,
        lifecycleEvents: this.lifecycleEvents,
        scribbleEvents: this.scribbleEvents,
        lastSequence: this.sequence
      }
    };
  }

  private bind(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const listener: EventListener = (event) => handler(event);
    const options: AddEventListenerOptions = { capture: true, passive: true };
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
  }

  private recordPointerBoundary(event: Event): void {
    const pointer = event as PointerEvent;
    const at = performance.now();
    const sequence = ++this.sequence;
    increment(this.eventTypes, event.type);
    const pointerType = pointer.pointerType || "(empty)";
    increment(this.pointerTypes, pointerType);
    if (typeof pointer.pointerId === "number") rememberBoundedId(this.pointerIds, pointer.pointerId);
    const target = event.target instanceof Element ? event.target : null;
    const pointerCapture = target ? safeHasPointerCapture(target, pointer.pointerId) : null;
    if (pointerCapture === true) this.pointerCaptureObserved += 1;
    if (event.type === "lostpointercapture") this.lostPointerCaptureEvents += 1;
    if (event.defaultPrevented) this.defaultPreventedObserved += 1;
    if (propagationWasStopped(event)) this.propagationStoppedObserved += 1;
    this.pushEvent({
      sequence,
      at,
      eventTimeStamp: finiteOrNull(event.timeStamp),
      type: event.type,
      source: "pointer",
      eventPhase: event.eventPhase,
      pointerType,
      pointerId: typeof pointer.pointerId === "number" ? pointer.pointerId : null,
      isPrimary: typeof pointer.isPrimary === "boolean" ? pointer.isPrimary : null,
      button: typeof pointer.button === "number" ? pointer.button : null,
      buttons: typeof pointer.buttons === "number" ? pointer.buttons : null,
      ...this.pointerSensorFields(pointer),
      pointerCapture,
      targetClass: target ? this.targetSnapshotFor(target, event.type) : null,
      touchIdentifiers: [],
      changedTouchIdentifiers: [],
      activePointerIds: [...this.activePointerIds].slice(0, MAX_IDS),
      activeTouchIdentifiers: [...this.activeTouchIdentifiers].slice(0, MAX_IDS),
      touchAction: null,
      defaultPrevented: event.defaultPrevented,
      propagationStopped: propagationWasStopped(event),
      inputType: null,
      composing: null
    });
  }

  private recordPassivePenHover(pointer: PointerEvent, event: Event): void {
    this.sequence += 1;
    increment(this.eventTypes, event.type);
    increment(this.pointerTypes, pointer.pointerType || "(empty)");
    rememberBoundedId(this.pointerIds, pointer.pointerId);
    this.passivePenHoverMoves += 1;
    if (event.defaultPrevented) this.defaultPreventedObserved += 1;
    if (propagationWasStopped(event)) this.propagationStoppedObserved += 1;
    const sample: IpadPenHoverSample = {
      sequence: ++this.sequence,
      at: performance.now(),
      eventTimeStamp: finiteOrNull(event.timeStamp),
      pointerId: pointer.pointerId,
      buttons: typeof pointer.buttons === "number" ? pointer.buttons : null,
      pressure: finiteOrNull(pointer.pressure),
      width: finiteOrNull(pointer.width),
      height: finiteOrNull(pointer.height),
      tiltX: finiteOrNull(pointer.tiltX),
      tiltY: finiteOrNull(pointer.tiltY),
      twist: finiteOrNull(pointer.twist)
    };
    this.passivePenHoverFirst ??= sample;
    this.passivePenHoverLast = sample;
  }

  private recordGestureChange(event: Event): void {
    this.sequence += 1;
    increment(this.eventTypes, event.type);
    this.gestureChangeEvents += 1;
    if (event.defaultPrevented) this.defaultPreventedObserved += 1;
    if (propagationWasStopped(event)) this.propagationStoppedObserved += 1;
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
    const pointerPressure = pointerEvent ? finiteOrNull(pointer.pressure) : null;
    if (
      pointerEvent
      && event.type === "pointermove"
      && pointerType === "pen"
      && pointer.buttons === 0
      && (pointerPressure === null || pointerPressure === 0)
      && !this.activePointerIds.has(pointer.pointerId)
    ) {
      this.recordPassivePenHover(pointer, event);
      return;
    }
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
    if (propagationWasStopped(event)) this.propagationStoppedObserved += 1;
    if (this.activePointerIds.size > 0 && this.activeTouchIdentifiers.size > 0) this.pointerTouchOverlapEvents += 1;
    if (source === "lifecycle") this.lifecycleEvents += 1;
    if (source === "scribble") this.scribbleEvents += 1;
    increment(this.eventTypes, event.type);
    if (pointerType) increment(this.pointerTypes, pointerType);
    const record: IpadInputTraceEvent = {
      sequence: ++this.sequence,
      at: performance.now(),
      eventTimeStamp: finiteOrNull(event.timeStamp),
      type: event.type,
      source,
      eventPhase: event.eventPhase,
      pointerType,
      pointerId,
      isPrimary: pointerEvent ? pointer.isPrimary : null,
      button: pointerEvent ? pointer.button : null,
      buttons: pointerEvent ? pointer.buttons : null,
      ...(pointerEvent ? this.pointerSensorFields(pointer) : {
        pressure: null,
        width: null,
        height: null,
        tiltX: null,
        tiltY: null,
        twist: null
      }),
      pointerCapture,
      targetClass,
      touchIdentifiers,
      changedTouchIdentifiers,
      activePointerIds: [...this.activePointerIds].slice(0, MAX_IDS),
      activeTouchIdentifiers: [...this.activeTouchIdentifiers].slice(0, MAX_IDS),
      touchAction,
      defaultPrevented: event.defaultPrevented,
      propagationStopped: propagationWasStopped(event),
      inputType: source === "scribble" ? input.inputType || null : null,
      composing: source === "scribble" ? Boolean(input.isComposing) : null
    };
    this.pushEvent(record);
  }

  private pointerSensorFields(pointer: PointerEvent): Pick<IpadInputTraceEvent, "pressure" | "width" | "height" | "tiltX" | "tiltY" | "twist"> {
    return {
      pressure: finiteOrNull(pointer.pressure),
      width: finiteOrNull(pointer.width),
      height: finiteOrNull(pointer.height),
      tiltX: finiteOrNull(pointer.tiltX),
      tiltY: finiteOrNull(pointer.tiltY),
      twist: finiteOrNull(pointer.twist)
    };
  }

  private pushEvent(event: IpadInputTraceEvent): void {
    this.events.push(event);
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
      contentEditable: isHTMLElement(target) && target.isContentEditable
    };
    this.targetSnapshots.set(target, snapshot);
    return snapshot;
  }
}

function propagationWasStopped(event: Event): boolean {
  // Event exposes no replacement for reading stopPropagation state mid-dispatch.
  return Reflect.get(event, "cancelBubble") === true;
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

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
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
