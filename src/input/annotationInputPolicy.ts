/** Pointer eligibility for annotation routes. Only a stylus may annotate. */

export interface AnnotatePointerContext {
  /** True only for a mouse-shaped event with prior pen evidence and tip signature. */
  stylusRemapped?: boolean;
}

export function canAnnotatePointer(
  event: Pick<PointerEvent, "pointerType">,
  context: AnnotatePointerContext = {}
): boolean {
  return event.pointerType === "pen"
    || (event.pointerType === "mouse" && context.stylusRemapped === true);
}

export function describeInputPolicies(): {
  stylusPolicy: "annotate";
  touchPolicy: "native";
  mousePolicy: "native";
} {
  return {
    stylusPolicy: "annotate",
    touchPolicy: "native",
    mousePolicy: "native"
  };
}
