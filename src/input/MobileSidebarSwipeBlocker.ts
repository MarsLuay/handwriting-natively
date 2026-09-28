export type SidebarSwipeDirection = "left" | "right";

const HORIZONTAL_DOMINANCE_RATIO = 3;
const MIN_HORIZONTAL_DISTANCE_PX = 10;
const COMMAND_PALETTE_TOP_EDGE_PX = 48;
const COMMAND_PALETTE_VERTICAL_DOMINANCE_RATIO = 3;
const MIN_VERTICAL_DISTANCE_PX = 10;

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

/** Return true for the downward top-edge gesture Obsidian uses to reveal the command palette. */
export function classifyCommandPaletteSwipe(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
): boolean {
  const deltaX = currentX - startX;
  const deltaY = currentY - startY;
  return startY <= COMMAND_PALETTE_TOP_EDGE_PX
    && deltaY > MIN_VERTICAL_DISTANCE_PX
    && deltaY > Math.abs(deltaX) * COMMAND_PALETTE_VERTICAL_DOMINANCE_RATIO;
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
 * Optionally prevents Obsidian's mobile one-finger sidebar and command-palette
 * swipe gestures.
 *
 * This requires one contact and waits for a strongly directional movement.
 * Both touch and pointer events are handled because mobile Obsidian builds can
 * route edge gestures through either event family. Pointer events from Apple
 * Pencil are tracked so their companion TouchEvents never become candidates.
 */
export class MobileSidebarSwipeBlocker {
  private sidebarEnabled = false;
  private commandPaletteEnabled = false;
  private candidate: TouchCandidate | null = null;
  private pointerCandidate: TouchCandidate | null = null;
  private readonly activePenPointers = new Set<number>();
  private readonly activeTouchPointers = new Set<number>();
  private readonly ownerWindow: Window | null;
  private readonly listenerOptions: AddEventListenerOptions = { capture: true };
  private readonly moveListenerOptions: AddEventListenerOptions = { capture: true, passive: false };

  constructor(private readonly ownerDocument: Document) {
    this.ownerWindow = ownerDocument.defaultView;
  }

  setEnabled(sidebarEnabled: boolean, commandPaletteEnabled = false): void {
    if (this.sidebarEnabled === sidebarEnabled && this.commandPaletteEnabled === commandPaletteEnabled) return;
    this.removeListeners();
    this.sidebarEnabled = sidebarEnabled;
    this.commandPaletteEnabled = commandPaletteEnabled;
    if (!sidebarEnabled && !commandPaletteEnabled) return;
    this.ownerDocument.addEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerDocument.addEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerDocument.addEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerDocument.addEventListener("pointermove", this.handlePointerMove, this.moveListenerOptions);
    this.ownerDocument.addEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.addEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.addEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerWindow?.addEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerWindow?.addEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerWindow?.addEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerWindow?.addEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerWindow?.addEventListener("pointermove", this.handlePointerMove, this.moveListenerOptions);
    this.ownerWindow?.addEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.addEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.addEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
  }

  destroy(): void {
    this.removeListeners();
    this.sidebarEnabled = false;
    this.commandPaletteEnabled = false;
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
    this.blockGesture(candidate, touch.clientX, touch.clientY, event);
  };

  private readonly handleTouchEnd = (): void => {
    this.candidate = null;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "pen") {
      this.activePenPointers.add(event.pointerId);
      return;
    }
    if (event.pointerType !== "touch") return;
    this.activeTouchPointers.add(event.pointerId);
    if (this.activePenPointers.size > 0 || this.activeTouchPointers.size !== 1) {
      this.pointerCandidate = null;
      return;
    }
    this.pointerCandidate = {
      identifier: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    const candidate = this.pointerCandidate;
    if (
      !candidate
      || candidate.identifier !== event.pointerId
      || this.activePenPointers.size > 0
      || this.activeTouchPointers.size !== 1
    ) {
      return;
    }
    this.blockGesture(candidate, event.clientX, event.clientY, event);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (event.pointerType === "pen") {
      this.activePenPointers.delete(event.pointerId);
      return;
    }
    if (event.pointerType !== "touch") return;
    this.activeTouchPointers.delete(event.pointerId);
    if (this.pointerCandidate?.identifier === event.pointerId || this.activeTouchPointers.size !== 1) {
      this.pointerCandidate = null;
    }
  };

  private blockGesture(candidate: TouchCandidate, currentX: number, currentY: number, event: Event): void {
    const direction = classifySidebarSwipe(candidate.startX, candidate.startY, currentX, currentY);
    const blocksSidebar = this.sidebarEnabled
      && direction !== null
      && !sidebarIsOpen(this.ownerDocument, direction);
    const blocksCommandPalette = this.commandPaletteEnabled
      && classifyCommandPaletteSwipe(candidate.startX, candidate.startY, currentX, currentY);
    if (!blocksSidebar && !blocksCommandPalette) return;
    event.preventDefault();
    // Obsidian's edge listener can be on the same event target. Stopping only
    // propagation still lets a later same-target listener open the sidebar.
    event.stopImmediatePropagation();
  }

  private removeListeners(): void {
    this.candidate = null;
    this.pointerCandidate = null;
    this.activePenPointers.clear();
    this.activeTouchPointers.clear();
    this.ownerDocument.removeEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerDocument.removeEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerDocument.removeEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointermove", this.handlePointerMove, this.moveListenerOptions);
    this.ownerDocument.removeEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerDocument.removeEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.removeEventListener("touchstart", this.handleTouchStart, this.listenerOptions);
    this.ownerWindow?.removeEventListener("touchmove", this.handleTouchMove, this.moveListenerOptions);
    this.ownerWindow?.removeEventListener("touchend", this.handleTouchEnd, this.listenerOptions);
    this.ownerWindow?.removeEventListener("touchcancel", this.handleTouchEnd, this.listenerOptions);
    this.ownerWindow?.removeEventListener("pointerdown", this.handlePointerDown, this.listenerOptions);
    this.ownerWindow?.removeEventListener("pointermove", this.handlePointerMove, this.moveListenerOptions);
    this.ownerWindow?.removeEventListener("pointerup", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.removeEventListener("pointercancel", this.handlePointerEnd, this.listenerOptions);
    this.ownerWindow?.removeEventListener("lostpointercapture", this.handlePointerEnd, this.listenerOptions);
  }
}
