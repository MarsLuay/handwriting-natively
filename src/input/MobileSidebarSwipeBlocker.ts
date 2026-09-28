export type SidebarSwipeDirection = "left" | "right";

const HORIZONTAL_DOMINANCE_RATIO = 3;
const MIN_HORIZONTAL_DISTANCE_PX = 10;

interface TouchCandidate {
  identifier: number;
  startX: number;
  startY: number;
}

/** Return the sidebar a dominant one-finger horizontal swipe would open. */
export function classifySidebarSwipe(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
): SidebarSwipeDirection | null {
  const deltaX = currentX - startX;
  const deltaY = currentY - startY;
  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance <= MIN_HORIZONTAL_DISTANCE_PX
    || horizontalDistance <= Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO
  ) {
    return null;
  }
  return deltaX > 0 ? "left" : "right";
}

function sidebarIsOpen(ownerDocument: Document, direction: SidebarSwipeDirection): boolean {
  const body = ownerDocument.body;
  if (!body) return false;
  const openClasses = direction === "left"
    ? ["is-left-sidebar-open", "is-left-sidedock-open"]
    : ["is-right-sidebar-open", "is-right-sidedock-open"];
  return openClasses.some((className) => body.classList.contains(className));
}

/**
 * Optionally prevents Obsidian's mobile one-finger sidebar swipe gesture.
 *
 * This deliberately listens only to TouchEvents, requires one contact, and
 * waits for a strongly horizontal movement. Pointer events from Apple Pencil
 * are tracked so their companion TouchEvents never become swipe candidates.
 */
export class MobileSidebarSwipeBlocker {
  private enabled = false;
  private candidate: TouchCandidate | null = null;
  private readonly activePenPointers = new Set<number>();
  private readonly listenerOptions: AddEventListenerOptions = { capture: true };
  private readonly moveListenerOptions: AddEventListenerOptions = { capture: true, passive: false };

  constructor(private readonly ownerDocument: Document) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.removeListeners();
    this.enabled = enabled;
    if (!enabled) return;
    this.ownerDocument.addEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerDocument.addEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerDocument.addEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerDocument.addEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
  }

  destroy(): void {
    this.removeListeners();
    this.enabled = false;
  }

  private readonly handleTouchStart = (event: TouchEvent): void => {
    if (this.activePenPointers.size > 0 || event.touches.length !== 1) {
      this.candidate = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    this.candidate = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY
    };
  };

  private readonly handleTouchMove = (event: TouchEvent): void => {
    const candidate = this.candidate;
    if (!candidate) return;
    if (this.activePenPointers.size > 0 || event.touches.length !== 1) {
      this.candidate = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch || touch.identifier !== candidate.identifier) {
      this.candidate = null;
      return;
    }
    const direction = classifySidebarSwipe(candidate.startX, candidate.startY, touch.clientX, touch.clientY);
    if (!direction || sidebarIsOpen(this.ownerDocument, direction)) return;
    if (!event.cancelable) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleTouchEnd = (): void => {
    this.candidate = null;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "pen") this.activePenPointers.add(event.pointerId);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (event.pointerType === "pen") this.activePenPointers.delete(event.pointerId);
  };

  private removeListeners(): void {
    this.candidate = null;
    this.activePenPointers.clear();
    this.ownerDocument.removeEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerDocument.removeEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerDocument.removeEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
  }
}
