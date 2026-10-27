import type { LaserPreferences, PagePoint } from "../model";
import { drawLaserStroke, laserTrailStillVisible, mapLaserPoints } from "../tools/LaserTool";
import type { StrokeBuilder } from "../ink/StrokeBuilder";
import { SLOW_SPAN_SYNC_MS } from "./SlowSpanTrace";

export interface LaserTrail {
  id: string;
  page: number;
  points: PagePoint[];
  color: string;
  width: number;
  opacity: number;
  holdMs: number;
  fadeMs: number;
}

export interface LaserSurface {
  page: { pageNumber: number };
  overlay: HTMLElement;
  context: CanvasRenderingContext2D;
  laserDraft: boolean;
  laserDiscardedPoints: number;
  builder?: StrokeBuilder | undefined;
  inkLayerValid: boolean;
  inkLayer: HTMLCanvasElement | null;
  inkLayerBurstCapture: boolean;
  rasterFallbackReady: boolean;
  settleUpgradePending: boolean;
}

export interface LaserOverlayHost<TSurface extends LaserSurface = LaserSurface> {
  getSurface(pageNumber: number): TSurface | undefined;
  getAllSurfaces(): Iterable<TSurface>;
  toViewport(surface: TSurface, point: PagePoint): { x: number; y: number };
  displayScale(surface: TSurface): number;
  pageLayout(surface: TSurface): { contentWidth: number; contentHeight: number };
  resolveInkBacking(width: number, height: number): { pixelWidth: number; pixelHeight: number; backingScale: number };
  blitInkLayerToCanvas(surface: TSurface, pixelWidth: number, pixelHeight: number, backingScale: number): void;
  renderPage(pageNumber: number): void;
  getLaserPreferences(): LaserPreferences;
  onSlowRepaint?(pageNumber: number, durationMs: number, draftPointCount: number, trailCount: number): void;
  isDestroyed(): boolean;
  defaultView(): Window | null;
}

/**
 * Manages transient laser pointer trails, ephemeral draft trimming,
 * fading animation frame loop, and fast laser blits on page overlays.
 */
export class LaserOverlayController<TSurface extends LaserSurface = LaserSurface> {
  static readonly LASER_FADE_MIN_MS = 32;
  static readonly MAX_LASER_DRAFT_POINTS = 1024;

  private trails: LaserTrail[] = [];
  private fadeFrame: number | null = null;
  private lastPaintAt = 0;

  constructor(private readonly host: LaserOverlayHost<TSurface>) {}

  getTrails(): readonly LaserTrail[] {
    return this.trails;
  }

  addTrail(trail: LaserTrail): void {
    this.trails.push(trail);
  }

  clearTrails(): void {
    if (this.fadeFrame !== null) {
      const view = this.host.defaultView() ?? window;
      view.cancelAnimationFrame(this.fadeFrame);
      this.fadeFrame = null;
    }
    this.trails = [];
  }

  paintPoints(
    surface: TSurface,
    points: readonly PagePoint[],
    color: string,
    width: number,
    opacity: number,
    holdMs: number,
    fadeMs: number
  ): void {
    if (!points.length) return;
    const scale = this.host.displayScale(surface);
    drawLaserStroke(surface.context, mapLaserPoints(points, (point) => this.host.toViewport(surface, point)), {
      color,
      width: Math.max(1, width * scale),
      opacity,
      nowMs: performance.now(),
      holdMs,
      fadeMs
    });
    this.lastPaintAt = performance.now();
  }

  paintTrails(surface: TSurface, pageNumber: number): void {
    for (const trail of this.trails) {
      if (trail.page !== pageNumber) continue;
      this.paintPoints(
        surface,
        trail.points,
        trail.color,
        trail.width,
        trail.opacity,
        trail.holdMs,
        trail.fadeMs
      );
    }
  }

  trimDraft(surface: TSurface, now: number): void {
    if (!surface.laserDraft || !surface.builder) return;
    const laser = this.host.getLaserPreferences();
    const retentionMs = Math.max(0, laser.holdMs) + Math.max(1, laser.fadeMs);
    surface.laserDiscardedPoints += surface.builder.discardBefore(now - retentionMs);
    surface.laserDiscardedPoints += surface.builder.discardToMaxPoints(LaserOverlayController.MAX_LASER_DRAFT_POINTS);
  }

  /** Blit cached ink + lasers only — avoids full committed-stroke rebuild every fade tick. */
  repaintOverlay(pageNumber: number): void {
    const surface = this.host.getSurface(pageNumber);
    if (!surface) return;
    const rect = surface.overlay.getBoundingClientRect();
    const layout = this.host.pageLayout(surface);
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = this.host.resolveInkBacking(width, height);
    const deferredRaster = !surface.inkLayerValid
      && Boolean(surface.inkLayer)
      && (surface.inkLayerBurstCapture || surface.rasterFallbackReady)
      && surface.settleUpgradePending
      && surface.inkLayer!.width === pixelWidth
      && surface.inkLayer!.height === pixelHeight;
    if ((!surface.inkLayerValid || !surface.inkLayer) && !deferredRaster) {
      this.host.renderPage(pageNumber);
      return;
    }

    const startedAt = performance.now();
    this.host.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
    const laserDraftPoints = surface.laserDraft ? surface.builder?.preview(true) ?? [] : [];
    if (laserDraftPoints.length) {
      const laser = this.host.getLaserPreferences();
      this.paintPoints(
        surface,
        laserDraftPoints,
        laser.color,
        laser.width,
        laser.opacity,
        laser.holdMs,
        laser.fadeMs
      );
    } else if (surface.builder?.preview().length && !surface.laserDraft) {
      this.host.renderPage(pageNumber);
      return;
    }
    this.paintTrails(surface, pageNumber);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_SPAN_SYNC_MS) {
      this.host.onSlowRepaint?.(pageNumber, durationMs, laserDraftPoints.length, this.trails.length);
    }
  }

  ensureFadeLoop(): void {
    if (this.host.isDestroyed() || this.fadeFrame !== null) return;
    const view = this.host.defaultView();
    if (!view) return;
    const tick = (now: number): void => {
      this.fadeFrame = null;
      if (this.host.isDestroyed()) return;

      const dirtyPages = new Set<number>();
      for (const trail of this.trails) dirtyPages.add(trail.page);
      let visibleDraft = false;
      for (const surface of this.host.getAllSurfaces()) {
        if (!surface.laserDraft) continue;
        this.trimDraft(surface, now);
        const laser = this.host.getLaserPreferences();
        const points = surface.builder?.preview(true) ?? [];
        if (!laserTrailStillVisible(points, now, laser.holdMs, laser.fadeMs)) continue;
        visibleDraft = true;
        dirtyPages.add(surface.page.pageNumber);
      }

      this.trails = this.trails.filter((trail) => {
        dirtyPages.add(trail.page);
        return laserTrailStillVisible(trail.points, now, trail.holdMs, trail.fadeMs);
      });

      // Skip if pointermove just painted (avoids double full-canvas work while dragging).
      const recentlyPainted = now - this.lastPaintAt < LaserOverlayController.LASER_FADE_MIN_MS;
      if (!recentlyPainted) {
        for (const page of dirtyPages) this.repaintOverlay(page);
      }

      const stillActive = this.trails.length > 0 || visibleDraft;
      if (stillActive) {
        this.fadeFrame = view.requestAnimationFrame(tick);
      }
    };
    this.fadeFrame = view.requestAnimationFrame(tick);
  }

  destroy(): void {
    this.clearTrails();
  }
}
