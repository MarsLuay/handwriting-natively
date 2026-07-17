import type { DrawingTool, InkStroke, PdfPoint } from "../model";
import { simplifyPoints, stabilizePoints, type StabilizationLevel } from "./StrokeStabilizer";

export interface StrokeBuilderOptions {
  id: string;
  page: number;
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: InkStroke["inputType"];
  stabilization?: StabilizationLevel;
  simplifyTolerance?: number;
  now?: () => string;
}

export class StrokeBuilder {
  private readonly points: PdfPoint[] = [];
  constructor(private readonly options: StrokeBuilderOptions) {}

  get id(): string {
    return this.options.id;
  }

  add(point: PdfPoint): void {
    if (![point.x, point.y, point.pressure, point.time].every(Number.isFinite)) throw new TypeError("Invalid stroke point");
    this.points.push({ ...point, pressure: Math.max(0, Math.min(1, point.pressure)) });
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
    return discarded;
  }

  /** Keep an ephemeral preview within a fixed rendering budget. */
  discardToMaxPoints(maxPoints: number): number {
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || this.points.length <= maxPoints) return 0;
    const discarded = this.points.length - maxPoints;
    this.points.splice(0, discarded);
    return discarded;
  }

  preview(simplifyEnabled = true): readonly PdfPoint[] {
    if (!simplifyEnabled) return this.points.map((point) => ({ ...point }));
    return stabilizePoints(this.points, this.options.stabilization ?? "off");
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

  private toStroke(points: PdfPoint[]): InkStroke {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return {
      id: this.options.id, page: this.options.page, tool: this.options.tool,
      color: this.options.color, width: this.options.width, opacity: this.options.opacity,
      inputType: this.options.inputType, points, createdAt: now, updatedAt: now
    };
  }
}
