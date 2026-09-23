import { describe, expect, it } from "vitest";
import {
  canAnnotatePointer,
  describeInputPolicies,
  mouseDragScrollForMode,
  resolveMouseInputMode,
  stylusAnnotationEnabled
} from "../src/input/annotationInputPolicy";

describe("annotationInputPolicy", () => {
  it("migrates mouseDragScroll into mouseInputMode", () => {
    expect(resolveMouseInputMode({ mouseDragScroll: true })).toBe("pan");
    expect(resolveMouseInputMode({ mouseDragScroll: false })).toBe("native");
    expect(resolveMouseInputMode({ mouseInputMode: "annotate", mouseDragScroll: true })).toBe("annotate");
    expect(mouseDragScrollForMode("pan")).toBe(true);
    expect(mouseDragScrollForMode("annotate")).toBe(false);
  });

  it("routes pen and touch consistently and gates desktop mouse drawing by page position", () => {
    expect(stylusAnnotationEnabled()).toBe(true);
    expect(canAnnotatePointer({ pointerType: "pen" }, { mouseInputMode: "pan" })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "touch" }, { mouseInputMode: "annotate" })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInputMode: "pan", mouseOverPdfPage: true })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInputMode: "annotate", mouseOverPdfPage: false })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInputMode: "native", mouseOverPdfPage: true })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { mouseInputMode: "pan" })).toBe(false);
    expect(describeInputPolicies({ mouseInputMode: "native" })).toEqual({
      stylusPolicy: "annotate",
      touchPolicy: "native",
      mousePolicy: "native"
    });
  });
});
