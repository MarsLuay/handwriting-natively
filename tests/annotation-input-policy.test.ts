import { describe, expect, it } from "vitest";
import {
  canAnnotatePointer,
  describeInputPolicies,
  stylusAnnotationEnabled
} from "../src/input/annotationInputPolicy";

describe("annotationInputPolicy", () => {
  it("routes pen and touch consistently and gates mouse inking by setting and page position", () => {
    expect(stylusAnnotationEnabled()).toBe(true);
    expect(canAnnotatePointer({ pointerType: "pen" }, { mouseInkingEnabled: false })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "touch" }, { mouseInkingEnabled: true })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInkingEnabled: false, mouseOverPdfPage: true })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInkingEnabled: true, mouseOverPdfPage: false })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInkingEnabled: true, mouseOverPdfPage: true })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInkingEnabled: true })).toBe(true);
    expect(describeInputPolicies({ mouseInkingEnabled: false })).toEqual({
      stylusPolicy: "annotate",
      touchPolicy: "native",
      mousePolicy: "native"
    });
    expect(describeInputPolicies({ mouseInkingEnabled: true }).mousePolicy).toBe("inking");
  });
});
