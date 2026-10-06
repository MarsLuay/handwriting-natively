/**
 * Device-aware annotation input policy (pencil-first).
 * Pen annotates by active tool; touch stays native PDF navigation; mouse
 * annotation is an explicit left-button opt-in on PDF pages.
 */

export interface MouseInputSettings {
  mouseInkingEnabled?: boolean | null;
}

/** Stylus / Apple Pencil always may annotate (caller still checks UI occlusion). */
export function stylusAnnotationEnabled(): boolean {
  return true;
}

export interface AnnotatePointerContext {
  mouseInkingEnabled: boolean;
  /** Fixed desktop page gate. Omit to retain the enabled-only policy. */
  mouseOverPdfPage?: boolean;
  /** Runtime capability has observed a valid Pointer Events pen contact. */
  stylusConfirmed?: boolean;
  /** Explicit fallback for touch-only or ambiguous input devices. */
  touchDrawFallback?: boolean;
}

/**
 * Whether this pointer may create annotation ink/edit/text routes.
 * Touch never inks by default. Pen always may (occlusion handled separately).
 * Desktop mouse annotates only when the single mouse-inking setting is enabled
 * and the caller confirms that the pointer started on a PDF page.
 */
export function canAnnotatePointer(
  event: Pick<PointerEvent, "pointerType">,
  ctx: AnnotatePointerContext
): boolean {
  if (event.pointerType === "pen") return stylusAnnotationEnabled();
  if (event.pointerType === "touch") {
    return ctx.touchDrawFallback === true && ctx.stylusConfirmed !== true;
  }
  if (event.pointerType === "mouse") {
    if (!ctx.mouseInkingEnabled) return false;
    if (ctx.mouseOverPdfPage !== undefined) return ctx.mouseOverPdfPage;
    return true;
  }
  return false;
}

export function describeInputPolicies(settings: MouseInputSettings): {
  stylusPolicy: "annotate";
  touchPolicy: "native";
  mousePolicy: "inking" | "native";
} {
  return {
    stylusPolicy: "annotate",
    touchPolicy: "native",
    mousePolicy: settings.mouseInkingEnabled === true ? "inking" : "native"
  };
}
