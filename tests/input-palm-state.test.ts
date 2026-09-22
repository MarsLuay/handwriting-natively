import { describe, expect, it } from "vitest";
import { ManipulationStateMachine } from "../src/input/ManipulationStateMachine";

describe("mobile manipulation state", () => {
  it("advertises native pinch before contact and arms the pen guard on signal", () => {
    const machine = new ManipulationStateMachine();

    expect(machine.state).toBe("armed");
    expect(machine.touchAction()).toBe("pan-xy");
    expect(machine.penSignal()).toMatchObject({
      event: "pen-signal",
      from: "armed",
      to: "armed",
      cancelAssist: false,
      touchAction: "pan-xy"
    });
  });

  it("cancels a first-finger assist when the palm arrives before the pen", () => {
    const machine = new ManipulationStateMachine();
    const palm = machine.touchStart();
    const pen = machine.penSignal();
    const lift = machine.touchEnd(false);

    expect(palm).toMatchObject({
      event: "touch-start",
      to: "assisted-touch",
      assistThisGesture: true,
      touchAction: "pan-xy"
    });
    expect(pen).toMatchObject({
      event: "pen-signal",
      from: "assisted-touch",
      to: "armed",
      cancelAssist: true,
      touchAction: "none"
    });
    expect(lift).toMatchObject({ to: "armed", scheduleRearm: false });
  });

  it("takes over for a native pinch and restores the native touch window", () => {
    const machine = new ManipulationStateMachine();
    machine.touchStart();
    const pinch = machine.touchStart();
    const firstLift = machine.touchEnd(true);
    const lastLift = machine.touchEnd(true);

    expect(pinch).toMatchObject({
      event: "pinch-start",
      from: "assisted-touch",
      to: "pinch",
      pinchTakeover: true,
      cancelAssist: true,
      touchAction: "pan-xy"
    });
    expect(firstLift.activeTouches).toBe(1);
    expect(lastLift).toMatchObject({ to: "armed", touchAction: "pan-xy" });
  });

  it("delays restoring the standing guard until a real touch pan ends", () => {
    const machine = new ManipulationStateMachine();
    machine.touchStart();

    const panEnd = machine.touchEnd(true);
    const nativeWindow = machine.touchStart();
    const rearm = machine.rearm();

    expect(panEnd).toMatchObject({
      to: "touch-linger",
      touchAction: "pan-xy",
      scheduleRearm: true
    });
    expect(nativeWindow).toMatchObject({
      to: "native-touch",
      touchAction: "pan-xy",
      assistThisGesture: false,
      cancelRearm: true
    });
    expect(rearm).toMatchObject({ to: "native-touch", touchAction: "pan-xy" });
  });

  it("uses explicit platform capabilities instead of user-agent guesses", () => {
    const fallback = new ManipulationStateMachine({
      supportsTouchAction: false,
      supportsNativePinch: true
    });
    const first = fallback.touchStart();

    expect(first).toMatchObject({ to: "native-touch", assistThisGesture: false, touchAction: "pan-xy" });
    expect(fallback.penSignal().touchAction).toBe("pan-xy");

    const noNativePinch = new ManipulationStateMachine({
      supportsTouchAction: true,
      supportsNativePinch: false
    });
    noNativePinch.touchStart();
    expect(noNativePinch.touchStart().touchAction).toBe("none");
  });
});
