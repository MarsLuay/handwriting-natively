import { setElementCssProps } from "../dom/typeGuards";
import { isDrawingTool, isInkDrawTool, type ToolId } from "../model";
import { scrollPdfBy } from "../integration/PdfScrollRoot";
import { PalmRejectionPolicy } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isSelectablePdfTarget } from "./PdfSelectableTarget";

export type PointerRoute = "draw" | "edit" | "text" | "touch-stylus" | "touch-pan" | "touch-zoom-pan" | "mouse-pan" | "native" | "ignored";

export function isAnnotationChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".native-pdf-handwriting-selection-toolbar"));
}

function isTextInputTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".native-pdf-handwriting-text-input"));
}

/** Primary tip drag: mouse LMB or stylus tip (not barrel / eraser buttons). */
export function isDragPanPointer(event: Pick<PointerEvent, "pointerType" | "button">): boolean {
  if (event.button !== 0) return false;
  return event.pointerType === "mouse" || event.pointerType === "pen";
}

/** W3C Pointer Events reports a stylus eraser tip as button 5 / buttons bit 32. */
export function isStylusEraserInput(event: Pick<PointerEvent, "pointerType" | "button" | "buttons">): boolean {
  return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0);
}

interface PanGesture {
  startX: number;
  startY: number;
  lastY: number;
  active: boolean;
}

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  drawingEnabled(): boolean;
  onStylusEraser?(): void;
  onStylusEraserEnd?(): void;
  onTextInput?(event: PointerEvent): void;
  rightMouseEraserEnabled?(): boolean;
  singleTouchMode?(): "none" | "touch" | "stylus";
  twoFingerPinchZoomEnabled?(): boolean;
  twoFingerSwipeScrollEnabled?(): boolean;
  scrollRoot?(): HTMLElement | null;
  cursorParent?(): HTMLElement;
  hideNativeCursor?(): boolean;
  eraserCursorDiameter?(): number;
  stylusHoverCursorEnabled?(): boolean;
  stylusStrokeCursorEnabled?(): boolean;
  drawCursorColor?(): string;
  projectCursor?(clientX: number, clientY: number): { x: number; y: number } | null;
  onStart?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onMove?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onEnd?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onCancel?(route: "draw" | "edit", event: PointerEvent, reason?: "multi-touch"): void;
  onRoute?(route: PointerRoute, event: PointerEvent): void;
  onPinch?(factor: number, clientX: number, clientY: number): void;
  onTwoFingerPan?(deltaX: number, deltaY: number, clientX: number, clientY: number): void;
  onMousePan?(phase: "start" | "activate" | "move" | "end" | "abort", event: PointerEvent, details: Record<string, unknown>): void;
}

export class PointerRouter {
  private static readonly STYLUS_HOVER_CURSOR_SIZE_PX = 6;
  private static readonly NATIVE_POINTER_HOVER_RING_SIZE_PX = 22;
  private static readonly HOVER_RESUME_DISTANCE_PX = 3;
  private static readonly HOVER_RESUME_DELAY_MS = 400;

  private readonly routed = new Map<number, "draw" | "edit">();
  private readonly routedTouches = new Set<number>();
  private readonly consumedTouches = new Set<number>();
  private readonly stylusEraserPointers = new Set<number>();
  private readonly contactPointers = new Set<number>();
  private readonly panning = new Map<number, PanGesture>();
  private readonly touches = new Set<number>();
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly abort = new AbortController();
  private readonly eraserCursor: HTMLElement;
  private readonly stylusHoverCursor: HTMLElement;
  private lastCursor: { clientX: number; clientY: number; pointerId: number; pointerType: string; buttons: number } | null = null;
  private hoverResumePoint: { x: number; y: number } | null = null;
  private hoverResumeAfter = 0;
  private pinchDistance: number | null = null;
  private pinchCenter: { x: number; y: number } | null = null;
  private twoFingerGesture: "pinch" | "pan" | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy = new PalmRejectionPolicy(),
    gestureTarget: HTMLElement = element
  ) {
    this.palmPolicy = palmPolicy;
    this.eraserCursor = element.ownerDocument.createElement("span");
    this.eraserCursor.className = "native-pdf-handwriting-eraser-cursor";
    this.eraserCursor.setAttribute("aria-hidden", "true");
    this.eraserCursor.hidden = true;
    this.stylusHoverCursor = element.ownerDocument.createElement("span");
    this.stylusHoverCursor.className = "native-pdf-handwriting-stylus-hover-cursor";
    this.stylusHoverCursor.setAttribute("aria-hidden", "true");
    this.stylusHoverCursor.hidden = true;
    element.ownerDocument.body.append(this.eraserCursor);
    (this.callbacks.cursorParent?.() ?? element.ownerDocument.body).append(this.stylusHoverCursor);
    const options = { capture: true, signal: this.abort.signal, passive: false };
    element.addEventListener("pointerdown", this.routePointerEvent, options);
    element.addEventListener("pointermove", this.routePointerEvent, options);
    element.addEventListener("pointerup", this.routePointerEvent, options);
    element.addEventListener("pointercancel", this.routePointerEvent, options);
    element.addEventListener("pointerover", this.updateHoverCursor, options);
    element.addEventListener("pointerenter", this.updateHoverCursor, options);
    element.addEventListener("pointerrawupdate", this.updateHoverCursor, options);
    element.addEventListener("contextmenu", this.suppressRightMouseEraserMenu, options);
    element.addEventListener("pointerleave", this.hideCustomCursors, options);
    const documentHoverOptions = { capture: true, signal: this.abort.signal, passive: true };
    element.ownerDocument.addEventListener("pointermove", this.updateDocumentHoverCursor, documentHoverOptions);
    element.ownerDocument.addEventListener("pointerover", this.updateDocumentHoverCursor, documentHoverOptions);
    element.ownerDocument.addEventListener("pointerrawupdate", this.updateDocumentHoverCursor, documentHoverOptions);
    element.ownerDocument.addEventListener("mousemove", this.updateDocumentHoverCursor, documentHoverOptions);
    element.ownerDocument.addEventListener("mouseover", this.updateDocumentHoverCursor, documentHoverOptions);
    const touchOptions = { signal: this.abort.signal, passive: false };
    gestureTarget.addEventListener("touchstart", this.suppressTouchGestures, touchOptions);
    gestureTarget.addEventListener("touchmove", this.suppressTouchGestures, touchOptions);
    gestureTarget.addEventListener("touchend", this.suppressTouchGestures, touchOptions);
    gestureTarget.addEventListener("touchcancel", this.suppressTouchGestures, touchOptions);
  }

  routePointer(event: PointerEvent): void {
    if (event.type === "pointerdown") this.handleDown(event);
    else if (event.type === "pointermove") this.handleMove(event);
    else if (event.type === "pointerup") this.handleEnd(event);
    else if (event.type === "pointercancel") this.handleCancel(event);
  }

  observeHover(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "pointerType" | "buttons">): void {
    this.updateCustomCursors(event);
  }

  classify(event: PointerEvent): PointerRoute {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (this.palmPolicy.shouldIgnore(event)) return "ignored";
      if (this.touches.size + (this.touches.has(event.pointerId) ? 0 : 1) >= 2) return "touch-zoom-pan";
      const touchMode = this.callbacks.singleTouchMode?.() ?? "touch";
      if (touchMode === "none") return "touch-stylus";
      if (touchMode === "stylus") {
        return this.callbacks.drawingEnabled() ? this.stylusRoute(tool) : "touch-stylus";
      }
      return "touch-pan";
    }
    if (!this.callbacks.drawingEnabled()) {
      if (isDragPanPointer(event) && this.callbacks.scrollRoot?.()) {
        if (!isAnnotationChromeTarget(event.target) && !isSelectablePdfTarget(event.target)) return "mouse-pan";
      }
      return "native";
    }
    if (tool === "text" && (event.pointerType === "pen" || (event.pointerType === "mouse" && event.button === 0))) return "text";
    if (event.pointerType === "pen") return this.stylusRoute(tool);
    const editing = tool === "eraser" || tool === "lasso";
    if (event.pointerType === "mouse" && event.button === 2 && this.callbacks.rightMouseEraserEnabled?.()) return "edit";
    if (event.pointerType === "mouse" && event.button === 0 && isInkDrawTool(tool)) return "draw";
    if (event.pointerType === "mouse" && event.button === 0 && editing) return "edit";
    return "native";
  }

  private readonly routePointerEvent = (event: Event): void => {
    this.routePointer(event as PointerEvent);
  };

  private readonly updateHoverCursor = (event: Event): void => {
    this.updateCustomCursors(event as PointerEvent);
  };

  private readonly updateDocumentHoverCursor = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (!this.containsClientPoint(pointer.clientX, pointer.clientY)) {
      this.hideStylusHoverCursor();
      return;
    }
    this.updateCustomCursors({
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      pointerId: pointer.pointerId || -1,
      pointerType: pointer.pointerType || "mouse",
      buttons: pointer.buttons ?? 0
    });
  };

  private readonly suppressRightMouseEraserMenu = (event: Event): void => {
    const mouse = event as MouseEvent;
    if (!this.callbacks.drawingEnabled() || !this.callbacks.rightMouseEraserEnabled?.() || mouse.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleDown = (event: PointerEvent): void => {
    // Textareas own their pointer drag so browser-native character selection keeps working in lasso mode.
    if (isTextInputTarget(event.target)) return;
    this.suppressPenGestures(event);
    if (isAnnotationChromeTarget(event.target)) return;
    this.hoverResumePoint = null;
    this.hoverResumeAfter = 0;
    this.contactPointers.add(event.pointerId);
    if (this.callbacks.drawingEnabled() && isStylusEraserInput(event)) {
      this.stylusEraserPointers.add(event.pointerId);
      this.callbacks.onStylusEraser?.();
    }
    this.updateCustomCursors(event);
    this.palmPolicy.pointerDown(event);
    const route = this.classify(event);
    if (event.pointerType === "touch" && route !== "ignored") this.touches.add(event.pointerId);
    if (route === "touch-zoom-pan") {
      this.cancelRoutedTouches(event);
      event.preventDefault();
      event.stopPropagation();
    }
    this.callbacks.onRoute?.(route, event);
    if (route === "touch-stylus") {
      this.consumedTouches.add(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      this.element.setPointerCapture?.(event.pointerId);
      return;
    }
    if (route === "text") {
      event.preventDefault();
      this.callbacks.onTextInput?.(event);
      return;
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
    if (route !== "draw" && route !== "edit") return;
    this.routed.set(event.pointerId, route);
    if (event.pointerType === "touch") this.routedTouches.add(event.pointerId);
    event.preventDefault();
    this.element.setPointerCapture?.(event.pointerId);
    this.updateStylusHoverCursor(event);
    this.callbacks.onStart?.(PointerCapabilities.samples(event), route, event);
  };

  private readonly handleMove = (event: PointerEvent): void => {
    this.suppressPenGestures(event);
    this.updateCustomCursors(event);
    if (this.consumedTouches.has(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onMove?.(PointerCapabilities.samples(event), route, event);
      return;
    }
    const pan = this.panning.get(event.pointerId);
    if (pan) this.updateMousePan(event, pan);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    this.suppressPenGestures(event);
    if (this.consumedTouches.delete(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
    }
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
      this.routedTouches.delete(event.pointerId);
    }
    this.finishMousePan(event);
    this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
    this.contactPointers.delete(event.pointerId);
    this.hideEraserCursor();
    if (this.stylusEraserPointers.delete(event.pointerId)) this.callbacks.onStylusEraserEnd?.();
    this.hoverResumePoint = { x: event.clientX, y: event.clientY };
    this.hoverResumeAfter = performance.now() + PointerRouter.HOVER_RESUME_DELAY_MS;
    this.hideStylusHoverCursor();
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    this.suppressPenGestures(event);
    if (this.consumedTouches.delete(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
    }
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onCancel?.(route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
      this.routedTouches.delete(event.pointerId);
    }
    this.finishMousePan(event);
    this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
    this.contactPointers.delete(event.pointerId);
    if (this.stylusEraserPointers.delete(event.pointerId)) this.callbacks.onStylusEraserEnd?.();
    this.hoverResumePoint = { x: event.clientX, y: event.clientY };
    this.hoverResumeAfter = performance.now() + PointerRouter.HOVER_RESUME_DELAY_MS;
    this.hideCustomCursors();
  };

  syncToolState(): void {
    if (!this.callbacks.drawingEnabled()) {
      this.hideCustomCursors();
      this.syncColorCursor();
      return;
    }
    const tool = this.callbacks.activeTool();
    if (tool !== "eraser") this.hideEraserCursor();
    this.syncColorCursor();
    this.refreshCursors();
  }

  refreshCursors(): void {
    if (!this.lastCursor || !this.callbacks.drawingEnabled()) return;
    this.updateStylusHoverCursor(this.lastCursor);
    this.updateEraserCursor(this.lastCursor);
  }

  private stylusRoute(tool: ToolId): PointerRoute {
    if (tool === "text") return "text";
    if (tool === "eraser" || tool === "lasso") return "edit";
    return tool === "pan" ? "native" : "draw";
  }

  private cancelRoutedTouches(event: PointerEvent): void {
    for (const pointerId of this.routedTouches) {
      const route = this.routed.get(pointerId);
      if (!route) continue;
      this.callbacks.onCancel?.(route, event, "multi-touch");
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
      this.routed.delete(pointerId);
    }
    this.routedTouches.clear();
    for (const pointerId of this.consumedTouches) {
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
    }
    this.consumedTouches.clear();
  }

  private cursorClientPoint(clientX: number, clientY: number): { x: number; y: number } {
    return this.callbacks.projectCursor?.(clientX, clientY) ?? { x: clientX, y: clientY };
  }

  private containsClientPoint(clientX: number, clientY: number): boolean {
    const bounds = this.element.getBoundingClientRect();
    return clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
  }

  private suppressPenGestures(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    event.preventDefault();
    if (this.callbacks.drawingEnabled()) event.stopPropagation();
  }

  private readonly suppressTouchGestures = (event: Event): void => {
    const touchMode = this.callbacks.singleTouchMode?.() ?? "touch";
    const touchStylusEnabled = touchMode === "stylus";
    if (!this.callbacks.drawingEnabled() && touchMode === "touch") return;
    const touches = (event as TouchEvent).touches;
    // Pointer Events own one-finger stylus input. Cancelling its raw touchstart can
    // make some WebViews emit pointercancel before the stroke or text route begins.
    if (touchStylusEnabled && touches?.length === 1) {
      this.pinchDistance = null;
      this.pinchCenter = null;
      this.twoFingerGesture = null;
      event.stopPropagation();
      return;
    }
    if (touches?.length >= 2) {
      const distance = Math.hypot(
        touches[0]!.clientX - touches[1]!.clientX,
        touches[0]!.clientY - touches[1]!.clientY
      );
      const center = {
        x: (touches[0]!.clientX + touches[1]!.clientX) / 2,
        y: (touches[0]!.clientY + touches[1]!.clientY) / 2
      };
      if (this.pinchDistance !== null && event.type === "touchmove") {
        const factor = distance / this.pinchDistance;
        const centerDelta = this.pinchCenter
          ? Math.hypot(center.x - this.pinchCenter.x, center.y - this.pinchCenter.y)
          : 0;
        const distanceDelta = Math.abs(distance - this.pinchDistance);
        if (this.twoFingerGesture === null) {
          if (Math.abs(factor - 1) >= 0.025) this.twoFingerGesture = "pinch";
          else if (centerDelta >= 3) this.twoFingerGesture = "pan";
        }
        if (this.twoFingerGesture === "pinch" && this.callbacks.twoFingerPinchZoomEnabled?.() !== false && (factor >= 1.025 || factor <= 1 / 1.025)) {
          this.callbacks.onPinch?.(factor, center.x, center.y);
        }
        if (this.twoFingerGesture === "pan" && this.callbacks.twoFingerSwipeScrollEnabled?.() !== false && this.pinchCenter) {
          this.callbacks.onTwoFingerPan?.(center.x - this.pinchCenter.x, center.y - this.pinchCenter.y, center.x, center.y);
        }
        if (distanceDelta > 0) this.pinchDistance = distance;
      } else {
        this.pinchDistance = distance;
      }
      this.pinchCenter = center;
    } else {
      this.pinchDistance = null;
      this.pinchCenter = null;
      this.twoFingerGesture = null;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  destroy(): void {
    for (const pointerId of this.routed.keys()) {
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
    }
    this.routed.clear();
    this.routedTouches.clear();
    this.stylusEraserPointers.clear();
    this.contactPointers.clear();
    this.panning.clear();
    this.touches.clear();
    this.pinchCenter = null;
    this.twoFingerGesture = null;
    this.palmPolicy.reset();
    this.abort.abort();
    this.element.classList.remove("native-pdf-handwriting-has-eraser-cursor", "native-pdf-handwriting-panning");
    this.eraserCursor.remove();
    this.stylusHoverCursor.remove();
  }

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

  private updateCustomCursors(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "pointerType" | "buttons">): void {
    this.lastCursor = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      buttons: event.buttons
    };
    this.updateStylusHoverCursor(this.lastCursor);
    this.updateEraserCursor(event);
  }

  private syncColorCursor(): void {
    const enabled = this.callbacks.drawingEnabled()
      && (this.callbacks.stylusHoverCursorEnabled?.() === true || this.callbacks.stylusStrokeCursorEnabled?.() === true);
    if (!enabled) {
      this.element.classList.remove("native-pdf-handwriting-has-color-cursor");
      this.element.style.removeProperty("--native-pdf-handwriting-color-cursor");
      return;
    }
    this.element.style.setProperty(
      "--native-pdf-handwriting-color-cursor",
      colorCursorCss(this.callbacks.drawCursorColor?.())
    );
    this.element.classList.add("native-pdf-handwriting-has-color-cursor");
  }

  private updateStylusHoverCursor(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "pointerType" | "buttons">): void {
    if (!this.isStylusHover(event)) {
      this.hideStylusHoverCursor();
      return;
    }
    if (this.shouldHoldHoverAtStrokeEndpoint(event)) {
      this.hideStylusHoverCursor();
      return;
    }
    const point = this.cursorPointInParent(event.clientX, event.clientY, this.stylusHoverCursor.parentElement);
    const color = this.callbacks.drawCursorColor?.();
    const nativePointerVisible = this.callbacks.hideNativeCursor?.() === false;
    const size = nativePointerVisible
      ? PointerRouter.NATIVE_POINTER_HOVER_RING_SIZE_PX
      : PointerRouter.STYLUS_HOVER_CURSOR_SIZE_PX;
    this.stylusHoverCursor.classList.toggle("is-native-pointer-visible", nativePointerVisible);
    this.stylusHoverCursor.style.width = `${size}px`;
    this.stylusHoverCursor.style.height = `${size}px`;
    this.stylusHoverCursor.style.left = `${point.x}px`;
    this.stylusHoverCursor.style.top = `${point.y}px`;
    this.stylusHoverCursor.style.setProperty("--native-pdf-handwriting-hover-cursor-color", color ?? "var(--text-normal, #111827)");
    this.stylusHoverCursor.hidden = false;
    if (this.callbacks.hideNativeCursor?.() !== false) {
      this.element.classList.add("native-pdf-handwriting-has-stylus-hover-cursor");
    }
  }

  private isStylusHover(event: Pick<PointerEvent, "pointerId" | "pointerType" | "buttons">): boolean {
    const hovering = this.callbacks.stylusHoverCursorEnabled?.() === true
      && event.pointerType !== "touch"
      && this.contactPointers.size === 0
      && event.buttons === 0;
    const drawing = this.callbacks.stylusStrokeCursorEnabled?.() === true
      && event.pointerType !== "touch"
      && this.routed.get(event.pointerId) === "draw";
    return hovering || drawing;
  }

  private shouldHoldHoverAtStrokeEndpoint(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId">): boolean {
    if (!this.hoverResumePoint || this.routed.get(event.pointerId) === "draw") return false;
    const distance = Math.hypot(event.clientX - this.hoverResumePoint.x, event.clientY - this.hoverResumePoint.y);
    if (distance >= PointerRouter.HOVER_RESUME_DISTANCE_PX || performance.now() >= this.hoverResumeAfter) {
      this.hoverResumePoint = null;
      this.hoverResumeAfter = 0;
      return false;
    }
    return true;
  }

  private cursorPointInParent(clientX: number, clientY: number, parent: HTMLElement | null): { x: number; y: number } {
    const point = this.cursorClientPoint(clientX, clientY);
    if (!parent || parent === parent.ownerDocument.body) return point;
    const bounds = parent.getBoundingClientRect();
    return { x: point.x - bounds.left, y: point.y - bounds.top };
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
    if (this.callbacks.hideNativeCursor?.() !== false) {
      this.element.classList.add("native-pdf-handwriting-has-eraser-cursor");
    }
  }

  private readonly hideCustomCursors = (): void => {
    this.hideEraserCursor();
    this.hideStylusHoverCursor();
  };

  private readonly hideStylusHoverCursor = (): void => {
    this.stylusHoverCursor.hidden = true;
    this.element.classList.remove("native-pdf-handwriting-has-stylus-hover-cursor");
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

function colorCursorCss(color: string | undefined): string {
  const fill = /^#[0-9a-f]{3,8}$/i.test(color ?? "") ? color! : "#111827";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${fill}" stroke="white" stroke-width="1.5"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 8, crosshair`;
}

function scrollRootLabel(root: HTMLElement): string {
  const id = root.id ? `#${root.id}` : "";
  const classes = [...root.classList].slice(0, 2).join(".");
  const scrollable = root.scrollHeight > root.clientHeight;
  return `${root.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""} scrollable=${scrollable}`;
}
