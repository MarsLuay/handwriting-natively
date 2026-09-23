/**
 * Device-aware annotation input policy (pencil-first).
 * Pen annotates by active tool; touch stays native PDF nav; mouse follows explicit mode.
 */

export type MouseInputMode = "pan" | "annotate" | "native";

export interface MouseInputSettings {
  mouseInputMode?: MouseInputMode | null;
  mouseDragScroll?: boolean | null;
}

/** Resolve persisted mouse mode; migrate legacy mouseDragScroll when mode absent. */
export function resolveMouseInputMode(settings: MouseInputSettings): MouseInputMode {
  const mode = settings.mouseInputMode;
  if (mode === "pan" || mode === "annotate" || mode === "native") return mode;
  // Legacy: drag-scroll on → pan; off → native (never silently map to annotate).
  return settings.mouseDragScroll === false ? "native" : "pan";
}

/** Keep mouseDragScroll aligned with mode for older readers / back-compat. */
export function mouseDragScrollForMode(mode: MouseInputMode): boolean {
  return mode === "pan";
}

/** Stylus / Apple Pencil always may annotate (caller still checks UI occlusion). */
export function stylusAnnotationEnabled(): boolean {
  return true;
}

export interface AnnotatePointerContext {
  mouseInputMode: MouseInputMode;
}

/**
 * Whether this pointer may create annotation ink/edit/text routes.
 * Touch never inks. Pen always may (occlusion handled separately). Mouse only in annotate mode.
 */
export function canAnnotatePointer(
  event: Pick<PointerEvent, "pointerType">,
  ctx: AnnotatePointerContext
): boolean {
  if (event.pointerType === "pen") return stylusAnnotationEnabled();
  if (event.pointerType === "touch") return false;
  if (event.pointerType === "mouse") return ctx.mouseInputMode === "annotate";
  return false;
}

export function mouseAnnotationEnabled(mode: MouseInputMode): boolean {
  return mode === "annotate";
}

export function mousePanEnabled(mode: MouseInputMode): boolean {
  return mode === "pan";
}

export function describeInputPolicies(settings: MouseInputSettings): {
  stylusPolicy: "annotate";
  touchPolicy: "native";
  mousePolicy: MouseInputMode;
} {
  return {
    stylusPolicy: "annotate",
    touchPolicy: "native",
    mousePolicy: resolveMouseInputMode(settings)
  };
}
