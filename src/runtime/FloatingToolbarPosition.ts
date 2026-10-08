import type { FloatingToolbarPosition } from "../model";

export interface FloatingToolbarPositionInput {
  savedPosition: FloatingToolbarPosition | null;
  currentPosition: FloatingToolbarPosition | null;
  hostPosition: FloatingToolbarPosition;
  viewport: { width: number; height: number };
  toolbarSize: { width: number; height: number };
}

/** Restore the shared position, keep a mounted toolbar stable, or use the viewer's top-left. */
export function resolveFloatingToolbarPosition({
  savedPosition,
  currentPosition,
  hostPosition,
  viewport,
  toolbarSize
}: FloatingToolbarPositionInput): FloatingToolbarPosition {
  const requested = savedPosition ?? currentPosition ?? hostPosition;
  return {
    left: Math.min(Math.max(requested.left, 0), Math.max(0, viewport.width - toolbarSize.width)),
    top: Math.min(Math.max(requested.top, 0), Math.max(0, viewport.height - toolbarSize.height))
  };
}
