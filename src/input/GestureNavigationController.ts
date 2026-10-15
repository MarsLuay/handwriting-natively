export type GestureNavigationEndReason =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "pen-contact"
  | "lifecycle"
  | "disabled";

export interface GestureNavigationControllerOptions {
  getScrollRoot?: () => HTMLElement | null;
  onPan?: (deltaX: number, deltaY: number, clientX: number, clientY: number) => boolean | void;
}

export interface GestureNavigationPointerContext {
  surface: HTMLElement;
  route: string;
  pointerType: "pen" | "mouse" | "touch";
  customHandPanEnabled?: boolean;
}

interface HandPointer {
  surface: HTMLElement;
  clientX: number;
  clientY: number;
}

export interface GestureNavigationPointerResult {
  handled: boolean;
  route?: string;
  reason?: string;
}

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

/** Owns stylus hand-pan and companion-touch blocking for one viewer session. */
export class GestureNavigationController {
  private readonly activePens = new Set<number>();
  private readonly handPointers = new Map<number, HandPointer>();
  private readonly originalTouchNone = new Map<HTMLElement, boolean>();
  private panningSurface: HTMLElement | null = null;
  private destroyed = false;

  constructor(private readonly options: GestureNavigationControllerOptions = {}) {}

  attachSurface(surface: HTMLElement): void {
    if (!this.originalTouchNone.has(surface)) {
      this.originalTouchNone.set(surface, surface.classList.contains("native-pdf-handwriting-touch-none"));
    }
    this.syncSurfacePolicy(surface);
  }

  detachSurface(surface: HTMLElement): void {
    if (!this.originalTouchNone.has(surface)) return;
    this.cancelForSurface(surface, "lifecycle");
    surface.classList.toggle("native-pdf-handwriting-touch-none", this.originalTouchNone.get(surface) === true);
    this.originalTouchNone.delete(surface);
  }

  isActive(): boolean {
    return this.handPointers.size > 0;
  }

  ownsPointer(pointerId: number): boolean {
    return this.handPointers.has(pointerId);
  }

  activePointerIds(): number[] {
    return [...this.handPointers.keys()];
  }

  hasActivePen(): boolean {
    return this.activePens.size > 0;
  }

  reconcilePenContacts(activePenIds: readonly number[]): void {
    this.activePens.clear();
    for (const pointerId of activePenIds) this.activePens.add(pointerId);
    for (const surface of this.originalTouchNone.keys()) this.syncSurfacePolicy(surface);
  }

  blockCompanionTouch(event: TouchEvent): boolean {
    if (!this.hasActivePen()) return false;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  handlePointerDown(
    event: PointerEvent,
    context: GestureNavigationPointerContext
  ): GestureNavigationPointerResult {
    if (this.destroyed) return { handled: false };
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

  handlePointerMove(event: PointerEvent): boolean {
    const contact = this.handPointers.get(event.pointerId);
    if (!contact) return false;
    const deltaX = event.clientX - contact.clientX;
    const deltaY = event.clientY - contact.clientY;
    contact.clientX = event.clientX;
    contact.clientY = event.clientY;
    if (deltaX !== 0 || deltaY !== 0) this.applyPan(deltaX, deltaY, event.clientX, event.clientY);
    this.preventPointer(event);
    return true;
  }

  handlePointerEnd(event: PointerEvent, reason: GestureNavigationEndReason = "pointerup"): boolean {
    const contact = this.handPointers.get(event.pointerId);
    if (!contact) return false;
    this.handPointers.delete(event.pointerId);
    releasePointer(contact.surface, event.pointerId);
    if (this.handPointers.size === 0) this.setPanningSurface(contact.surface, false);
    if (reason !== "lostpointercapture") this.preventPointer(event);
    return true;
  }

  cancelForSurface(surface: HTMLElement, _reason: GestureNavigationEndReason): void {
    for (const [pointerId, contact] of [...this.handPointers]) {
      if (contact.surface !== surface) continue;
      releasePointer(contact.surface, pointerId);
      this.handPointers.delete(pointerId);
    }
    if (this.panningSurface === surface) this.setPanningSurface(surface, false);
  }

  clearContacts(): void {
    for (const [pointerId, contact] of this.handPointers) releasePointer(contact.surface, pointerId);
    this.handPointers.clear();
    this.activePens.clear();
    if (this.panningSurface) this.setPanningSurface(this.panningSurface, false);
    for (const surface of this.originalTouchNone.keys()) this.syncSurfacePolicy(surface);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearContacts();
    for (const [surface, originallyDisabled] of this.originalTouchNone) {
      surface.classList.toggle("native-pdf-handwriting-touch-none", originallyDisabled);
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
    const originallyDisabled = this.originalTouchNone.get(surface) === true;
    surface.classList.toggle("native-pdf-handwriting-touch-none", originallyDisabled || this.hasActivePen());
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
}
