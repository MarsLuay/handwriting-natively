export interface TouchDoubleTapPoint {
  clientX: number;
  clientY: number;
}

export interface TouchDoubleTapState extends TouchDoubleTapPoint {
  at: number;
}

export interface TouchDoubleTapResult {
  doubleTap: boolean;
  next: TouchDoubleTapState | null;
}

export const TOUCH_DOUBLE_TAP_MAX_DELAY_MS = 350;
export const TOUCH_DOUBLE_TAP_MAX_DISTANCE_PX = 32;

export function consumeTouchDoubleTap(
  previous: TouchDoubleTapState | null,
  point: TouchDoubleTapPoint,
  at: number,
  maxDelayMs = TOUCH_DOUBLE_TAP_MAX_DELAY_MS,
  maxDistancePx = TOUCH_DOUBLE_TAP_MAX_DISTANCE_PX
): TouchDoubleTapResult {
  const doubleTap = previous !== null
    && at >= previous.at
    && at - previous.at <= maxDelayMs
    && Math.hypot(point.clientX - previous.clientX, point.clientY - previous.clientY) <= maxDistancePx;
  return {
    doubleTap,
    next: doubleTap ? null : { ...point, at }
  };
}
