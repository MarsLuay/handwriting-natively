/*
 * Behavior adapted from hata-suriiken/obsidian-mobile-pinch-zoom,
 * revision 8fe3152eb82c2084fbb847e1c445312145134b66 (MIT).
 */

export interface MobilePinchZoomPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface MobilePinchZoomFrame {
  generation: number;
  points: readonly MobilePinchZoomPoint[];
}

export type MobilePinchZoomEndReason = "pointerup" | "pointercancel" | "lostpointercapture" | "pen-contact" | "lifecycle" | "disabled";

export interface MobilePinchZoomFocalPoint {
  x: number;
  y: number;
}

export interface MobilePinchZoomControllerOptions {
  minScale: number;
  maxScale: number;
  snapScale?: number;
  snapRange?: number;
  animationMs?: number;
  wheelSessionGapMs?: number;
  now?: () => number;
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  getScale: () => number;
  getViewportCenter?: () => MobilePinchZoomFocalPoint | null;
  onStart: (frame: MobilePinchZoomFrame) => { accepted: boolean; scale?: number };
  onPreview: (scale: number, focalPoint: MobilePinchZoomFocalPoint) => void;
  onEnd: (scale: number, reason: MobilePinchZoomEndReason) => void;
  onCancel: (reason: string) => void;
  onSettled?: (scale: number) => void;
  onEligibility?: (target: EventTarget | null) => boolean;
  onIndicator?: (scale: number, reset: () => void) => void;
}

export interface MobilePinchZoomWheelEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

interface ActivePinch {
  startDistance: number;
  startScale: number;
  focalPoint: MobilePinchZoomFocalPoint;
  lastScale: number;
}

const DEFAULT_ANIMATION_MS = 180;
const DEFAULT_SNAP_RANGE = 0.05;
const DEFAULT_WHEEL_SESSION_GAP_MS = 300;

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultRequestFrame(callback: (timestamp: number) => void): number {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  if (typeof window !== "undefined") {
    return window.setTimeout(() => callback(defaultNow()), 16);
  }
  return 0;
}

function defaultCancelFrame(handle: number): void {
  if (typeof window === "undefined") return;
  if (window.cancelAnimationFrame) window.cancelAnimationFrame(handle);
  else window.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function defaultSetTimer(callback: () => void, delayMs: number): number {
  return typeof window === "undefined" ? 0 : window.setTimeout(callback, delayMs);
}

function defaultClearTimer(handle: number): void {
  if (typeof window !== "undefined") window.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function distance(points: readonly MobilePinchZoomPoint[]): number {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function midpoint(points: readonly MobilePinchZoomPoint[]): MobilePinchZoomFocalPoint | null {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2
  };
}

/**
 * PDF session remains responsible for the private PDF.js scale commit and
 * temporary page/ink compositor.
 */
export class MobilePinchZoomController {
  private readonly snapScale: number;
  private readonly snapRange: number;
  private readonly animationMs: number;
  private readonly wheelSessionGapMs: number;
  private readonly now: () => number;
  private readonly requestFrame: (callback: (timestamp: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private active: ActivePinch | null = null;
  private pending: { scale: number; focalPoint: MobilePinchZoomFocalPoint } | null = null;
  private previewFrame: number | null = null;
  private animationFrame: number | null = null;
  private wheelTimer: number | null = null;
  private wheelLastAt = 0;
  private wheelTarget: number | null = null;
  private destroyed = false;

  constructor(private readonly options: MobilePinchZoomControllerOptions) {
    this.snapScale = options.snapScale ?? 1;
    this.snapRange = options.snapRange ?? DEFAULT_SNAP_RANGE;
    this.animationMs = options.animationMs ?? DEFAULT_ANIMATION_MS;
    this.wheelSessionGapMs = options.wheelSessionGapMs ?? DEFAULT_WHEEL_SESSION_GAP_MS;
    this.now = options.now ?? defaultNow;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  start(frame: MobilePinchZoomFrame): boolean {
    if (this.destroyed || frame.points.length < 2) return false;
    const startDistance = distance(frame.points);
    const focalPoint = midpoint(frame.points);
    if (!Number.isFinite(startDistance) || startDistance <= 1 || !focalPoint) return false;

    this.cancelAnimation("pinch-replaced");
    this.flushPreview();
    const result = this.options.onStart(frame);
    if (!result.accepted) return false;
    const startScale = this.clamp(result.scale ?? this.options.getScale());
    this.active = {
      startDistance,
      startScale,
      focalPoint,
      lastScale: startScale
    };
    this.wheelTarget = null;
    this.updateIndicator(startScale);
    return true;
  }

  frame(frame: MobilePinchZoomFrame): void {
    if (this.destroyed || !this.active || frame.points.length < 2) return;
    const active = this.active;
    const currentDistance = distance(frame.points);
    const focalPoint = midpoint(frame.points);
    if (!Number.isFinite(currentDistance) || currentDistance <= 1 || !focalPoint) return;
    active.focalPoint = focalPoint;
    this.queuePreview(this.clamp(active.startScale * currentDistance / active.startDistance), focalPoint);
  }

  end(reason: MobilePinchZoomEndReason): void {
    if (this.destroyed || !this.active) return;
    this.flushPreview();
    if (reason !== "pointerup") {
      this.active = null;
      this.wheelTarget = null;
      this.options.onCancel(reason);
      return;
    }
    const active = this.active;
    // A physical pinch ends at the scale the user chose. Snapping or easing
    // here creates a second zoom gesture after the fingers leave the page;
    // command and ctrl/meta-wheel sessions retain their existing settle policy.
    if (this.wheelTarget === null) {
      this.finish(active.lastScale, reason);
      return;
    }
    const target = Math.abs(active.lastScale - this.snapScale) <= this.snapRange
      ? this.snapScale
      : active.lastScale;
    if (Math.abs(target - active.lastScale) > 0.001) {
      this.animateTo(target, active.focalPoint);
      return;
    }
    this.finish(target, reason);
  }

  handleWheel(event: MobilePinchZoomWheelEvent): boolean {
    if (this.destroyed || (!event.ctrlKey && !event.metaKey)) return false;
    if (this.options.onEligibility && !this.options.onEligibility(event.target)) return false;
    const now = this.now();
    if (!this.active || this.wheelTarget === null || now - this.wheelLastAt > this.wheelSessionGapMs) {
      this.cancelAnimation("wheel-start");
      this.flushPreview();
      const focalPoint = { x: event.clientX, y: event.clientY };
      const frame: MobilePinchZoomFrame = {
        generation: 0,
        points: [
          { pointerId: -1, clientX: focalPoint.x - 1, clientY: focalPoint.y },
          { pointerId: -2, clientX: focalPoint.x + 1, clientY: focalPoint.y }
        ]
      };
      const result = this.options.onStart(frame);
      if (!result.accepted) return false;
      const startScale = this.clamp(result.scale ?? this.options.getScale());
      this.active = { startDistance: 2, startScale, focalPoint, lastScale: startScale };
      this.wheelTarget = startScale;
      this.updateIndicator(startScale);
    }
    this.wheelLastAt = now;
    this.active.focalPoint = { x: event.clientX, y: event.clientY };
    this.wheelTarget = this.clamp((this.wheelTarget ?? this.active.lastScale) * Math.exp(-event.deltaY / 100));
    this.queuePreview(this.wheelTarget, this.active.focalPoint);
    if (this.wheelTimer !== null) this.clearTimer(this.wheelTimer);
    this.wheelTimer = this.setTimer(() => {
      this.wheelTimer = null;
      this.flushPreview();
      this.end("pointerup");
    }, this.wheelSessionGapMs + 50);
    return true;
  }

  reset(): void {
    if (this.destroyed) return;
    this.cancelAnimation("reset");
    this.flushPreview();
    const center = this.options.getViewportCenter?.() ?? { x: 0, y: 0 };
    if (!this.beginCommandSession(center)) return;
    const from = this.clamp(this.options.getScale());
    this.beginAnimation(from, this.clamp(this.snapScale), center);
  }

  zoomBy(delta: number): void {
    if (this.destroyed || !Number.isFinite(delta)) return;
    this.cancelAnimation("command");
    this.flushPreview();
    const center = this.options.getViewportCenter?.() ?? { x: 0, y: 0 };
    if (!this.beginCommandSession(center)) return;
    const from = this.clamp(this.options.getScale());
    this.beginAnimation(from, this.clamp(from + delta), center);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAnimation("destroy");
    if (this.previewFrame !== null) this.cancelFrame(this.previewFrame);
    this.previewFrame = null;
    if (this.wheelTimer !== null) this.clearTimer(this.wheelTimer);
    this.wheelTimer = null;
    this.pending = null;
    this.active = null;
    this.wheelTarget = null;
  }

  private queuePreview(scale: number, focalPoint: MobilePinchZoomFocalPoint): void {
    if (!this.active) return;
    this.pending = { scale, focalPoint };
    if (this.previewFrame !== null) return;
    this.previewFrame = this.requestFrame(() => {
      this.previewFrame = null;
      this.flushPreview();
    });
  }

  private flushPreview(): void {
    if (this.previewFrame !== null) {
      this.cancelFrame(this.previewFrame);
      this.previewFrame = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.active) return;
    this.active.lastScale = pending.scale;
    this.active.focalPoint = pending.focalPoint;
    this.options.onPreview(pending.scale, pending.focalPoint);
    this.updateIndicator(pending.scale);
  }

  private beginCommandSession(focalPoint: MobilePinchZoomFocalPoint): boolean {
    this.options.onCancel("command-replaced");
    const frame: MobilePinchZoomFrame = {
      generation: 0,
      points: [
        { pointerId: -1, clientX: focalPoint.x - 1, clientY: focalPoint.y },
        { pointerId: -2, clientX: focalPoint.x + 1, clientY: focalPoint.y }
      ]
    };
    const result = this.options.onStart(frame);
    if (!result.accepted) return false;
    const scale = this.clamp(result.scale ?? this.options.getScale());
    this.active = {
      startDistance: 2,
      startScale: scale,
      focalPoint,
      lastScale: scale
    };
    this.wheelTarget = null;
    this.updateIndicator(scale);
    return true;
  }

  private animateTo(target: number, focalPoint: MobilePinchZoomFocalPoint): void {
    this.cancelAnimation("animate-replaced");
    const from = this.active?.lastScale ?? this.clamp(this.options.getScale());
    this.beginAnimation(from, target, focalPoint);
  }

  private beginAnimation(from: number, to: number, focalPoint: MobilePinchZoomFocalPoint): void {
    const clampedFrom = this.clamp(from);
    const clampedTo = this.clamp(to);
    if (Math.abs(clampedTo - clampedFrom) < 0.001) {
      this.options.onPreview(clampedTo, focalPoint);
      this.finish(clampedTo, "pointerup");
      return;
    }
    const startedAt = this.now();
    const ease = (value: number): number => 1 - Math.pow(1 - value, 3);
    const step = (timestamp: number): void => {
      if (this.destroyed) return;
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / this.animationMs));
      const scale = clampedFrom + (clampedTo - clampedFrom) * ease(progress);
      if (this.active) this.active.lastScale = scale;
      this.options.onPreview(scale, focalPoint);
      this.updateIndicator(scale);
      if (progress < 1) {
        this.animationFrame = this.requestFrame(step);
        return;
      }
      this.animationFrame = null;
      if (this.active) this.active.lastScale = clampedTo;
      this.finish(clampedTo, "pointerup");
    };
    this.animationFrame = this.requestFrame(step);
  }

  private finish(scale: number, reason: MobilePinchZoomEndReason): void {
    this.active = null;
    this.wheelTarget = null;
    this.options.onEnd(scale, reason);
    this.options.onSettled?.(scale);
    this.updateIndicator(scale);
  }

  private cancelAnimation(reason: string): void {
    if (this.animationFrame !== null) {
      this.cancelFrame(this.animationFrame);
      this.animationFrame = null;
      if (this.active) {
        this.active = null;
        this.wheelTarget = null;
        this.options.onCancel(reason);
      }
    }
  }

  private updateIndicator(scale: number): void {
    this.options.onIndicator?.(scale, () => this.reset());
  }

  private clamp(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(this.options.maxScale, Math.max(this.options.minScale, scale));
  }
}