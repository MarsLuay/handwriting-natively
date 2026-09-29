import { describe, expect, it } from "vitest";
import {
  consumeTouchDoubleTap,
  TOUCH_DOUBLE_TAP_MAX_DELAY_MS,
  TOUCH_DOUBLE_TAP_MAX_DISTANCE_PX
} from "../src/input/TouchDoubleTap";

describe("finger double-tap eraser gesture", () => {
  it("recognizes two nearby taps within the timing window", () => {
    const first = consumeTouchDoubleTap(null, { clientX: 20, clientY: 30 }, 100);
    const second = consumeTouchDoubleTap(first.next, { clientX: 24, clientY: 34 }, 100 + TOUCH_DOUBLE_TAP_MAX_DELAY_MS);

    expect(second.doubleTap).toBe(true);
    expect(second.next).toBeNull();
  });

  it("starts a new candidate when timing or distance is outside the window", () => {
    const first = consumeTouchDoubleTap(null, { clientX: 20, clientY: 30 }, 100);
    const late = consumeTouchDoubleTap(first.next, { clientX: 20, clientY: 30 }, 101 + TOUCH_DOUBLE_TAP_MAX_DELAY_MS);
    expect(late.doubleTap).toBe(false);
    expect(late.next).toMatchObject({ clientX: 20, clientY: 30, at: 101 + TOUCH_DOUBLE_TAP_MAX_DELAY_MS });

    const far = consumeTouchDoubleTap(first.next, {
      clientX: 20 + TOUCH_DOUBLE_TAP_MAX_DISTANCE_PX + 1,
      clientY: 30
    }, 200);
    expect(far.doubleTap).toBe(false);
  });
});
