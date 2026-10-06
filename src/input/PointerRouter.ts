import { appendToBodyOr, createDetachedSpan } from "../vendor/createDetached";
import { setElementCssProps } from "../dom/typeGuards";
import { isInkDrawTool, type ToolId } from "../model";
import { classifyInputTarget, isUiInputTarget } from "./InputTargetClassification";
import { PalmRejectionPolicy, type PenStateResetReason } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isTipContact, remapMouseTipSamples } from "./PenPresence";
import { GestureOwnership } from "./GestureOwnership";
import {
  DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES,
  MANIPULATION_REARM_MS,
  ManipulationStateMachine,
  type ManipulationPlatformCapabilities,
  type ManipulationState
} from "./ManipulationStateMachine";
import {
  type TouchAxisLock
} from "./TouchAxisPolicy";
import {
  DEFAULT_POINTER_INPUT_CAPABILITIES,
  type PointerInputCapabilities
} from "./PointerInputCapabilities";

export type PointerRoute = "draw" | "edit" | "text" | "touch-pan" | "touch-zoom-pan" | "touch-custom-pinch" | "native" | "ignored";

export interface CustomPinchPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface CustomPinchFrame {
  generation: number;
  points: readonly CustomPinchPoint[];
}
export type PointerRejectionReason = "annotation-chrome" | "already-handled" | "inactive-owner" | "stale-generation";
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

export function safeSetPointerCapture(element: Element, pointerId: number): {
  attempted: boolean;
  succeeded: boolean;
} {
  if (typeof element.setPointerCapture !== "function") return { attempted: false, succeeded: true };
  try {
    element.setPointerCapture(pointerId);
    return {
      attempted: true,
      succeeded: element.hasPointerCapture?.(pointerId) ?? true
    };
  } catch {
    return { attempted: true, succeeded: false };
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
  /** Whether the selected touch fallback is currently available for cursors. */
  touchAnnotationEnabled?(): boolean;
  /** Qualified mobile-only custom pinch gate; false preserves native touch. */
  customPinchEnabled?(): boolean;
  onCustomPinchStart?(frame: CustomPinchFrame): void;
  /** Latest visual sample, delivered at most once per display frame. */
  onCustomPinchFrame?(frame: CustomPinchFrame): void;
  onCustomPinchEnd?(reason: "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled"): void;
  /** True when left-button mouse input is enabled for annotation gestures. */
  mouseInkingEnabled?(): boolean;
  onStylusEraserStart?(): void;
  onStylusEraserEnd?(): void;
  scrollRoot?(): HTMLElement | null;
  cursorParent?(): HTMLElement;
  eraserCursorDiameter?(): number;
  drawCursorColor?(): string;
  projectCursor?(clientX: number, clientY: number): { x: number; y: number } | null;
  onStart?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onMove?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  /** Ephemeral predicted pen samples; never part of the canonical move stream. */
  onPredictedMove?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onEnd?(samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void;
  onCancel?(route: "draw" | "edit" | "text", event: PointerEvent): void;
  onRoute?(route: PointerRoute, event: PointerEvent): void;
  /** Diagnostic-only reason paired with the already-emitted route decision. */
  onRouteDecision?(route: PointerRoute, reason: string, event: PointerEvent): void;
  /** Diagnostic-only claim result after annotation prevention/capture. */
  onPointerClaim?(route: "draw" | "edit" | "text", event: PointerEvent, details: {
    preventDefaultCalled: boolean;
    propagationStopped: boolean;
    captureAttempted: boolean;
    captureSucceeded: boolean;
  }): void;
  /** Fired as soon as this router's pointerdown listener runs (before classify). */
  onRouterReceived?(event: PointerEvent, generation: number): void;
  /** Page touchstart, before pen scroll-blocking. Raw TouchEvent, not a pointer type. */
  onTouchStart?(event: TouchEvent): void;
  /** Primary touch pointerdown, before native PDF routing. */
  onTouchPointerDown?(event: PointerEvent): void;
  /** True when a single finger is over a committed text annotation. */
  touchTextTarget?(event: PointerEvent): boolean;
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
  pointerInputCapabilities?(): PointerInputCapabilities;
}

export class PointerRouter {
  private static readonly DRAW_CURSOR_SIZE_PX = 6;
  private static nextGeneration = 1;

  /** Monotonic id for this listener generation (fresh AbortController per instance). */
  readonly generation: number;
  private readonly routed = new Map<number, "draw" | "edit" | "text">();
  private readonly routedPointerTypes = new Map<number, "pen" | "mouse" | "touch">();
  /** Same PointerEvent must not append ink twice when document and page both see it. */
  private readonly consumedStrokeEvents = new WeakSet<Event>();
  private readonly stylusErasers = new Set<number>();
  private touchAxis: TouchAxisGesture | null = null;
  private readonly manipulation: ManipulationStateMachine;
  private manipulationRearmTimer: number | undefined;
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly ownership: GestureOwnership;
  private readonly inputCapabilities: PointerInputCapabilities;
  private readonly resetOwnershipOnDestroy: boolean;
  private readonly abort = new AbortController();
  private readonly eraserCursor: HTMLElement;
  private readonly drawCursor: HTMLElement;
  private lastCursorClient: { x: number; y: number } | null = null;
  private lastCursorPointerType: string | null = null;
  private pendingCursorUpdate: Pick<PointerEvent, "clientX" | "clientY" | "pointerType"> | null = null;
  private cursorAnimationFrame: number | null = null;
  private readonly customPinchPoints = new Map<number, CustomPinchPoint>();
  private customPinchFrameAnimation: number | null = null;
  private customPinchActive = false;
  /** iOS can deliver TouchEvents without the promoting second PointerEvent. */
  private customPinchTouchFallbackActive = false;
  private touchTextContactActive = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy?: PalmRejectionPolicy,
    ownership?: GestureOwnership,
    resetOwnershipOnDestroy = true
  ) {
    this.generation = PointerRouter.nextGeneration++;
    const manipulationCapabilities = callbacks.manipulationCapabilities?.() ?? DEFAULT_MANIPULATION_PLATFORM_CAPABILITIES;
    const customPinchEnabled = callbacks.customPinchEnabled?.() === true && manipulationCapabilities.supportsTouchAction;
    this.manipulation = new ManipulationStateMachine({
      ...manipulationCapabilities,
      supportsCustomPinch: customPinchEnabled
    });
    this.manipulation.setCustomPinchEnabled(customPinchEnabled);
    this.palmPolicy = palmPolicy ?? new PalmRejectionPolicy();
    this.ownership = ownership ?? new GestureOwnership({ customPinchEnabled });
    this.inputCapabilities = callbacks.pointerInputCapabilities?.() ?? DEFAULT_POINTER_INPUT_CAPABILITIES;
    this.resetOwnershipOnDestroy = resetOwnershipOnDestroy;
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
    const options = { capture: true, passive: false, signal: this.abort.signal };
    const passiveOptions = { capture: true, passive: true, signal: this.abort.signal };
    if (this.inputCapabilities.pointerEvents) {
      element.addEventListener("pointerdown", this.handleDown, options);
      element.addEventListener("pointermove", this.handleMove, options);
      element.addEventListener("pointerup", this.handleEnd, options);
      element.addEventListener("pointercancel", this.handleCancel, options);
      element.addEventListener("lostpointercapture", this.handleLostPointerCapture, options);
      element.addEventListener("pointerleave", this.hideCustomCursors, options);
      // Native PDF scrolling can deliver a terminal event to another virtualized
      // page (or directly to document). Do not retain it as a phantom pinch.
      element.ownerDocument.addEventListener("pointerup", this.clearEndedTouch, passiveOptions);
      element.ownerDocument.addEventListener("pointercancel", this.clearEndedTouch, passiveOptions);
      element.ownerDocument.addEventListener("lostpointercapture", this.clearEndedTouch, passiveOptions);
    }
    if (this.inputCapabilities.touchEvents) {
      if (this.inputCapabilities.pointerEvents) {
        // iPad Pencil emits companion TouchEvents after pen pointerdown. Without
        // a non-passive cancel, WebKit still pans the PDF scroll root (touch-action
        // stays auto so fingers can scroll when no pen is down).
        element.addEventListener("touchstart", this.blockTouchScrollWhilePen, { ...options, passive: false });
        element.addEventListener("touchmove", this.blockTouchScrollWhilePen, { ...options, passive: false });
        // WKWebView may expose the two-finger TouchEvent stream while native
        // gesture recognition suppresses the promoting second PointerEvent.
        // Keep this page-local and only enable it after the same qualified gate.
        element.addEventListener("touchstart", this.handleTouchCustomPinch, options);
        element.addEventListener("touchmove", this.handleTouchCustomPinch, options);
        for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
          element.addEventListener(type, this.handleNativeGesture, options);
        }
        // Touch Events ignore Pointer Events capture (Ink). Use them for finger
        // bookkeeping + stale-pen unlock when pointerup never reaches the page.
        element.ownerDocument.addEventListener("touchend", this.handleTouchTerminal, { ...options, passive: true });
        element.ownerDocument.addEventListener("touchcancel", this.handleTouchTerminal, { ...options, passive: true });
      } else {
        // No Pointer Events means Touch Events are observation/native fallback
        // only. They must never synthesize a second drawing or pan engine.
        element.addEventListener("touchstart", this.observeTouchFallback, { ...options, passive: true });
        element.addEventListener("touchmove", this.observeTouchFallback, { ...options, passive: true });
        element.ownerDocument.addEventListener("touchend", this.observeTouchFallback, { ...options, passive: true });
        element.ownerDocument.addEventListener("touchcancel", this.observeTouchFallback, { ...options, passive: true });
      }
    }
    // Blur/background can suppress pointerup and leave a captured pen alive.
    // Cancel plugin-owned input at this lifecycle boundary; native touch remains
    // untouched when no plugin ownership exists.
    element.ownerDocument.addEventListener("visibilitychange", this.handleLifecycleCancellation, {
      ...passiveOptions
    });
    const view = element.ownerDocument.defaultView;
    view?.addEventListener("blur", this.handleLifecycleCancellation, passiveOptions);
    view?.addEventListener("pagehide", this.handleLifecycleCancellation, passiveOptions);
    this.syncTouchActionMode();
  }

  /**
   * Document pointermove owner for an open pen stroke. Page capture misses
   * samples after iOS moves pointer capture off the page; lostpointercapture
   * is not the end of that stroke.
   */
  acceptDocumentPenStroke(event: PointerEvent): boolean {
    if (this.abort.signal.aborted) return false;
    if (event.pointerType !== "pen" || event.type !== "pointermove") return false;
    // iPadOS also sends document-level Pencil hover moves. They cannot advance
    // an open tip stroke and would otherwise enter the capture-loss recovery path.
    if (event.buttons === 0 && event.pressure <= 0) return false;
    if (!this.routed.has(event.pointerId)) return false;
    this.handleMove(event);
    return true;
  }

  classify(event: PointerEvent): PointerRoute {
    return this.classifyWithReason(event).route;
  }

  private classifyWithReason(event: PointerEvent): { route: PointerRoute; reason: string } {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (this.palmPolicy.shouldIgnore(event)) return { route: "ignored", reason: "palm-rejection" };
      const activeTouchIds = this.ownership.snapshot().activeTouchIds;
      const multi = activeTouchIds.size + (activeTouchIds.has(event.pointerId) ? 0 : 1) >= 2;
      const touchFallback = this.callbacks.touchAnnotationEnabled?.() === true
        && this.callbacks.canAnnotatePointer(event);
      const textTarget = this.callbacks.touchTextTarget?.(event) === true;
      if (multi && this.customPinchAllowed() && !touchFallback && !this.touchTextContactActive && !textTarget) {
        return { route: "touch-custom-pinch", reason: "multi-touch-custom" };
      }
      if (multi) return { route: "touch-zoom-pan", reason: "multi-touch-native" };
      if (event.isPrimary !== false && this.callbacks.touchTextTarget?.(event)) {
        return { route: "text", reason: "text-box-touch" };
      }
      if (this.callbacks.touchAnnotationEnabled?.() === true && this.callbacks.canAnnotatePointer(event)) {
        if (tool === "text") return { route: "text", reason: "touch-fallback-text" };
        if (tool === "eraser" || tool === "lasso") return { route: "edit", reason: "touch-fallback-edit" };
        if (isInkDrawTool(tool)) return { route: "draw", reason: "touch-fallback-draw" };
      }
      // Fingers leave native scroll/pinch unless the gesture starts on a text box.
      return { route: "touch-pan", reason: "touch-native" };
    }
    if (event.pointerType === "mouse" && !isStylusEraserInput(event) && event.button !== 0 && event.button !== -1) {
      return { route: "native", reason: "mouse-primary-button-only" };
    }
    if (event.pointerType === "mouse"
      && this.callbacks.mouseInkingEnabled
      && !isStylusEraserInput(event)
      && !this.callbacks.mouseInkingEnabled()) {
      return { route: "native", reason: "mouse-inking-disabled" };
    }
    if (!this.callbacks.canAnnotatePointer(event)) {
      return { route: "native", reason: "annotation-policy" };
    }
    // MockTab can expose a physical eraser as a mouse pointer with W3C's
    // dedicated eraser button/bit. Route it before the active drawing tool.
    if (isStylusEraserInput(event)) return { route: "edit", reason: "stylus-eraser" };
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (this.isTextToolRoute(tool, event, penLike)) return { route: "text", reason: "text-tool" };
    const editing = tool === "eraser" || tool === "lasso";
    if (penLike) return { route: editing ? "edit" : "draw", reason: editing ? "stylus-edit" : "stylus-draw" };
    if (event.pointerType === "mouse" && event.button === 0 && isInkDrawTool(tool)) {
      return { route: "draw", reason: "mouse-draw" };
    }
    if (event.pointerType === "mouse" && event.button === 0 && editing) {
      return { route: "edit", reason: "mouse-edit" };
    }
    return { route: "native", reason: "unsupported-pointer" };
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
    if (this.ownership.snapshot().owner === "custom-touch-pinch") {
      this.ownership.setCustomPinchEnabled(false);
      this.finishCustomPinch("pen-contact");
      this.ownership.setCustomPinchEnabled(this.customPinchAllowed());
    }
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

  private touchIds(): number[] {
    return [...this.ownership.snapshot().activeTouchIds];
  }

  private touchCount(): number {
    return this.ownership.snapshot().activeTouchIds.size;
  }

  private customPinchAllowed(): boolean {
    return this.callbacks.customPinchEnabled?.() === true
      && this.inputCapabilities.pointerEvents
      && this.inputCapabilities.touchEvents;
  }

  private syncCustomPinchPolicy(): void {
    const enabled = this.customPinchAllowed();
    this.manipulation.setCustomPinchEnabled(enabled);
    const before = this.ownership.snapshot().owner;
    const after = this.ownership.setCustomPinchEnabled(enabled);
    if (!enabled && (before === "custom-touch-pinch" || this.customPinchActive)) {
      this.finishCustomPinch("disabled");
    } else if (before === "custom-touch-pinch" && after.owner !== "custom-touch-pinch") {
      this.finishCustomPinch("disabled");
    }
  }

  private updateCustomPinchPoint(event: PointerEvent): void {
    if (event.pointerType !== "touch" || this.customPinchTouchFallbackActive) return;
    this.customPinchPoints.set(event.pointerId, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY
    });
  }

  private touchContactsAreQualified(event: TouchEvent): boolean {
    const contacts = Array.from(event.touches).slice(0, 2);
    return contacts.length >= 2 && contacts.every((touch) => {
      const target = touch.target;
      return target instanceof Element
        && this.element.contains(target)
        && classifyInputTarget(target).targetClass === "page";
    });
  }

  private updateCustomPinchTouches(event: TouchEvent): boolean {
    if (!this.touchContactsAreQualified(event)) return false;
    this.customPinchPoints.clear();
    for (const touch of Array.from(event.touches).slice(0, 2)) {
      this.customPinchPoints.set(touch.identifier, {
        pointerId: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY
      });
    }
    return this.customPinchPoints.size >= 2;
  }

  private preventCustomPinchTouch(event: TouchEvent): void {
    if (!event.cancelable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * iPadOS/WKWebView can expose TouchEvents for a pinch while withholding the
   * second PointerEvent after native gesture recognition begins. Use the same
   * page-local gate and point stream as the pointer path, without synthesizing
   * ink or changing native one-finger navigation.
   */
  private readonly handleTouchCustomPinch = (event: TouchEvent): void => {
    if (!this.customPinchAllowed()
      || this.palmPolicy.hasActivePen()
      || classifyInputTarget(event.target).targetClass !== "page"
      || this.touchTextContactActive) return;
    if (this.customPinchActive && !this.customPinchTouchFallbackActive) return;
    if (event.type === "touchstart") {
      if (event.touches.length < 2 || this.customPinchActive) return;
      if (!this.updateCustomPinchTouches(event)) return;
      this.customPinchTouchFallbackActive = true;
      while (this.manipulation.activeTouches < 2) this.beginManipulationTouch();
      this.beginCustomPinch();
      this.preventCustomPinchTouch(event);
      return;
    }
    if (!this.customPinchTouchFallbackActive) return;
    if (!this.updateCustomPinchTouches(event)) return;
    this.scheduleCustomPinchFrame();
    this.preventCustomPinchTouch(event);
  };

  /** Stop WebKit's parallel native GestureEvent recognizer on a qualified page. */
  private readonly handleNativeGesture = (event: Event): void => {
    if (!this.customPinchAllowed()
      || classifyInputTarget(event.target).targetClass !== "page") return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  private currentCustomPinchFrame(): CustomPinchFrame {
    return {
      generation: this.generation,
      points: [...this.customPinchPoints.values()]
        .sort((left, right) => left.pointerId - right.pointerId)
        .map((point) => ({ ...point }))
    };
  }

  private beginCustomPinch(): void {
    if (this.customPinchActive) return;
    this.customPinchActive = true;
    this.callbacks.onCustomPinchStart?.(this.currentCustomPinchFrame());
    this.scheduleCustomPinchFrame();
  }

  private scheduleCustomPinchFrame(): void {
    if (!this.customPinchActive || this.customPinchPoints.size < 2 || this.customPinchFrameAnimation !== null) return;
    const view = this.element.ownerDocument.defaultView;
    const flush = (): void => {
      this.customPinchFrameAnimation = null;
      if (!this.customPinchActive || this.customPinchPoints.size < 2) return;
      this.callbacks.onCustomPinchFrame?.(this.currentCustomPinchFrame());
    };
    this.customPinchFrameAnimation = view?.requestAnimationFrame?.(flush)
      ?? (view?.setTimeout(flush, 16) ?? window.setTimeout(flush, 16));
  }

  private finishCustomPinch(reason: "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled"): void {
    if (this.customPinchFrameAnimation !== null) {
      const view = this.element.ownerDocument.defaultView;
      if (view?.cancelAnimationFrame) view.cancelAnimationFrame(this.customPinchFrameAnimation);
      else (view?.clearTimeout ?? window.clearTimeout)(this.customPinchFrameAnimation);
      this.customPinchFrameAnimation = null;
    }
    this.customPinchPoints.clear();
    this.customPinchTouchFallbackActive = false;
    if (!this.customPinchActive) return;
    this.customPinchActive = false;
    this.callbacks.onCustomPinchEnd?.(reason);
  }

  private finishManipulationTouch(event: PointerEvent, panned: boolean): void {
    if (event.pointerType !== "touch" || this.manipulation.activeTouches === 0) return;
    const transition = this.manipulation.touchEnd(panned);
    this.applyManipulationTransition(transition);
  }

  /** Native finger contact. Pencil-first: this never creates an ink route. */
  private beginManipulationTouch(): void {
    this.applyManipulationTransition(this.manipulation.touchStart());
  }

  private readonly handleDown = (event: PointerEvent): PointerRoute => {
    if (this.abort.signal.aborted) {
      this.callbacks.onPointerRejected?.("stale-generation", event, this.generation);
      return "ignored";
    }
    this.callbacks.onRouterReceived?.(event, this.generation);
    if (this.callbacks.isInputOwnerActive?.() === false) {
      this.callbacks.onPointerRejected?.("inactive-owner", event, this.generation);
      return "ignored";
    }
    const targetClass = classifyInputTarget(event.target);
    if (targetClass.targetClass !== "page") {
      this.callbacks.onPointerRejected?.("annotation-chrome", event, this.generation);
      return "native";
    }
    if (this.callbacks.isPointerHandled?.(event.pointerId, this.generation)) {
      this.callbacks.onPointerRejected?.("already-handled", event, this.generation);
      return "ignored";
    }
    this.callbacks.onPointerHandled?.(event.pointerId, this.generation);
    this.paintCustomCursorsNow(event);
    this.syncCustomPinchPolicy();
    // A TouchEvent fallback may already own the two-finger gesture while this
    // host is still emitting a late/duplicate PointerEvent.
    if (event.pointerType === "touch" && this.customPinchTouchFallbackActive) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return "touch-custom-pinch";
    }
    if (event.pointerType === "touch" && event.isPrimary !== false) this.callbacks.onTouchPointerDown?.(event);
    if (event.pointerType === "touch") {
      if (this.touchCount() === 0) this.touchTextContactActive = this.callbacks.touchTextTarget?.(event) === true;
      this.updateCustomPinchPoint(event);
    }
    if (event.pointerType === "touch") {
      // Finger after a vanished Pencil tip: do not keep scroll-lock forever.
      this.palmPolicy.reconcileStalePenOnTouch();
    }
    if (event.pointerType === "touch" && event.isPrimary && this.touchCount() > 0) {
      const trackedBefore = this.touchCount();
      this.ownership.clearTouchContacts();
      this.clearManipulationRearm();
      this.finishCustomPinch("lifecycle");
      this.manipulation.reset();
      // Keep active pens — a stale finger ID must not unlock Pencil scroll lock.
      if (!this.palmPolicy.hasActivePen()) this.palmPolicy.reset();
      this.callbacks.onTouchLifecycle?.("primary-reset", event, { trackedBefore, trackedAfter: 0 });
    }
    this.notePenSignal(event);
    this.palmPolicy.pointerDown(event);
    if (this.palmPolicy.hasActivePen()) this.syncTouchActionMode();
    this.beginStylusEraser(event);
    const routeDecision = this.classifyWithReason(event);
    let route = routeDecision.route;
    const touchTextTarget = event.pointerType === "touch"
      && route === "text"
      && this.callbacks.touchTextTarget?.(event) === true;
    const ownershipDecision = event.pointerType === "touch" || route === "draw" || route === "edit" || route === "text"
      ? this.ownership.pointerDown({
        pointerId: event.pointerId,
        pointerType: this.gesturePointerType(event),
        button: event.button,
        buttons: event.buttons,
        target: event.pointerType === "touch" || this.callbacks.canAnnotatePointer(event) ? "page" : "ui",
        inkToolSelected: route === "draw" || route === "edit" || route === "text",
        inkIntent: (route === "draw" || route === "edit" || route === "text")
          && (event.pointerType !== "touch" || this.callbacks.canAnnotatePointer(event) || touchTextTarget)
      })
      : { state: this.ownership.snapshot() };
    if (this.palmPolicy.hasActivePen()) {
      this.palmPolicy.adoptActivePenIds(this.activePenIds());
      this.syncTouchActionMode();
    }
    let routeReason = routeDecision.reason;
    const gesturePointerType = this.gesturePointerType(event);
    if (gesturePointerType === "pen"
      && (route === "draw" || route === "edit" || route === "text")
      && (ownershipDecision.state.owner !== "pen-ink" || ownershipDecision.state.activePenId !== event.pointerId)) {
      route = "ignored";
      routeReason = "gesture-ownership";
    } else if (gesturePointerType === "mouse"
      && (route === "draw" || route === "edit" || route === "text")
      && (ownershipDecision.state.owner !== "mouse-ink" || ownershipDecision.state.activeMousePointerId !== event.pointerId)) {
      route = "native";
      routeReason = "gesture-ownership";
    } else if (gesturePointerType === "touch"
      && (route === "draw" || route === "edit" || route === "text")
      && (ownershipDecision.state.owner !== "touch-ink"
        || !ownershipDecision.state.activeTouchIds.has(event.pointerId))) {
      route = "touch-pan";
      routeReason = "gesture-ownership";
    } else if (gesturePointerType === "touch"
      && route === "touch-custom-pinch"
      && (ownershipDecision.state.owner !== "custom-touch-pinch"
        || !ownershipDecision.state.activeTouchIds.has(event.pointerId))) {
      route = "touch-pan";
      routeReason = "gesture-ownership";
    }
    this.callbacks.onRouteDecision?.(route, routeReason, event);
    if (
      event.pointerType === "touch"
      && (route === "touch-pan" || route === "touch-zoom-pan" || route === "touch-custom-pinch")
      && this.manipulation.activeTouches < this.touchCount()
    ) {
      this.beginManipulationTouch();
    }
    this.callbacks.onRoute?.(route, event);
    if (route === "touch-zoom-pan") {
      for (const [pointerId, routed] of this.routed) {
        if (this.routedPointerTypes.get(pointerId) !== "touch") continue;
        const cancel = this.syntheticPointerEvent(pointerId, "pointercancel", "touch");
        this.callbacks.onCancel?.(routed, cancel);
        this.releaseGestureOwnership(cancel, "pointercancel");
        safeReleasePointerCapture(this.element, pointerId);
        this.routed.delete(pointerId);
        this.routedPointerTypes.delete(pointerId);
      }
      this.clearTouchAxisGesture("multi-finger");
    }
    if (route === "touch-custom-pinch") {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      this.beginCustomPinch();
      return route;
    }
    // Palm / Pencil companion touch while a stylus is down: block native scroll.
    if (route === "ignored") {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      this.syncTouchActionMode();
      this.callbacks.onTouchLifecycle?.("scroll-block", event, {
        reason: "ignored-pointer",
        activePens: this.palmPolicy.hasActivePen(),
        touchCount: this.touchCount()
      });
      return route;
    }
    if (route !== "draw" && route !== "edit" && route !== "text") return route;
    this.routed.set(event.pointerId, route);
    if (event.pointerType === "pen" || event.pointerType === "mouse" || event.pointerType === "touch") {
      this.routedPointerTypes.set(event.pointerId, event.pointerType);
    }
    const deferTouchTextClaim = event.pointerType === "touch" && route === "text";
    if (!deferTouchTextClaim) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }
    const capture = deferTouchTextClaim
      ? { attempted: false, succeeded: true }
      : safeSetPointerCapture(this.element, event.pointerId);
    this.callbacks.onPointerClaim?.(route, event, {
      preventDefaultCalled: event.defaultPrevented,
      propagationStopped: event.cancelBubble,
      captureAttempted: capture.attempted,
      captureSucceeded: capture.succeeded
    });
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
    if (this.abort.signal.aborted) return false;
    if (this.callbacks.isInputOwnerActive?.() === false) return false;
    if (isUiInputTarget(event.target)) return false;
    if (!this.callbacks.canAnnotatePointer(event) || !isTipContact(event)) return false;
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (!penLike) return false;
    this.callbacks.onRouterReceived?.(event, this.generation);
    this.palmPolicy.pointerDown(event);
    if (this.palmPolicy.hasActivePen()) this.syncTouchActionMode();
    this.beginStylusEraser(event);
    const route = this.classify(event);
    if (route !== "draw" && route !== "edit" && route !== "text") return false;
    const ownership = this.ownership.pointerDown({
      pointerId: event.pointerId,
      pointerType: this.gesturePointerType(event),
      button: event.button,
      buttons: event.buttons,
      target: "page",
      inkToolSelected: true,
      inkIntent: true
    });
    if (this.palmPolicy.hasActivePen()) this.palmPolicy.adoptActivePenIds(this.activePenIds());
    const gesturePointerType = this.gesturePointerType(event);
    const expectedOwner = gesturePointerType === "mouse" ? "mouse-ink" : "pen-ink";
    if (ownership.state.owner !== expectedOwner
      || (gesturePointerType === "pen"
        ? ownership.state.activePenId !== event.pointerId
        : ownership.state.activeMousePointerId !== event.pointerId)) {
      return false;
    }
    this.routed.set(event.pointerId, route);
    if (event.pointerType === "pen" || event.pointerType === "mouse") {
      this.routedPointerTypes.set(event.pointerId, event.pointerType);
    }
    this.callbacks.onPointerHandled?.(event.pointerId, this.generation);
    this.callbacks.onRouteDecision?.(route, "recovered-pointerdown", event);
    this.callbacks.onRoute?.(route, event);
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    const capture = safeSetPointerCapture(this.element, event.pointerId);
    this.callbacks.onPointerClaim?.(route, event, {
      preventDefaultCalled: event.defaultPrevented,
      propagationStopped: event.cancelBubble,
      captureAttempted: capture.attempted,
      captureSucceeded: capture.succeeded
    });
    this.syncTouchActionMode();
    this.callbacks.onStart?.(this.inkSamples(event), route, event);
    return true;
  }

  /** Cancel companion TouchEvents while stylus is down (iPad WebKit scroll path). */
  private readonly blockTouchScrollWhilePen = (event: TouchEvent): void => {
    if (event.type === "touchstart") this.callbacks.onTouchStart?.(event);
    // Companion touchstart arrives ~0–4ms after pen down — reconcile only when stale.
    this.palmPolicy.reconcileStalePenOnTouch();
    if (!this.palmPolicy.hasActivePen()) return;
    // A native pinch already owns two fingers; a Pencil transition must not
    // cancel that browser gesture through the companion Touch stream.
    if (this.touchCount() >= 2) return;
    if (!event.cancelable) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "touchstart") {
      this.callbacks.onTouchLifecycle?.("scroll-block", event, {
        reason: "touch-while-pen",
        activePens: true,
        touchCount: event.touches.length,
        activePenIds: this.activePenIds()
      });
    }
  };

  /** Pointer-less hosts keep Touch Events passive and native-only. */
  private readonly observeTouchFallback = (event: TouchEvent): void => {
    if (event.type === "touchstart") this.callbacks.onTouchStart?.(event);
  };

  /**
   * Document touchend/cancel — fires even when setPointerCapture stole pointer
   * terminals (Ink). Clears finger bookkeeping; clears pen only if stale.
   */
  private readonly handleTouchTerminal = (event: TouchEvent): void => {
    const trackedBefore = this.touchCount();
    const hadTouchAxis = this.touchAxis !== null;
    const hadActivePen = this.palmPolicy.hasActivePen();
    // A qualified iOS TouchEvent fallback ends when either finger leaves. The
    // pointer terminal may be absent or arrive later, so commit/cancel here.
    if (this.customPinchTouchFallbackActive) {
      if (event.type === "touchcancel") this.finishCustomPinch("pointercancel");
      else if (event.touches.length < 2) this.finishCustomPinch("pointerup");
      this.syncTouchActionMode();
    }
    // Every page router observes document terminals. Once the owning router
    // clears shared touch state, the remaining page routers have no work and
    // must not repeat the same bookkeeping or diagnostic record.
    if (trackedBefore === 0 && !hadTouchAxis && !hadActivePen && !this.customPinchActive) return;
    for (const touch of Array.from(event.changedTouches)) {
      const terminal = this.syntheticPointerEvent(touch.identifier, event.type === "touchcancel" ? "pointercancel" : "pointerup");
      this.releaseGestureOwnership(terminal, event.type === "touchcancel" ? "pointercancel" : "pointerup");
      const panned = this.touchAxis?.pointerId === touch.identifier
        && (this.touchAxis.active || this.touchAxis.lock === "vertical");
      if (this.touchAxis?.pointerId === touch.identifier) {
        this.clearTouchAxisGesture(event.type === "touchcancel" ? "touchcancel" : "pointerup", terminal);
      }
      this.finishManipulationTouch(terminal, panned);
    }
    const remaining = event.touches.length;
    if (remaining > 0) {
      if (trackedBefore !== this.touchCount()) {
        this.callbacks.onTouchLifecycle?.(
          event.type === "touchcancel" ? "touchcancel" : "touchend",
          event,
          {
            reason: "touch-partial-end",
            trackedBefore,
            trackedAfter: this.touchCount(),
            touchCount: remaining,
            activePens: this.palmPolicy.hasActivePen()
          }
        );
      }
      return;
    }
    this.ownership.clearTouchContacts();
    this.manipulation.reset();
    // Companion touchend can arrive while Pencil tip is still down — only clear
    // pens that look stale (no tip sample within grace window).
    const stalePenCleared = this.palmPolicy.reconcileStalePenOnTouch();
    if (this.touchAxis) this.clearTouchAxisGesture("touch-all-clear");
    this.syncTouchActionMode();
    if (trackedBefore === 0 && !hadTouchAxis && !hadActivePen && !stalePenCleared) return;
    this.callbacks.onTouchLifecycle?.(
      event.type === "touchcancel" ? "touchcancel" : "touchend",
      event,
      {
        reason: event.type === "touchcancel" ? "touchcancel-all-clear" : "touchend-all-clear",
        trackedBefore,
        trackedAfter: 0,
        touchCount: 0,
        activePens: this.palmPolicy.hasActivePen(),
        activePenIds: this.activePenIds(),
        stalePenCleared
      }
    );
  };

  /** Pen or a vertical axis lock wins. Otherwise the manipulation machine owns touch-action. */
  private syncTouchActionMode(): void {
    const nativeTouchGesture = this.touchCount() > 0;
    const touchInk = this.ownership.snapshot().owner === "touch-ink";
    const mode = touchInk || ((this.palmPolicy.hasActivePen() && !nativeTouchGesture) || this.touchAxis?.lock === "vertical")
      ? "none"
      : this.manipulation.touchAction();
    const customPinchGuard = mode === "pan-xy" && this.customPinchAllowed();
    this.element.classList.toggle("native-pdf-handwriting-touch-none", mode === "none");
    this.element.classList.toggle("native-pdf-handwriting-touch-pan-xy", mode === "pan-xy");
    // Keep one-finger panning but remove `pinch-zoom` from the qualified
    // custom path. Leaving native pinch enabled prevents WebKit from
    // delivering the second touch pointer that promotes this router.
    this.element.classList.toggle("native-pdf-handwriting-touch-custom-pinch", customPinchGuard);
    // Legacy alias from 0.1.42–0.1.45 — keep cleared so only one mode class wins.
    this.element.classList.remove("native-pdf-handwriting-pen-capturing");
  }

  gesturePolicy(): {
    manipulationState: ManipulationState;
    manipulationActiveTouches: number;
    manipulationTouchAction: "none" | "pan-xy";
    touchNoneClassPresent: boolean;
    touchPanXyClassPresent: boolean;
    customPinchGuardClassPresent: boolean;
    computedTouchAction: string;
  } {
    const view = this.element.ownerDocument.defaultView;
    return {
      manipulationState: this.manipulation.state,
      manipulationActiveTouches: this.manipulation.activeTouches,
      manipulationTouchAction: this.manipulation.touchAction(),
      touchNoneClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-none"),
      touchPanXyClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-pan-xy"),
      customPinchGuardClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-custom-pinch"),
      computedTouchAction: view?.getComputedStyle(this.element).touchAction ?? ""
    };
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
        touchCount: this.touchCount()
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
    if (this.palmPolicy.hasActivePen() || this.touchCount() >= 2) {
      this.clearTouchAxisGesture(this.touchCount() >= 2 ? "multi-finger" : "draw-or-pen");
      return;
    }
    this.clearTouchAxisGesture("native-touch-policy");
  }

  private emitPenStateReset(
    reason: PenStateResetReason,
    activePenIds: number[],
    event?: PointerEvent | TouchEvent
  ): void {
    // A real routed stroke can be quiet longer than the palm-safety timeout.
    // Keep that contact alive; terminal/lifecycle events still own cleanup.
    const retained = reason === "pen-inactivity-timeout"
      ? activePenIds.filter((pointerId) => this.routed.has(pointerId))
      : [];
    if (retained.length) this.palmPolicy.adoptActivePenIds(retained);
    for (const pointerId of activePenIds) {
      if (retained.includes(pointerId)) continue;
      const route = this.routed.get(pointerId);
      if (route) {
        const cancel = this.syntheticPointerEvent(pointerId, "pointercancel", "pen");
        this.callbacks.onCancel?.(route, cancel);
        safeReleasePointerCapture(this.element, pointerId);
        this.routed.delete(pointerId);
        this.routedPointerTypes.delete(pointerId);
      }
      if (this.stylusErasers.delete(pointerId) && this.stylusErasers.size === 0) {
        this.callbacks.onStylusEraserEnd?.();
      }
      this.ownership.pointerCancel({ pointerId, pointerType: "pen", buttons: 0 });
    }
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

  private syntheticPointerEvent(
    pointerId: number,
    type: "pointerup" | "pointercancel" = "pointercancel",
    pointerType: "pen" | "mouse" | "touch" = "touch"
  ): PointerEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      pointerType: { value: pointerType },
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

  private gesturePointerType(event: PointerEvent): "pen" | "touch" | "mouse" {
    if (event.pointerType === "touch") return "touch";
    if (event.pointerType === "pen") return "pen";
    if (this.ownership.snapshot().activePenId === event.pointerId
      || this.palmPolicy.shouldTreatMouseTipAsPen(event)) {
      return "pen";
    }
    return "mouse";
  }

  private releaseGestureOwnership(
    event: PointerEvent,
    phase: "pointerup" | "pointercancel" | "lostpointercapture"
  ): void {
    const contact = {
      pointerId: event.pointerId,
      pointerType: this.gesturePointerType(event),
      button: event.button,
      buttons: event.buttons
    } as const;
    const wasCustomPinch = this.ownership.snapshot().owner === "custom-touch-pinch";
    if (phase === "pointercancel") this.ownership.pointerCancel(contact);
    else if (phase === "lostpointercapture") this.ownership.lostCapture(contact);
    else this.ownership.pointerUp(contact);
    if (wasCustomPinch && this.ownership.snapshot().owner !== "custom-touch-pinch") {
      this.finishCustomPinch(phase);
    }
    if (event.pointerType === "touch") {
      this.customPinchPoints.delete(event.pointerId);
      if (this.touchCount() === 0) this.touchTextContactActive = false;
    }
  }

  private finishRoutedPointer(event: PointerEvent, phase: "pointerup" | "pointercancel"): void {
    const route = this.routed.get(event.pointerId);
    if (!route) return;
    if (phase === "pointercancel") {
      this.callbacks.onPredictedMove?.([], route, event);
      this.callbacks.onCancel?.(route, event);
    } else {
      this.callbacks.onPredictedMove?.([], route, event);
      this.callbacks.onEnd?.(this.inkSamples(event), route, event);
    }
    safeReleasePointerCapture(this.element, event.pointerId);
    this.routed.delete(event.pointerId);
    this.routedPointerTypes.delete(event.pointerId);
  }

  /**
   * Pointerup is not guaranteed across blur, backgrounding, or pagehide.
   * Cancel every plugin-owned route and clear native-touch bookkeeping without
   * synthesizing a replacement navigation gesture.
   */
  private readonly handleLifecycleCancellation = (event: Event): void => {
    if (event.type === "visibilitychange" && this.element.ownerDocument.visibilityState !== "hidden") return;
    const trackedBefore = this.touchCount();
    const owned = this.routed.size > 0
      || this.stylusErasers.size > 0
      || this.touchCount() > 0
      || this.touchAxis !== null
      || this.palmPolicy.hasActivePen();
    if (!owned) return;

    for (const pointerId of [...this.routed.keys()]) {
      const pointerType = this.routedPointerTypes.get(pointerId) ?? "pen";
      this.finishRoutedPointer(this.syntheticPointerEvent(pointerId, "pointercancel", pointerType), "pointercancel");
    }
    if (this.stylusErasers.size > 0) this.callbacks.onStylusEraserEnd?.();
    this.stylusErasers.clear();
    if (this.touchAxis) this.clearTouchAxisGesture(`lifecycle-${event.type}`);
    this.clearManipulationRearm();
    this.manipulation.reset();
    this.palmPolicy.clearAll("pointercancel");
    this.finishCustomPinch("lifecycle");
    this.ownership.replaceGeneration();
    this.syncTouchActionMode();
    this.hideCustomCursors();
    this.callbacks.onTouchLifecycle?.("pointercancel", event, {
      reason: `lifecycle-${event.type}`,
      trackedBefore,
      trackedAfter: 0,
      activePens: false,
      activePenIds: []
    });
  };

  /** Clear stylus contact — Ink unlockScroll equivalent. */
  private releasePenContact(event: PointerEvent, reason: Extract<PenStateResetReason, "pointerup" | "pointercancel" | "lostpointercapture">): void {
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (!this.palmPolicy.activePenIds().includes(event.pointerId)) return;
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
    if (this.abort.signal.aborted) return;
    this.scheduleCustomCursorUpdate(event);
    this.notePenSignal(event);
    this.palmPolicy.notePenActivity(event);
    if (event.pointerType === "touch") {
      this.updateCustomPinchPoint(event);
      if (this.customPinchTouchFallbackActive) {
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (this.ownership.snapshot().owner === "custom-touch-pinch") this.scheduleCustomPinchFrame();
    }
    const route = this.routed.get(event.pointerId);
    const ownership = this.ownership.pointerMove({
      pointerId: event.pointerId,
      pointerType: this.gesturePointerType(event),
      button: event.button,
      buttons: event.buttons
    });
    if (route) {
      if ((event.pointerType === "pen" || event.pointerType === "mouse") && ownership.action !== "append-ink") {
        return;
      }
      if (this.consumedStrokeEvents.has(event)) return;
      // Ink: skip Pencil hover / near-zero pressure on move (keep down/up for floor + tip).
      const samples = this.inkSamples(event, {
        skipPenHover: route === "draw" || route === "edit"
      });
      const predicted = route === "draw" && event.pointerType === "pen"
        ? PointerCapabilities.predictedSamples(event)
        : [];
      if (samples.length === 0) {
        this.callbacks.onPredictedMove?.(predicted, route, event);
        return;
      }
      this.consumedStrokeEvents.add(event);
      this.callbacks.onMove?.(samples, route, event);
      this.callbacks.onPredictedMove?.(predicted, route, event);
      if (!(route === "text" && event.pointerType === "touch")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (this.recoverMissingPointerDown(event)) return;
    this.updateTouchAxisGesture(event);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (event.pointerType === "touch" && this.customPinchTouchFallbackActive) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    this.paintCustomCursorsNow(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      this.callbacks.onPredictedMove?.([], route, event);
      this.callbacks.onEnd?.(this.inkSamples(event), route, event);
      if (!(route === "text" && event.pointerType === "touch")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
      this.routedPointerTypes.delete(event.pointerId);
    }
    this.releaseGestureOwnership(event, "pointerup");
    this.releasePenContact(event, "pointerup");
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    const endedTouchGesture = this.touchAxis?.pointerId === event.pointerId;
    const pannedTouch = Boolean(endedTouchGesture && (this.touchAxis?.active || this.touchAxis?.lock === "vertical"));
    if (endedTouchGesture) this.clearTouchAxisGesture("pointerup", event);
    this.finishManipulationTouch(event, pannedTouch);
    this.syncTouchActionMode();
    // The custom cursor is a live pointer affordance, never a mark left after
    // drawing. Hover movement paints it again when the mouse/pen is active.
    this.hideCustomCursors();
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (event.pointerType === "touch" && this.customPinchTouchFallbackActive) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onPredictedMove?.([], route, event);
      this.callbacks.onCancel?.(route, event);
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
      this.routedPointerTypes.delete(event.pointerId);
    }
    this.releaseGestureOwnership(event, "pointercancel");
    this.releasePenContact(event, "pointercancel");
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) this.callbacks.onStylusEraserEnd?.();
    const endedTouchGesture = this.touchAxis?.pointerId === event.pointerId;
    if (endedTouchGesture) this.clearTouchAxisGesture("pointercancel", event);
    this.finishManipulationTouch(event, false);
    this.syncTouchActionMode();
    this.hideCustomCursors();
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (event.pointerType === "mouse" || event.pointerType === "pen") this.hideCustomCursors();
    // iOS drops page pointermove after capture leaves the page and reports
    // lostpointercapture at (0, 0). That is capture moving, not the pen lift.
    // The document listener keeps appending until pointerup or pointercancel.
    if (event.pointerType === "pen" && this.routed.has(event.pointerId)) return;
    if (event.pointerType === "pen" && this.palmPolicy.hasActivePen()) {
      this.releaseGestureOwnership(event, "lostpointercapture");
      this.releasePenContact(event, "lostpointercapture");
      this.syncTouchActionMode();
      return;
    }
    // Mouse ink routes (including MockTab tip-as-mouse) need the same finish path.
    if (event.pointerType === "mouse" && this.routed.has(event.pointerId)) {
      this.finishRoutedPointer(event, "pointerup");
      this.releaseGestureOwnership(event, "lostpointercapture");
      this.releasePenContact(event, "lostpointercapture");
      this.syncTouchActionMode();
    }
  };

  private readonly clearEndedTouch = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    // Document capture: Pencil terminal events often miss the page listener after
    // acceptPointerDown + setPointerCapture (same failure Ink documents).
    if (event.pointerType === "pen" && event.type === "lostpointercapture") return;
    if (event.pointerType === "pen") {
      const hadRoute = this.routed.has(event.pointerId);
      const hadPen = this.palmPolicy.hasActivePen();
      const phase = event.type === "pointercancel" ? "pointercancel" : "pointerup";
      this.finishRoutedPointer(event, phase);
      this.releaseGestureOwnership(event, event.type === "pointercancel" ? "pointercancel" : "pointerup");
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
            activePenIds: this.activePenIds()
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
      this.routedPointerTypes.delete(event.pointerId);
    }
    const trackedBefore = this.touchCount();
    const hadTouch = this.ownership.snapshot().activeTouchIds.has(event.pointerId);
    this.releaseGestureOwnership(
      event,
      event.type === "pointercancel" ? "pointercancel" : event.type === "lostpointercapture" ? "lostpointercapture" : "pointerup"
    );
    const removed = hadTouch;
    if (!removed && !completion) return;
    const phase = event.type === "pointerup"
      ? "pointerup"
      : event.type === "pointercancel"
        ? "pointercancel"
        : "lostpointercapture";
    this.callbacks.onTouchLifecycle?.(phase, event, {
      trackedBefore,
      trackedAfter: this.touchCount(),
      ...(route ? { route } : {}),
      ...(completion ? { completion } : {})
    });
  };

  /**
   * Abort a custom pinch before page/viewer replacement or capability loss.
   * This is intentionally routed through the existing GestureOwnership instance
   * so no second interaction state can retain a touch after the compositor is
   * released.
   */
  cancelCustomPinch(reason: "lifecycle" | "disabled" = "lifecycle"): void {
    if (this.ownership.snapshot().owner !== "custom-touch-pinch" && !this.customPinchActive) return;
    this.ownership.setCustomPinchEnabled(false);
    this.finishCustomPinch(reason);
    this.ownership.clearTouchContacts();
    this.manipulation.reset();
    this.clearManipulationRearm();
    this.syncTouchActionMode();
  }

  syncToolState(): void {
    this.cancelScheduledCursorUpdate();
    this.syncCustomPinchPolicy();
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

  /** Exact page element captured by this listener generation, for diagnostics. */
  boundElement(): HTMLElement {
    return this.element;
  }

  /** True once destroy() has aborted this listener generation. */
  isAborted(): boolean {
    return this.abort.signal.aborted;
  }

  /** True when this router is still listening on the given page node. */
  bindsTo(element: HTMLElement): boolean {
    return this.element === element;
  }

  /** Listeners survive only while the abort signal is live and the page is in the document. */
  isAlive(): boolean {
    return !this.isAborted() && this.element.isConnected;
  }

  /** Diagnostic-only listener state; routing callers must not use this to change policy. */
  isListenerAborted(): boolean {
    return this.abort.signal.aborted;
  }

  activePenIds(): number[] {
    const activePenId = this.ownership.snapshot().activePenId;
    return activePenId === null ? [] : [activePenId];
  }

  activeTouchPointerIds(): number[] {
    return this.touchIds();
  }

  activeRoutedPointerIds(): number[] {
    return [...this.routed.keys()];
  }

  adoptPointerState(handoff: PointerRouterHandoff): void {
    for (const { pointerId, route } of handoff.routed) {
      this.routed.set(pointerId, route);
      this.routedPointerTypes.set(pointerId, handoff.activePenIds.includes(pointerId) ? "pen" : "mouse");
      try {
        this.element.setPointerCapture?.(pointerId);
      } catch {
        // The platform may have already ended the pointer during the rebind.
      }
    }
    for (const penId of handoff.activePenIds) {
      this.ownership.adoptPenContact(penId);
    }
    this.palmPolicy.adoptActivePenIds(handoff.activePenIds);
    this.syncTouchActionMode();
  }

  /**
   * Drop captures this router still owns. Does not clear touch bookkeeping or
   * change the next route. Used once at zoom settle as a single recovery probe.
   */
  releaseOwnedPointerCaptures(): number[] {
    const ids = new Set<number>([
      ...this.routed.keys(),
      ...this.touchIds(),
      ...this.stylusErasers,
      ...(this.touchAxis ? [this.touchAxis.pointerId] : [])
    ]);
    const released: number[] = [];
    for (const pointerId of ids) {
      if (safeReleasePointerCapture(this.element, pointerId)) released.push(pointerId);
    }
    return released;
  }

  hasPointerCapture(pointerId: number): boolean {
    try {
      return this.element.hasPointerCapture?.(pointerId) ?? false;
    } catch {
      return false;
    }
  }

  destroy(): void {
    if (this.abort.signal.aborted) return;
    this.cancelScheduledCursorUpdate();
    this.clearManipulationRearm();
    const handoff: PointerRouterHandoff = {
      routed: [...this.routed.entries()].map(([pointerId, route]) => ({ pointerId, route })),
      activePenIds: this.activePenIds()
    };
    const captureIds = new Set<number>([
      ...handoff.routed.map(({ pointerId }) => pointerId),
      ...this.touchIds(),
      ...this.stylusErasers,
      ...(this.touchAxis ? [this.touchAxis.pointerId] : [])
    ]);
    for (const pointerId of captureIds) {
      safeReleasePointerCapture(this.element, pointerId);
    }
    this.routed.clear();
    this.routedPointerTypes.clear();
    if (this.stylusErasers.size > 0) this.callbacks.onStylusEraserEnd?.();
    this.stylusErasers.clear();
    this.finishCustomPinch("lifecycle");
    this.manipulation.reset();
    this.clearTouchAxisGesture("destroy");
    this.touchAxis = null;
    this.palmPolicy.setResetListener(null);
    this.palmPolicy.reset();
    if (this.resetOwnershipOnDestroy) this.ownership.replaceGeneration();
    this.callbacks.onPointerOwnerReleased?.(this.generation, handoff);
    this.abort.abort();
    this.element.classList.remove(
      "native-pdf-handwriting-has-eraser-cursor",
      "native-pdf-handwriting-has-draw-cursor",
      "native-pdf-handwriting-pen-capturing",
      "native-pdf-handwriting-touch-none",
      "native-pdf-handwriting-touch-pan-xy",
      "native-pdf-handwriting-touch-custom-pinch"
    );
    this.eraserCursor.remove();
    this.drawCursor.remove();
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
    this.lastCursorPointerType = event.pointerType;
    this.updateDrawCursor(event);
    this.updateEraserCursor(event);
  }

  private updateDrawCursor(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerType">): void {
    if (
      event.pointerType !== "mouse"
      && event.pointerType !== "pen"
      && !(event.pointerType === "touch" && this.callbacks.touchAnnotationEnabled?.() === true)
    ) {
      this.hideDrawCursor();
      return;
    }
    this.paintDrawCursor(event.clientX, event.clientY, event.pointerType);
  }

  private paintDrawCursor(clientX: number, clientY: number, pointerType?: string): void {
    const tool = this.callbacks.activeTool();
    const type = pointerType ?? this.lastCursorPointerType ?? "mouse";
    const pointerAllows = type === "pen"
      || (type === "touch" && this.callbacks.touchAnnotationEnabled?.() === true)
      || this.callbacks.mouseInkingEnabled?.() === true;
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
    if (
      event.pointerType !== "mouse"
      && event.pointerType !== "pen"
      && !(event.pointerType === "touch" && this.callbacks.touchAnnotationEnabled?.() === true)
    ) {
      this.hideEraserCursor();
      return;
    }
    this.paintEraserCursor(event.clientX, event.clientY, event.pointerType);
  }

  private paintEraserCursor(clientX: number, clientY: number, pointerType?: string): void {
    const type = pointerType ?? this.lastCursorPointerType ?? "mouse";
    const pointerAllows = type === "pen"
      || (type === "touch" && this.callbacks.touchAnnotationEnabled?.() === true)
      || this.callbacks.mouseInkingEnabled?.() === true;
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

