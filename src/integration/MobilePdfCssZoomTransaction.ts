import { MobilePdfCssZoom, type MobilePdfCssZoomPoint } from "./MobilePdfCssZoom";

export type MobilePdfCssZoomTransactionPhase = "preview" | "settled" | "cancelled";

export type MobilePdfCssZoomTransactionCompletion =
  | { phase: "settled"; scale: number }
  | { phase: "cancelled"; reason: string };

export interface MobilePdfCssZoomTransactionOptions {
  compositor: MobilePdfCssZoom;
  initialScale: number;
  onPreview?: (scale: number, focalPoint: MobilePdfCssZoomPoint) => void;
  onComplete?: (completion: MobilePdfCssZoomTransactionCompletion) => void;
}

/**
 * Owns one CSS/container zoom burst. Unlike the old native handoff
 * transaction, commit keeps the final CSS zoom and never calls PDF.js scale.
 */
export class MobilePdfCssZoomTransaction {
  private phase: MobilePdfCssZoomTransactionPhase = "preview";
  private completed = false;
  private latestScale: number;

  constructor(private readonly options: MobilePdfCssZoomTransactionOptions) {
    this.latestScale = options.initialScale;
  }

  currentPhase(): MobilePdfCssZoomTransactionPhase {
    return this.phase;
  }

  initialScale(): number {
    return this.options.initialScale;
  }

  currentScale(): number {
    return this.latestScale;
  }

  /** Compatibility name used by the diagnostics surface. */
  nativePhase(): MobilePdfCssZoomTransactionPhase {
    return this.phase;
  }

  preview(previewScale: number, focalPoint: MobilePdfCssZoomPoint): boolean {
    if (this.phase !== "preview" || !Number.isFinite(previewScale)) return false;
    const submitted = this.options.compositor.submit({ previewScale, focalPoint });
    if (!submitted) return false;
    this.latestScale = previewScale;
    this.options.onPreview?.(previewScale, focalPoint);
    return true;
  }

  /** Flush the final CSS sample and keep its container zoom in place. */
  commit(finalScale = this.latestScale): boolean {
    if (this.phase !== "preview" || !Number.isFinite(finalScale) || finalScale <= 0) return false;
    this.latestScale = finalScale;
    this.options.compositor.flush();
    this.options.compositor.settle();
    this.phase = "settled";
    this.complete({ phase: "settled", scale: finalScale });
    return true;
  }

  /** A competing native scale signal hands ownership back to PDF.js. */
  observe(_signal: unknown): void {
    this.cancel("native-scale-observed");
  }

  cancel(reason = "capability-lost"): void {
    if (this.completed || this.phase !== "preview") return;
    this.phase = "cancelled";
    this.options.compositor.cancel();
    this.complete({ phase: "cancelled", reason });
  }

  private complete(completion: MobilePdfCssZoomTransactionCompletion): void {
    if (this.completed) return;
    this.completed = true;
    this.options.onComplete?.(completion);
  }
}
