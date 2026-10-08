import { appendToBodyOr, createDetachedSpan } from "../vendor/createDetached";
import { setElementCssProps } from "../dom/typeGuards";
import { isInkDrawTool, type ToolId } from "../model";
import { classifyInputTarget, isUiInputTarget } from "./InputTargetClassification";
import { PalmRejectionPolicy, type PenStateResetReason } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isTipContact, remapMouseTipSamples } from "./PenPresence";
import { GestureOwnership } from "./GestureOwnership";
import { GestureNavigationController } from "./GestureNavigationController";
import {
  DEFAULT_POINTER_INPUT_CAPABILITIES,
  type PointerInputCapabilities
} from "./PointerInputCapabilities";

export type PointerRoute = "draw" | "edit" | "text" | "drag" | "touch-pan" | "touch-custom-pinch" | "native" | "ignored";

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

function cssPixelValue(value: string | undefined): number {
  const pixels = Number.parseFloat(value ?? "");
  return Number.isFinite(pixels) && pixels >= 0 ? pixels : 0;
}

function hasNativeScrollbarOverflow(axisValue: string | undefined, shorthand: string | undefined): boolean {
  // jsdom leaves overflow-x/y as `visible` for an `overflow: auto`
  // declaration; the shorthand is also the effective fallback for CSS's
  // visible/clip overflow conversion.
  const value = axisValue && axisValue !== "visible" ? axisValue : shorthand ?? axisValue;
  return value === undefined || value === "" || value === "auto" || value === "scroll" || value === "overlay";
}

/**
 * Native scrollbars are exposed as the scroll root itself, so drag mode must
 * leave a contact that starts in their gutter to the browser. The layout
 * gutter covers classic scrollbars; the edge fallback covers overlay
 * scrollbars whose hit target has no measurable layout width.
 */
export function isNativeScrollbarHit(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  target?: EventTarget | null
): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const view = root.ownerDocument.defaultView;
  const style = view?.getComputedStyle(root);
  const vertical = root.scrollHeight > root.clientHeight + 1
    && hasNativeScrollbarOverflow(style?.overflowY, style?.overflow);
  const horizontal = root.scrollWidth > root.clientWidth + 1
    && hasNativeScrollbarOverflow(style?.overflowX, style?.overflow);
  if (!vertical && !horizontal) return false;

  let rect: DOMRect;
  try {
    rect = root.getBoundingClientRect();
  } catch {
    return false;
  }
  const borderLeft = cssPixelValue(style?.borderLeftWidth);
  const borderRight = cssPixelValue(style?.borderRightWidth);
  const borderTop = cssPixelValue(style?.borderTopWidth);
  const borderBottom = cssPixelValue(style?.borderBottomWidth);
  const left = rect.left;
  const top = rect.top;
  const right = Number.isFinite(rect.right) ? rect.right : left + root.offsetWidth;
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + root.offsetHeight;
  const contentLeft = left + borderLeft;
  const contentRight = left + root.clientLeft + root.clientWidth;
  const contentBottom = top + borderTop + root.clientHeight;
  const rightGutterEnd = right - borderRight;
  const bottomGutterEnd = bottom - borderBottom;

  if (vertical) {
    // In RTL, clientLeft includes the left scrollbar and left border.
    const leftGutterEnd = left + root.clientLeft;
    if (leftGutterEnd - contentLeft > 1
      && clientX >= contentLeft && clientX < leftGutterEnd
      && clientY >= top && clientY < bottom) return true;
    if (rightGutterEnd - contentRight > 1
      && clientX >= contentRight && clientX < rightGutterEnd
      && clientY >= top && clientY < bottom) return true;
  }
  if (horizontal
    && bottomGutterEnd - contentBottom > 1
    && clientY >= contentBottom && clientY < bottomGutterEnd
    && clientX >= left && clientX < right) return true;

  // Overlay scrollbars do not change client/offset dimensions. Their native
  // hit target is the root, and the final edge slop is smaller than the
  // platform scrollbar hit area while avoiding normal page content.
  if (target !== root) return false;
  const edgeSlop = 16;
  if (vertical && clientX >= right - edgeSlop && clientX < right
    && clientY >= top && clientY < bottom) return true;
  return horizontal && clientY >= bottom - edgeSlop && clientY < bottom
    && clientX >= left && clientX < right;
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

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  /** Event-aware annotation gate (pen/touch/mouse policy). Replaces global Draw mode. */
  canAnnotatePointer(event: PointerEvent): boolean;
  /** Permit annotation over a surface-owned editor only when that surface opts in. */
  allowEditableAnnotationTarget?(event: PointerEvent): boolean;
  /** Whether the selected touch fallback is currently available for cursors. */
  touchAnnotationEnabled?(): boolean;
  /** Qualified mobile navigation gate; false preserves native touch behavior. */
  customNavigationEnabled?(): boolean;
  navigationController?: GestureNavigationController;
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
    phase: "primary-reset" | "pointerup" | "pointercancel" | "lostpointercapture" | "scroll-block" | "pen-state" | "touchend" | "touchcancel",
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
    }
  ): void;
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
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly ownership: GestureOwnership;
  private readonly navigationController: GestureNavigationController;
  private readonly ownsNavigationController: boolean;
  private readonly inputCapabilities: PointerInputCapabilities;
  private readonly resetOwnershipOnDestroy: boolean;
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
    palmPolicy?: PalmRejectionPolicy,
    ownership?: GestureOwnership,
    resetOwnershipOnDestroy = true
  ) {
    this.generation = PointerRouter.nextGeneration++;
    this.palmPolicy = palmPolicy ?? new PalmRejectionPolicy();
    this.ownership = ownership ?? new GestureOwnership();
    this.inputCapabilities = callbacks.pointerInputCapabilities?.() ?? DEFAULT_POINTER_INPUT_CAPABILITIES;
    this.ownsNavigationController = callbacks.navigationController === undefined;
    this.navigationController = callbacks.navigationController ?? new GestureNavigationController({
      minScale: 0.1,
      maxScale: 10,
      getScale: () => 1,
      getScrollRoot: () => callbacks.scrollRoot?.() ?? null,
      isHandMode: () => callbacks.activeTool() === "drag",
      onStart: () => ({ accepted: true, scale: 1 }),
      onPreview: () => undefined,
      onEnd: () => undefined,
      onCancel: () => undefined
    });
    this.resetOwnershipOnDestroy = resetOwnershipOnDestroy;
    this.navigationController.attachSurface(element, this.customNavigationAllowed());
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
        // Some WKWebViews expose the TouchEvent pair while omitting the
        // promoting second PointerEvent. The controller reconciles this path.
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
          element.addEventListener(type, this.handleTouchNavigation, options);
        }
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
    if (!this.routed.has(event.pointerId) && !this.navigationController.ownsPointer(event.pointerId)) return false;
    this.handleMove(event);
    return true;
  }

  classify(event: PointerEvent): PointerRoute {
    return this.classifyWithReason(event).route;
  }

  private classifyWithReason(event: PointerEvent): { route: PointerRoute; reason: string } {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (event.isPrimary !== false && this.callbacks.touchTextTarget?.(event)) {
        return { route: "text", reason: "text-box-touch" };
      }
      if (this.callbacks.touchAnnotationEnabled?.() === true && this.callbacks.canAnnotatePointer(event)) {
        if (this.palmPolicy.shouldIgnore(event)) return { route: "ignored", reason: "palm-rejection" };
        if (tool === "text") return { route: "text", reason: "touch-fallback-text" };
        if (tool === "eraser" || tool === "lasso") return { route: "edit", reason: "touch-fallback-edit" };
        if (isInkDrawTool(tool)) return { route: "draw", reason: "touch-fallback-draw" };
      }
      return { route: "touch-pan", reason: "touch-navigation" };
    }
    if (tool === "drag") {
      if (isStylusEraserInput(event)) return { route: "edit", reason: "stylus-eraser" };
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== -1) {
        return { route: "native", reason: "mouse-primary-button-only" };
      }
      return { route: "drag", reason: "hand-tool" };
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

  private isRoutableInputTarget(event: PointerEvent): boolean {
    return !isUiInputTarget(event.target)
      || this.callbacks.allowEditableAnnotationTarget?.(event) === true;
  }

  private isTextToolRoute(tool: ToolId, event: PointerEvent, penLike: boolean): boolean {
    return tool === "text" && (penLike || (event.pointerType === "mouse" && event.button === 0));
  }

  /** Document fallback / sync repair entry — same path as the page capture listener. */
  acceptPointerDown(event: PointerEvent): PointerRoute {
    return this.handleDown(event);
  }

  

  

  

  private touchIds(): number[] {
    return this.navigationController.activeTouchIds();
  }

  private touchCount(): number {
    return this.navigationController.activeTouchIds().length;
  }

  private customNavigationAllowed(): boolean {
    return this.callbacks.customNavigationEnabled?.() === true
      && this.inputCapabilities.pointerEvents
      && this.inputCapabilities.touchEvents;
  }

  

  

  

  

  

  /**
   * iPadOS/WKWebView can expose TouchEvents for a pinch while withholding the
   * second PointerEvent after native gesture recognition begins. Use the same
   * page-local gate and point stream as the pointer path, without synthesizing
   * ink or changing native one-finger navigation.
   */
  private readonly handleTouchNavigation = (event: TouchEvent): void => {
    if (classifyInputTarget(event.target).targetClass !== "page") return;
    if (this.navigationController.blockCompanionTouch(event)) return;
    this.navigationController.handleTouchFallback(
      event,
      this.element,
      this.customNavigationAllowed(),
      this.generation
    );
  };

  /** Stop WebKit's parallel native GestureEvent recognizer on a qualified page. */
  private readonly handleNativeGesture = (event: Event): void => {
    if (classifyInputTarget(event.target).targetClass !== "page") return;
    this.navigationController.handleNativeGesture(event, this.customNavigationAllowed());
  };

  

  

  

  

  

  /** Native finger contact. Pencil-first: this never creates an ink route. */
  

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
    if (classifyInputTarget(event.target).targetClass !== "page" && !this.isRoutableInputTarget(event)) {
      this.callbacks.onPointerRejected?.("annotation-chrome", event, this.generation);
      return "native";
    }
    const scrollRoot = this.callbacks.scrollRoot?.();
    if (scrollRoot && isNativeScrollbarHit(scrollRoot, event.clientX, event.clientY, event.target)) {
      this.callbacks.onRouteDecision?.("native", "native-scrollbar", event);
      return "native";
    }
    if (this.callbacks.isPointerHandled?.(event.pointerId, this.generation)) {
      this.callbacks.onPointerRejected?.("already-handled", event, this.generation);
      return "ignored";
    }
    this.callbacks.onPointerHandled?.(event.pointerId, this.generation);
    this.paintCustomCursorsNow(event);
    if (event.pointerType === "touch") {
      this.palmPolicy.reconcileStalePenOnTouch();
      this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
    }
    this.palmPolicy.pointerDown(event);
    this.beginStylusEraser(event);

    if (event.pointerType === "touch" && event.isPrimary !== false) {
      this.callbacks.onTouchPointerDown?.(event);
    }

    const routeDecision = this.classifyWithReason(event);
    let route = routeDecision.route;
    const navigationDecision = this.navigationController.handlePointerDown(event, {
      surface: this.element,
      route,
      customNavigationEnabled: this.customNavigationAllowed()
    }, this.generation);
    if (navigationDecision.handled) {
      route = (navigationDecision.route as PointerRoute | undefined) ?? route;
      this.callbacks.onRouteDecision?.(route, navigationDecision.reason ?? routeDecision.reason, event);
      this.callbacks.onRoute?.(route, event);
      if (route === "ignored") {
        this.callbacks.onTouchLifecycle?.("scroll-block", event, {
          reason: "ignored-pointer",
          activePens: this.palmPolicy.hasActivePen(),
          touchCount: this.touchCount()
        });
      }
      for (const pointerId of navigationDecision.cancelledTouchIds ?? []) {
        const routed = this.routed.get(pointerId);
        if (!routed || this.routedPointerTypes.get(pointerId) !== "touch") continue;
        this.finishRoutedPointer(this.syntheticPointerEvent(pointerId, "pointercancel", "touch"), "pointercancel");
      }
      return route;
    }

    const inkRoute = route === "draw" || route === "edit" || route === "text";
    const ownershipDecision = event.pointerType !== "touch" && inkRoute
      ? this.ownership.pointerDown({
        pointerId: event.pointerId,
        pointerType: this.gesturePointerType(event),
        button: event.button,
        buttons: event.buttons,
        target: this.callbacks.canAnnotatePointer(event) ? "page" : "ui",
        inkToolSelected: true,
        inkIntent: true
      })
      : { state: this.ownership.snapshot() };

    if (this.palmPolicy.hasActivePen()) {
      this.palmPolicy.adoptActivePenIds(this.activePenIds());
    }
    let routeReason = routeDecision.reason;
    const gesturePointerType = this.gesturePointerType(event);
    if (gesturePointerType === "pen" && inkRoute
      && (ownershipDecision.state.owner !== "pen-ink" || ownershipDecision.state.activePenId !== event.pointerId)) {
      route = "ignored";
      routeReason = "gesture-ownership";
    } else if (gesturePointerType === "mouse" && inkRoute
      && (ownershipDecision.state.owner !== "mouse-ink" || ownershipDecision.state.activeMousePointerId !== event.pointerId)) {
      route = "native";
      routeReason = "gesture-ownership";
    }

    this.callbacks.onRouteDecision?.(route, routeReason, event);
    this.callbacks.onRoute?.(route, event);

    if (route === "ignored") {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onTouchLifecycle?.("scroll-block", event, {
        reason: "ignored-pointer",
        activePens: this.palmPolicy.hasActivePen(),
        touchCount: this.touchCount()
      });
      return route;
    }
    if (!inkRoute || (route !== "draw" && route !== "edit" && route !== "text")) return route;

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
      propagationStopped: Reflect.get(event, "cancelBubble") === true,
      captureAttempted: capture.attempted,
      captureSucceeded: capture.succeeded
    });
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
    if (!this.isRoutableInputTarget(event)) return false;
    if (!this.callbacks.canAnnotatePointer(event) || !isTipContact(event)) return false;
    const penLike = event.pointerType === "pen" || this.palmPolicy.shouldTreatMouseTipAsPen(event);
    if (!penLike) return false;
    this.callbacks.onRouterReceived?.(event, this.generation);
    this.palmPolicy.pointerDown(event);
    this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
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
      propagationStopped: Reflect.get(event, "cancelBubble") === true,
      captureAttempted: capture.attempted,
      captureSucceeded: capture.succeeded
    });
    this.callbacks.onStart?.(this.inkSamples(event), route, event);
    return true;
  }

  /** Cancel companion TouchEvents while stylus is down (iPad WebKit scroll path). */
  private readonly blockTouchScrollWhilePen = (event: TouchEvent): void => {
    if (event.type === "touchstart") this.callbacks.onTouchStart?.(event);
    // Touchstart can arrive without the Pencil pointerup after a page transition.
    this.palmPolicy.reconcileStalePenOnTouch();
    this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
    if (!this.navigationController.blockCompanionTouch(event)) return;
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
    const hadActivePen = this.palmPolicy.hasActivePen();
    const stalePenCleared = this.palmPolicy.reconcileStalePenOnTouch();
    this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
    this.navigationController.reconcileTouchTerminal(this.element, Array.from(event.touches ?? []));
    const trackedAfter = this.touchCount();
    if (trackedBefore === 0 && trackedAfter === 0 && !hadActivePen && !stalePenCleared) return;
    this.callbacks.onTouchLifecycle?.(
      event.type === "touchcancel" ? "touchcancel" : "touchend",
      event,
      {
        reason: event.type === "touchcancel" ? "touchcancel-terminal" : "touchend-terminal",
        trackedBefore,
        trackedAfter,
        touchCount: event.touches.length,
        activePens: this.palmPolicy.hasActivePen(),
        activePenIds: this.activePenIds(),
        stalePenCleared
      }
    );
  };

  /** Pen or a vertical axis lock wins. Otherwise the manipulation machine owns touch-action. */
  

  gesturePolicy(): {
    navigationPointerCount: number;
    activeTouchCount: number;
    stylusActive: boolean;
    customNavigationEnabled: boolean;
    touchNoneClassPresent: boolean;
    touchPanXyClassPresent: boolean;
    touchControllerClassPresent: boolean;
    computedTouchAction: string;
    customPinchGuardClassPresent: boolean;
    manipulationActiveTouches: number;
    manipulationState: string;
  } {
    const view = this.element.ownerDocument.defaultView;
    return {
      navigationPointerCount: this.navigationController.activePointerIds().length,
      activeTouchCount: this.navigationController.activeTouchIds().length,
      stylusActive: this.navigationController.hasActivePen(),
      customNavigationEnabled: this.customNavigationAllowed(),
      touchNoneClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-none"),
      touchPanXyClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-pan-xy"),
      touchControllerClassPresent: this.element.classList.contains("native-pdf-handwriting-touch-custom-pinch"),
      computedTouchAction: view?.getComputedStyle(this.element).touchAction ?? "",
      customPinchGuardClassPresent: this.element.classList.contains("native-pdf-handwriting-pinch-guard"),
      manipulationActiveTouches: this.navigationController.activeTouchIds().length,
      manipulationState: "idle"
    };
  }

  

  

  /**
   * Draw-mode single finger: lock vertical → drive PDF scroll; lock horizontal →
   * leave native (Ink dedicated-writing axis policy). Avoids fighty diagonal pan.
   */
  

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
    this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
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
    if (event.pointerType === "touch") return;
    const contact = {
      pointerId: event.pointerId,
      pointerType: this.gesturePointerType(event),
      button: event.button,
      buttons: event.buttons
    } as const;
    if (phase === "pointercancel") this.ownership.pointerCancel(contact);
    else if (phase === "lostpointercapture") this.ownership.lostCapture(contact);
    else this.ownership.pointerUp(contact);
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
      || this.navigationController.activePointerIds().length > 0
      || this.palmPolicy.hasActivePen();
    if (!owned) return;

    for (const pointerId of [...this.routed.keys()]) {
      const pointerType = this.routedPointerTypes.get(pointerId) ?? "pen";
      this.finishRoutedPointer(this.syntheticPointerEvent(pointerId, "pointercancel", pointerType), "pointercancel");
    }
    if (this.stylusErasers.size > 0) this.callbacks.onStylusEraserEnd?.();
    this.stylusErasers.clear();
    this.navigationController.cancelForSurface(this.element, "lifecycle");
    this.palmPolicy.clearAll("pointercancel");
    this.navigationController.reconcilePenContacts([]);
    this.ownership.replaceGeneration();
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
    if (reason === "lostpointercapture") return;
    if (reason === "pointercancel") {
      this.palmPolicy.clearPenPointer(event.pointerId, "pointercancel");
      return;
    }
    this.palmPolicy.pointerUp(event);
  }

  private readonly handleMove = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    this.palmPolicy.notePenActivity(event);
    if (this.navigationController.handlePointerMove(event, this.generation)) return;
    this.scheduleCustomCursorUpdate(event);
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
      const samples = this.inkSamples(event, { skipPenHover: route === "draw" || route === "edit" });
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
    this.recoverMissingPointerDown(event);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (this.navigationController.handlePointerEnd(event, "pointerup")) {
      this.releasePenContact(event, "pointerup");
      this.hideCustomCursors();
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
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) {
      this.callbacks.onStylusEraserEnd?.();
    }
    this.hideCustomCursors();
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (this.navigationController.handlePointerEnd(event, "pointercancel")) {
      this.releasePenContact(event, "pointercancel");
      this.hideCustomCursors();
      return;
    }
    const route = this.routed.get(event.pointerId);
    if (route) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      this.callbacks.onPredictedMove?.([], route, event);
      this.callbacks.onCancel?.(route, event);
      safeReleasePointerCapture(this.element, event.pointerId);
      this.routed.delete(event.pointerId);
      this.routedPointerTypes.delete(event.pointerId);
    }
    this.releaseGestureOwnership(event, "pointercancel");
    this.releasePenContact(event, "pointercancel");
    if (this.stylusErasers.delete(event.pointerId) && this.stylusErasers.size === 0) {
      this.callbacks.onStylusEraserEnd?.();
    }
    this.hideCustomCursors();
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    if (this.navigationController.handlePointerEnd(event, "lostpointercapture")) {
      this.releasePenContact(event, "lostpointercapture");
      return;
    }
    if (event.pointerType === "mouse" || event.pointerType === "pen") this.hideCustomCursors();
    // iOS capture can move off-page during a live Pencil stroke. The document
    // owner keeps appending until the actual terminal event.
    if (event.pointerType === "pen" && this.routed.has(event.pointerId)) return;
    if (event.pointerType === "pen" && this.palmPolicy.hasActivePen()) {
      this.releaseGestureOwnership(event, "lostpointercapture");
      this.releasePenContact(event, "lostpointercapture");
      return;
    }
    if (event.pointerType === "mouse" && this.routed.has(event.pointerId)) {
      this.finishRoutedPointer(event, "pointerup");
      this.releaseGestureOwnership(event, "lostpointercapture");
      this.releasePenContact(event, "lostpointercapture");
    }
  };

  private readonly clearEndedTouch = (event: PointerEvent): void => {
    if (this.abort.signal.aborted) return;
    const phase = event.type === "pointercancel" ? "pointercancel"
      : event.type === "lostpointercapture" ? "lostpointercapture"
        : "pointerup";
    const trackedBefore = event.pointerType === "touch" ? this.touchCount() : 0;
    const hadNavigationContact = this.navigationController.ownsPointer(event.pointerId);
    if (this.navigationController.handlePointerEnd(event, phase)) {
      this.releasePenContact(event, phase === "pointerup" ? "pointerup" : phase);
      return;
    }
    if (event.pointerType === "pen" && event.type === "lostpointercapture") return;
    if (event.pointerType === "pen") {
      const hadRoute = this.routed.has(event.pointerId);
      const hadPen = this.palmPolicy.hasActivePen();
      this.finishRoutedPointer(event, phase === "pointercancel" ? "pointercancel" : "pointerup");
      this.releaseGestureOwnership(event, phase === "pointercancel" ? "pointercancel" : "pointerup");
      this.releasePenContact(event, phase);
      if (hadRoute || hadPen) {
        this.callbacks.onTouchLifecycle?.(phase, event, {
          reason: "document-pen-terminal",
          activePens: this.palmPolicy.hasActivePen(),
          activePenIds: this.activePenIds()
        });
      }
      return;
    }
    if (event.pointerType !== "touch") return;
    const route = this.routed.get(event.pointerId);
    const endedOnThisPage = event.target instanceof Node && this.element.contains(event.target);
    let completion: "document-end" | "document-cancel" | undefined;
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
    this.releaseGestureOwnership(event, phase);
    if (!hadNavigationContact && !completion) return;
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
  cancelNavigation(reason: "lifecycle" | "disabled" = "lifecycle"): void {
    this.navigationController.cancelForSurface(this.element, reason);
  }

  syncToolState(): void {
    this.cancelScheduledCursorUpdate();
    this.navigationController.attachSurface(this.element, this.customNavigationAllowed());
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
    this.navigationController.reconcilePenContacts(this.palmPolicy.activePenIds());
  }

  /**
   * Drop captures this router still owns. Does not clear touch bookkeeping or
   * change the next route. Used once at zoom settle as a single recovery probe.
   */
  releaseOwnedPointerCaptures(): number[] {
    const ids = new Set<number>([
      ...this.routed.keys(),
      ...this.navigationController.activePointerIds(),
      ...this.stylusErasers
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

  

  

  destroy(options: { preserveRoutedPointers?: boolean } = {}): void {
    if (this.abort.signal.aborted) return;
    this.cancelScheduledCursorUpdate();
    const handoff: PointerRouterHandoff = {
      routed: [...this.routed.entries()].map(([pointerId, route]) => ({ pointerId, route })),
      activePenIds: this.activePenIds()
    };
    this.releaseOwnedPointerCaptures();
    if (!options.preserveRoutedPointers) {
      for (const pointerId of [...this.routed.keys()]) {
        this.finishRoutedPointer(this.syntheticPointerEvent(pointerId, "pointercancel"), "pointercancel");
      }
    }
    this.routed.clear();
    this.routedPointerTypes.clear();
    if (this.stylusErasers.size > 0) this.callbacks.onStylusEraserEnd?.();
    this.stylusErasers.clear();
    this.navigationController.detachSurface(this.element);
    if (this.ownsNavigationController) this.navigationController.destroy();
    this.palmPolicy.setResetListener(null);
    this.palmPolicy.reset();
    if (this.resetOwnershipOnDestroy) this.ownership.replaceGeneration();
    this.callbacks.onPointerOwnerReleased?.(this.generation, handoff);
    this.abort.abort();
    this.element.classList.remove(
      "native-pdf-handwriting-has-eraser-cursor",
      "native-pdf-handwriting-has-draw-cursor",
      "native-pdf-handwriting-pen-capturing"
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
