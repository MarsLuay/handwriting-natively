export interface PalmRejectionOptions {
  ignoreTouchWhilePenActive?: boolean;
  palmWidthThreshold?: number;
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
  private readonly activePens = new Set<number>();
  private readonly ignoreTouchWhilePenActive: boolean;
  private readonly palmWidthThreshold: number;
  private readonly stalePenTouchMs: number;
  private readonly penInactivityMs: number;
  private readonly now: () => number;
  private readonly schedule: (handler: () => void, ms: number) => number;
  private readonly clearSchedule: (id: number) => void;
  private lastPenEventAt = 0;
  private penResetTimer: number | undefined;
  private onReset: ((reason: PenStateResetReason, activePenIds: number[]) => void) | null = null;

  constructor(options: PalmRejectionOptions = {}) {
    this.ignoreTouchWhilePenActive = options.ignoreTouchWhilePenActive ?? true;
    this.palmWidthThreshold = options.palmWidthThreshold ?? 42;
    this.stalePenTouchMs = options.stalePenTouchMs ?? 150;
    this.penInactivityMs = options.penInactivityMs ?? 250;
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.schedule = options.setTimeout
      ?? ((handler, ms) => window.setTimeout(handler, ms));
    this.clearSchedule = options.clearTimeout
      ?? ((id) => window.clearTimeout(id));
  }

  /** Optional diagnostic hook when contact flips from active → empty. */
  setResetListener(listener: ((reason: PenStateResetReason, activePenIds: number[]) => void) | null): void {
    this.onReset = listener;
  }

  pointerDown(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    this.activePens.add(event.pointerId);
    this.markPenActivity();
  }

  /** Refresh inactivity timer while tip still reports contact. */
  notePenActivity(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    if (!this.activePens.has(event.pointerId)) return;
    if (event.buttons === 0 && event.pressure <= 0) return;
    this.markPenActivity();
  }

  pointerUp(event: PointerEvent): boolean {
    if (event.pointerType !== "pen") return false;
    return this.clearPenPointer(event.pointerId, "pointerup");
  }

  clearPenPointer(pointerId: number, reason: PenStateResetReason): boolean {
    if (!this.activePens.has(pointerId)) return false;
    const before = [...this.activePens];
    this.activePens.delete(pointerId);
    if (this.activePens.size === 0) {
      this.clearInactivityTimer();
      this.onReset?.(reason, before);
      return true;
    }
    this.markPenActivity();
    return false;
  }

  /** Clear every tracked tip (lost capture / timeout / reconcile / destroy). */
  clearAll(reason: PenStateResetReason): boolean {
    if (this.activePens.size === 0) {
      this.clearInactivityTimer();
      return false;
    }
    const before = [...this.activePens];
    this.activePens.clear();
    this.clearInactivityTimer();
    this.onReset?.(reason, before);
    return true;
  }

  /**
   * Finger arrived while we still think a pen is down, but no pen sample for
   * stalePenTouchMs — treat contact as stale (WebKit omitted pointerup).
   */
  reconcileStalePenOnTouch(): boolean {
    if (this.activePens.size === 0) return false;
    if (this.now() - this.lastPenEventAt <= this.stalePenTouchMs) return false;
    return this.clearAll("touch-after-stale-pen");
  }

  shouldIgnore(event: PointerEvent): boolean {
    if (event.pointerType !== "touch") return false;
    if (this.ignoreTouchWhilePenActive && this.activePens.size > 0) return true;
    return Math.max(event.width || 0, event.height || 0) >= this.palmWidthThreshold && event.pressure > 0.5;
  }

  /** True while at least one stylus tip is down (for scroll-lock / TouchEvent cancel). */
  hasActivePen(): boolean {
    return this.activePens.size > 0;
  }

  activePenIds(): number[] {
    return [...this.activePens];
  }

  reset(): void {
    this.clearAll("reset");
  }

  private markPenActivity(): void {
    this.lastPenEventAt = this.now();
    this.clearInactivityTimer();
    if (this.activePens.size === 0) return;
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
