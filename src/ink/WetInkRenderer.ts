import type { Bounds } from "./StrokeHitTesting";
import { DamageLedger } from "./DamageLedger";

export interface WetInkCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): CanvasRenderingContext2D | null;
}

/**
 * Renders a temporary edit preview without mutating the committed canvas.
 *
 * A wet preview starts as a bitmap copy of committed ink in the disposable
 * draft canvas. Erasing punches holes only in that copy. The caller hides the
 * committed canvas while the wet layer is active and restores it after the
 * canonical command has been applied (or cancelled).
 */
export class WetInkRenderer {
  begin(committed: WetInkCanvas, wet: WetInkCanvas): boolean {
    const context = wet.getContext("2d");
    if (!context || committed.width <= 0 || committed.height <= 0) return false;
    if (wet.width !== committed.width || wet.height !== committed.height) {
      wet.width = committed.width;
      wet.height = committed.height;
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, wet.width, wet.height);
    context.drawImage(committed as CanvasImageSource, 0, 0);
    context.restore();
    return true;
  }

  erase(
    wet: WetInkCanvas,
    points: readonly { x: number; y: number }[],
    lineWidth: number,
    backingScale: number,
    damage: DamageLedger
  ): boolean {
    if (points.length === 0 || !Number.isFinite(lineWidth) || lineWidth <= 0) return false;
    const context = wet.getContext("2d");
    if (!context) return false;
    const radius = lineWidth / 2;
    context.save();
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = lineWidth;
    context.beginPath();
    const first = points[0]!;
    if (points.length === 1) {
      context.arc(first.x, first.y, radius, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
    damage.add(boundsOf(points, radius));
    return true;
  }

  end(wet: WetInkCanvas): void {
    const context = wet.getContext("2d");
    if (context && wet.width > 0 && wet.height > 0) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, wet.width, wet.height);
      context.restore();
    }
  }
}

function boundsOf(points: readonly { x: number; y: number }[], radius: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x - radius);
    minY = Math.min(minY, point.y - radius);
    maxX = Math.max(maxX, point.x + radius);
    maxY = Math.max(maxY, point.y + radius);
  }
  return { minX, minY, maxX, maxY };
}
