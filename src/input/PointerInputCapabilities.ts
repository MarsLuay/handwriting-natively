export interface PointerInputCapabilities {
  /** Pointer Events are available as the normal action stream. */
  pointerEvents: boolean;
  /** Pointer capture is available for annotation ownership. */
  pointerCapture: boolean;
  /** Touch Events are available for passive observation / native fallback. */
  touchEvents: boolean;
}

/** Tests and non-DOM callers retain the established Pointer Events path. */
export const DEFAULT_POINTER_INPUT_CAPABILITIES: PointerInputCapabilities = {
  pointerEvents: true,
  pointerCapture: false,
  touchEvents: true
};

/** Detect the host input primitives without user-agent or viewport guesses. */
export function detectPointerInputCapabilities(element: HTMLElement): PointerInputCapabilities {
  const view = element.ownerDocument.defaultView as (Window & {
    PointerEvent?: unknown;
    TouchEvent?: unknown;
  }) | null;
  const target = element as unknown as Record<string, unknown>;
  const pointerEvents = Boolean(
    typeof view?.PointerEvent === "function"
      || typeof target.onpointerdown !== "undefined"
      || typeof target.setPointerCapture === "function"
  );
  return {
    pointerEvents,
    pointerCapture: typeof target.setPointerCapture === "function"
      && typeof target.releasePointerCapture === "function",
    touchEvents: Boolean(view && ("ontouchstart" in view || typeof view.TouchEvent === "function"))
  };
}
