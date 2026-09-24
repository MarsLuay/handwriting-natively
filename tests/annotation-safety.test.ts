import { describe, expect, it } from "vitest";
import {
  annotationPageMountMatches,
  annotationPageSafetyReason,
  type AnnotationPageInfo
} from "../src/runtime/AnnotationSurface";

function page(overrides: Partial<AnnotationPageInfo> = {}): AnnotationPageInfo {
  const element = document.createElement("div");
  document.body.append(element);
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    scale: 1,
    rotation: 0,
    element,
    ...overrides
  };
}

describe("annotation page safety", () => {
  it("keeps validated pages available when optional evidence is absent", () => {
    const current = page();
    expect(annotationPageSafetyReason(current)).toBeNull();
    expect(annotationPageMountMatches(current, current)).toBe(true);
    current.element.remove();
  });

  it("blocks invalid geometry and identity evidence", () => {
    const geometry = page({ geometrySafe: false });
    expect(annotationPageSafetyReason(geometry)).toBe("geometry-unsafe");
    geometry.element.remove();

    const dimensions = page({ width: Number.NaN });
    expect(annotationPageSafetyReason(dimensions)).toBe("geometry-unsafe");
    dimensions.element.remove();

    const identity = page({ identitySafe: false });
    expect(annotationPageSafetyReason(identity)).toBe("identity-unsafe");
    identity.element.remove();

    const ambiguous = page({ identityConfidence: "ambiguous" });
    expect(annotationPageSafetyReason(ambiguous)).toBe("identity-unsafe");
    ambiguous.element.remove();
  });

  it("blocks detached shells and stale mount generations", () => {
    const detached = page();
    detached.element.remove();
    expect(annotationPageSafetyReason(detached)).toBe("page-detached");

    const first = page({ mountGeneration: 1 });
    const replacement = page({ element: document.createElement("div"), mountGeneration: 2 });
    expect(annotationPageMountMatches(replacement, first)).toBe(false);
    expect(annotationPageMountMatches({ ...first, mountGeneration: 2 }, first)).toBe(false);
    first.element.remove();
    replacement.element.remove();
  });
});
