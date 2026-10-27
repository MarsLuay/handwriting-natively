export type GestureNavigationEndReason =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "pen-contact"
  | "touch-terminal"
  | "lifecycle"
  | "disabled";

export interface GestureNavigationPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface GestureNavigationFrame {
  generation: number;
  points: readonly GestureNavigationPoint[];
}

export interface GestureNavigationFocalPoint {
  x: number;
  y: number;
}

export interface GestureNavigationControllerOptions {
  getScrollRoot?: () => HTMLElement | null;
  onPan?: (deltaX: number, deltaY: number, clientX: number, clientY: number) => boolean | void;
  minScale?: number;
  maxScale?: number;
  getScale?: () => number;
  onPinchStart?: (frame: GestureNavigationFrame) => { accepted: boolean; scale?: number };
  onPinchPreview?: (scale: number, focalPoint: GestureNavigationFocalPoint) => void;
  onPinchEnd?: (scale: number, reason: GestureNavigationEndReason) => void;
};

export interface GestureNavigationPointerContext {
  surface: HTMLElement;
  route: string;
  pointerType: "pen" | "mouse" | "touch";
  customHandPanEnabled?: boolean;
  customNavigationEnabled?: boolean;
}

interface HandPointer {
  surface: HTMLElement;
  clientX: number;
  clientY: number;
}

interface TouchPointer extends GestureNavigationPoint {
  surface: HTMLElement;
  startX: number;
  startY: number;
  route: string;
  mode: "annotation" | "navigation" | "ignored";
  didPan: boolean;
}

interface ActivePinch {
  startDistance: number;
  startScale: number;
  lastScale: number;
}

export interface GestureNavigationPointerResult {
  handled: boolean;
  route?: string;
  reason?: string;
  cancelledTouchIds?: number[];
}

const TOUCH_PAN_THRESHOLD_PX = 8;

function capturePointer(surface: Element, pointerId: number): void {
  try {
    surface.setPointerCapture?.(pointerId);
  } catch {
    // The browser may already have canceled the contact.
  }
}

function releasePointer(surface: Element, pointerId: number): void {
  try {
    if (surface.hasPointerCapture?.(pointerId)) surface.releasePointerCapture?.(pointerId);
  } catch {
    // A viewer replacement may release capture first.
  }
}

function distance(points: readonly GestureNavigationPoint[]): number {
  const first = points[0];
  const second = points[1];
  return first && second ? Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) : 0;
}

function midpoint(points: readonly GestureNavigationPoint[]): GestureNavigationFocalPoint | null {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
}

/** Owns stylus hand-pan, companion-touch blocking, and qualified mobile PDF navigation. */
export class GestureNavigationController {
  private readonly activePens = new Set<number>();
  private readonly handPointers = new Map<number, HandPointer>();
  private readonly touchPointers = new Map<number, TouchPointer>();
  private readonly nativeFallbackTouchPointers = new Map<number, HTMLElement>();
  private readonly originalTouchNone = new Map<HTMLElement, { hadClass: boolean; customNavigationEnabled: boolean }>();
  private panningSurface: HTMLElement | null = null;
  private activePinch: ActivePinch | null = null;
  private previousTouchCenter: GestureNavigationFocalPoint | null = null;
  private destroyed = false;

  constructor(private readonly options: GestureNavigationControllerOptions = {}) {}

  attachSurface(surface: HTMLElement, customNavigationEnabled = false): void {
    const existing = this.originalTouchNone.get(surface);
    if (!existing) {
      this.originalTouchNone.set(surface, {
        hadClass: surface.classList.contains("native-pdf-handwriting-touch-none"),
        customNavigationEnabled
      });
    } else {
      const wasEnabled = existing.customNavigationEnabled;
      existing.customNavigationEnabled = customNavigationEnabled;
      if (wasEnabled && !customNavigationEnabled) this.cancelForSurface(surface, "disabled");
    }
    this.syncSurfacePolicy(surface);
  }

  detachSurface(surface: HTMLElement): void {
    const original = this.originalTouchNone.get(surface);
    if (!original) return;
    this.cancelForSurface(surface, "lifecycle");
    surface.classList.toggle("native-pdf-handwriting-touch-none", original.hadClass);
    this.originalTouchNone.delete(surface);
  }

  isActive(): boolean {
    return this.handPointers.size > 0 || this.touchPointersHasNavigation();
  }

  ownsPointer(pointerId: number): boolean {
    return this.handPointers.has(pointerId)
      || this.touchPointers.get(pointerId)?.mode === "navigation";
  }

  recaptureNavigationPointer(pointerId: number): void {
    const contact = this.touchPointers.get(pointerId);
    if (contact?.mode === "navigation") capturePointer(contact.surface, pointerId);
  }

  activePointerIds(): number[] {
    return [...new Set([...this.handPointers.keys(), ...this.navigationTouchPointers().map(({ pointerId }) => pointerId)])];
  }

  hasActivePen(): boolean {
    return this.activePens.size > 0;
  }

  hasNativeFallbackTouches(): boolean {
    return this.nativeFallbackTouchPointers.size > 0;
  }

  clearNativeFallbackTouches(): void {
    if (this.nativeFallbackTouchPointers.size === 0) return;
    this.nativeFallbackTouchPointers.clear();
    this.syncAttachedSurfacePolicies();
  }

  handleTouchTerminal(event: TouchEvent): void {
    if (event.touches.length !== 0) return;
    this.clearNativeFallbackTouches();
    // Some mobile browsers can omit the matching pointerup after the final
    // touchend. Do not leave those contacts holding a phantom pinch open.
    this.cancelTouchContacts("touch-terminal");
  }

  reconcilePenContacts(activePenIds: readonly number[]): void {
    this.activePens.clear();
    for (const pointerId of activePenIds) this.activePens.add(pointerId);
    if (this.hasActivePen()) this.cancelTouchContacts("pen-contact");
    this.syncAttachedSurfacePolicies();
  }

  blockCompanionTouch(event: TouchEvent): boolean {
    if (!this.hasActivePen()) return false;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  handlePointerDown(
    event: PointerEvent,
    context: GestureNavigationPointerContext,
    generation = 0
  ): GestureNavigationPointerResult {
    if (this.destroyed) return { handled: false };
    if (event.pointerType === "touch") {
      return this.handleTouchPointerDown(event, context, generation);
    }
    if (context.route !== "drag"
      || context.pointerType !== "pen"
      || context.customHandPanEnabled === false
      || event.button !== 0
      || event.isPrimary === false) {
      return { handled: false };
    }

    this.handPointers.set(event.pointerId, {
      surface: context.surface,
      clientX: event.clientX,
      clientY: event.clientY
    });
    capturePointer(context.surface, event.pointerId);
    this.setPanningSurface(context.surface, true);
    this.preventPointer(event);
    return { handled: true, route: "drag", reason: "stylus-hand-tool" };
  }

  private handleTouchPointerDown(
    event: PointerEvent,
    context: GestureNavigationPointerContext,
    generation: number
  ): GestureNavigationPointerResult {
    if (this.hasActivePen()) {
      return { handled: true, route: "native", reason: "stylus-active" };
    }
    if (this.nativeFallbackTouchPointers.size > 0) {
      this.trackNativeFallbackTouch(event.pointerId, context.surface);
      return { handled: true, route: "native", reason: "native-touch-fallback-active" };
    }
    const existing = this.navigationTouchPointers();
    if (!context.customNavigationEnabled || context.route === "ignored") {
      if (this.touchPointers.size === 0) return { handled: false };
      const cancelledTouchIds = this.cancelTouchContactsToNative(event.pointerId, context.surface, "disabled");
      return {
        handled: true,
        route: "native",
        reason: "custom-gesture-cancelled-for-ineligible-contact",
        cancelledTouchIds
      };
    }

    const annotationRoute = context.route === "draw" || context.route === "edit" || context.route === "text";
    if (existing.length === 0 && annotationRoute) {
      this.touchPointers.set(event.pointerId, {
        pointerId: event.pointerId,
        surface: context.surface,
        clientX: event.clientX,
        clientY: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        route: context.route,
        mode: "annotation",
        didPan: false
      });
      return { handled: false };
    }

    const candidate: TouchPointer = {
      pointerId: event.pointerId,
      surface: context.surface,
      clientX: event.clientX,
      clientY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      route: context.route,
      mode: "navigation",
      didPan: false
    };
    const priorPointers = this.navigationTouchPointers();
    this.touchPointers.set(event.pointerId, candidate);
    const points = this.navigationFrame(generation).points.slice(0, 2);
    const cancelledTouchIds = priorPointers
      .filter((pointer) => pointer.mode === "annotation")
      .map((pointer) => pointer.pointerId);

    if (points.length >= 2 && !this.activePinch) {
      const startDistance = distance(points);
      const focalPoint = midpoint(points);
      const result = startDistance > 1 && focalPoint
        ? this.options.onPinchStart?.({ generation, points })
        : undefined;
      if (!result?.accepted) {
        this.touchPointers.delete(event.pointerId);
        const cancelledTouchIds = this.cancelTouchContactsToNative(event.pointerId, context.surface, "disabled");
        return {
          handled: true,
          route: "native",
          reason: "custom-pinch-rejected",
          cancelledTouchIds
        };
      }
      this.activePinch = {
        startDistance,
        startScale: this.clampScale(result.scale ?? this.options.getScale?.() ?? 1),
        lastScale: this.clampScale(result.scale ?? this.options.getScale?.() ?? 1)
      };
      for (const pointer of this.navigationTouchPointers()) {
        pointer.mode = "navigation";
        pointer.didPan = true;
        capturePointer(pointer.surface, pointer.pointerId);
      }
      this.previousTouchCenter = focalPoint;
      this.setPanningSurface(candidate.surface, true);
      this.syncAttachedSurfacePolicies();
      this.preventPointer(event);
      return { handled: true, route: "touch-custom-pinch", reason: "qualified-mobile-pdf-pinch", cancelledTouchIds };
    }

    if (priorPointers.length >= 2) {
      candidate.mode = "ignored";
      this.preventPointer(event);
      return { handled: true, route: "ignored", reason: "extra-touch-contact" };
    }

    for (const pointer of this.navigationTouchPointers()) {
      pointer.mode = "navigation";
      capturePointer(pointer.surface, pointer.pointerId);
    }
    capturePointer(context.surface, event.pointerId);
    this.previousTouchCenter = { x: event.clientX, y: event.clientY };
    this.setPanningSurface(context.surface, true);
    this.syncAttachedSurfacePolicies();
    return { handled: true, route: "touch-pan", reason: "qualified-mobile-pdf-pan", cancelledTouchIds };
  }

  handlePointerMove(event: PointerEvent): boolean {
    const hand = this.handPointers.get(event.pointerId);
    if (hand) {
      const deltaX = event.clientX - hand.clientX;
      const deltaY = event.clientY - hand.clientY;
      hand.clientX = event.clientX;
      hand.clientY = event.clientY;
      if (deltaX !== 0 || deltaY !== 0) this.applyPan(deltaX, deltaY, event.clientX, event.clientY);
      this.preventPointer(event);
      return true;
    }

    const touch = this.touchPointers.get(event.pointerId);
    if (!touch || touch.mode !== "navigation") return false;
    const oldX = touch.clientX;
    const oldY = touch.clientY;
    touch.clientX = event.clientX;
    touch.clientY = event.clientY;
    const points = this.navigationFrame(0).points.slice(0, 2);
    if (this.activePinch && points.length >= 2) {
      const center = midpoint(points);
      const currentDistance = distance(points);
      if (center && currentDistance > 1) {
        const previousCenter = this.previousTouchCenter;
        if (previousCenter) {
          this.applyPan(
            center.x - previousCenter.x,
            center.y - previousCenter.y,
            center.x,
            center.y
          );
        }
        const nextScale = this.clampScale(this.activePinch.startScale * currentDistance / this.activePinch.startDistance);
        this.activePinch.lastScale = nextScale;
        this.options.onPinchPreview?.(nextScale, center);
        this.previousTouchCenter = center;
      }
    } else {
      const deltaX = event.clientX - oldX;
      const deltaY = event.clientY - oldY;
      const distanceFromStart = Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY);
      if (!touch.didPan && distanceFromStart < TOUCH_PAN_THRESHOLD_PX) return false;
      if (!touch.didPan) {
        touch.didPan = true;
        this.applyPan(event.clientX - touch.startX, event.clientY - touch.startY, event.clientX, event.clientY);
      } else if (deltaX !== 0 || deltaY !== 0) {
        this.applyPan(deltaX, deltaY, event.clientX, event.clientY);
      }
      this.previousTouchCenter = { x: event.clientX, y: event.clientY };
    }
    this.preventPointer(event);
    return true;
  }

  handlePointerEnd(event: PointerEvent, reason: GestureNavigationEndReason = "pointerup"): boolean {
    if (this.nativeFallbackTouchPointers.has(event.pointerId)) {
      // Explicit capture release may emit lostpointercapture while the finger
      // is still down. Keep native fallback active until a physical terminal.
      if (reason !== "lostpointercapture") {
        this.nativeFallbackTouchPointers.delete(event.pointerId);
        if (this.nativeFallbackTouchPointers.size === 0) this.syncAttachedSurfacePolicies();
      }
      return false;
    }
    const hand = this.handPointers.get(event.pointerId);
    if (hand) {
      this.handPointers.delete(event.pointerId);
      releasePointer(hand.surface, event.pointerId);
      if (this.handPointers.size === 0 && !this.touchPointersHasNavigation()) this.setPanningSurface(hand.surface, false);
      if (reason !== "lostpointercapture") this.preventPointer(event);
      return true;
    }

    const touch = this.touchPointers.get(event.pointerId);
    if (!touch) return false;
    this.touchPointers.delete(event.pointerId);
    if (touch.mode === "annotation") {
      this.syncSurfacePolicy(touch.surface);
      return false;
    }
    const wasGesture = touch.didPan || this.activePinch !== null;
    releasePointer(touch.surface, event.pointerId);
    if (this.activePinch && this.navigationTouchPointers().length < 2) this.endPinch(reason);
    const remaining = this.navigationTouchPointers();
    this.previousTouchCenter = remaining.length === 1
      ? { x: remaining[0]!.clientX, y: remaining[0]!.clientY }
      : null;
    if (remaining.length === 0 && this.handPointers.size === 0) this.setPanningSurface(touch.surface, false);
    this.syncAttachedSurfacePolicies();
    if (wasGesture && reason !== "lostpointercapture") this.preventPointer(event);
    return true;
  }

  cancelForSurface(surface: HTMLElement, reason: GestureNavigationEndReason): void {
    for (const [pointerId, contact] of [...this.handPointers]) {
      if (contact.surface !== surface) continue;
      releasePointer(contact.surface, pointerId);
      this.handPointers.delete(pointerId);
    }
    const touchContacts = [...this.touchPointers.values()].filter((contact) => contact.surface === surface);
    if (touchContacts.length > 0) {
      if (this.activePinch) this.endPinch(reason);
      for (const [pointerId, contact] of [...this.touchPointers]) {
        if (contact.mode === "navigation") releasePointer(contact.surface, pointerId);
        this.touchPointers.delete(pointerId);
      }
      this.previousTouchCenter = null;
    }
    let removedFallbackPointer = false;
    for (const [pointerId, pointerSurface] of this.nativeFallbackTouchPointers) {
      if (pointerSurface !== surface) continue;
      this.nativeFallbackTouchPointers.delete(pointerId);
      removedFallbackPointer = true;
    }
    if (this.handPointers.size === 0 && !this.touchPointersHasNavigation() && this.panningSurface) {
      this.setPanningSurface(this.panningSurface, false);
    }
    if (removedFallbackPointer && this.nativeFallbackTouchPointers.size === 0) {
      this.syncAttachedSurfacePolicies();
    } else {
      this.syncSurfacePolicy(surface);
    }
  }

  clearContacts(): void {
    for (const [pointerId, contact] of this.handPointers) releasePointer(contact.surface, pointerId);
    for (const [pointerId, contact] of this.touchPointers) {
      if (contact.mode === "navigation") releasePointer(contact.surface, pointerId);
    }
    if (this.activePinch) this.endPinch("lifecycle");
    this.handPointers.clear();
    this.touchPointers.clear();
    this.nativeFallbackTouchPointers.clear();
    this.activePens.clear();
    this.previousTouchCenter = null;
    if (this.panningSurface) this.setPanningSurface(this.panningSurface, false);
    this.syncAttachedSurfacePolicies();
  }

  cancelTouchContacts(reason: GestureNavigationEndReason): void {
    if (this.activePinch) this.endPinch(reason);
    for (const [pointerId, contact] of this.touchPointers) {
      if (contact.mode === "navigation") releasePointer(contact.surface, pointerId);
    }
    this.touchPointers.clear();
    this.previousTouchCenter = null;
    if (this.handPointers.size === 0 && this.panningSurface) this.setPanningSurface(this.panningSurface, false);
    this.syncAttachedSurfacePolicies();
  }

  private cancelTouchContactsToNative(
    joiningPointerId: number,
    joiningSurface: HTMLElement,
    reason: GestureNavigationEndReason
  ): number[] {
    const contacts = [...this.touchPointers.values()];
    const cancelledTouchIds = contacts
      .filter((pointer) => pointer.mode === "annotation")
      .map((pointer) => pointer.pointerId);
    this.cancelTouchContacts(reason);
    for (const contact of contacts) this.trackNativeFallbackTouch(contact.pointerId, contact.surface, false);
    this.trackNativeFallbackTouch(joiningPointerId, joiningSurface, false);
    this.syncAttachedSurfacePolicies();
    return cancelledTouchIds;
  }

  private trackNativeFallbackTouch(pointerId: number, surface: HTMLElement, sync = true): void {
    this.nativeFallbackTouchPointers.set(pointerId, surface);
    if (sync) this.syncAttachedSurfacePolicies();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearContacts();
    for (const [surface, original] of this.originalTouchNone) {
      surface.classList.toggle("native-pdf-handwriting-touch-none", original.hadClass);
    }
    this.originalTouchNone.clear();
  }

  private applyPan(deltaX: number, deltaY: number, clientX: number, clientY: number): void {
    if (this.options.onPan) {
      this.options.onPan(deltaX, deltaY, clientX, clientY);
      return;
    }
    const root = this.options.getScrollRoot?.();
    if (!root) return;
    root.scrollLeft -= deltaX;
    root.scrollTop -= deltaY;
  }

  private syncSurfacePolicy(surface: HTMLElement): void {
    const original = this.originalTouchNone.get(surface);
    if (!original) return;
    const none = original.hadClass
      || (original.customNavigationEnabled && !this.hasNativeFallbackTouches())
      || this.hasActivePen();
    surface.classList.toggle("native-pdf-handwriting-touch-none", none);
  }

  private syncAttachedSurfacePolicies(): void {
    for (const surface of this.originalTouchNone.keys()) this.syncSurfacePolicy(surface);
  }

  private setPanningSurface(surface: HTMLElement, active: boolean): void {
    if (this.panningSurface && this.panningSurface !== surface) {
      this.panningSurface.classList.remove("native-pdf-handwriting-panning");
    }
    this.panningSurface = active ? surface : null;
    surface.ownerDocument.body?.classList.toggle("native-pdf-handwriting-panning", active);
    surface.classList.toggle("native-pdf-handwriting-panning", active);
  }

  private preventPointer(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  private navigationTouchPointers(): TouchPointer[] {
    return [...this.touchPointers.values()].filter((contact) => contact.mode !== "ignored");
  }

  private touchPointersHasNavigation(): boolean {
    return [...this.touchPointers.values()].some((contact) => contact.mode === "navigation");
  }

  private navigationFrame(generation: number): GestureNavigationFrame {
    return {
      generation,
      points: this.navigationTouchPointers().map(({ pointerId, clientX, clientY }) => ({ pointerId, clientX, clientY }))
    };
  }

  private clampScale(scale: number): number {
    const min = this.options.minScale ?? 0.1;
    const max = this.options.maxScale ?? 10;
    return Math.max(min, Math.min(max, Number.isFinite(scale) ? scale : 1));
  }

  private endPinch(reason: GestureNavigationEndReason): void {
    const active = this.activePinch;
    if (!active) return;
    this.options.onPinchEnd?.(active.lastScale, reason);
    this.activePinch = null;
  }
}
