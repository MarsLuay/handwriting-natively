import { isSyntheticPointerOrigin } from "./PointerCapabilities";

/** One finished pen stroke. Copy Logs keeps the last few of these, not per-move logs. */
export interface InkStrokeGeometryRecord {
  pointerId: number;
  pointCount: number;
  routerMoveCount: number;
  coalescedSampleCount: number;
  clientPathLengthPx: number;
  chordLengthPx: number;
  straightness: number;
  terminalEvent: string;
  terminalSampleDropped: boolean;
}

interface ClientPoint {
  x: number;
  y: number;
}

/**
 * Client-space path of one open pen stroke. Affine page mapping cannot turn a
 * curve into a line, so a straight ink mark with straightness near 1 means the
 * builder only received colinear samples.
 */
export class OpenInkStrokeGeometry {
  private pointCount = 0;
  private routerMoveCount = 0;
  private coalescedSampleCount = 0;
  private pathLength = 0;
  private first: ClientPoint | null = null;
  private last: ClientPoint | null = null;

  noteSamples(samples: ReadonlyArray<{ clientX: number; clientY: number }>, fromMove: boolean): void {
    if (fromMove) this.routerMoveCount += 1;
    if (fromMove) this.coalescedSampleCount += samples.length;
    for (const sample of samples) this.notePoint(sample.clientX, sample.clientY);
  }

  finish(
    pointerId: number,
    terminalEvent: string,
    terminalClient: { clientX: number; clientY: number } | null
  ): InkStrokeGeometryRecord {
    const chord = this.first && this.last
      ? Math.hypot(this.last.x - this.first.x, this.last.y - this.first.y)
      : 0;
    const straightness = this.pathLength <= 0.5 ? 1 : Math.min(1, chord / this.pathLength);
    const dropped = terminalClient !== null
      && isSyntheticPointerOrigin(terminalClient)
      && this.last !== null
      && !isOriginPoint(this.last);
    return {
      pointerId,
      pointCount: this.pointCount,
      routerMoveCount: this.routerMoveCount,
      coalescedSampleCount: this.coalescedSampleCount,
      clientPathLengthPx: round1(this.pathLength),
      chordLengthPx: round1(chord),
      straightness: Math.round(straightness * 1000) / 1000,
      terminalEvent,
      terminalSampleDropped: dropped
    };
  }

  private notePoint(x: number, y: number): void {
    if (isOriginPoint({ x, y }) && this.last && !isOriginPoint(this.last)) return;
    const point = { x, y };
    if (!this.first) this.first = point;
    if (this.last) this.pathLength += Math.hypot(x - this.last.x, y - this.last.y);
    this.last = point;
    this.pointCount += 1;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isOriginPoint(point: ClientPoint): boolean {
  return isSyntheticPointerOrigin({ clientX: point.x, clientY: point.y });
}
