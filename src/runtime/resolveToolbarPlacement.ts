import type { ToolbarPlacement } from "../model";

/** Keep the user's explicit toolbar location, defaulting invalid values to the PDF bar. */
export function resolveToolbarPlacement(
  configured: ToolbarPlacement | undefined
): ToolbarPlacement {
  return configured === "left" || configured === "right" || configured === "main"
    ? configured
    : "main";
}
