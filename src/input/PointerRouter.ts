import { appendToBodyOr, createDetachedSpan } from "../vendor/createDetached";
import { setElementCssProps } from "../dom/typeGuards";
import { isInkDrawTool, type ToolId } from "../model";
import { PalmRejectionPolicy, type PenStateResetReason } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isTipContact, remapMouseTipSamples } from "./PenPresence";
import {
  DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES,
  MANIPULATION_REARM_MS,
  ManipulationStateMachine,
  type ManipulationPlatformCapabilities
} from "./ManipulationStateMachine";
import {
  type TouchAxisLock
} from "./TouchAxisPolicy";

export type PointerRoute = "draw" | "edit" | "text" | "touch-pan" | "touch-zoom-pan" | "native" | "ignored";
export type PointerRejectionReason = "annotation-chrome" | "already-handled" | "inactive-owner";
export interface PointerRouterHandoff {
  routed: Array<{ pointerId: number; route: "draw" | "edit" | "text" }>;
  activePenIds: number[];
}

export function isAnnotationChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    ".native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-selection-control, .native-pdf-handwriting-text-input"
  ));
}

/** W3C Pointer Events reports an eraser stylus tip as button 5 / buttons bit 32. */
export function isStylusEraserInput(event: Pick<PointerEvent, "pointerType" | "button" | "buttons">): boolean {
  return (event.pointerType === "pen" || event.pointerType === "mouse")
    && (event.button === 5 || (event.buttons & 32) !== 0);
}

/**
 * `hasPointerCapture` can still be true while `releasePointerCapture` throws
 * NotFoundError (pointer already gone / capture transferred during zoom settle).
 * Optional chaining does not catch DOMException.
 */
export function safeReleasePointerCapture(element: Element, pointerId: number): boolean {
  try {
    if (!element.hasPointerCapture?.(pointerId)) return false;
    element.releasePointerCapture?.(pointerId);
    return true;
  } catch {
    return false;
  }
}

/** Draw-mode single-finger axis lock (Ink dedicated-writing pattern). */
interface TouchAxisGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lock: TouchAxisLock;
  assist: boolean;
  active: boolean;
}

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  /** Event-aware annotation gate (pen/touch/mouse policy). Replaces global Draw mode. */
  canAnnotatePointer(event: PointerEvent): boolean;
  /** True when primary mouse may annotate (cursor chrome / right-click eraser). */
  mouseAnnotationEnabled?(): boolean;
  rightMouseEraserEnabled?(): boolean;
  onStylusEraserStart?(): void;
  onStylusEraserEnd?(): void;
  scrollRoot?(): HTMLElement | null;
  cursorParent?(): HTMLElement;
  eraserCursorDiameter?(): number;
  drawCursorColor?(): string;
  projectCursor?(clientX: number, clientY: number): { x: number; y: number } | null;
  onStart?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onMove?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onEnd?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onCancel?(route: "draw" | "edit" | "text", event: PointerEvent): void;
  onRoute?(route: PointerRoute, event: PointerEvent): void;
  /** Fired as soon as this router's pointerdown listener runs (before classify). */
  onRouterReceived?(event: PointerEvent, generation: number): void;
  /** True when document fallback / another router already owns this pointerId. */
  isPointerHandled?(pointerId: number, generation: number): boolean;
  /** Mark pointerId so document fallback does not start a duplicate stroke. */
  onPointerHandled?(pointerId: number, generation: number): void;
  /** Release pointer ownership when this listener generation is torn down. */
  onPointerOwnerReleased?(generation: number, handoff?: PointerRouterHandoff): void;
  /** Explain pointerdown rejection while the session is still listening. */
  onPointerRejected?(reason: PointerRejectionReason, event: PointerEvent, generation: number): void;
  /** Prevent a superseded session from reclaiming a page during async teardown. */
  isInputOwnerActive?(): boolean;
  /** Native terminal events can land outside a virtualized PDF page. */
  onTouchLifecycle?(
    phase: "primary-reset" | "pointerup" | "pointercancel" | "lostpointercapture" | "scroll-block" | "pen-state" | "touchend" | "touchcancel" | "axis-lock",
    event: Event,
    details: {
      trackedBefore?: number;
      trackedAfter?: number;
      route?: "draw" | "edit" | "text";
      completion?: "document-end" | "document-cancel";
      reason?: string;
      touchCount?: number;
      activePens?: boolean;
      activePenIds?: number[];
      stalePenCleared?: boolean;
      axisLock?: TouchAxisLock;
      dx?: number;
      dy?: number;
    }
  ): void;
  onTouchPan?(phase: "start" | "activate" | "move" | "end" | "abort", event: PointerEvent, details: Record<string, unknown>): void;
  manipulationCapabilities?(): ManipulationPlatformCapabilities;
}

export class PointerRouter {
  private static readonly DRAW_CURSOR_SIZE_PX = 6;
  private static nextGeneration = 1;

  /** Monotonic id for this listener generation (fresh AbortController per instance). */
  readonly generation: number;
  private readonly routed = new Map<number, "draw" | "edit" | "text">();
  private readonly stylusErasers = new Set<number>();
  private readonly touches = new Set<number>();
  private readonly manipulationTouches = new Set<number>();
  private touchAxis: TouchAxisGesture | null = null;
  private readonly manipulation: ManipulationStateMachine;
  private manipulationRearmTimer: number | undefined;
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly abort = new AbortController();
  private readonly eraserCursor: HTMLElement;
  private readonly drawCursor: HTMLElement;
  private lastCursorClient: { x: number; y: number } | null = null;
  private lastCursorPointerType: string | null = null;
  private pendingCursorUpdate: Pick<PointerEvent, "clientX" | "clientY" | "pointerType"> | null = null;
  private cursorAnimationFrame: number | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy = new PalmRejectionPolicy()
  ) {
    this.generation = PointerRouter.nextGeneration++;
    this.manipulation = new ManipulationStateMachine(
      callbacks.manipulationCapabilities?.() ?? DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES
    );
    this.palmPolicy = palmPolicy;
    this.palmPolicy.setResetListener((reason, activePenIds) => {
      this.emitPenStateReset(reason, activePenIds);
    });
    this.eraserCursor = createDetachedSpan(element.ownerDocument);
    this.eraserCursor.className = "native-pdf-handwriting-eraser-cursor";
    this.eraserCursor.setAttribute("aria-hidden", "true");
    this.eraserCursor.hidden = true;
    this.drawCursor = createDetachedSpan(element.ownerDocument);
    this.drawCursor.className = "native-pdf-handwriting-draw-cursor";
    this.drawCursor.setAttribute("aria-hidden", "true");
    this.drawCursor.hidden = true;
    const cursorHost = this.callbacks.cursorParent?.() ?? element;
    appendToBodyOr(element.ownerDocument, this.eraserCursor, cursorHost);
    appendToBodyOr(element.ownerDocument, this.drawCursor, cursorHost);
    // Explicit annotation gestures are handled in capture so a stale router
    // left by a prior plugin session cannot process the same event in bubble.
    // Native text inputs are excluded by isAnnotationChromeTarget above.
    const options = { capture: true, signal: this.abort.signal };
    element.addEventListener("pointerdown", this.handleDown, options);
    element.addEventListener("pointermove", this.handleMove, options);
    element.addEventListener("pointerup", this.handleEnd, options);
    element.addEventListener("pointercancel", this.handleCancel, options);
    element.addEventListener("lostpointercapture", this.handleLostPointerCapture, options);
    element.addEventListener("contextmenu", this.suppressRightMouseEraserMenu, options);
    element.addEventListener("pointerleave", this.hideCustomCursors, options);
    // iPad Pencil emits companion TouchEvents after pen pointerdown. Without a
    // non-passive cancel, WebKit still pans the PDF scroll root (touch-action
    // stays auto so fingers can scroll when no pen is down).
    element.addEventListener("touchstart", this.blockTouchScrollWhilePen, { ...options, passive: false });
    element.addEventListener("touchmove", this.blockTouchScrollWhilePen, { ...options, passive: false });
    // Touch Events ignore Pointer Events capture (Ink). Use them for finger
    // bookkeeping + stale-pen unlock when pointerup never reaches the page.
    element.ownerDocument.addEventListener("touchend", this.handleTouchTerminal, { ...options, passive: true });
    element.ownerDocument.addEventListener("touchcancel", this.handleTouchTerminal, { ...options, passive: true });
    // Native PDF scrolling can deliver a terminal event to another virtualized
    // page (or directly to document). Do not retain it as a phantom pinch.
    element.ownerDocument.addEventListener("pointerup", this.clearEndedTouch, options);
    element.ownerDocument.addEventListener("pointercancel", this.clearEndedTouch, options);
    element.ownerDocument.addEventListener("lostpointercapture", this.clearEndedTouch, options);
    this.syncTouchActionMode();
  }

  classify(event: PointerEvent): PointerRoute {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (this.palmPolicy.shouldIgnore(event)) return "ignored";
      const multi = this.touches.size + (this.touches.has(event.pointerId) ? 0 : 1) >= 2;
      if (multi) return "touch-zoom-pan";
      // Fingers always leave native scroll/pinch. Annotation is stylus + optional mouse only.
      return "touch-pan";
    }
    if (!this.callbacks.canAnnotatePointer(event)) {
      return "native";
    }
    // MockTab can expose a physical eraser as a mouse pointer with W3C's
    // dedicated eraser button/bit. Route it before the active drawing tool.
    if (isStylusEraserInput(event)) return "edit";
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (this.isTextToolRoute(tool, event, penLike)) return "text";
    const editing = tool === "eraser" || tool === "lasso";
    if (event.pointerType === "mouse" && event.button === 2 && this.callbacks.rightMouseEraserEnabled?.()) return "edit";
    if (penLike) return editing ? "edit" : "draw";
    if (event.pointerType === "mouse" && event.button === 0 && isInkDrawTool(tool)) return "draw";
    if (event.pointerType === "mouse" && event.button === 0 && editing) return "edit";
    return "native";
  }

  private isTextToolRoute(tool: ToolId, event: PointerEvent, penLike: boolean): boolean {
    return tool === "text" && (penLike || (event.pointerType === "mouse" && event.button === 0));
  }

  /** Document fallback / sync repair entry — same path as the page capture listener. */
  acceptPointerDown(event: PointerEvent): PointerRoute {
    return this.handleDown(event);
  }

  private notePenSignal(event: PointerEvent): void {
    if (!this.callbacks.canAnnotatePointer(event)) return;
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (!penLike) return;
    const transition = this.manipulation.penSignal();
    if (transition.cancelAssist) this.clearTouchAxisGesture("pen-contact", event);
    this.applyManipulationTransition(transition);
  }

  private applyManipulationTransition(transition: {
    cancelRearm: boolean;
    scheduleRearm: boolean;
  }): void {
    if (transition.cancelRearm) this.clearManipulationRearm();
    if (transition.scheduleRearm) {
      this.clearManipulationRearm();
      const view = this.element.ownerDocument.defaultView;
      this.manipulationRearmTimer = (view?.setTimeout ?? window.setTimeout)(() => {
        this.manipulationRearmTimer = undefined;
        this.manipulation.rearm();
        this.syncTouchActionMode();
      }, MANIPULATION_REARM_MS);
    }
    this.syncTouchActionMode();
  }

  private clearManipulationRearm(): void {
    if (this.manipulationRearmTimer === undefined) return;
    const view = this.element.ownerDocument.defaultView;
    (view?.clearTimeout ?? window.clearTimeout)(this.manipulationRearmTimer);
    this.manipulationRearmTimer = undefined;
  }

  private finishManipulationTouch(event: PointerEvent, panned: boolean): void {
    if (!this.manipulationTouches.delete(event.pointerId)) return;
    const transition = this.manipulation.touchEnd(panned);
    this.applyManipulationTransition(transition);
  }

  private readonly handleDown = (event: PointerEvent): PointerRoute => {
    this.callbacks.onRouterReceived?.(event, this.generation);
    if (this.callbacks.isInputOwnerActive?.() === false) {
      this.callbacks.onPointerRejected?.("inactive-owner", event, this.generation);
      return "ignored";
    }
    if (isAnnotationChromeTarget(event.target)) {
      this.callbacks.onPointerRejected?.("annotation-chrome", event, this.generation);
      return "native";
    }
    if (this.callbacks.isPointerHandled?.(event.pointerId, this.generation)) {
      this.callbacks.onPointerRejected?.("already-handled", event, this.generation);
      return "ignored";
    }
    this.callbacks.onPointerHandled?.(event.pointerId, this.generation);
    this.paintCustomCursorsNow(event);
    if (event.pointerType === "touch") {
      // Finger after a vanished Pencil tip: do not keep scroll-lock forever.
      this.palmPolicy.reconcileStalePenOnTouch();
    }
    if (event.pointerType === "touch" && event.isPrimary && this.touches.size > 0) {
      const trackedBefore = this.touches.size;
      this.touches.clear();
      this.manipulationTouches.clear();
      this.clearManipulationRearm();
      this.manipulation.reset();
      // Keep active pens — a stale finger ID must not unlock Pencil scroll lock.
      if (!this.palmPolicy.hasActivePen()) this.palmPolicy.reset();
      this.callbacks.onTouchLifecycle?.("primary-reset", event, { trackedBefore, trackedAfter: 0 });
    }
    this.notePenSignal(event);
    this.palmPolicy.pointerDown(event);
    if (this.palmPolicy.hasActivePen()) this.syncTouchActionMode();
    this.beginStylusEraser(event);
    const route = this.classify(event);
    if (event.pointerType === "touch" && route !== "ignored") {
      this.touches.add(event.pointerId);
      // Touch stays native PDF nav — no custom axis lock from annotation availability.
    }
    this.callbacks.onRoute?.(route, event);
    if (route === "touch-zoom-pan") {
      this.clearTouchAxisGesture("multi-finger");
    }
    // Palm / Pencil companion touch while a stylus is down: block native scroll.
    if (route === "ignored") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.syncTouchActionMode();
      this.callbacks.onTouchLifecycle?.("scroll-block", event, {
        reason: "ignored-pointer",
        activePens: this.palmPolicy.hasActivePen(),
        touchCount: this.touches.size
      });
      return route;
    }
    if (route !== "draw" && route !== "edit" && route !== "text") return route;
    this.routed.set(event.pointerId, route);
    event.preventDefault();
    event.stopImmediatePropagation();
    this.element.setPointerCapture?.(event.pointerId);
    this.syncTouchActionMode();
    this.callbacks.onStart?.(this.inkSamples(event), route, event);
    return route;
  };

  /** Samples with MockTab mouse-tip remapped to pen after pen was seen. */
  private inkSamples(
    event: PointerEvent,
    options?: { skipPenHover?: boolean }
  ): PointerSample[] {
    this.palmPolicy.notePenPresence(event);
    const samples = PointerCapabilities.samples(event, options);
    return remapMouseTipSamples(
      samples,
      this.palmPolicy.hasPenSeen(),
      this.palmPolicy.shouldTreatMouseTipAsPen(event)
    );
  }

  /** Start temporary Eraser mode once for a physical eraser pointer. */
  private beginStylusEraser(event: PointerEvent): void {
    if (!this.callbacks.canAnnotatePointer(event) || !isStylusEraserInput(event)) return;
    if (this.stylusErasers.has(event.pointerId)) return;
    this.stylusErasers.add(event.pointerId);
    this.callbacks.onStylusEraserStart?.();
  }

  /**
   * Some mouse-emulated tablet stacks first expose tip contact on pointermove.
   * Recover a routed ink start only for an actual pen or a MockTab-style
   * pressure/eraser mouse tip; ordinary mouse movement stays native.
   */
  private recoverMissingPointerDown(event: PointerEvent): boolean {
    if (this.callbacks.isInputOwnerActive?.() === false) return false;
    if (!this.callbacks.canAnnotatePointer(event) || !isTipContact(event)) return false;
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (!penLike) return false;
    this.palmPolicy.pointerDown(event);
    if (this.palmPolicy.hasActivePen()) this.syncTouchActionMode();
    this.beginStylusEraser(event);
    const route = this.classify(event);
    if (route !== "draw" && route !== "edit" && route !== "text") return false;
    this.routed.set(event.pointerId, route);
    this.callbacks.onPointerHandled?.(event.pointerId, this.generation);
    event.preventDefault();
    event.stopImmediatePropagation();
    this.element.setPointerCapture?.(event.pointerId);
    this.callbacks.onStart?.(this.inkSamples(event), route, event);
    return true;
  }

  /** Cancel companion TouchEvents while stylus is down (iPad WebKit scroll path). */
  private readonly blockTouchScrollWhilePen = (event: TouchEvent): void => {
    // Companion touchstart arrives ~0–4ms after pen down — reconcile only when stale.
    this.palmPolicy.reconcileStalePenOnTouch();
    if (!this.palmPolicy.hasActivePen()) return;
    if (!event.cancelable) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "touchstart") {
      this.callbacks.onTouchLifecycle?.("scroll-block", event, {
        reason: "touch-while-pen",
        activePens: true,
        touchCount: event.touches.length,
        activePenIds: this.palmPolicy.activePenIds()
      });
    }
  };

  /**
   * Document touchend/cancel — fires even when setPointerCapture stole pointer
   * terminals (Ink). Clears finger bookkeeping; clears pen only if stale.
   */
  private readonly handleTouchTerminal = (event: TouchEvent): void => {
    const trackedBefore = this.touches.size;
    for (const touch of Array.from(event.changedTouches)) {
      this.touches.delete(touch.identifier);
      const terminal = this.syntheticPointerEvent(touch.identifier, event.type === "touchcancel" ? "pointercancel" : "pointerup");
      const panned = this.touchAxis?.pointerId === touch.identifier
        && (this.touchAxis.active || this.touchAxis.lock === "vertical");
      if (this.touchAxis?.pointerId === touch.identifier) {
        this.clearTouchAxisGesture(event.type === "touchcancel" ? "touchcancel" : "pointerup", terminal);
      }
      this.finishManipulationTouch(terminal, panned);
    }
    const remaining = event.touches.length;
    if (remaining > 0) {
      if (trackedBefore !== this.touches.size) {
        this.callbacks.onTouchLifecycle?.(
          event.type === "touchcancel" ? "touchcancel" : "touchend",
          event,
          {
            reason: "touch-partial-end",
            trackedBefore,
            trackedAfter: this.touches.size,
            touchCount: remaining,
            activePens: this.palmPolicy.hasActivePen()
          }
        );
      }
      return;
    }
    this.touches.clear();
    // Companion touchend can arrive while Pencil tip is still down — only clear
    // pens that look stale (no tip sample within grace window).
    const stalePenCleared = this.palmPolicy.reconcileStalePenOnTouch();
    if (this.touchAxis) this.clearTouchAxisGesture("touch-all-clear");
    this.syncTouchActionMode();
    this.callbacks.onTouchLifecycle?.(
      event.type === "touchcancel" ? "touchcancel" : "touchend",
      event,
      {
        reason: event.type === "touchcancel" ? "touchcancel-all-clear" : "touchend-all-clear",
        trackedBefore,
        trackedAfter: 0,
        touchCount: 0,
        activePens: this.palmPolicy.hasActivePen(),
        activePenIds: this.palmPolicy.activePenIds(),
        stalePenCleared
      }
    );
  };

  /** WebKit / iPad: transient touch-action only while pen/palm requires it. */
  private syncTouchActionMode(): void {
    // Pencil-first: never lock touch from annotation availability alone.
    const mode = this.palmPolicy.hasActivePen() || this.touchAxis?.lock === "vertical"
      ? "none"
      : "default";
    if (mode === "default") {
      this.clearManipulationRearm();
      if (this.manipulation.state !== "armed" || this.manipulation.activeTouches > 0) this.manipulation.reset();
    }
    this.element.classList.toggle("native-pdf-handwriting-touch-none", mode === "none");
    this.element.classList.toggle("native-pdf-handwriting-touch-pan-xy", false);
    // Legacy alias from 0.1.42–0.1.45 — keep cleared so only one mode class wins.
    this.element.classList.remove("native-pdf-handwriting-pen-capturing");
  }

  private beginTouchAxisGesture(event: PointerEvent, assist: boolean): void {
    this.touchAxis = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lock: "none",
      assist,
      active: false
    };
    if (assist) {
      this.callbacks.onTouchPan?.("start", event, { reason: "standing-guard-assist", pointerId: event.pointerId });
    }
  }

  private clearTouchAxisGesture(reason: string, event?: PointerEvent): void {
    const gesture = this.touchAxis;
    if (!gesture) return;
    this.touchAxis = null;
    if (gesture.assist && gesture.active) {
      this.callbacks.onTouchPan?.(reason === "pointerup" ? "end" : "abort", event ?? this.syntheticPointerEvent(
        gesture.pointerId,
        reason === "pointerup" ? "pointerup" : "pointercancel"
      ), {
        reason,
        pointerId: gesture.pointerId
      });
    }
    if (gesture.lock === "vertical") {
      safeReleasePointerCapture(this.element, gesture.pointerId);
    }
    if (gesture.lock !== "none") {
      this.callbacks.onTouchLifecycle?.("axis-lock", this.syntheticLifecycleEvent(), {
        reason: `clear:${reason}`,
        axisLock: "none",
        touchCount: this.touches.size
      });
    }
    this.syncTouchActionMode();
  }

  /**
   * Draw-mode single finger: lock vertical → drive PDF scroll; lock horizontal →
   * leave native (Ink dedicated-writing axis policy). Avoids fighty diagonal pan.
   */
  private updateTouchAxisGesture(event: PointerEvent): void {
    const gesture = this.touchAxis;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // Custom touch-axis assist is unused in pencil-first (touch stays native).
    if (this.palmPolicy.hasActivePen() || this.touches.size >= 2) {
      this.clearTouchAxisGesture(this.touches.size >= 2 ? "multi-finger" : "draw-or-pen");
      return;
    }
    this.clearTouchAxisGesture("native-touch-policy");
  }


  private emitPenStateReset(
    reason: PenStateResetReason,
    activePenIds: number[],
    event?: PointerEvent | TouchEvent
  ): void {
    this.callbacks.onTouchLifecycle?.("pen-state", event ?? this.syntheticLifecycleEvent(), {
      reason,
      activePens: this.palmPolicy.hasActivePen(),
      activePenIds
    });
    this.syncTouchActionMode();
  }

  private syntheticLifecycleEvent(): Event {
    return new Event("pointercancel", { bubbles: true, cancelable: true });
  }

  private syntheticPointerEvent(pointerId: number, type: "pointerup" | "pointercancel" = "pointercancel"): PointerEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      pointerType: { value: "touch" },
      button: { value: 0 },
      buttons: { value: 0 },
      pressure: { value: 0 },
      width: { value: 0 },
      height: { value: 0 },
      clientX: { value: 0 },
      clientY: { value: 0 }
    });
    return event;
  }

  private finishRoutedPointer(event: PointerEvent, phase: "pointerup" | "pointercancel"): void {
    const route = this.routed.get(event.pointerId);
    if (!route) return;
    if (phase === "pointercancel") {
      this.callbacks.onCancel?.(route, event);
    } else {
      this.callbacks.onEnd?.(this.inkSamples(event), route, event);
    }
    safeReleasePointerCapture(this.element, event.pointerId);
    this.routed.delete(event.pointerId);
  }

  /** Clear stylus contact — Ink unlockScroll equivalent. */
  private releasePenContact(event: PointerEvent, reason: Extract<PenStateResetReason, "pointerup" | "pointercancel" | "lostpointercapture">): void {
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (event.pointerType === "mouse" && !this.palmPolicy.activePenIds().includes(event.pointerId)) return;
    if (reason === "lostpointercapture") {
      this.palmPolicy.clearAll("lostpointercapture");
      return;
    }
    if (reason === "pointercancel") {
      this.palmPolicy.clearPenPointer(event.pointerId, "pointercancel");
      return;
    }
    this.palmPolicy.pointerUp(event);
  }

  private readonly handleMove = (event: PointerEvent): void => {
    this.scheduleCustomCursorUpdate(event);
    this.notePenSignal(event);
    this.palmPolicy.notePenActivity(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      // Ink: skip Pencil hover / near-zero pressure on move (keep down/up for floor + tip).
      const samples = this.inkSamples(event, {
        skipPenHover: route === "draw" || route === "edit"
      });
      if (samples.length === 0) return;
      this.callbacks.onMove?.(samples, route, event);
      return;
    }
    if (this.recoverMissingPointerDown(event)) return;
    this.updateTouchAxisGesture(event);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    this.paintCustomCursorsNow(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onEnd?.(this.inkSamples(event), route, event);
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
    }
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    const endedTouchGesture = this.touchAxis?.pointerId === event.pointerId;
    const pannedTouch = Boolean(endedTouchGesture && (this.touchAxis?.active || this.touchAxis?.lock === "vertical"));
    this.touches.delete(event.pointerId);
    if (endedTouchGesture) this.clearTouchAxisGesture("pointerup", event);
    this.finishManipulationTouch(event, pannedTouch);
    this.releasePenContact(event, "pointerup");
    this.syncTouchActionMode();
    // The custom cursor is a live pointer affordance, never a mark left after
    // drawing. Hover movement paints it again when the mouse/pen is active.
    this.hideCustomCursors();
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onCancel?.(route, event);
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
    }
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    const endedTouchGesture = this.touchAxis?.pointerId === event.pointerId;
    this.touches.delete(event.pointerId);
    if (endedTouchGesture) this.clearTouchAxisGesture("pointercancel", event);
    this.finishManipulationTouch(event, false);
    this.releasePenContact(event, "pointercancel");
    this.syncTouchActionMode();
    this.hideCustomCursors();
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" || event.pointerType === "pen") this.hideCustomCursors();
    // Capture can move to another node; pointerup may never hit this page listener.
    if (event.pointerType === "pen" && this.palmPolicy.hasActivePen()) {
      this.finishRoutedPointer(event, "pointerup");
      this.releasePenContact(event, "lostpointercapture");
      this.syncTouchActionMode();
      return;
    }
    // Mouse ink routes (including MockTab tip-as-mouse) need the same finish path.
    if (event.pointerType === "mouse" && this.routed.has(event.pointerId)) {
      this.finishRoutedPointer(event, "pointerup");
      this.releasePenContact(event, "lostpointercapture");
      this.syncTouchActionMode();
    }
  };

  private readonly clearEndedTouch = (event: PointerEvent): void => {
    // Document capture: Pencil terminal events often miss the page listener after
    // acceptPointerDown + setPointerCapture (same failure Ink documents).
    if (event.pointerType === "pen") {
      const hadRoute = this.routed.has(event.pointerId);
      const hadPen = this.palmPolicy.hasActivePen();
      const phase = event.type === "pointercancel" ? "pointercancel" : "pointerup";
      this.finishRoutedPointer(event, phase);
      this.releasePenContact(
        event,
        event.type === "lostpointercapture"
          ? "lostpointercapture"
          : event.type === "pointercancel"
            ? "pointercancel"
            : "pointerup"
      );
      this.syncTouchActionMode();
      if (hadRoute || hadPen) {
        this.callbacks.onTouchLifecycle?.(
          event.type === "pointerup"
            ? "pointerup"
            : event.type === "pointercancel"
              ? "pointercancel"
              : "lostpointercapture",
          event,
          {
            reason: "document-pen-terminal",
            activePens: this.palmPolicy.hasActivePen(),
            activePenIds: this.palmPolicy.activePenIds()
          }
        );
      }
      return;
    }
    if (event.pointerType !== "touch") return;
    const endedTouchGesture = this.touchAxis?.pointerId === event.pointerId;
    const pannedTouch = Boolean(endedTouchGesture && (this.touchAxis?.active || this.touchAxis?.lock === "vertical"));
    if (endedTouchGesture) {
      this.clearTouchAxisGesture(event.type === "pointerup" ? "pointerup" : "document-touch-terminal", event);
    }
    this.finishManipulationTouch(event, pannedTouch);
    const route = this.routed.get(event.pointerId);
    const endedOnThisPage = event.target instanceof Node && this.element.contains(event.target);
    let completion: "document-end" | "document-cancel" | undefined;
    // The source PDF page can be virtualized before its terminal event arrives.
    // Finish a still-routed line here rather than letting its draft vanish when
    // the page router is torn down. Local pointerup/cancel still use the page
    // handlers below, preserving normal cancellation semantics.
    if (route && (event.type === "lostpointercapture" || !endedOnThisPage)) {
      if (event.type === "pointercancel") {
        this.callbacks.onCancel?.(route, event);
        completion = "document-cancel";
      } else {
        this.callbacks.onEnd?.(this.inkSamples(event), route, event);
        completion = "document-end";
      }
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
    }
    const trackedBefore = this.touches.size;
    const removed = this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
    if (!removed && !completion) return;
    const phase = event.type === "pointerup"
      ? "pointerup"
      : event.type === "pointercancel"
        ? "pointercancel"
        : "lostpointercapture";
    this.callbacks.onTouchLifecycle?.(phase, event, {
      trackedBefore,
      trackedAfter: this.touches.size,
      ...(route ? { route } : {}),
      ...(completion ? { completion } : {})
    });
  };

  syncToolState(): void {
    this.cancelScheduledCursorUpdate();
    this.syncTouchActionMode();
    const tool = this.callbacks.activeTool();
    if (tool !== "eraser") this.hideEraserCursor();
    if (!isInkDrawTool(tool)) this.hideDrawCursor();
    this.refreshCursors();
  }

  refreshCursors(): void {
    this.cancelScheduledCursorUpdate();
    if (!this.lastCursorClient) return;
    const { x, y } = this.lastCursorClient;
    const tool = this.callbacks.activeTool();
    if (tool === "eraser" && !this.eraserCursor.hidden) this.paintEraserCursor(x, y);
    if (isInkDrawTool(tool) && !this.drawCursor.hidden) this.paintDrawCursor(x, y);
  }

  private cursorClientPoint(clientX: number, clientY: number): { x: number; y: number } {
    return this.callbacks.projectCursor?.(clientX, clientY) ?? { x: clientX, y: clientY };
  }

  /** True when this router is still listening on the given page node. */
  bindsTo(element: HTMLElement): boolean {
    return this.element === element;
  }

  /** Listeners survive only while the abort signal is live and the page is in the document. */
  isAlive(): boolean {
    return !this.abort.signal.aborted && this.element.isConnected;
  }

  activePenIds(): number[] {
    return this.palmPolicy.activePenIds();
  }

  activeRoutedPointerIds(): number[] {
    return [...this.routed.keys()];
  }

  adoptPointerState(handoff: PointerRouterHandoff): void {
    for (const { pointerId, route } of handoff.routed) {
      this.routed.set(pointerId, route);
      try {
        this.element.setPointerCapture?.(pointerId);
      } catch {
        // The platform may have already ended the pointer during the rebind.
      }
    }
    this.palmPolicy.adoptActivePenIds(handoff.activePenIds);
    this.syncTouchActionMode();
  }

  hasPointerCapture(pointerId: number): boolean {
    try {
      return this.element.hasPointerCapture?.(pointerId) ?? false;
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.cancelScheduledCursorUpdate();
    this.clearManipulationRearm();
    const handoff: PointerRouterHandoff = {
      routed: [...this.routed.entries()].map(([pointerId, route]) => ({ pointerId, route })),
      activePenIds: this.palmPolicy.activePenIds()
    };
    const captureIds = new Set<number>([
      ...handoff.routed.map(({ pointerId }) => pointerId),
      ...(this.touchAxis ? [this.touchAxis.pointerId] : [])
    ]);
    for (const pointerId of captureIds) {
      safeReleasePointerCapture(this.element, pointerId);
    }
    this.routed.clear();
    this.stylusErasers.clear();
    this.touches.clear();
    this.manipulationTouches.clear();
    this.manipulation.reset();
    this.clearTouchAxisGesture("destroy");
    this.touchAxis = null;
    this.palmPolicy.setResetListener(null);
    this.palmPolicy.reset();
    this.callbacks.onPointerOwnerReleased?.(this.generation, handoff);
    this.abort.abort();
    this.element.classList.remove(
      "native-pdf-handwriting-has-eraser-cursor",
      "native-pdf-handwriting-has-draw-cursor",
      "native-pdf-handwriting-pen-capturing",
      "native-pdf-handwriting-touch-none",
      "native-pdf-handwriting-touch-pan-xy"
    );
    this.eraserCursor.remove();
    this.drawCursor.remove();
  }

  private readonly suppressRightMouseEraserMenu = (event: MouseEvent): void => {
    if (!this.callbacks.mouseAnnotationEnabled?.() || !this.callbacks.rightMouseEraserEnabled?.() || event.button !== 2) return;
    event.preventDefault();
  };

  private scheduleCustomCursorUpdate(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.paintCustomCursorsNow(event);
      return;
    }
    this.lastCursorClient = { x: event.clientX, y: event.clientY };
    this.pendingCursorUpdate = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType
    };
    if (this.cursorAnimationFrame !== null) return;
    const view = this.element.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) {
      this.paintScheduledCursorUpdate();
      return;
    }
    this.cursorAnimationFrame = view.requestAnimationFrame(() => this.paintScheduledCursorUpdate());
  }

  private paintCustomCursorsNow(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    this.cancelScheduledCursorUpdate();
    this.updateCustomCursors(event);
  }

  private paintScheduledCursorUpdate(): void {
    this.cursorAnimationFrame = null;
    const event = this.pendingCursorUpdate;
    this.pendingCursorUpdate = null;
    if (event) this.updateCustomCursors(event);
  }

  private cancelScheduledCursorUpdate(): void {
    this.pendingCursorUpdate = null;
    if (this.cursorAnimationFrame === null) return;
    this.element.ownerDocument.defaultView?.cancelAnimationFrame(this.cursorAnimationFrame);
    this.cursorAnimationFrame = null;
  }

  private updateCustomCursors(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    this.lastCursorClient = { x: event.clientX, y: event.clientY };
    this.lastCursorPointerType = event.pointerType;
    this.updateDrawCursor(event);
    this.updateEraserCursor(event);
  }

  private updateDrawCursor(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.hideDrawCursor();
      return;
    }
    this.paintDrawCursor(event.clientX, event.clientY, event.pointerType);
  }

  private paintDrawCursor(clientX: number, clientY: number, pointerType?: string): void {
    const tool = this.callbacks.activeTool();
    const type = pointerType ?? this.lastCursorPointerType ?? "mouse";
    const pointerAllows = type === "pen" || this.callbacks.mouseAnnotationEnabled?.() === true;
    const visible = pointerAllows && isInkDrawTool(tool);
    if (!visible) {
      this.hideDrawCursor();
      return;
    }
    const size = PointerRouter.DRAW_CURSOR_SIZE_PX;
    const color = this.callbacks.drawCursorColor?.();
    const point = this.cursorClientPoint(clientX, clientY);
    setElementCssProps(this.drawCursor, {
      width: `${size}px`,
      height: `${size}px`,
      left: `${point.x}px`,
      top: `${point.y}px`,
      "background-color": color ?? ""
    });
    this.drawCursor.hidden = false;
    this.element.classList.add("native-pdf-handwriting-has-draw-cursor");
  }

  private updateEraserCursor(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.hideEraserCursor();
      return;
    }
    this.paintEraserCursor(event.clientX, event.clientY, event.pointerType);
  }

  private paintEraserCursor(clientX: number, clientY: number, pointerType?: string): void {
    const type = pointerType ?? this.lastCursorPointerType ?? "mouse";
    const pointerAllows = type === "pen" || this.callbacks.mouseAnnotationEnabled?.() === true;
    const visible = pointerAllows && this.callbacks.activeTool() === "eraser";
    if (!visible) {
      this.hideEraserCursor();
      return;
    }
    const diameter = Math.max(1, this.callbacks.eraserCursorDiameter?.() ?? 12);
    const point = this.cursorClientPoint(clientX, clientY);
    setElementCssProps(this.eraserCursor, {
      width: `${diameter}px`,
      height: `${diameter}px`,
      left: `${point.x}px`,
      top: `${point.y}px`
    });
    this.eraserCursor.hidden = false;
    this.element.classList.add("native-pdf-handwriting-has-eraser-cursor");
  }

  private readonly hideDrawCursor = (): void => {
    this.drawCursor.hidden = true;
    this.element.classList.remove("native-pdf-handwriting-has-draw-cursor");
  };

  private readonly hideCustomCursors = (): void => {
    this.cancelScheduledCursorUpdate();
    this.hideEraserCursor();
    this.hideDrawCursor();
  };

  private readonly hideEraserCursor = (): void => {
    this.eraserCursor.hidden = true;
    this.element.classList.remove("native-pdf-handwriting-has-eraser-cursor");
  };
}

