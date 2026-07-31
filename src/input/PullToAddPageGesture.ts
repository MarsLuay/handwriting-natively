import { isHTMLElement, setElementCssProps } from "../dom/typeGuards";
import { queryPdfPageNodes } from "../integration/pdfPageSelectors";
import { createDetachedDiv, createDetachedEl, createDetachedSvg } from "../vendor/createDetached";
import { isAnnotationChromeTarget } from "./PointerRouter";

/** Ignored overscroll before the cue engages — casual bottom-scroll stays inert. */
export const PULL_TO_ADD_DEADZONE_PX = 56;
/** Raw pull past the dead zone needed to arm a new page. */
export const PULL_TO_ADD_THRESHOLD_PX = 110;
/** Cap raw pull so rubber-band never grows unbound. */
export const PULL_TO_ADD_MAX_PX = 260;
/** Dampen intake so wheel ticks / light flicks climb the dead zone slowly. */
export const PULL_TO_ADD_INTAKE_GAIN = 0.55;
/**
 * Minimum viewport reveal (px) for the ring + label once the pull is underway.
 * Ramped in via stretchPixelsForPull — not applied as a one-frame pop.
 */
export const PULL_TO_ADD_CUE_REVEAL_PX = 72;
/** Treat scroll as pinned to the bottom within this slack. */
export const PULL_TO_ADD_EDGE_EPS_PX = 2;
/**
 * While still scrolling toward the bottom, ticks at/above this mark the approach
 * as a fling (arrival lockout only — not re-armed by normal pulls at rest).
 */
export const PULL_TO_ADD_MOMENTUM_DELTA_PX = 64;
/** Instantaneous scroll speed (px/ms) that marks a fast approach. */
export const PULL_TO_ADD_MOMENTUM_SPEED_PX_MS = 2.2;
/**
 * Only absurd leftover fling on the *arrival* tick at the bottom.
 * Settled trackpad pulls often send 120–250px deltas — those must intake.
 */
export const PULL_TO_ADD_BOTTOM_FLING_DELTA_PX = 120;
/** Ignore pull intake this long after a fast arrival at the bottom. */
export const PULL_TO_ADD_ARRIVAL_LOCKOUT_MS = 280;

export interface PullToAddPageCallbacks {
  /** Gesture allowed (session alive, insert API present). */
  enabled(): boolean;
  /** Block while drawing ink, saving, or inserting. */
  isBusy?(): boolean;
  /** True while Draw mode is using the stylus for ink (fingers may still pull). */
  isDrawing?: () => boolean;
  scrollRoot(): HTMLElement;
  /** Overlay mounts relative to this host (PDF leaf / adapter root). */
  host(): HTMLElement;
  withinTarget?(target: EventTarget | null): boolean;
  /** Append a blank page at end. */
  onCommit(): void | Promise<void>;
  /** Optional debug breadcrumb (session logger). */
  onLog?(phase: string, details: Record<string, unknown>): void;
}

export interface PullToAddProgress {
  rawPull: number;
  visualPull: number;
  progress: number;
  armed: boolean;
  /** True once pull has cleared the dead zone and the cue is visible. */
  engaged: boolean;
}

/** Pull that counts toward stretch / ring after the dead zone. */
export function effectivePullFromRaw(rawPull: number): number {
  return Math.max(0, rawPull - PULL_TO_ADD_DEADZONE_PX);
}

/** Diminishing rubber-band displacement from raw overscroll (post dead zone). */
export function visualPullFromRaw(rawPull: number): number {
  const x = Math.min(
    PULL_TO_ADD_MAX_PX - PULL_TO_ADD_DEADZONE_PX,
    effectivePullFromRaw(rawPull)
  );
  if (x <= 0) return 0;
  // Soft asymptotic stretch — more linear early, heavier resistance later.
  return 78 * (1 - 1 / (1 + x / 88));
}

/**
 * Viewer translate distance for the rubber-band + cue gap.
 * Cue reveal ramps with a smoothstep so engage does not pop 72px in one frame.
 */
export function stretchPixelsForPull(rawPull: number): number {
  const visual = visualPullFromRaw(rawPull);
  const effective = effectivePullFromRaw(rawPull);
  if (effective <= 0 && visual <= 0) return 0;
  // Full cue by ~36px past the dead zone (well before arm), then + rubber.
  const revealT = Math.max(0, Math.min(1, effective / 36));
  const reveal = PULL_TO_ADD_CUE_REVEAL_PX * (revealT * revealT * (3 - 2 * revealT));
  return reveal + visual;
}

export function pullProgressFromRaw(rawPull: number): number {
  return Math.max(0, Math.min(1, effectivePullFromRaw(rawPull) / PULL_TO_ADD_THRESHOLD_PX));
}

/** Smoothstep toward a target — used by the display lerp. */
export function smoothPullToward(current: number, target: number, alpha = 0.3): number {
  const next = current + (target - current) * alpha;
  if (Math.abs(target - next) < 0.25) return target;
  return next;
}

export function applyPullIntake(rawPull: number, deltaTowardBottom: number): number {
  if (deltaTowardBottom === 0) return rawPull;
  const gain = deltaTowardBottom > 0 ? PULL_TO_ADD_INTAKE_GAIN : 1;
  return Math.max(0, Math.min(PULL_TO_ADD_MAX_PX, rawPull + deltaTowardBottom * gain));
}

/** True when a tick looks like fling/momentum while approaching the bottom. */
export function isMomentumScrollTick(deltaTowardBottom: number, speedPxPerMs: number): boolean {
  return deltaTowardBottom >= PULL_TO_ADD_MOMENTUM_DELTA_PX
    || speedPxPerMs >= PULL_TO_ADD_MOMENTUM_SPEED_PX_MS;
}

/** Leftover fling at the bottom — much larger than a deliberate pull tick. */
export function isBottomFlingTick(deltaTowardBottom: number): boolean {
  return deltaTowardBottom >= PULL_TO_ADD_BOTTOM_FLING_DELTA_PX;
}

export function isScrollAtBottom(root: HTMLElement, eps = PULL_TO_ADD_EDGE_EPS_PX): boolean {
  // The in-flow pull cue grows scrollHeight; ignore it or the gesture thinks we
  // left the bottom the instant the ring appears.
  const cue = root.querySelector(".native-pdf-handwriting-pull-add-page");
  const cueHeight = isHTMLElement(cue)
    ? (cue.offsetHeight || cue.getBoundingClientRect().height || 0)
    : 0;
  const contentHeight = Math.max(0, root.scrollHeight - cueHeight);
  // Short docs that do not scroll still count as "at bottom".
  if (contentHeight <= root.clientHeight + eps) return true;
  const slack = contentHeight - root.clientHeight - root.scrollTop;
  return slack <= eps;
}

export function resolvePullStretchTarget(scrollRoot: HTMLElement): HTMLElement {
  const named = scrollRoot.querySelector<HTMLElement>(".pdfViewer, .pdf-viewer, #viewer");
  if (named) return named;
  const child = scrollRoot.firstElementChild;
  return isHTMLElement(child) ? child : scrollRoot;
}

/** Last rendered PDF page shell — the pull cue mounts immediately after this node. */
export function resolveLastPdfPage(scrollRoot: HTMLElement): HTMLElement | null {
  const pages = queryPdfPageNodes(scrollRoot);
  if (pages.length === 0) return null;
  let last = pages[0]!;
  let lastNumber = Number(last.dataset.pageNumber) || 0;
  for (const page of pages.slice(1)) {
    const number = Number(page.dataset.pageNumber) || 0;
    if (number >= lastNumber) {
      last = page;
      lastNumber = number;
    }
  }
  return last;
}

/**
 * GoodNotes-style pull past the bottom edge: rubber-band stretch, fill ring,
 * then snap to append a blank PDF page.
 */
export class PullToAddPageGesture {
  private readonly abort = new AbortController();
  private rawPull = 0;
  private activePointerId: number | null = null;
  private lastClientY = 0;
  private claimed = false;
  private committing = false;
  private releaseFrame: number | null = null;
  private overlay: HTMLDivElement | null = null;
  private ring: SVGCircleElement | null = null;
  private stretchTarget: HTMLElement | null = null;
  private slotHost: HTMLElement | null = null;
  private releasing = false;
  private displayPull = 0;
  private displayStretch = 0;
  private smoothFrame: number | null = null;
  private readonly activeTouches = new Set<number>();
  private crossedArm = false;
  private wasAtBottom = false;
  private approachingFast = false;
  private lockoutUntil = 0;
  private lastMotionAt = 0;
  private lastLogAt = 0;
  private lastLogPhase = "";

  constructor(
    private readonly listenerRoot: Document | HTMLElement,
    private readonly callbacks: PullToAddPageCallbacks
  ) {
    const options = { capture: true, signal: this.abort.signal };
    this.listenerRoot.addEventListener("pointerdown", (event) => this.onPointerDown(event as PointerEvent), options);
    this.listenerRoot.addEventListener("pointermove", (event) => this.onPointerMove(event as PointerEvent), options);
    this.listenerRoot.addEventListener("pointerup", (event) => this.onPointerUp(event as PointerEvent), options);
    this.listenerRoot.addEventListener("pointercancel", (event) => this.onPointerUp(event as PointerEvent), options);
    this.listenerRoot.addEventListener("wheel", (event) => this.onWheel(event as WheelEvent), { ...options, passive: false });
    this.listenerRoot.addEventListener("scroll", (event) => this.onScroll(event), { capture: true, passive: true, signal: this.abort.signal });
  }

  destroy(): void {
    this.abort.abort();
    this.cancelReleaseAnimation();
    this.cancelSmoothLoop();
    this.clearVisual(true);
    this.activeTouches.clear();
    this.activePointerId = null;
    this.claimed = false;
    this.rawPull = 0;
    this.displayPull = 0;
    this.displayStretch = 0;
    this.releasing = false;
    this.lockoutUntil = 0;
    this.wasAtBottom = false;
    this.approachingFast = false;
  }

  /** Feed from mouse/stylus grab-pan when scroll is already clamped at the bottom. */
  feedScrollAttempt(scrollDeltaY: number, scrolled: boolean): void {
    if (!this.live() || this.activePointerId !== null) return;
    const now = this.now();
    const root = this.callbacks.scrollRoot();
    const atBottom = isScrollAtBottom(root);

    if (scrolled) {
      this.observeMotion(scrollDeltaY, atBottom, now);
      // Any real scroll means we are not overscrolling the edge — drop the cue.
      if (!atBottom || scrollDeltaY !== 0) this.resetPullQuiet(atBottom ? undefined : "scrolled-away");
      return;
    }

    if (scrollDeltaY <= 0) {
      if (this.rawPull > 0) this.setRawPull(applyPullIntake(this.rawPull, scrollDeltaY));
      return;
    }

    // Cue / stretch only while clamped at the bottom and pushing further down.
    if (!atBottom) {
      if (this.rawPull <= 0 && this.displayPull <= 0) {
        this.resetPullQuiet("not-at-bottom");
        this.observeMotion(scrollDeltaY, atBottom, now);
        return;
      }
      // Active pull: ignore transient !atBottom from cue layout growth.
    }

    this.observeMotion(scrollDeltaY, atBottom || this.rawPull > 0, now);
    if (!this.pullIntakeAllowed(now)) {
      this.resetPullQuiet("lockout-feed");
      return;
    }
    this.setRawPull(applyPullIntake(this.rawPull, scrollDeltaY));
  }

  /** Mouse-pan gesture ended — commit or spring back. */
  feedScrollEnd(): void {
    if (this.activePointerId !== null || this.committing) return;
    void this.finishGesture();
  }

  snapshot(): PullToAddProgress {
    return this.progressState(this.rawPull);
  }

  /** Test seam: remaining lockout after a fast bottom arrival. */
  lockoutRemainingMs(now = this.now()): number {
    return Math.max(0, this.lockoutUntil - now);
  }

  private now(): number {
    // Date.now keeps lockout tests / fake timers simple across popouts.
    return Date.now();
  }

  private live(): boolean {
    return this.callbacks.enabled() && !this.callbacks.isBusy?.() && !this.committing;
  }

  private within(event: Event): boolean {
    return this.callbacks.withinTarget?.(event.target) ?? true;
  }

  private pullIntakeAllowed(now: number): boolean {
    return now >= this.lockoutUntil;
  }

  private log(phase: string, details: Record<string, unknown> = {}, force = false): void {
    if (!this.callbacks.onLog) return;
    const now = this.now();
    // Throttle noisy progress ticks; always keep decision breadcrumbs.
    const noisy = phase === "progress" || phase === "blocked";
    if (!force && noisy && phase === this.lastLogPhase && now - this.lastLogAt < 120) return;
    this.lastLogAt = now;
    this.lastLogPhase = phase;
    this.callbacks.onLog(phase, {
      rawPull: Math.round(this.rawPull),
      lockoutMs: Math.round(Math.max(0, this.lockoutUntil - now)),
      atBottom: this.wasAtBottom,
      approachingFast: this.approachingFast,
      ...details
    });
  }

  private resetPullQuiet(reason?: string): void {
    if (this.rawPull === 0 && this.displayPull === 0 && !this.overlay && !this.stretchTarget) {
      if (reason) this.log("blocked", { reason });
      return;
    }
    if (reason) this.log("reset", { reason, hadPull: this.rawPull > 0 });
    this.rawPull = 0;
    this.displayPull = 0;
    this.displayStretch = 0;
    this.releasing = false;
    this.crossedArm = false;
    this.cancelSmoothLoop();
    this.clearVisual(true);
  }

  /**
   * Fast flings that slam into the bottom arm a short lockout so leftover
   * momentum cannot climb the dead zone / commit a page.
   * Once settled at the bottom, large trackpad ticks must NOT re-arm lockout —
   * Mac wheel deltas of 120–250px are normal deliberate pulls.
   */
  private observeMotion(deltaTowardBottom: number, atBottom: boolean, now: number): void {
    const dt = this.lastMotionAt > 0 ? now - this.lastMotionAt : 0;
    // First sample and same-ms bursts don't get a synthetic speed score.
    const speed = this.lastMotionAt > 0 && dt >= 8 ? Math.abs(deltaTowardBottom) / dt : 0;
    this.lastMotionAt = now;

    if (!atBottom) {
      // Mid-pull metric glitches (cue height / layout) must not unpin the edge.
      if (this.rawPull > 0 || this.displayPull > 0 || this.claimed) return;
      this.wasAtBottom = false;
      // Speed-based, or an absurd single tick — ordinary trackpad scroll deltas alone
      // must not mark approach-fast (that spammed lockout and felt glitchy).
      if (
        deltaTowardBottom > 0
        && (speed >= PULL_TO_ADD_MOMENTUM_SPEED_PX_MS || deltaTowardBottom >= PULL_TO_ADD_BOTTOM_FLING_DELTA_PX)
      ) {
        this.approachingFast = true;
        this.lockoutUntil = Math.max(this.lockoutUntil, now + PULL_TO_ADD_ARRIVAL_LOCKOUT_MS);
        this.log("approach-fast", { delta: Math.round(deltaTowardBottom), speed: Number(speed.toFixed(2)) });
      }
      return;
    }

    const arrived = !this.wasAtBottom;
    this.wasAtBottom = true;
    if (arrived && this.approachingFast) {
      this.lockoutUntil = Math.max(this.lockoutUntil, now + PULL_TO_ADD_ARRIVAL_LOCKOUT_MS);
      this.resetPullQuiet("arrived-fast");
      this.log("lockout", { reason: "arrived-fast", delta: Math.round(deltaTowardBottom) }, true);
    } else if (arrived && isBottomFlingTick(deltaTowardBottom)) {
      // Only the landing tick of a leftover fling — never while already settled.
      this.lockoutUntil = Math.max(this.lockoutUntil, now + PULL_TO_ADD_ARRIVAL_LOCKOUT_MS);
      this.resetPullQuiet("bottom-fling");
      this.log("lockout", { reason: "bottom-fling", delta: Math.round(deltaTowardBottom) }, true);
    }
    this.approachingFast = false;
  }

  private onScroll(event: Event): void {
    if (!this.live()) return;
    const root = this.callbacks.scrollRoot();
    const target = event.target;
    if (target !== root && !(target instanceof Node && (target === root || root.contains(target)))) {
      return;
    }
    const atBottom = isScrollAtBottom(root);
    const now = this.now();
    if (!atBottom) {
      this.wasAtBottom = false;
      // Left the edge — never keep the rubber-band / cue while scrolling the doc.
      if (this.rawPull > 0 || this.displayPull > 0 || this.overlay) {
        this.resetPullQuiet("left-bottom");
      }
      return;
    }
    if (!this.wasAtBottom) {
      // Arrived via native scroll. Only lock out leftover fling, not slow settles.
      this.wasAtBottom = true;
      if (this.approachingFast) {
        this.lockoutUntil = Math.max(this.lockoutUntil, now + PULL_TO_ADD_ARRIVAL_LOCKOUT_MS);
        this.resetPullQuiet("scroll-arrived");
        this.log("lockout", { reason: "scroll-arrived" }, true);
      }
      this.approachingFast = false;
    }
  }

  private progressState(rawPull: number): PullToAddProgress {
    const progress = pullProgressFromRaw(rawPull);
    const visualPull = visualPullFromRaw(rawPull);
    return {
      rawPull,
      visualPull,
      progress,
      armed: progress >= 1,
      engaged: effectivePullFromRaw(rawPull) > 0
    };
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      this.activeTouches.add(event.pointerId);
      if (event.isPrimary && this.activeTouches.size > 1) {
        this.activeTouches.clear();
        this.activeTouches.add(event.pointerId);
      }
      if (this.activeTouches.size >= 2) {
        this.abortActivePointer("multi-touch");
        return;
      }
    }
    if (!this.live() || !this.within(event)) return;
    if (event.button !== 0) return;
    if (isAnnotationChromeTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown")) {
      return;
    }
    // Stylus ink owns the gesture in Draw mode; fingers / mouse still overscroll.
    if (event.pointerType === "pen" && this.callbacks.isDrawing?.()) return;

    const root = this.callbacks.scrollRoot();
    if (!isScrollAtBottom(root)) return;

    // A fresh press at the bottom is deliberate — clear fling lockout.
    this.lockoutUntil = 0;
    this.approachingFast = false;
    this.cancelReleaseAnimation();
    this.activePointerId = event.pointerId;
    this.lastClientY = event.clientY;
    this.claimed = false;
    this.crossedArm = false;
    this.log("pointer-start", { pointerType: event.pointerType }, true);
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch" && this.activeTouches.size >= 2) {
      this.abortActivePointer("multi-touch");
      return;
    }
    if (this.activePointerId !== event.pointerId || !this.live()) return;

    const deltaY = event.clientY - this.lastClientY;
    this.lastClientY = event.clientY;
    // Finger/mouse moving up → content scrolls down → bottom overscroll.
    const towardBottom = -deltaY;
    const root = this.callbacks.scrollRoot();
    const now = this.now();
    const atBottom = isScrollAtBottom(root);

    if (this.rawPull <= 0 && towardBottom <= 0) return;
    // Cue only while clamped at the bottom — never while scrolling the document.
    if (!atBottom && this.rawPull <= 0 && this.displayPull <= 0) {
      return;
    }

    if (towardBottom > 0 || this.rawPull > 0) {
      this.observeMotion(towardBottom, atBottom || this.rawPull > 0, now);
      if (towardBottom > 0 && !this.pullIntakeAllowed(now)) {
        this.resetPullQuiet("lockout-pointer");
        return;
      }
      const next = applyPullIntake(this.rawPull, towardBottom);
      // Stay out of the pointer's way until the dead zone is cleared.
      if (effectivePullFromRaw(next) > 0 || this.claimed) {
        if (!this.claimed) {
          this.claimed = true;
          event.preventDefault();
          event.stopPropagation();
          if (event.target instanceof Element) event.target.setPointerCapture?.(event.pointerId);
        } else {
          event.preventDefault();
        }
      }
      this.setRawPull(next);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") this.activeTouches.delete(event.pointerId);
    if (this.activePointerId !== event.pointerId) return;
    if (this.claimed && event.target instanceof Element && event.target.hasPointerCapture?.(event.pointerId)) {
      event.target.releasePointerCapture?.(event.pointerId);
    }
    this.activePointerId = null;
    this.claimed = false;
    void this.finishGesture();
  }

  private onWheel(event: WheelEvent): void {
    if (!this.live() || !this.within(event)) return;
    if (event.ctrlKey || event.metaKey) return;
    // Pinch / horizontal trackpad pans are not page-add gestures.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5) return;

    const root = this.callbacks.scrollRoot();
    const towardBottom = event.deltaY;
    const now = this.now();
    const atBottom = isScrollAtBottom(root);
    this.observeMotion(towardBottom, atBottom || this.rawPull > 0, now);

    if (towardBottom <= 0 && this.rawPull <= 0) return;
    // Only rubber-band past the last page when already pinned at the bottom.
    if (!atBottom && this.rawPull <= 0 && this.displayPull <= 0) {
      return;
    }

    // Fling leftovers at the bottom: absorb without climbing the pull gesture.
    if (towardBottom > 0 && !this.pullIntakeAllowed(now)) {
      this.resetPullQuiet("lockout-wheel");
      this.scheduleWheelSettle();
      return;
    }

    this.cancelReleaseAnimation();
    const next = applyPullIntake(this.rawPull, towardBottom);
    // Casual overscroll ticks stay native until the dead zone is cleared.
    if (effectivePullFromRaw(next) > 0 || effectivePullFromRaw(this.rawPull) > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.setRawPull(next);
    // Wheel has no pointerup — settle shortly after the last tick.
    this.scheduleWheelSettle();
  }

  private wheelSettleTimer: number | null = null;

  private timerView(): Window | null {
    return this.callbacks.host().ownerDocument.defaultView;
  }

  private scheduleWheelSettle(): void {
    const view = this.timerView();
    if (this.wheelSettleTimer !== null) view?.clearTimeout(this.wheelSettleTimer);
    // Trackpad strokes pause between ticks — too-short settle springs mid-pull (glitchy).
    this.wheelSettleTimer = view?.setTimeout(() => {
      this.wheelSettleTimer = null;
      if (this.activePointerId !== null || this.committing) return;
      void this.finishGesture();
    }, 420) ?? null;
  }

  private abortActivePointer(reason: string): void {
    void reason;
    this.activePointerId = null;
    this.claimed = false;
    if (this.rawPull > 0 || this.displayPull > 0 || this.displayStretch > 0) this.animateRelease();
  }

  private setRawPull(next: number): void {
    const previous = this.progressState(this.rawPull);
    this.releasing = false;
    this.rawPull = Math.max(0, Math.min(PULL_TO_ADD_MAX_PX, next));
    const state = this.progressState(this.rawPull);
    if (!previous.engaged && state.engaged) this.log("engage", { progress: Number(state.progress.toFixed(2)) }, true);
    if (!this.crossedArm && state.armed && !previous.armed) {
      this.crossedArm = true;
      this.log("armed", { progress: 1 }, true);
      try {
        navigator.vibrate?.(10);
      } catch {
        // Optional haptic — ignore unavailable / denied.
      }
    }
    if (!state.armed) this.crossedArm = false;
    if (state.engaged) {
      this.log("progress", {
        progress: Number(state.progress.toFixed(2)),
        visual: Math.round(state.visualPull),
        stretch: Math.round(stretchPixelsForPull(this.rawPull))
      });
    }
    this.ensureSmoothLoop();
  }

  private ensureSmoothLoop(): void {
    this.paintDisplayPull();
    if (this.smoothFrame !== null) return;
    if (!this.needsSmoothFollowUp()) return;
    const view = this.timerView();
    const tick = (): void => {
      this.smoothFrame = null;
      this.paintDisplayPull();
      if (this.needsSmoothFollowUp()) {
        this.smoothFrame = view?.requestAnimationFrame(tick) ?? null;
      }
    };
    this.smoothFrame = view?.requestAnimationFrame(tick) ?? null;
  }

  private needsSmoothFollowUp(): boolean {
    const targetStretch = stretchPixelsForPull(this.rawPull);
    return Math.abs(this.displayPull - this.rawPull) > 0.25
      || Math.abs(this.displayStretch - targetStretch) > 0.25
      || this.releasing;
  }

  private paintDisplayPull(): void {
    // Never paint the cue / stretch unless the scroll root is still at the edge
    // (or we are already mid-gesture / releasing — cue height can confuse slack).
    const atBottom = isScrollAtBottom(this.callbacks.scrollRoot());
    if (!atBottom && !this.releasing && !this.committing && this.rawPull <= 0 && !this.claimed) {
      if (this.displayPull > 0 || this.displayStretch > 0 || this.overlay) {
        this.displayPull = 0;
        this.displayStretch = 0;
        this.crossedArm = false;
        this.clearVisual(true);
      }
      return;
    }

    const target = this.rawPull;
    const authority = this.progressState(target);
    // Lerp pull — no dead-zone snap (that popped the stretch open).
    const catchingUp = target > this.displayPull;
    const alpha = this.releasing ? 0.2 : catchingUp ? 0.45 : 0.3;
    this.displayPull = smoothPullToward(this.displayPull, target, alpha);

    const targetStretch = stretchPixelsForPull(this.releasing ? this.displayPull : this.rawPull);
    const stretchAlpha = this.releasing ? 0.22 : catchingUp ? 0.4 : 0.28;
    this.displayStretch = smoothPullToward(this.displayStretch, targetStretch, stretchAlpha);

    const visualState = this.progressState(this.displayPull);
    if (authority.engaged || this.releasing || this.displayStretch > 1) {
      visualState.engaged = true;
      visualState.visualPull = visualPullFromRaw(this.displayPull);
      visualState.progress = pullProgressFromRaw(this.displayPull);
    }
    if (authority.armed) {
      visualState.armed = true;
      visualState.progress = Math.max(visualState.progress, authority.progress);
    }
    this.renderVisual(visualState, this.displayStretch);

    if (this.releasing && this.displayPull <= 0.3 && this.displayStretch <= 0.5 && this.rawPull <= 0) {
      this.displayPull = 0;
      this.displayStretch = 0;
      this.releasing = false;
      this.crossedArm = false;
      this.clearVisual(true);
    }
  }

  private cancelSmoothLoop(): void {
    if (this.smoothFrame !== null) {
      this.timerView()?.cancelAnimationFrame(this.smoothFrame);
      this.smoothFrame = null;
    }
  }

  private async finishGesture(): Promise<void> {
    if (this.wheelSettleTimer !== null) {
      this.timerView()?.clearTimeout(this.wheelSettleTimer);
      this.wheelSettleTimer = null;
    }
    const state = this.progressState(this.rawPull);
    if (state.armed && this.live() && !this.callbacks.isBusy?.()) {
      this.log("commit", { progress: 1 }, true);
      await this.commitAddPage();
      return;
    }
    // Dead-zone-only overscroll disappears immediately — no rubber-band flash.
    if (!state.engaged && this.displayPull < 1 && this.displayStretch < 1) {
      this.log("cancel-deadzone", {}, true);
      this.rawPull = 0;
      this.displayPull = 0;
      this.displayStretch = 0;
      this.crossedArm = false;
      this.cancelSmoothLoop();
      this.clearVisual(true);
      return;
    }
    this.log("cancel-spring", { progress: Number(state.progress.toFixed(2)) }, true);
    this.animateRelease();
  }

  private async commitAddPage(): Promise<void> {
    if (this.committing) return;
    this.committing = true;
    this.cancelReleaseAnimation();
    this.releasing = false;
    this.rawPull = PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX;
    this.displayPull = this.rawPull;
    this.displayStretch = stretchPixelsForPull(this.rawPull);
    this.renderVisual({
      ...this.progressState(this.rawPull),
      armed: true,
      progress: 1,
      engaged: true
    }, this.displayStretch);
    this.overlay?.classList.add("is-snap");
    const view = this.timerView();
    await new Promise<void>((resolve) => {
      view?.setTimeout(() => resolve(), 160) ?? resolve();
    });
    try {
      await this.callbacks.onCommit();
    } finally {
      this.rawPull = 0;
      this.displayPull = 0;
      this.displayStretch = 0;
      this.crossedArm = false;
      this.cancelSmoothLoop();
      this.clearVisual(true);
      this.committing = false;
    }
  }

  private animateRelease(): void {
    this.cancelReleaseAnimation();
    if (this.rawPull <= 0 && this.displayPull <= 0 && this.displayStretch <= 0) {
      this.clearVisual(true);
      return;
    }
    this.releasing = true;
    const start = Math.max(this.rawPull, this.displayPull);
    const startedAt = this.now();
    const durationMs = 320;
    const view = this.timerView();
    const step = (): void => {
      const t = Math.min(1, (this.now() - startedAt) / durationMs);
      // Ease-out with a tiny settle — no hard stop.
      const eased = 1 - (1 - t) ** 3;
      this.rawPull = start * (1 - eased);
      if (t >= 1) {
        this.rawPull = 0;
        this.releaseFrame = null;
        this.ensureSmoothLoop();
        return;
      }
      this.releaseFrame = view?.requestAnimationFrame(step) ?? null;
      this.ensureSmoothLoop();
    };
    this.releaseFrame = view?.requestAnimationFrame(step) ?? null;
    this.ensureSmoothLoop();
  }

  private cancelReleaseAnimation(): void {
    if (this.releaseFrame !== null) {
      this.timerView()?.cancelAnimationFrame(this.releaseFrame);
      this.releaseFrame = null;
    }
  }

  private renderVisual(state: PullToAddProgress, stretchPx = stretchPixelsForPull(state.rawPull)): void {
    if (!state.engaged && !this.releasing && stretchPx < 1) {
      this.clearVisual(false);
      return;
    }
    const root = this.callbacks.scrollRoot();
    const doc = root.ownerDocument;
    this.stretchTarget ??= resolvePullStretchTarget(root);
    this.stretchTarget.classList.add("native-pdf-handwriting-pull-stretch");
    this.stretchTarget.classList.toggle("is-releasing", this.releasing);
    setElementCssProps(this.stretchTarget, {
      "--pull-stretch": `${Math.max(0, stretchPx).toFixed(2)}px`
    });

    const lastPage = resolveLastPdfPage(root);
    const slotParent = lastPage?.parentElement ?? this.stretchTarget;

    if (!this.overlay) {
      const overlay = createDetachedDiv(doc);
      overlay.className = "native-pdf-handwriting-pull-add-page";
      overlay.setAttribute("aria-hidden", "true");

      const label = createDetachedEl(doc, "span");
      label.className = "native-pdf-handwriting-pull-add-page-label";
      label.textContent = "New page";

      const svg = createDetachedSvg(doc, "svg") as SVGSVGElement;
      svg.setAttribute("viewBox", "0 0 36 36");
      svg.classList.add("native-pdf-handwriting-pull-add-page-ring");

      const track = createDetachedSvg(doc, "circle") as SVGCircleElement;
      track.setAttribute("cx", "18");
      track.setAttribute("cy", "18");
      track.setAttribute("r", "12");
      track.classList.add("is-track");

      const ring = createDetachedSvg(doc, "circle") as SVGCircleElement;
      ring.setAttribute("cx", "18");
      ring.setAttribute("cy", "18");
      ring.setAttribute("r", "12");
      ring.classList.add("is-progress");
      const circumference = 2 * Math.PI * 12;
      ring.setAttribute("stroke-dasharray", String(circumference));

      svg.append(track, ring);
      overlay.append(svg, label);
      this.overlay = overlay;
      this.ring = ring;
    }

    // Keep the cue in document flow directly under the last page (not over it).
    if (this.slotHost !== slotParent || this.overlay.parentElement !== slotParent) {
      if (lastPage?.nextSibling) slotParent.insertBefore(this.overlay, lastPage.nextSibling);
      else slotParent.append(this.overlay);
      this.slotHost = slotParent;
    } else if (lastPage && this.overlay.previousElementSibling !== lastPage) {
      if (lastPage.nextSibling) slotParent.insertBefore(this.overlay, lastPage.nextSibling);
      else slotParent.append(this.overlay);
    }

    const circumference = 2 * Math.PI * 12;
    // CSS vars inherit onto the SVG progress ring (no direct SVG style writes).
    setElementCssProps(this.overlay, {
      "--ring-circ": String(circumference),
      "--pull-progress": String(state.progress),
      height: `${PULL_TO_ADD_CUE_REVEAL_PX}px`
    });
    this.overlay.classList.toggle("is-armed", state.armed);
    this.overlay.classList.toggle("is-releasing", this.releasing);
  }

  private clearVisual(resetStretch: boolean): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.ring = null;
    }
    this.slotHost = null;
    if (this.stretchTarget) {
      setElementCssProps(this.stretchTarget, { "--pull-stretch": "0px" });
      this.stretchTarget.classList.remove("is-releasing");
      if (resetStretch) this.stretchTarget.classList.remove("native-pdf-handwriting-pull-stretch");
      if (resetStretch) this.stretchTarget = null;
    }
  }
}
