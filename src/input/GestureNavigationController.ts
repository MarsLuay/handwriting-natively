/*
 * Behavior adapted from hata-suriiken/obsidian-mobile-pinch-zoom,
 * revision 8fe3152eb82c2084fbb847e1c445312145134b66 (MIT).
 */

export interface GestureNavigationPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface GestureNavigationFrame {
  generation: number;
  points: readonly GestureNavigationPoint[];
}

export type GestureNavigationEndReason = "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled";

export interface GestureNavigationFocalPoint {
  x: number;
  y: number;
}

export interface GestureNavigationControllerOptions {
  minScale: number;
  maxScale: number;
  snapScale?: number;
  snapRange?: number;
  animationMs?: number;
  wheelSessionGapMs?: number;
  now?: () => number;
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  getScale: () => number;
  getViewportCenter?: () => GestureNavigationFocalPoint | null;
  onStart: (frame: GestureNavigationFrame) => { accepted: boolean; scale?: number };
  onPreview: (scale: number, focalPoint: GestureNavigationFocalPoint) => void;
  onEnd: (scale: number, reason: GestureNavigationEndReason) => void;
  onCancel: (reason: string) => void;
  onSettled?: (scale: number) => void;
  onEligibility?: (target: EventTarget | null) => boolean;
  onIndicator?: (scale: number, reset: () => void) => void;
  getScrollRoot?: () => HTMLElement | null;
  isHandMode?: () => boolean;
  onPan?: (deltaX: number, deltaY: number, clientX: number, clientY: number) => boolean | void;
  onFrame?: (frame: GestureNavigationFrame) => void;
}

export interface GestureNavigationPointerContext {
  surface: HTMLElement;
  route: string;
  customNavigationEnabled: boolean;
}

interface TrackedNavigationPointer extends GestureNavigationPoint {
  surface: HTMLElement;
  mode: "touch" | "hand" | "annotation";
  blockNativeTouch: boolean;
  startX: number;
  startY: number;
  started: boolean;
}

/** Result is true only when this controller has claimed movement for the pointer. */
export interface GestureNavigationPointerResult {
  handled: boolean;
  route?: string;
  reason?: string;
  cancelledTouchIds?: number[];
}

const TOUCH_PAN_THRESHOLD_PX = 4;

export interface GestureNavigationWheelEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

export interface GestureNavigationWheelPanEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  clientX: number;
  clientY: number;
}

interface ActivePinch {
  startDistance: number;
  startScale: number;
  focalPoint: GestureNavigationFocalPoint;
  lastScale: number;
}

const DEFAULT_ANIMATION_MS = 180;
const DEFAULT_SNAP_RANGE = 0.05;
const DEFAULT_WHEEL_SESSION_GAP_MS = 300;

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultRequestFrame(callback: (timestamp: number) => void): number {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  if (typeof window !== "undefined") {
    return window.setTimeout(() => callback(defaultNow()), 16);
  }
  return 0;
}

function defaultCancelFrame(handle: number): void {
  if (typeof window === "undefined") return;
  if (window.cancelAnimationFrame) window.cancelAnimationFrame(handle);
  else window.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function defaultSetTimer(callback: () => void, delayMs: number): number {
  return typeof window === "undefined" ? 0 : window.setTimeout(callback, delayMs);
}

function defaultClearTimer(handle: number): void {
  if (typeof window !== "undefined") window.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function distance(points: readonly GestureNavigationPoint[]): number {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function midpoint(points: readonly GestureNavigationPoint[]): GestureNavigationFocalPoint | null {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2
  };
}

function capturePointer(surface: Element, pointerId: number): void {
  try {
    surface.setPointerCapture?.(pointerId);
  } catch {
    // Capture can fail when the browser has already canceled the contact.
  }
}

function releasePointer(surface: Element, pointerId: number): void {
  try {
    if (surface.hasPointerCapture?.(pointerId)) surface.releasePointerCapture?.(pointerId);
  } catch {
    // The host may release capture during a page or viewer handoff.
  }
}

/**
 * PDF session remains responsible for the private PDF.js scale commit and
 * temporary page/ink compositor.
 */
export class GestureNavigationController {
  private readonly snapScale: number;
  private readonly snapRange: number;
  private readonly animationMs: number;
  private readonly wheelSessionGapMs: number;
  private readonly now: () => number;
  private readonly requestFrame: (callback: (timestamp: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private active: ActivePinch | null = null;
  private pending: { scale: number; focalPoint: GestureNavigationFocalPoint } | null = null;
  private previewFrame: number | null = null;
  private animationFrame: number | null = null;
  private wheelTimer: number | null = null;
  private wheelLastAt = 0;
  private wheelTarget: number | null = null;
  private destroyed = false;
  private readonly activePens = new Set<number>();
  private readonly navigationPointers = new Map<number, TrackedNavigationPointer>();
  private readonly originalTouchClasses = new Map<HTMLElement, {
    none: boolean;
    pan: boolean;
    custom: boolean;
    customNavigationEnabled: boolean;
  }>();
  private touchFallbackActive = false;
  private panningSurface: HTMLElement | null = null;
  private previousPanCenter: GestureNavigationFocalPoint | null = null;

  constructor(private readonly options: GestureNavigationControllerOptions) {
    this.snapScale = options.snapScale ?? 1;
    this.snapRange = options.snapRange ?? DEFAULT_SNAP_RANGE;
    this.animationMs = options.animationMs ?? DEFAULT_ANIMATION_MS;
    this.wheelSessionGapMs = options.wheelSessionGapMs ?? DEFAULT_WHEEL_SESSION_GAP_MS;
    this.now = options.now ?? defaultNow;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  attachSurface(surface: HTMLElement, customNavigationEnabled: boolean): void {
    if (!this.originalTouchClasses.has(surface)) {
      this.originalTouchClasses.set(surface, {
        none: surface.classList.contains("native-pdf-handwriting-touch-none"),
        pan: surface.classList.contains("native-pdf-handwriting-touch-pan-xy"),
        custom: surface.classList.contains("native-pdf-handwriting-touch-custom-pinch"),
        customNavigationEnabled
      });
    } else {
      const policy = this.originalTouchClasses.get(surface);
      if (policy) policy.customNavigationEnabled = customNavigationEnabled;
    }
    this.syncSurfacePolicy(surface);
  }

  syncSurfacePolicy(surface: HTMLElement): void {
    const policy = this.originalTouchClasses.get(surface);
    if (!policy) return;
    const annotationContact = [...this.navigationPointers.values()].some((contact) =>
      contact.surface === surface && contact.blockNativeTouch
    );
    const customNavigationEnabled = policy.customNavigationEnabled;
    const touchNone = !customNavigationEnabled && (this.hasActivePen() || annotationContact);
    surface.classList.toggle("native-pdf-handwriting-touch-custom-pinch", customNavigationEnabled);
    surface.classList.toggle("native-pdf-handwriting-touch-none", touchNone);
    surface.classList.toggle("native-pdf-handwriting-touch-pan-xy", !customNavigationEnabled && !touchNone);
  }

  private syncAttachedSurfacePolicies(): void {
    for (const surface of this.originalTouchClasses.keys()) this.syncSurfacePolicy(surface);
  }

  detachSurface(surface: HTMLElement): void {
    const original = this.originalTouchClasses.get(surface);
    if (!original) return;
    this.cancelForSurface(surface, "lifecycle");
    surface.classList.toggle("native-pdf-handwriting-touch-custom-pinch", original.custom);
    surface.classList.toggle("native-pdf-handwriting-touch-none", original.none);
    surface.classList.toggle("native-pdf-handwriting-touch-pan-xy", original.pan);
    this.originalTouchClasses.delete(surface);
  }

  activeTouchIds(): number[] {
    return [...this.navigationPointers.values()]
      .filter((contact) => contact.mode !== "hand")
      .map(({ pointerId }) => pointerId);
  }

  ownsPointer(pointerId: number): boolean {
    return this.navigationPointers.has(pointerId);
  }

  activePointerIds(): number[] {
    return [...this.navigationPointers.keys()];
  }

  hasActivePen(): boolean {
    return this.activePens.size > 0;
  }

  reconcilePenContacts(activePenIds: readonly number[]): void {
    this.activePens.clear();
    for (const pointerId of activePenIds) this.activePens.add(pointerId);
    this.syncAttachedSurfacePolicies();
  }

  blockCompanionTouch(event: TouchEvent): boolean {
    if (!this.hasActivePen()) return false;
    this.preventTouch(event);
    return true;
  }

  handlePointerDown(
    event: PointerEvent,
    context: GestureNavigationPointerContext,
    generation = 0
  ): GestureNavigationPointerResult {
    if (this.destroyed) return { handled: false };
    if (event.pointerType === "pen") {
      this.activePens.add(event.pointerId);
      if (this.isActive()) this.end("pen-contact");
      this.syncAttachedSurfacePolicies();
      if (context.route !== "drag" && this.options.isHandMode?.() !== true) return { handled: false };
    }

    if (event.pointerType === "touch" && this.hasActivePen()) {
      this.preventPointer(event);
      return { handled: true, route: "ignored", reason: "stylus-active" };
    }

    const handMode = context.route === "drag" || this.options.isHandMode?.() === true;
    if (handMode && event.pointerType !== "touch"
      && event.button === 0 && event.isPrimary !== false) {
      this.navigationPointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        surface: context.surface,
        mode: "hand",
        blockNativeTouch: false,
        startX: event.clientX,
        startY: event.clientY,
        started: true
      });
      capturePointer(context.surface, event.pointerId);
      this.setPanningSurface(context.surface, true);
      this.preventPointer(event);
      return { handled: true, route: "drag", reason: "hand-tool" };
    }

    if (event.pointerType !== "touch" || context.route === "ignored") {
      return { handled: false };
    }

    const priorTouchIds = this.activeTouchIds();
    const annotationRoute = context.route === "draw" || context.route === "edit" || context.route === "text";
    if (annotationRoute && priorTouchIds.length === 0) {
      this.navigationPointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        surface: context.surface,
        mode: "annotation",
        blockNativeTouch: context.route === "draw" || context.route === "edit",
        startX: event.clientX,
        startY: event.clientY,
        started: false
      });
      this.syncSurfacePolicy(context.surface);
      return { handled: false };
    }
    if (!context.customNavigationEnabled) {
      this.navigationPointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        surface: context.surface,
        mode: "annotation",
        blockNativeTouch: annotationRoute && (context.route === "draw" || context.route === "edit"),
        startX: event.clientX,
        startY: event.clientY,
        started: false
      });
      this.syncSurfacePolicy(context.surface);
      return { handled: false };
    }
    this.navigationPointers.set(event.pointerId, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      surface: context.surface,
      mode: annotationRoute && priorTouchIds.length === 0 ? "annotation" : "touch",
      blockNativeTouch: false,
      startX: event.clientX,
      startY: event.clientY,
      started: priorTouchIds.length >= 1
    });
    for (const priorId of priorTouchIds) {
      const prior = this.navigationPointers.get(priorId);
      if (prior) prior.mode = "touch";
    }
    capturePointer(context.surface, event.pointerId);
    this.setPanningSurface(context.surface, true);
    this.syncSurfacePolicy(context.surface);
    const touchCount = this.activeTouchIds().length;
    if (touchCount >= 2) {
      const points = this.currentNavigationFrame(generation).points;
      this.previousPanCenter = midpoint(points);
      this.start({ generation, points });
    } else {
      this.previousPanCenter = { x: event.clientX, y: event.clientY };
    }
    if (touchCount >= 2) this.preventPointer(event);
    return {
      handled: true,
      route: touchCount >= 2 ? "touch-custom-pinch" : "touch-pan",
      reason: touchCount >= 2 ? "controller-multitouch" : "controller-touch-pan",
      cancelledTouchIds: priorTouchIds
    };
  }

  handlePointerMove(event: PointerEvent, generation = 0): boolean {
    if (this.destroyed) return false;
    const contact = this.navigationPointers.get(event.pointerId);
    if (!contact) return false;
    if (contact.mode === "annotation") {
      contact.clientX = event.clientX;
      contact.clientY = event.clientY;
      return false;
    }

    const touchPointers = [...this.navigationPointers.values()].filter((pointer) => pointer.mode === "touch");
    const oldCenter = touchPointers.length >= 2
      ? midpoint(this.currentNavigationFrame(generation).points)
      : { x: contact.clientX, y: contact.clientY };
    if (contact.mode === "touch" && !contact.started) {
      const distanceFromStart = Math.hypot(event.clientX - contact.startX, event.clientY - contact.startY);
      if (distanceFromStart < TOUCH_PAN_THRESHOLD_PX) {
        contact.clientX = event.clientX;
        contact.clientY = event.clientY;
        return false;
      }
      contact.started = true;
    }
    contact.clientX = event.clientX;
    contact.clientY = event.clientY;
    const frame = this.currentNavigationFrame(generation);
    const nextCenter = frame.points.length >= 2
      ? midpoint(frame.points)
      : { x: event.clientX, y: event.clientY };

    const compositorOwnsPinchMovement = contact.mode === "touch" && frame.points.length >= 2 && this.isActive();
    if (!compositorOwnsPinchMovement && oldCenter && nextCenter) {
      const deltaX = nextCenter.x - oldCenter.x;
      const deltaY = nextCenter.y - oldCenter.y;
      if (deltaX !== 0 || deltaY !== 0) this.applyPan(deltaX, deltaY, nextCenter.x, nextCenter.y);
    }
    if (contact.mode === "touch" && frame.points.length >= 2) this.frame(frame);
    this.previousPanCenter = nextCenter;
    this.preventPointer(event);
    return true;
  }

  handlePointerEnd(
    event: PointerEvent,
    reason: GestureNavigationEndReason = "pointerup"
  ): boolean {
    if (event.pointerType === "pen" && reason !== "lostpointercapture") {
      this.activePens.delete(event.pointerId);
      this.syncAttachedSurfacePolicies();
    }
    const contact = this.navigationPointers.get(event.pointerId);
    if (!contact) return false;
    this.navigationPointers.delete(event.pointerId);
    if (contact.mode === "annotation") {
      this.syncSurfacePolicy(contact.surface);
      return false;
    }
    releasePointer(contact.surface, event.pointerId);
    const touchCount = this.activeTouchIds().length;
    if (contact.mode === "touch" && this.isActive() && touchCount < 2) this.end(reason);
    if (this.navigationPointers.size === 0) {
      this.previousPanCenter = null;
      this.setPanningSurface(contact.surface, false);
    } else {
      const remaining = [...this.navigationPointers.values()][0];
      this.previousPanCenter = remaining ? { x: remaining.clientX, y: remaining.clientY } : null;
    }
    if (contact.started) this.preventPointer(event);
    return true;
  }

  reconcileTouchTerminal(
    surface: HTMLElement,
    activeTouches: readonly Pick<Touch, "identifier">[]
  ): void {
    const activeTouchIds = new Set(activeTouches.map((touch) => touch.identifier));
    if (this.touchFallbackActive) {
      for (const [pointerId, contact] of [...this.navigationPointers]) {
        if (contact.surface !== surface || contact.mode !== "touch" || activeTouchIds.has(pointerId)) continue;
        releasePointer(contact.surface, pointerId);
        this.navigationPointers.delete(pointerId);
      }
      if (activeTouches.length < 2 && this.isActive()) this.end("pointerup");
      if (activeTouches.length === 0) this.touchFallbackActive = false;
    } else if (activeTouches.length === 0) {
      for (const [pointerId, contact] of [...this.navigationPointers]) {
        if (contact.surface !== surface || contact.mode === "hand") continue;
        releasePointer(contact.surface, pointerId);
        this.navigationPointers.delete(pointerId);
      }
      if (this.isActive()) this.end("pointerup");
    }

    const hasSurfaceContact = [...this.navigationPointers.values()].some((contact) => contact.surface === surface);
    if (!hasSurfaceContact) {
      this.previousPanCenter = null;
      this.setPanningSurface(surface, false);
    }
    this.syncSurfacePolicy(surface);
  }

  handleTouchFallback(event: TouchEvent, surface: HTMLElement, enabled: boolean, generation = 0): boolean {
    if (this.destroyed || !enabled || this.hasActivePen()) return false;
    if (event.type === "touchstart") {
      if (event.touches.length < 2 || this.isActive()) return false;
      for (const [pointerId, contact] of this.navigationPointers) releasePointer(contact.surface, pointerId);
      this.navigationPointers.clear();
      for (const touch of Array.from(event.touches).slice(0, 2)) {
        this.navigationPointers.set(touch.identifier, {
          pointerId: touch.identifier,
          clientX: touch.clientX,
          clientY: touch.clientY,
          surface,
          mode: "touch",
          blockNativeTouch: false,
          startX: touch.clientX,
          startY: touch.clientY,
          started: true
        });
      }
      this.touchFallbackActive = this.navigationPointers.size >= 2;
      const frame = this.currentNavigationFrame(generation);
      this.previousPanCenter = midpoint(frame.points);
      if (!this.touchFallbackActive || !this.start(frame)) {
        this.navigationPointers.clear();
        this.touchFallbackActive = false;
        this.previousPanCenter = null;
        return false;
      }
      this.syncSurfacePolicy(surface);
      return this.touchFallbackActive && this.preventTouch(event);
    }
    if (!this.touchFallbackActive) return false;
    for (const touch of Array.from(event.touches).slice(0, 2)) {
      const contact = this.navigationPointers.get(touch.identifier);
      if (contact) {
        contact.clientX = touch.clientX;
        contact.clientY = touch.clientY;
      }
    }
    if (event.type === "touchmove") {
      const frame = this.currentNavigationFrame(generation);
      const center = midpoint(frame.points);
      if (!this.isActive() && center && this.previousPanCenter) {
        this.applyPan(
          center.x - this.previousPanCenter.x,
          center.y - this.previousPanCenter.y,
          center.x,
          center.y
        );
      }
      if (frame.points.length >= 2) this.frame(frame);
      this.previousPanCenter = center;
      return this.preventTouch(event);
    }
    if (event.type === "touchend" || event.type === "touchcancel") {
      for (const touch of Array.from(event.changedTouches)) this.navigationPointers.delete(touch.identifier);
      const remaining = Array.from(event.touches).slice(0, 2);
      if (remaining.length < 2 && this.isActive()) this.end(event.type === "touchend" ? "pointerup" : "pointercancel");
      if (remaining.length === 0) {
        this.touchFallbackActive = false;
        this.navigationPointers.clear();
        this.previousPanCenter = null;
        this.setPanningSurface(surface, false);
        this.syncSurfacePolicy(surface);
      }
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    return false;
  }

  handleNativeGesture(event: Event, enabled: boolean): boolean {
    if (!enabled || !event.cancelable) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  cancelForSurface(surface: HTMLElement, reason: GestureNavigationEndReason): void {
    for (const [pointerId, contact] of [...this.navigationPointers]) {
      if (contact.surface !== surface) continue;
      releasePointer(contact.surface, pointerId);
      this.navigationPointers.delete(pointerId);
    }
    if (this.isActive()) this.end(reason);
    this.syncSurfacePolicy(surface);
    if (this.navigationPointers.size === 0) {
      this.previousPanCenter = null;
      this.setPanningSurface(surface, false);
    }
  }

  clearContacts(reason: GestureNavigationEndReason = "lifecycle"): void {
    for (const [pointerId, contact] of this.navigationPointers) releasePointer(contact.surface, pointerId);
    this.navigationPointers.clear();
    this.activePens.clear();
    this.touchFallbackActive = false;
    this.previousPanCenter = null;
    if (this.isActive()) this.end(reason);
    this.setPanningSurface(this.panningSurface, false);
    this.syncAttachedSurfacePolicies();
  }

  start(frame: GestureNavigationFrame): boolean {
    if (this.destroyed || frame.points.length < 2) return false;
    const startDistance = distance(frame.points);
    const focalPoint = midpoint(frame.points);
    if (!Number.isFinite(startDistance) || startDistance <= 1 || !focalPoint) return false;

    this.cancelAnimation("pinch-replaced");
    this.flushPreview();
    const result = this.options.onStart(frame);
    if (!result.accepted) return false;
    const startScale = this.clamp(result.scale ?? this.options.getScale());
    this.active = {
      startDistance,
      startScale,
      focalPoint,
      lastScale: startScale
    };
    this.wheelTarget = null;
    this.updateIndicator(startScale);
    return true;
  }

  frame(frame: GestureNavigationFrame): void {
    if (this.destroyed || !this.active || frame.points.length < 2) return;
    this.options.onFrame?.(frame);
    const active = this.active;
    const currentDistance = distance(frame.points);
    const focalPoint = midpoint(frame.points);
    if (!Number.isFinite(currentDistance) || currentDistance <= 1 || !focalPoint) return;
    active.focalPoint = focalPoint;
    this.queuePreview(this.clamp(active.startScale * currentDistance / active.startDistance), focalPoint);
  }

  end(reason: GestureNavigationEndReason): void {
    if (this.destroyed || !this.active) return;
    this.flushPreview();
    if (reason !== "pointerup") {
      this.active = null;
      this.wheelTarget = null;
      this.options.onCancel(reason);
      return;
    }
    const active = this.active;
    // A physical pinch ends at the scale the user chose. Snapping or easing
    // here creates a second zoom gesture after the fingers leave the page;
    // command and ctrl/meta-wheel sessions retain their existing settle policy.
    if (this.wheelTarget === null) {
      this.finish(active.lastScale, reason);
      return;
    }
    const target = Math.abs(active.lastScale - this.snapScale) <= this.snapRange
      ? this.snapScale
      : active.lastScale;
    if (Math.abs(target - active.lastScale) > 0.001) {
      this.animateTo(target, active.focalPoint);
      return;
    }
    this.finish(target, reason);
  }

  handleWheel(event: GestureNavigationWheelEvent): boolean {
    if (this.destroyed || (!event.ctrlKey && !event.metaKey)) return false;
    if (this.options.onEligibility && !this.options.onEligibility(event.target)) return false;
    const now = this.now();
    if (!this.active || this.wheelTarget === null || now - this.wheelLastAt > this.wheelSessionGapMs) {
      this.cancelAnimation("wheel-start");
      this.flushPreview();
      const focalPoint = { x: event.clientX, y: event.clientY };
      const frame: GestureNavigationFrame = {
        generation: 0,
        points: [
          { pointerId: -1, clientX: focalPoint.x - 1, clientY: focalPoint.y },
          { pointerId: -2, clientX: focalPoint.x + 1, clientY: focalPoint.y }
        ]
      };
      const result = this.options.onStart(frame);
      if (!result.accepted) return false;
      const startScale = this.clamp(result.scale ?? this.options.getScale());
      this.active = { startDistance: 2, startScale, focalPoint, lastScale: startScale };
      this.wheelTarget = startScale;
      this.updateIndicator(startScale);
    }
    this.wheelLastAt = now;
    this.active.focalPoint = { x: event.clientX, y: event.clientY };
    this.wheelTarget = this.clamp((this.wheelTarget ?? this.active.lastScale) * Math.exp(-event.deltaY / 100));
    this.queuePreview(this.wheelTarget, this.active.focalPoint);
    if (this.wheelTimer !== null) this.clearTimer(this.wheelTimer);
    this.wheelTimer = this.setTimer(() => {
      this.wheelTimer = null;
      this.flushPreview();
      this.end("pointerup");
    }, this.wheelSessionGapMs + 50);
    return true;
  }

  handleWheelPan(event: GestureNavigationWheelPanEvent): boolean {
    if (this.destroyed || event.ctrlKey || event.metaKey || (event.deltaX === 0 && event.deltaY === 0)) return false;
    return this.applyPan(-event.deltaX, -event.deltaY, event.clientX, event.clientY);
  }

  reset(): void {
    if (this.destroyed) return;
    this.cancelAnimation("reset");
    this.flushPreview();
    const center = this.options.getViewportCenter?.() ?? { x: 0, y: 0 };
    if (!this.beginCommandSession(center)) return;
    const from = this.clamp(this.options.getScale());
    this.beginAnimation(from, this.clamp(this.snapScale), center);
  }

  zoomBy(delta: number): void {
    if (this.destroyed || !Number.isFinite(delta)) return;
    this.cancelAnimation("command");
    this.flushPreview();
    const center = this.options.getViewportCenter?.() ?? { x: 0, y: 0 };
    if (!this.beginCommandSession(center)) return;
    const from = this.clamp(this.options.getScale());
    this.beginAnimation(from, this.clamp(from + delta), center);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.clearContacts("lifecycle");
    this.destroyed = true;
    this.cancelAnimation("destroy");
    if (this.previewFrame !== null) this.cancelFrame(this.previewFrame);
    this.previewFrame = null;
    if (this.wheelTimer !== null) this.clearTimer(this.wheelTimer);
    this.wheelTimer = null;
    this.pending = null;
    this.active = null;
    this.wheelTarget = null;
    for (const [surface, original] of this.originalTouchClasses) {
      surface.classList.toggle("native-pdf-handwriting-touch-custom-pinch", original.custom);
      surface.classList.toggle("native-pdf-handwriting-touch-none", original.none);
      surface.classList.toggle("native-pdf-handwriting-touch-pan-xy", original.pan);
    }
    this.originalTouchClasses.clear();
  }

  private currentNavigationFrame(generation: number): GestureNavigationFrame {
    return {
      generation,
      points: [...this.navigationPointers.values()]
        .filter((contact) => contact.mode === "touch")
        .sort((left, right) => left.pointerId - right.pointerId)
        .map(({ pointerId, clientX, clientY }) => ({ pointerId, clientX, clientY }))
    };
  }

  private applyPan(deltaX: number, deltaY: number, clientX: number, clientY: number): boolean {
    if (this.options.onPan) {
      return this.options.onPan(deltaX, deltaY, clientX, clientY) !== false;
    }
    const root = this.options.getScrollRoot?.();
    if (!root) return false;
    const beforeLeft = root.scrollLeft;
    const beforeTop = root.scrollTop;
    if (deltaX !== 0) root.scrollLeft -= deltaX;
    if (deltaY !== 0) root.scrollTop -= deltaY;
    return root.scrollLeft !== beforeLeft || root.scrollTop !== beforeTop;
  }

  private setPanningSurface(surface: HTMLElement | null, active: boolean): void {
    if (this.panningSurface && this.panningSurface !== surface) {
      this.panningSurface.classList.remove("native-pdf-handwriting-panning");
    }
    this.panningSurface = active ? surface : null;
    const doc = surface?.ownerDocument;
    doc?.body?.classList.toggle("native-pdf-handwriting-panning", active);
    surface?.classList.toggle("native-pdf-handwriting-panning", active);
  }

  private preventPointer(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  private preventTouch(event: TouchEvent): boolean {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  private queuePreview(scale: number, focalPoint: GestureNavigationFocalPoint): void {
    if (!this.active) return;
    this.pending = { scale, focalPoint };
    if (this.previewFrame !== null) return;
    this.previewFrame = this.requestFrame(() => {
      this.previewFrame = null;
      this.flushPreview();
    });
  }

  private flushPreview(): void {
    if (this.previewFrame !== null) {
      this.cancelFrame(this.previewFrame);
      this.previewFrame = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.active) return;
    this.active.lastScale = pending.scale;
    this.active.focalPoint = pending.focalPoint;
    this.options.onPreview(pending.scale, pending.focalPoint);
    this.updateIndicator(pending.scale);
  }

  private beginCommandSession(focalPoint: GestureNavigationFocalPoint): boolean {
    this.options.onCancel("command-replaced");
    const frame: GestureNavigationFrame = {
      generation: 0,
      points: [
        { pointerId: -1, clientX: focalPoint.x - 1, clientY: focalPoint.y },
        { pointerId: -2, clientX: focalPoint.x + 1, clientY: focalPoint.y }
      ]
    };
    const result = this.options.onStart(frame);
    if (!result.accepted) return false;
    const scale = this.clamp(result.scale ?? this.options.getScale());
    this.active = {
      startDistance: 2,
      startScale: scale,
      focalPoint,
      lastScale: scale
    };
    this.wheelTarget = null;
    this.updateIndicator(scale);
    return true;
  }

  private animateTo(target: number, focalPoint: GestureNavigationFocalPoint): void {
    this.cancelAnimation("animate-replaced");
    const from = this.active?.lastScale ?? this.clamp(this.options.getScale());
    this.beginAnimation(from, target, focalPoint);
  }

  private beginAnimation(from: number, to: number, focalPoint: GestureNavigationFocalPoint): void {
    const clampedFrom = this.clamp(from);
    const clampedTo = this.clamp(to);
    if (Math.abs(clampedTo - clampedFrom) < 0.001) {
      this.options.onPreview(clampedTo, focalPoint);
      this.finish(clampedTo, "pointerup");
      return;
    }
    const startedAt = this.now();
    const ease = (value: number): number => 1 - Math.pow(1 - value, 3);
    const step = (timestamp: number): void => {
      if (this.destroyed) return;
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / this.animationMs));
      const scale = clampedFrom + (clampedTo - clampedFrom) * ease(progress);
      if (this.active) this.active.lastScale = scale;
      this.options.onPreview(scale, focalPoint);
      this.updateIndicator(scale);
      if (progress < 1) {
        this.animationFrame = this.requestFrame(step);
        return;
      }
      this.animationFrame = null;
      if (this.active) this.active.lastScale = clampedTo;
      this.finish(clampedTo, "pointerup");
    };
    this.animationFrame = this.requestFrame(step);
  }

  private finish(scale: number, reason: GestureNavigationEndReason): void {
    this.active = null;
    this.wheelTarget = null;
    this.options.onEnd(scale, reason);
    this.options.onSettled?.(scale);
    this.updateIndicator(scale);
  }

  private cancelAnimation(reason: string): void {
    if (this.animationFrame !== null) {
      this.cancelFrame(this.animationFrame);
      this.animationFrame = null;
      if (this.active) {
        this.active = null;
        this.wheelTarget = null;
        this.options.onCancel(reason);
      }
    }
  }

  private updateIndicator(scale: number): void {
    this.options.onIndicator?.(scale, () => this.reset());
  }

  private clamp(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(this.options.maxScale, Math.max(this.options.minScale, scale));
  }
}
