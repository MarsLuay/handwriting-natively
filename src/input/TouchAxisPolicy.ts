/** Ink dedicated-writing axis lock — vertical PDF scroll vs horizontal native pan. */
export type TouchAxisLock = "none" | "vertical" | "horizontal";

/** Minimum movement (px) before locking single-finger axis (Ink TOUCH_AXIS_LOCK_THRESHOLD_PX). */
export const TOUCH_AXIS_LOCK_THRESHOLD_PX = 4;

export function isVerticalDominant(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) >= Math.abs(deltaX);
}

/** Resolve lock once movement clears the threshold; otherwise stay undecided. */
export function resolveTouchAxisLock(
  deltaX: number,
  deltaY: number,
  thresholdPx: number = TOUCH_AXIS_LOCK_THRESHOLD_PX
): TouchAxisLock {
  if (Math.hypot(deltaX, deltaY) < thresholdPx) return "none";
  return isVerticalDominant(deltaX, deltaY) ? "vertical" : "horizontal";
}

/**
 * Whether Draw-mode single-finger move should claim the gesture (preventDefault +
 * drive PDF vertical scroll). Horizontal lock leaves the browser alone.
 */
export function shouldClaimVerticalTouchPan(axisLocked: TouchAxisLock): boolean {
  return axisLocked === "vertical";
}
