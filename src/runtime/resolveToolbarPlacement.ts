import type { ToolbarPlacement } from "../model";

/**
 * Mobile PDF chrome has little room for a top ink bar. Treat configured `main`
 * as `left` so the Draw toolbar docks beside the pages by default.
 */
export function resolveToolbarPlacement(
  configured: ToolbarPlacement | undefined,
  mobile: boolean
): ToolbarPlacement {
  const placement = configured === "left" || configured === "right" || configured === "main"
    ? configured
    : "main";
  if (mobile && placement === "main") return "left";
  return placement;
}
