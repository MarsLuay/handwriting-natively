import { scheduleAfterDisplayFrames } from "./MobilePdfZoomReleaseGate";
import {
  MobilePdfCompositor,
  type MobilePdfCompositorPoint
} from "./MobilePdfCompositor";
import {
  MobilePdfZoomHandoff,
  type MobilePdfZoomHandoffCancelReason,
  type MobilePdfZoomHandoffReleaseResult,
  type MobilePdfZoomHandoffSignal
} from "./MobilePdfZoomHandoff";

export type MobilePdfPinchTransactionPhase = "preview" | "committing" | "settled" | "cancelled";

export type MobilePdfPinchTransactionCompletion =
  | { phase: "settled"; result: MobilePdfZoomHandoffReleaseResult }
  | { phase: "cancelled"; reason: MobilePdfZoomHandoffCancelReason };

export interface MobilePdfPinchTransactionOptions {
  compositor: MobilePdfCompositor;
  handoff: MobilePdfZoomHandoff;
  initialScale: number;
  view: Window | null | undefined;
  /** The bounded escape hatch for a native viewer that stops reporting geometry. */
  maxWaitMs?: number;
  onPreview?: (scale: number, focalPoint: MobilePdfCompositorPoint) => void;
  onNativeCommit?: () => void;
  onNativeSignal?: (signal: MobilePdfZoomHandoffSignal) => void;
  onComplete?: (completion: MobilePdfPinchTransactionCompletion) => void;
}

/**
 * One owner for the mobile PDF pinch transaction.
 *
 * The compositor owns only the live preview. This transaction flushes that
 * preview before PDF.js receives the canonical scale, then keeps the handoff
 * alive through native evidence and the bounded display-frame release gate.
 */
export class MobilePdfPinchTransaction {
  private phase: MobilePdfPinchTransactionPhase = "preview";
  private releaseTimer: number | null = null;
  private releaseFrameCancel: (() => void) | null = null;
  private completed = false;
  private latestScale: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: MobilePdfPinchTransactionOptions) {
    this.latestScale = options.initialScale;
    this.maxWaitMs = Math.max(1, options.maxWaitMs ?? 1500);
  }

  currentPhase(): MobilePdfPinchTransactionPhase {
    return this.phase;
  }

  initialScale(): number {
    return this.options.initialScale;
  }

  nativePhase(): string {
    return this.options.handoff.currentPhase();
  }

  preview(previewScale: number, focalPoint: MobilePdfCompositorPoint): boolean {
    if (this.phase !== "preview" || !Number.isFinite(previewScale)) return false;
    if (!this.options.handoff.updateFocalPoint(focalPoint)) {
      this.cancel(this.options.handoff.currentCancelReason() ?? "capability-lost");
      return false;
    }
    const submitted = this.options.compositor.submit({ previewScale, focalPoint });
    if (submitted) {
      this.latestScale = previewScale;
      this.options.onPreview?.(previewScale, focalPoint);
    }
    return submitted;
  }

  /** Flush the final visual sample, then commit exactly one native scale. */
  commit(finalScale = this.latestScale): boolean {
    if (this.phase !== "preview" || !Number.isFinite(finalScale) || finalScale <= 0) return false;
    this.latestScale = finalScale;
    this.options.compositor.flush();
    let result: ReturnType<MobilePdfZoomHandoff["commit"]>;
    try {
      result = this.options.handoff.commit(finalScale);
    } catch {
      this.cancel("capability-lost");
      return false;
    }
    if (!result.accepted) {
      this.cancel(result.reason ?? "native-scale-commit-unavailable");
      return false;
    }
    this.phase = "committing";
    this.options.onNativeCommit?.();
    this.armReleaseWatchdog();
    this.scheduleRelease();
    return true;
  }

  observe(signal: MobilePdfZoomHandoffSignal): void {
    if (this.completed || this.phase === "settled" || this.phase === "cancelled") return;
    try {
      const nativePhase = this.options.handoff.observe(signal);
      if (nativePhase === "committing") this.options.onNativeSignal?.(signal);
      if (nativePhase === "cancelled") this.tryRelease();
      else if (this.phase === "committing") this.scheduleRelease();
    } catch {
      this.cancel("capability-lost");
    }
  }

  cancel(reason: MobilePdfZoomHandoffCancelReason = "capability-lost"): void {
    if (this.completed || this.phase === "settled" || this.phase === "cancelled") return;
    this.phase = "cancelled";
    this.options.handoff.cancel(reason);
    this.options.compositor.cancel();
    this.cleanupTimers();
    this.complete({ phase: "cancelled", reason });
  }

  private armReleaseWatchdog(): void {
    const view = this.options.view;
    const setTimer = view?.setTimeout.bind(view)
      ?? (typeof window !== "undefined" ? window.setTimeout.bind(window) : null);
    if (!setTimer) return;
    this.releaseTimer = setTimer(() => {
      if (!this.completed) this.cancel("stable-geometry-unavailable");
    }, this.maxWaitMs);
  }

  private scheduleRelease(): void {
    if (this.phase !== "committing" || this.releaseFrameCancel !== null) return;
    this.releaseFrameCancel = scheduleAfterDisplayFrames(this.options.view, () => {
      this.releaseFrameCancel = null;
      this.tryRelease();
    });
  }

  private tryRelease(): void {
    const nativePhase = this.options.handoff.currentPhase();
    if (this.phase !== "committing" && nativePhase !== "cancelled") return;
    let result: MobilePdfZoomHandoffReleaseResult;
    try {
      result = this.options.handoff.release();
    } catch {
      this.cancel("capability-lost");
      return;
    }
    const cancelled = this.options.handoff.currentPhase() === "cancelled";
    if (!result.released && !cancelled) return;
    this.cleanupTimers();
    this.options.compositor.cancel();
    if (cancelled) {
      this.phase = "cancelled";
      this.complete({
        phase: "cancelled",
        reason: this.options.handoff.currentCancelReason() ?? result.reason ?? "capability-lost"
      });
      return;
    }
    this.phase = "settled";
    this.complete({ phase: "settled", result });
  }

  private cleanupTimers(): void {
    if (this.releaseTimer !== null) {
      const view = this.options.view;
      if (view) view.clearTimeout(this.releaseTimer);
      else if (typeof window !== "undefined") window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.releaseFrameCancel?.();
    this.releaseFrameCancel = null;
  }

  private complete(completion: MobilePdfPinchTransactionCompletion): void {
    if (this.completed) return;
    this.completed = true;
    this.options.onComplete?.(completion);
  }
}
