/** Device-aware annotation policy; host/page safety checks remain with the caller. */
export interface AnnotatePointerContext {
  /** True for an OS-remapped stylus that reports as a mouse. */
  stylusRemapped?: boolean;
  mouseInkingEnabled?: boolean;
  /** False when this mouse event is not on an eligible desktop PDF page. */
  mouseOverPdfPage?: boolean;
  /** Touch fallback is disabled after a confirmed stylus is observed. */
  touchDrawFallback?: boolean;
  stylusConfirmed?: boolean;
}

export function canAnnotatePointer(
  event: Pick<PointerEvent, "pointerType">,
  context: AnnotatePointerContext = {}
): boolean {
  if (event.pointerType === "pen" || context.stylusRemapped === true) return true;
  if (event.pointerType === "touch") {
    return context.touchDrawFallback === true && context.stylusConfirmed !== true;
  }
  if (event.pointerType === "mouse") {
    return context.mouseInkingEnabled === true && context.mouseOverPdfPage !== false;
  }
  return false;
}

export function describeInputPolicies(settings: {
  mouseInkingEnabled?: boolean;
  touchDrawFallback?: boolean;
} = {}): {
  stylusPolicy: "annotate";
  touchPolicy: "fallback" | "native";
  mousePolicy: "inking" | "native";
} {
  return {
    stylusPolicy: "annotate",
    touchPolicy: settings.touchDrawFallback === true ? "fallback" : "native",
    mousePolicy: settings.mouseInkingEnabled === true ? "inking" : "native"
  };
}
