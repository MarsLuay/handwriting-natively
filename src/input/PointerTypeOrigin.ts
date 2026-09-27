import { describeTarget } from "../dom/describeElement";

export const POINTER_TYPE_ORIGIN_LIMIT = 20;

export type PointerInputKind = "pen" | "touch" | "mouse" | "other";
export type PointerTypeListenerPhase = "capture" | "bubble" | "target";

export interface PointerTypeOrigin {
  event: "pointer-type-origin";
  inputKind: PointerInputKind;
  rawPointerType: string | null;
  /** The browser field that supplied the kind. TouchEvent has no pointerType. */
  typeSource: "PointerEvent.pointerType" | "TouchEvent" | "WheelEvent" | "GestureEvent";
  eventInterface: "PointerEvent" | "TouchEvent" | "WheelEvent" | "other";
  eventType: string;
  listener: string;
  listenerPhase: PointerTypeListenerPhase;
  isTrusted: boolean;
  eventPhase: number;
  target: string;
  composedPath: string[];
  pointerId: number | null;
  touchIdentifiers: number[];
}

export class PointerTypeOriginLog {
  private readonly entries: PointerTypeOrigin[] = [];
  private readonly byPointerId = new Map<number, PointerTypeOrigin[]>();
  private readonly byTouchId = new Map<number, PointerTypeOrigin[]>();

  note(origin: PointerTypeOrigin): PointerTypeOrigin {
    const stored = cloneOrigin(origin);
    this.entries.push(stored);
    if (this.entries.length > POINTER_TYPE_ORIGIN_LIMIT) {
      this.entries.splice(0, this.entries.length - POINTER_TYPE_ORIGIN_LIMIT);
    }
    if (stored.pointerId !== null) this.remember(this.byPointerId, stored.pointerId, stored);
    for (const touchId of stored.touchIdentifiers) this.remember(this.byTouchId, touchId, stored);
    return cloneOrigin(stored);
  }

  snapshot(): PointerTypeOrigin[] {
    return this.entries.map(cloneOrigin);
  }

  forContact(pointerIds: readonly number[], touchIdentifiers: readonly number[]): PointerTypeOrigin[] {
    const seen = new Set<string>();
    const matches: PointerTypeOrigin[] = [];
    for (const id of pointerIds) {
      for (const origin of this.byPointerId.get(id) ?? []) this.pushUnique(matches, seen, origin);
    }
    for (const id of touchIdentifiers) {
      for (const origin of this.byTouchId.get(id) ?? []) this.pushUnique(matches, seen, origin);
    }
    return matches;
  }

  private remember(map: Map<number, PointerTypeOrigin[]>, id: number, origin: PointerTypeOrigin): void {
    const current = map.get(id) ?? [];
    if (current.some((entry) => entry.listener === origin.listener && entry.eventType === origin.eventType)) return;
    current.push(origin);
    if (current.length > 6) current.splice(0, current.length - 6);
    map.set(id, current);
    if (map.size > 40) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  private pushUnique(matches: PointerTypeOrigin[], seen: Set<string>, origin: PointerTypeOrigin): void {
    const key = `${origin.listener}|${origin.eventType}|${origin.pointerId}|${origin.touchIdentifiers.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(cloneOrigin(origin));
  }
}

export function pointerTypeOrigin(
  event: Event,
  listener: string,
  listenerPhase: PointerTypeListenerPhase
): PointerTypeOrigin {
  const eventInterface = eventInterfaceOf(event);
  const pointer = pointerEventOf(event);
  const touch = touchEventOf(event);
  const rawPointerType = pointer ? (pointer.pointerType || null) : null;
  const touchIdentifiers = touch
    ? [...touch.changedTouches].slice(0, 8).map((point) => point.identifier)
    : [];
  return {
    event: "pointer-type-origin",
    inputKind: inputKindFor(rawPointerType, eventInterface),
    rawPointerType,
    typeSource: typeSourceFor(eventInterface),
    eventInterface,
    eventType: event.type,
    listener,
    listenerPhase,
    isTrusted: event.isTrusted,
    eventPhase: event.eventPhase,
    target: describeTarget(event.target),
    composedPath: composedPathLabels(event),
    pointerId: pointer ? pointer.pointerId : null,
    touchIdentifiers
  };
}

function inputKindFor(rawPointerType: string | null, eventInterface: PointerTypeOrigin["eventInterface"]): PointerInputKind {
  if (eventInterface === "TouchEvent") return "touch";
  if (rawPointerType === "pen" || rawPointerType === "touch" || rawPointerType === "mouse") return rawPointerType;
  return "other";
}

function typeSourceFor(eventInterface: PointerTypeOrigin["eventInterface"]): PointerTypeOrigin["typeSource"] {
  if (eventInterface === "PointerEvent") return "PointerEvent.pointerType";
  if (eventInterface === "TouchEvent") return "TouchEvent";
  if (eventInterface === "WheelEvent") return "WheelEvent";
  return "GestureEvent";
}

function pointerEventOf(event: Event): PointerEvent | null {
  if (touchEventOf(event) || wheelEventOf(event)) return null;
  if (event instanceof PointerEvent) return event;
  if ("pointerType" in event && typeof (event as PointerEvent).pointerType === "string") return event as PointerEvent;
  return null;
}

function touchEventOf(event: Event): TouchEvent | null {
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) return event;
  if (event.type.startsWith("touch") && "changedTouches" in event) return event as TouchEvent;
  return null;
}

function wheelEventOf(event: Event): WheelEvent | null {
  if (typeof WheelEvent !== "undefined" && event instanceof WheelEvent) return event;
  return event.type === "wheel" ? event as WheelEvent : null;
}

function eventInterfaceOf(event: Event): PointerTypeOrigin["eventInterface"] {
  if (touchEventOf(event)) return "TouchEvent";
  if (wheelEventOf(event)) return "WheelEvent";
  if (pointerEventOf(event)) return "PointerEvent";
  return "other";
}

function composedPathLabels(event: Event): string[] {
  const path = typeof event.composedPath === "function" ? event.composedPath().slice(0, 8) : [];
  return path.map((entry) => describeTarget(entry));
}

function cloneOrigin(origin: PointerTypeOrigin): PointerTypeOrigin {
  return {
    ...origin,
    composedPath: [...origin.composedPath],
    touchIdentifiers: [...origin.touchIdentifiers]
  };
}
