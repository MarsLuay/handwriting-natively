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

  it("leaves UI, mouse, and touch contacts unclaimed while stylus ink owns its contact", () => {
    const ownership = new GestureOwnership();
    expect(ownership.pointerDown({ pointerId: 4, pointerType: "pen", target: "ui", inkToolSelected: true }).action).toBe("ignore");
    const nativeMouse = ownership.pointerDown({ pointerId: 5, pointerType: "mouse", target: "page", inkToolSelected: true });
    expect(nativeMouse.state.owner).toBe("idle");
    expect(nativeMouse.preventDefault).toBe(false);
    const nativeTouch = ownership.pointerDown({ pointerId: 6, pointerType: "touch", target: "page", inkToolSelected: true });
    expect(nativeTouch.state.owner).toBe("idle");
    expect(nativeTouch.preventDefault).toBe(false);
    const draw = ownership.pointerDown({
      pointerId: 7,
      pointerType: "pen",
      target: "page",
      inkToolSelected: true
    });
    expect(draw.state.owner).toBe("pen-ink");
    expect(draw.action).toBe("claim-ink");
  });

  it("keeps one stylus stroke owner and suppresses a competing stylus until it lifts", () => {
    const ownership = new GestureOwnership();
    ownership.pointerDown({ pointerId: 10, pointerType: "pen", target: "page", inkToolSelected: true });

    const competingDown = ownership.pointerDown({ pointerId: 11, pointerType: "pen", target: "page", inkToolSelected: true });
    expect(competingDown).toMatchObject({ action: "ignore", preventDefault: true, state: { activePenId: 10 } });
    expect(ownership.pointerMove({ pointerId: 11, pointerType: "pen" })).toMatchObject({
      action: "ignore",
      preventDefault: true,
      state: { activePenId: 10 }
    });
    expect(ownership.pointerMove({ pointerId: 10, pointerType: "pen", samples: ["primary"] }).action).toBe("append-ink");
    expect(ownership.pointerUp({ pointerId: 11, pointerType: "pen" })).toMatchObject({
      action: "ignore",
      preventDefault: true,
      state: { activePenId: 10 }
    });
    expect(ownership.pointerUp({ pointerId: 10, pointerType: "pen" }).action).toBe("finalize-ink");
    expect(ownership.snapshot()).toMatchObject({ owner: "idle", activePenId: null });
  });

  it("keeps a rejected stylus suppressed across capture loss and ownership handoff", () => {
    const ownership = new GestureOwnership();
    ownership.pointerDown({ pointerId: 20, pointerType: "pen", target: "page", inkToolSelected: true });
    ownership.pointerDown({ pointerId: 21, pointerType: "pen", target: "page", inkToolSelected: true });

    const ignoredPenIds = ownership.ignoredPenContactIds();
    ownership.replaceGeneration();
    ownership.adoptPenContact(20);
    ownership.adoptIgnoredPenContacts(ignoredPenIds);

    expect(ownership.lostCapture({ pointerId: 21, pointerType: "pen" })).toMatchObject({
      action: "ignore",
      preventDefault: true,
      state: { activePenId: 20 }
    });
    expect(ownership.pointerUp({ pointerId: 20, pointerType: "pen" }).action).toBe("finalize-ink");
    expect(ownership.pointerDown({ pointerId: 21, pointerType: "pen", target: "page", inkToolSelected: true })).toMatchObject({
      action: "ignore",
      preventDefault: true,
      state: { activePenId: null, owner: "idle" }
    });
    expect(ownership.pointerMove({ pointerId: 21, pointerType: "pen", samples: ["must-not-ink"] })).toMatchObject({
      action: "ignore",
      preventDefault: true,
      persistSamples: []
    });
    expect(ownership.pointerUp({ pointerId: 21, pointerType: "pen" }).action).toBe("ignore");
    expect(ownership.pointerDown({ pointerId: 21, pointerType: "pen", target: "page", inkToolSelected: true }).action).toBe("claim-ink");
  });
});
