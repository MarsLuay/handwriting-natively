import { describe, expect, it } from "vitest";
import {
  isVerticalDominant,
  resolveTouchAxisLock,
  shouldClaimVerticalTouchPan,
  TOUCH_AXIS_LOCK_THRESHOLD_PX
} from "../src/input/TouchAxisPolicy";

describe("TouchAxisPolicy", () => {
  it("treats equal |dy| as vertical-dominant", () => {
    expect(isVerticalDominant(0, 10)).toBe(true);
    expect(isVerticalDominant(5, 5)).toBe(true);
    expect(isVerticalDominant(10, 0)).toBe(false);
  });

  it("stays unlocked under the movement threshold", () => {
    expect(resolveTouchAxisLock(2, 2)).toBe("none");
    expect(resolveTouchAxisLock(0, TOUCH_AXIS_LOCK_THRESHOLD_PX - 1)).toBe("none");
  });

  it("locks vertical or horizontal once past the threshold", () => {
    expect(resolveTouchAxisLock(0, TOUCH_AXIS_LOCK_THRESHOLD_PX)).toBe("vertical");
    expect(resolveTouchAxisLock(TOUCH_AXIS_LOCK_THRESHOLD_PX, 0)).toBe("horizontal");
    expect(resolveTouchAxisLock(3, 8)).toBe("vertical");
    expect(resolveTouchAxisLock(8, 3)).toBe("horizontal");
  });

  it("claims only vertical lock for PDF scroll", () => {
    expect(shouldClaimVerticalTouchPan("none")).toBe(false);
    expect(shouldClaimVerticalTouchPan("horizontal")).toBe(false);
    expect(shouldClaimVerticalTouchPan("vertical")).toBe(true);
  });
});
