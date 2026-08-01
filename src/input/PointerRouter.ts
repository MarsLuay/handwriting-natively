import { appendToBodyOr, createDetachedSpan } from "../vendor/createDetached";
import { setElementCssProps } from "../dom/typeGuards";
import { isInkDrawTool, type ToolId } from "../model";
import { scrollPdfBy } from "../integration/PdfScrollRoot";
import { PalmRejectionPolicy, type PenStateResetReason } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isSelectablePdfTarget } from "./PdfSelectableTarget";
import {
  resolveTouchAxisLock,
  shouldClaimVerticalTouchPan,
  type TouchAxisLock
} from "./TouchAxisPolicy";

export type PointerRoute = "draw" | "edit" | "text" | "touch-pan" | "touch-zoom-pan" | "mouse-pan" | "native" | "ignored";

export function isAnnotationChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    ".native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-selection-control, .native-pdf-handwriting-text-input"
  ));
}

/** Primary tip drag: mouse LMB or stylus tip (not barrel / eraser buttons). */
export function isDragPanPointer(event: Pick<PointerEvent, "pointerType" | "button">): boolean {
  if (event.button !== 0) return false;
  return event.pointerType === "mouse" || event.pointerType === "pen";
}

/** W3C Pointer Events reports an eraser stylus tip as button 5 / buttons bit 32. */
export function isStylusEraserInput(event: Pick<PointerEvent, "pointerType" | "button" | "buttons">): boolean {
  return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0);
}

interface PanGesture {
  startX: number;
  startY: number;
  lastY: number;
  active: boolean;
}

/** Draw-mode single-finger axis lock (Ink dedicated-writing pattern). */
interface TouchAxisGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  lock: TouchAxisLock;
}

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  drawingEnabled(): boolean;
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
  /** True when document fallback / a prior accept already owns this pointerId. */
  isPointerHandled?(pointerId: number): boolean;
  /** Mark pointerId so document fallback does not start a duplicate stroke. */
  onPointerHandled?(pointerId: number): void;
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
  onMousePan?(phase: "start" | "activate" | "move" | "end" | "abort", event: PointerEvent, details: Record<string, unknown>): void;
}

export class PointerRouter {
  private static readonly DRAW_CURSOR_SIZE_PX = 6;
  private static nextGeneration = 1;

  /** Monotonic id for this listener generation (fresh AbortController per instance). */
  readonly generation: number;
  private readonly routed = new Map<number, "draw" | "edit" | "text">();
  private readonly stylusErasers = new Set<number>();
  private readonly panning = new Map<number, PanGesture>();
  private readonly touches = new Set<number>();
  private touchAxis: TouchAxisGesture | null = null;
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly abort = new AbortController();
  private readonly eraserCursor: HTMLElement;
  private readonly drawCursor: HTMLElement;
  private lastCursorClient: { x: number; y: number } | null = null;
  private pendingCursorUpdate: Pick<PointerEvent, "clientX" | "clientY" | "pointerType"> | null = null;
  private cursorAnimationFrame: number | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy = new PalmRejectionPolicy()
  ) {
    this.generation = PointerRouter.nextGeneration++;
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
      // Fingers always leave native scroll/pinch. Draw mode is mouse + stylus only.
      return "touch-pan";
    }
    if (!this.callbacks.drawingEnabled()) {
      if (isDragPanPointer(event) && this.callbacks.scrollRoot?.()) {
        if (!isAnnotationChromeTarget(event.target) && !isSelectablePdfTarget(event.target)) return "mouse-pan";
      }
      return "native";
    }
    if (tool === "text" && (event.pointerType === "pen" || (event.pointerType === "mouse" && event.button === 0))) return "text";
    const editing = tool === "eraser" || tool === "lasso";
    if (event.pointerType === "mouse" && event.button === 2 && this.callbacks.rightMouseEraserEnabled?.()) return "edit";
    if (event.pointerType === "pen") return editing ? "edit" : "draw";
    if (event.pointerType === "mouse" && event.button === 0 && isInkDrawTool(tool)) return "draw";
    if (event.pointerType === "mouse" && event.button === 0 && editing) return "edit";
    return "native";
  }

  /** Document fallback / sync repair entry — same path as the page capture listener. */
  acceptPointerDown(event: PointerEvent): void {
    this.handleDown(event);
  }

  private readonly handleDown = (event: PointerEvent): void => {
    if (isAnnotationChromeTarget(event.target)) return;
    if (this.callbacks.isPointerHandled?.(event.pointerId)) return;
    this.callbacks.onRouterReceived?.(event, this.generation);
    this.callbacks.onPointerHandled?.(event.pointerId);
    this.paintCustomCursorsNow(event);
    if (event.pointerType === "touch") {
      // Finger after a vanished Pencil tip: do not keep scroll-lock forever.
      this.palmPolicy.reconcileStalePenOnTouch();
    }
    if (event.pointerType === "touch" && event.isPrimary && this.touches.size > 0) {
      const trackedBefore = this.touches.size;
      this.touches.clear();
      // Keep active pens — a stale finger ID must not unlock Pencil scroll lock.
      if (!this.palmPolicy.hasActivePen()) this.palmPolicy.reset();
      this.callbacks.onTouchLifecycle?.("primary-reset", event, { trackedBefore, trackedAfter: 0 });
    }
    this.palmPolicy.pointerDown(event);
    if (event.pointerType === "pen") this.syncTouchActionMode();
    if (isStylusEraserInput(event) && this.callbacks.drawingEnabled()) {
      this.stylusErasers.add(event.pointerId);
      this.callbacks.onStylusEraserStart?.();
    }
    const route = this.classify(event);
    if (event.pointerType === "touch" && route !== "ignored") this.touches.add(event.pointerId);
    this.callbacks.onRoute?.(route, event);
    if (route === "touch-zoom-pan") {
      this.clearTouchAxisGesture("multi-finger");
    } else if (route === "touch-pan" && this.callbacks.drawingEnabled() && !this.palmPolicy.hasActivePen()) {
      this.beginTouchAxisGesture(event);
    }
    if (route === "mouse-pan") {
      this.panning.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        active: false
      });
      this.element.setPointerCapture?.(event.pointerId);
      const root = this.callbacks.scrollRoot?.();
      this.callbacks.onMousePan?.("start", event, {
        target: targetLabel(event.target),
        scrollRoot: root ? scrollRootLabel(root) : null
      });
      return;
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
      return;
    }
    if (route !== "draw" && route !== "edit" && route !== "text") return;
    this.routed.set(event.pointerId, route);
    event.preventDefault();
    event.stopImmediatePropagation();
    this.element.setPointerCapture?.(event.pointerId);
    this.syncTouchActionMode();
    this.callbacks.onStart?.(PointerCapabilities.samples(event), route, event);
  };

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
      if (this.touchAxis?.pointerId === touch.identifier) {
        this.clearTouchAxisGesture(event.type === "touchcancel" ? "touchcancel" : "touchend");
      }
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

  /** WebKit / iPad: explicit touch-action modes (Ink finger-blocker pattern). */
  private syncTouchActionMode(): void {
    const mode = this.palmPolicy.hasActivePen() || this.touchAxis?.lock === "vertical"
      ? "none"
      : this.callbacks.drawingEnabled()
        ? "pan-xy"
        : "default";
    this.element.classList.toggle("native-pdf-handwriting-touch-none", mode === "none");
    this.element.classList.toggle("native-pdf-handwriting-touch-pan-xy", mode === "pan-xy");
    // Legacy alias from 0.1.42–0.1.45 — keep cleared so only one mode class wins.
    this.element.classList.remove("native-pdf-handwriting-pen-capturing");
  }

  private beginTouchAxisGesture(event: PointerEvent): void {
    this.touchAxis = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      lock: "none"
    };
  }

  private clearTouchAxisGesture(reason: string): void {
    const gesture = this.touchAxis;
    if (!gesture) return;
    this.touchAxis = null;
    if (gesture.lock === "vertical" && this.element.hasPointerCapture?.(gesture.pointerId)) {
      this.element.releasePointerCapture?.(gesture.pointerId);
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
    if (!this.callbacks.drawingEnabled() || this.palmPolicy.hasActivePen() || this.touches.size >= 2) {
      this.clearTouchAxisGesture(this.touches.size >= 2 ? "multi-finger" : "draw-or-pen");
      return;
    }
    if (gesture.lock === "none") {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      const next = resolveTouchAxisLock(dx, dy);
      if (next === "none") return;
      gesture.lock = next;
      this.syncTouchActionMode();
      this.callbacks.onTouchLifecycle?.("axis-lock", event, {
        reason: next === "vertical" ? "lock-vertical" : "lock-horizontal",
        axisLock: next,
        dx,
        dy,
        touchCount: this.touches.size
      });
      if (next === "horizontal") return;
      this.element.setPointerCapture?.(event.pointerId);
    }
    if (!shouldClaimVerticalTouchPan(gesture.lock)) return;
    const root = this.callbacks.scrollRoot?.();
    if (!root) return;
    const deltaY = event.clientY - gesture.lastY;
    gesture.lastY = event.clientY;
    if (deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const changed = scrollPdfBy(root, -deltaY);
    this.callbacks.onMousePan?.("move", event, {
      reason: "touch-axis-vertical",
      deltaY: -deltaY,
      changed,
      scrollTop: root.scrollTop
    });
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

  private finishRoutedPointer(event: PointerEvent, phase: "pointerup" | "pointercancel"): void {
    const route = this.routed.get(event.pointerId);
    if (!route) return;
    if (phase === "pointercancel") {
      this.callbacks.onCancel?.(route, event);
    } else {
      this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
    }
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
    this.routed.delete(event.pointerId);
  }

  /** Clear stylus contact — Ink unlockScroll equivalent. */
  private releasePenContact(event: PointerEvent, reason: Extract<PenStateResetReason, "pointerup" | "pointercancel" | "lostpointercapture">): void {
    if (event.pointerType !== "pen") return;
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
    this.palmPolicy.notePenActivity(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      // Ink: skip Pencil hover / near-zero pressure on move (keep down/up for floor + tip).
      const samples = PointerCapabilities.samples(event, {
        skipPenHover: route === "draw" || route === "edit"
      });
      if (samples.length === 0) return;
      this.callbacks.onMove?.(samples, route, event);
      return;
    }
    const pan = this.panning.get(event.pointerId);
    if (pan) {
      this.updateMousePan(event, pan);
      return;
    }
    this.updateTouchAxisGesture(event);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    this.paintCustomCursorsNow(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
    }
    this.finishMousePan(event);
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    this.touches.delete(event.pointerId);
    if (this.touchAxis?.pointerId === event.pointerId) this.clearTouchAxisGesture("pointerup");
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
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
    }
    this.finishMousePan(event);
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    this.touches.delete(event.pointerId);
    if (this.touchAxis?.pointerId === event.pointerId) this.clearTouchAxisGesture("pointercancel");
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
    if (this.touchAxis?.pointerId === event.pointerId) this.clearTouchAxisGesture("document-touch-terminal");
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
        this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
        completion = "document-end";
      }
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
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
    if (!this.callbacks.drawingEnabled()) {
      this.hideCustomCursors();
      return;
    }
    const tool = this.callbacks.activeTool();
    if (tool !== "eraser") this.hideEraserCursor();
    if (!isInkDrawTool(tool)) this.hideDrawCursor();
    this.refreshCursors();
  }

  refreshCursors(): void {
    this.cancelScheduledCursorUpdate();
    if (!this.lastCursorClient || !this.callbacks.drawingEnabled()) return;
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

  destroy(): void {
    this.cancelScheduledCursorUpdate();
    for (const pointerId of this.routed.keys()) {
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
    }
    this.routed.clear();
    this.stylusErasers.clear();
    this.panning.clear();
    this.touches.clear();
    this.touchAxis = null;
    this.palmPolicy.setResetListener(null);
    this.palmPolicy.reset();
    this.abort.abort();
    this.element.classList.remove(
      "native-pdf-handwriting-has-eraser-cursor",
      "native-pdf-handwriting-has-draw-cursor",
      "native-pdf-handwriting-panning",
      "native-pdf-handwriting-pen-capturing",
      "native-pdf-handwriting-touch-none",
      "native-pdf-handwriting-touch-pan-xy"
    );
    this.eraserCursor.remove();
    this.drawCursor.remove();
  }

  private readonly suppressRightMouseEraserMenu = (event: MouseEvent): void => {
    if (!this.callbacks.drawingEnabled() || !this.callbacks.rightMouseEraserEnabled?.() || event.button !== 2) return;
    event.preventDefault();
  };

  private updateMousePan(event: PointerEvent, pan: PanGesture): void {
    const root = this.callbacks.scrollRoot?.();
    if (!root) {
      this.callbacks.onMousePan?.("abort", event, { reason: "missing-scroll-root" });
      this.panning.delete(event.pointerId);
      return;
    }
    if (!pan.active) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.hypot(dx, dy) < 4) return;
      if (Math.abs(dx) > Math.max(4, Math.abs(dy) * 1.25)) {
        this.callbacks.onMousePan?.("abort", event, { reason: "horizontal-dominant", dx, dy });
        this.panning.delete(event.pointerId);
        return;
      }
      pan.active = true;
      this.element.classList.add("native-pdf-handwriting-panning");
      this.callbacks.onMousePan?.("activate", event, {
        scrollRoot: scrollRootLabel(root),
        scrollTop: root.scrollTop
      });
    }
    const deltaY = event.clientY - pan.lastY;
    event.preventDefault();
    const changed = scrollPdfBy(root, -deltaY);
    pan.lastY = event.clientY;
    this.callbacks.onMousePan?.("move", event, {
      deltaY: -deltaY,
      scrollTop: root.scrollTop,
      changed
    });
  }

  private finishMousePan(event: PointerEvent): void {
    const pan = this.panning.get(event.pointerId);
    if (!pan) return;
    if (pan.active) {
      event.preventDefault();
      const root = this.callbacks.scrollRoot?.();
      this.callbacks.onMousePan?.("end", event, {
        scrollTop: root?.scrollTop ?? null,
        scrollRoot: root ? scrollRootLabel(root) : null
      });
    }
    this.panning.delete(event.pointerId);
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
    if (!this.panning.size) this.element.classList.remove("native-pdf-handwriting-panning");
  }

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
    this.updateDrawCursor(event);
    this.updateEraserCursor(event);
  }

  private updateDrawCursor(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.hideDrawCursor();
      return;
    }
    this.paintDrawCursor(event.clientX, event.clientY);
  }

  private paintDrawCursor(clientX: number, clientY: number): void {
    const tool = this.callbacks.activeTool();
    const visible = this.callbacks.drawingEnabled()
      && isInkDrawTool(tool);
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
    this.paintEraserCursor(event.clientX, event.clientY);
  }

  private paintEraserCursor(clientX: number, clientY: number): void {
    const visible = this.callbacks.drawingEnabled()
      && this.callbacks.activeTool() === "eraser";
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

function targetLabel(target: EventTarget | null): string {
  if (target === null) return "null";
  if (!(target instanceof Element)) return Object.prototype.toString.call(target);
  const tag = target.tagName.toLowerCase();
  const classes = [...target.classList].slice(0, 3).join(".");
  return classes ? `${tag}.${classes}` : tag;
}

function scrollRootLabel(root: HTMLElement): string {
  const id = root.id ? `#${root.id}` : "";
  const classes = [...root.classList].slice(0, 2).join(".");
  const scrollable = root.scrollHeight > root.clientHeight;
  return `${root.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""} scrollable=${scrollable}`;
}
