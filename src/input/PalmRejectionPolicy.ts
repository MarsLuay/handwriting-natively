import { resolvePointerIdentity, type PointerIdentityResolution } from "./PenPresence";

export interface PalmRejectionOptions {
  /** Clear contact if a finger arrives this long after the last pen sample (ms). */
  stalePenTouchMs?: number;
  /** Safety clear when no pen activity arrives (ms). */
  penInactivityMs?: number;
  /** Wall clock for tests; defaults to performance.now / Date.now. */
  now?: () => number;
  /** Timer hooks for tests. */
  setTimeout?: (handler: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

export type PenStateResetReason =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture"
  | "touch-after-stale-pen"
  | "pen-inactivity-timeout"
  | "reset";

/**
 * Tracks stylus contact for palm / companion-touch scroll lock.
 * iPad WebKit often omits or redirects Pencil pointerup — clear via every
 * terminal path, stale-touch reconcile, and inactivity timeout (Ink-style).
 */
export class PalmRejectionPolicy {
  /** Evidence-only pen contact tracking; PointerRouter owns canonical gestures. */
  private readonly activePenPointers = new Set<number>();
  private readonly stalePenTouchMs: number;
  private readonly penInactivityMs: number;
  private readonly now: () => number;
  private readonly schedule: (handler: () => void, ms: number) => number;
  private readonly clearSchedule: (id: number) => void;
  private lastPenEventAt = 0;
  private penResetTimer: number | undefined;
  private onReset: ((reason: PenStateResetReason, resetPenIds: number[]) => void) | null = null;
  /** True after any `pointerType=pen` sample (hover or tip) in this session. */
  private penSeen = false;

  constructor(options: PalmRejectionOptions = {}) {
    this.stalePenTouchMs = options.stalePenTouchMs ?? 150;
    this.penInactivityMs = options.penInactivityMs ?? 250;
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.schedule = options.setTimeout
      ?? ((handler, ms) => window.setTimeout(handler, ms));
    this.clearSchedule = options.clearTimeout
      ?? ((id) => window.clearTimeout(id));
  }

  /** Reports the stylus contacts cleared by a reset. */
  setResetListener(listener: ((reason: PenStateResetReason, resetPenIds: number[]) => void) | null): void {
    this.onReset = listener;
  }

  /** Record pen hover/tip so later mouse tip (MockTab) counts as stylus. */
  notePenPresence(
    event: Pick<PointerEvent, "pointerType" | "type" | "buttons" | "pressure" | "button">,
    identity = resolvePointerIdentity(event, this.penSeen)
  ): void {
    if (identity.effectivePointerType === "pen") this.penSeen = true;
  }

  hasPenSeen(): boolean {
    return this.penSeen;
  }

  /**
   * Mouse tip after pen was seen (MockTab tip-as-mouse). Requires non-default
   * tip pressure so a normal mouse (0 / 0.5 / 1) after stylus use stays mouse.
   */
  shouldTreatMouseTipAsPen(
    event: PointerEvent,
    identity = resolvePointerIdentity(event, this.penSeen)
  ): boolean {
    return identity.stylusRemapped;
  }

  private isPenLikeContact(event: PointerEvent, identity: PointerIdentityResolution): boolean {
    return identity.effectivePointerType === "pen";
  }

  pointerDown(
    event: PointerEvent,
    identity = resolvePointerIdentity(event, this.penSeen)
  ): void {
    this.notePenPresence(event, identity);
    if (!this.isPenLikeContact(event, identity)) return;
    this.activePenPointers.add(event.pointerId);
    this.markPenActivity();
  }

  /** Refresh inactivity timer while tip still reports contact. */
  notePenActivity(
    event: PointerEvent,
    identity = resolvePointerIdentity(event, this.penSeen)
  ): void {
    this.notePenPresence(event, identity);
    if (!this.activePenIds().includes(event.pointerId)) return;
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (event.buttons === 0 && event.pressure <= 0) return;
    this.markPenActivity();
  }

  pointerUp(event: PointerEvent): boolean {
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return false;
    if (!this.activePenIds().includes(event.pointerId)) return false;
    return this.clearPenPointer(event.pointerId, "pointerup");
  }

  clearPenPointer(pointerId: number, reason: PenStateResetReason): boolean {
    const before = this.activePenIds();
    if (!before.includes(pointerId)) return false;
    this.clearInactivityTimer();
    this.activePenPointers.delete(pointerId);
    this.onReset?.(reason, [pointerId]);
    return true;
  }

  /** Clear every tracked tip (lost capture / timeout / reconcile / destroy). */
  clearAll(reason: PenStateResetReason): boolean {
    const before = this.activePenIds();
    if (before.length === 0) {
      this.clearInactivityTimer();
      return false;
    }
    this.clearInactivityTimer();
    this.activePenPointers.clear();
    this.onReset?.(reason, before);
    return true;
  }

  /**
   * Finger arrived while we still think a pen is down, but no pen sample for
   * stalePenTouchMs — treat contact as stale (WebKit omitted pointerup).
   */
  reconcileStalePenOnTouch(): boolean {
    if (this.activePenIds().length === 0) return false;
    if (this.now() - this.lastPenEventAt <= this.stalePenTouchMs) return false;
    return this.clearAll("touch-after-stale-pen");
  }

  /** True while at least one stylus tip is down (for scroll-lock / TouchEvent cancel). */
  hasActivePen(): boolean {
    return this.activePenPointers.size > 0;
  }

  activePenIds(): number[] {
    return [...this.activePenPointers];
  }

  /** Restore stylus contact when a page router is rebound during a live tip. */
  adoptActivePenIds(pointerIds: readonly number[]): void {
    this.activePenPointers.clear();
    for (const pointerId of pointerIds) this.activePenPointers.add(pointerId);
    if (pointerIds.length > 0) this.markPenActivity();
  }

  reset(): void {
    this.clearAll("reset");
  }

  private markPenActivity(): void {
    this.lastPenEventAt = this.now();
    this.clearInactivityTimer();
    if (!this.hasActivePen()) return;
    this.penResetTimer = this.schedule(() => {
      this.penResetTimer = undefined;
      this.clearAll("pen-inactivity-timeout");
    }, this.penInactivityMs);
  }

  private clearInactivityTimer(): void {
    if (this.penResetTimer === undefined) return;
    this.clearSchedule(this.penResetTimer);
    this.penResetTimer = undefined;
  }
}
