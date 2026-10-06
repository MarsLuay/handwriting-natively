import type { DrawingTool, InkStroke, PagePoint, PenType } from "../model";
import {
  appendStabilizedPoint,
  simplifyPoints,
  stabilizePoints,
  type StabilizationLevel
} from "./StrokeStabilizer";

export interface StrokeBuilderOptions {
  id: string;
  page: number;
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: InkStroke["inputType"];
  /** Captured only for pen strokes; legacy strokes omit the field. */
  penType?: PenType;
  stabilization?: StabilizationLevel;
  simplifyTolerance?: number;
  now?: () => string;
}

export class StrokeBuilder {
  private readonly points: PagePoint[] = [];
  /** Causal preview path — indices never move after append (safe for incremental draft). */
  private readonly smoothedPoints: PagePoint[] = [];
  constructor(private readonly options: StrokeBuilderOptions) {}

  get id(): string {
    return this.options.id;
  }

  /** Spawn-time style — live preview must not follow later toolbar color/tool changes. */
  get style(): Pick<StrokeBuilderOptions, "tool" | "color" | "width" | "opacity" | "penType"> {
    return {
      tool: this.options.tool,
      color: this.options.color,
      width: this.options.width,
      opacity: this.options.opacity,
      ...(this.options.penType ? { penType: this.options.penType } : {})
    };
  }

  /** Stabilization captured at stroke start. */
  get stabilization(): StabilizationLevel {
    return this.options.stabilization ?? "off";
  }

  add(point: PagePoint): void {
    if (![point.x, point.y, point.pressure, point.time].every(Number.isFinite)) throw new TypeError("Invalid stroke point");
    const raw = { ...point, pressure: Math.max(0, Math.min(1, point.pressure)) };
    this.points.push(raw);
    appendStabilizedPoint(this.smoothedPoints, raw, this.stabilization);
  }

  /**
   * Drop samples that can no longer affect an ephemeral preview. One point
   * immediately before the cutoff remains as a continuity anchor for the next
   * visible segment.
   */
  discardBefore(time: number): number {
    if (!Number.isFinite(time) || this.points.length < 2) return 0;
    const firstVisible = this.points.findIndex((point) => point.time >= time);
    if (firstVisible <= 1) return 0;
    const discarded = firstVisible - 1;
    this.points.splice(0, discarded);
    this.smoothedPoints.splice(0, Math.min(discarded, this.smoothedPoints.length));
    return discarded;
  }

  /** Keep an ephemeral preview within a fixed rendering budget. */
  discardToMaxPoints(maxPoints: number): number {
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || this.points.length <= maxPoints) return 0;
    const discarded = this.points.length - maxPoints;
    this.points.splice(0, discarded);
    this.smoothedPoints.splice(0, Math.min(discarded, this.smoothedPoints.length));
    return discarded;
  }

  preview(simplifyEnabled = true): readonly PagePoint[] {
    // These arrays are append-only during a live stroke. Returning the readonly
    // view avoids cloning the entire path on every display frame; the finished
    // stroke still copies its points at the persistence boundary.
    if (!simplifyEnabled) return this.points;
    // Causal smoothed path (not batch stabilizePoints) — prior coords stay fixed.
    return this.smoothedPoints;
  }

  finish(simplifyEnabled = true): InkStroke {
    if (this.points.length === 0) throw new Error("Cannot finish an empty stroke");
    const processed = simplifyEnabled
      ? simplifyPoints(
        stabilizePoints(this.points, this.options.stabilization ?? "off"),
        this.options.simplifyTolerance ?? 0.35
      )
      : this.points.map((point) => ({ ...point }));
    return this.toStroke(processed);
  }

  /**
   * Same geometry as live `preview()` — so release does not snap when simplify
   * would otherwise drop/reshape points (laser + ink).
   */
  finishMatchingPreview(simplifyEnabled = true): InkStroke {
    if (this.points.length === 0) throw new Error("Cannot finish an empty stroke");
    return this.toStroke(this.preview(simplifyEnabled).map((point) => ({ ...point })));
  }

  private toStroke(points: PagePoint[]): InkStroke {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return {
      id: this.options.id, page: this.options.page, tool: this.options.tool,
      color: this.options.color, width: this.options.width, opacity: this.options.opacity,
      inputType: this.options.inputType, points, createdAt: now, updatedAt: now,
      ...(this.options.penType ? { penType: this.options.penType } : {})
    };
  }
}
