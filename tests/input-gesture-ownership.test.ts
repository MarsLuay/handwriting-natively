import { describe, expect, it } from "vitest";
import { GestureOwnership } from "../src/input/GestureOwnership";

describe("GestureOwnership", () => {
  it("lets a selected pen ink without a draw checkbox and ignores finger ink", () => {
    const ownership = new GestureOwnership();
    const down = ownership.pointerDown({
      pointerId: 7,
      pointerType: "pen",
      target: "page",
      inkToolSelected: true
    });
    expect(down.action).toBe("claim-ink");
    expect(down.state.owner).toBe("pen-ink");
    expect(down.preventDefault).toBe(true);
    const finger = ownership.pointerDown({ pointerId: 3, pointerType: "touch", target: "page" });
    expect(finger.preventDefault).toBe(false);
    expect(finger.state.owner).toBe("pen-ink");
    expect(finger.state.activePenId).toBe(7);
    ownership.pointerUp({ pointerId: 7, pointerType: "pen" });
    expect(ownership.snapshot().owner).toBe("idle");
    expect(ownership.snapshot().activePenId).toBeNull();
  });

  it("persists coalesced samples and keeps predictions as preview", () => {
    const ownership = new GestureOwnership();
    ownership.pointerDown({ pointerId: 1, pointerType: "pen", target: "page", inkToolSelected: true });
    const move = ownership.pointerMove({
      pointerId: 1,
      pointerType: "pen",
      samples: ["a", "b"],
      predicted: ["c"]
    });
    expect(move.persistSamples).toEqual(["a", "b"]);
    expect(move.previewSamples).toEqual(["c"]);
    expect(move.previewSamples.every((sample) => !move.persistSamples.includes(sample))).toBe(true);
  });

  it("keeps two fingers on native navigation and clears on cancel, capture loss, and generation change", () => {
    const ownership = new GestureOwnership();
    ownership.pointerDown({ pointerId: 1, pointerType: "touch" });
    ownership.pointerDown({ pointerId: 2, pointerType: "touch" });
    expect(ownership.snapshot().owner).toBe("native-touch-navigation");
    expect(ownership.observeTouchEvent().preventDefault).toBe(false);
    expect(ownership.snapshot().owner).toBe("native-touch-navigation");
    ownership.pointerCancel({ pointerId: 1, pointerType: "touch" });
    ownership.pointerUp({ pointerId: 2, pointerType: "touch" });
    expect(ownership.snapshot().owner).toBe("idle");

    ownership.pointerDown({ pointerId: 9, pointerType: "pen", target: "page", inkToolSelected: true });
    const generation = ownership.snapshot().generation;
    ownership.lostCapture({ pointerId: 9, pointerType: "pen" });
    expect(ownership.snapshot().activePenId).toBeNull();
    ownership.replaceGeneration();
    expect(ownership.snapshot().generation).toBe(generation + 1);
    const stale = ownership.pointerMove({ pointerId: 9, pointerType: "pen", samples: ["stale"] });
    expect(stale.persistSamples).toEqual([]);
  });

  it("leaves UI targets and mouse pan independent from pen ink", () => {
    const ownership = new GestureOwnership();
    expect(ownership.pointerDown({ pointerId: 4, pointerType: "pen", target: "ui", inkToolSelected: true }).action).toBe("ignore");
    const pan = ownership.pointerDown({ pointerId: 5, pointerType: "mouse", mouseIntent: "pan", buttons: 1 });
    expect(pan.state.owner).toBe("mouse-pan");
    expect(pan.preventDefault).toBe(false);
    ownership.pointerUp({ pointerId: 5, pointerType: "mouse" });
    const draw = ownership.pointerDown({ pointerId: 6, pointerType: "mouse", mouseIntent: "ink", buttons: 1 });
    expect(draw.state.owner).toBe("mouse-ink");
    expect(draw.action).toBe("claim-ink");
  });
});
