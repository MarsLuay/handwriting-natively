import { describe, expect, it } from "vitest";
import { canAnnotatePointer, describeInputPolicies } from "../src/input/annotationInputPolicy";

describe("annotationInputPolicy", () => {
  it("allows only pen and explicitly remapped stylus events", () => {
    expect(canAnnotatePointer({ pointerType: "pen" })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "touch" }, { stylusRemapped: true })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { stylusRemapped: false })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "mouse" }, { stylusRemapped: true })).toBe(true);
    expect(describeInputPolicies()).toEqual({
      stylusPolicy: "annotate",
      touchPolicy: "native",
      mousePolicy: "native"
    });
  });
});
