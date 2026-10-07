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

  it("leaves touch navigation to GestureNavigationController", () => {
    const ownership = new GestureOwnership();
    const first = ownership.pointerDown({ pointerId: 1, pointerType: "touch" });
    const second = ownership.pointerDown({ pointerId: 2, pointerType: "touch" });
    expect(first.action).toBe("observe");
    expect(second.action).toBe("observe");
    expect(first.state.owner).toBe("idle");
    expect(second.state.owner).toBe("idle");
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

  it("leaves UI and native mouse targets unclaimed while explicit mouse ink owns its contact", () => {
    const ownership = new GestureOwnership();
    expect(ownership.pointerDown({ pointerId: 4, pointerType: "pen", target: "ui", inkToolSelected: true }).action).toBe("ignore");
    const nativeMouse = ownership.pointerDown({ pointerId: 5, pointerType: "mouse", target: "page", buttons: 1 });
    expect(nativeMouse.state.owner).toBe("idle");
    expect(nativeMouse.preventDefault).toBe(false);
    const draw = ownership.pointerDown({
      pointerId: 6,
      pointerType: "mouse",
      target: "page",
      inkToolSelected: true,
      inkIntent: true,
      buttons: 1
    });
    expect(draw.state.owner).toBe("mouse-ink");
    expect(draw.action).toBe("claim-ink");
  });
});
