import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PullToAddPageGesture,
  PULL_TO_ADD_ARRIVAL_LOCKOUT_MS,
  PULL_TO_ADD_BOTTOM_FLING_DELTA_PX,
  PULL_TO_ADD_CUE_REVEAL_PX,
  PULL_TO_ADD_DEADZONE_PX,
  PULL_TO_ADD_INTAKE_GAIN,
  PULL_TO_ADD_MOMENTUM_DELTA_PX,
  PULL_TO_ADD_THRESHOLD_PX,
  applyPullIntake,
  effectivePullFromRaw,
  isBottomFlingTick,
  isMomentumScrollTick,
  isScrollAtBottom,
  pullProgressFromRaw,
  smoothPullToward,
  stretchPixelsForPull,
  visualPullFromRaw
} from "../src/input/PullToAddPageGesture";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("pull-to-add math", () => {
  it("treats short unscrolled documents as at bottom", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 400 });
    Object.defineProperty(root, "clientHeight", { value: 500 });
    Object.defineProperty(root, "scrollTop", { value: 0 });
    expect(isScrollAtBottom(root)).toBe(true);
  });

  it("detects the scroll bottom edge", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000 });
    Object.defineProperty(root, "clientHeight", { value: 800 });
    Object.defineProperty(root, "scrollTop", { value: 1198, writable: true });
    expect(isScrollAtBottom(root)).toBe(true);
    Object.defineProperty(root, "scrollTop", { value: 100 });
    expect(isScrollAtBottom(root)).toBe(false);
  });

  it("keeps a dead zone before the cue engages", () => {
    expect(effectivePullFromRaw(PULL_TO_ADD_DEADZONE_PX - 1)).toBe(0);
    expect(effectivePullFromRaw(PULL_TO_ADD_DEADZONE_PX + 10)).toBe(10);
    expect(pullProgressFromRaw(PULL_TO_ADD_DEADZONE_PX)).toBe(0);
    expect(pullProgressFromRaw(PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX / 2)).toBeCloseTo(0.5, 5);
    expect(pullProgressFromRaw(PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX)).toBe(1);
    expect(visualPullFromRaw(PULL_TO_ADD_DEADZONE_PX)).toBe(0);
    expect(visualPullFromRaw(PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX)).toBeGreaterThan(0);
    expect(visualPullFromRaw(PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX))
      .toBeLessThan(PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX);
  });

  it("opens enough stretch for the full ring+label once engaged", () => {
    expect(stretchPixelsForPull(0)).toBe(0);
    expect(stretchPixelsForPull(PULL_TO_ADD_DEADZONE_PX)).toBe(0);
    // Early engage: reveal is ramping, not a full 72px pop.
    const early = stretchPixelsForPull(PULL_TO_ADD_DEADZONE_PX + 8);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(PULL_TO_ADD_CUE_REVEAL_PX);
    // By ~36px past dead zone the cue reveal is full, plus rubber.
    const mid = stretchPixelsForPull(PULL_TO_ADD_DEADZONE_PX + 36);
    expect(mid).toBeGreaterThanOrEqual(PULL_TO_ADD_CUE_REVEAL_PX);
    expect(mid).toBeGreaterThan(36);
  });

  it("damps forward intake so casual ticks climb slowly", () => {
    expect(applyPullIntake(0, 100)).toBeCloseTo(100 * PULL_TO_ADD_INTAKE_GAIN, 5);
    expect(applyPullIntake(50, -20)).toBe(30);
  });

  it("lerps display pull toward the target", () => {
    expect(smoothPullToward(0, 100, 0.3)).toBeCloseTo(30, 5);
    expect(smoothPullToward(99.9, 100, 0.3)).toBe(100);
  });

  it("ignores pull-cue height when deciding if scroll is at the bottom", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 800 });
    Object.defineProperty(root, "scrollTop", { value: 1200 });
    expect(isScrollAtBottom(root)).toBe(true);

    const cue = document.createElement("div");
    cue.className = "native-pdf-handwriting-pull-add-page";
    Object.defineProperty(cue, "offsetHeight", { value: 80 });
    root.append(cue);
    Object.defineProperty(root, "scrollHeight", { value: 2080, configurable: true });
    expect(isScrollAtBottom(root)).toBe(true);
  });

  it("treats large/fast ticks as momentum", () => {
    expect(isMomentumScrollTick(PULL_TO_ADD_MOMENTUM_DELTA_PX, 0)).toBe(true);
    expect(isMomentumScrollTick(10, 3)).toBe(true);
    expect(isMomentumScrollTick(10, 0.2)).toBe(false);
    expect(isBottomFlingTick(PULL_TO_ADD_BOTTOM_FLING_DELTA_PX)).toBe(true);
    expect(isBottomFlingTick(PULL_TO_ADD_BOTTOM_FLING_DELTA_PX - 1)).toBe(false);
  });
});

describe("PullToAddPageGesture", () => {
  function mountScrollRoot(atBottom: boolean): HTMLElement {
    const root = document.createElement("div");
    root.className = "pdf-viewer-scroll-container";
    const viewer = document.createElement("div");
    viewer.className = "pdfViewer";
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    const canvas = document.createElement("canvas");
    page.append(canvas);
    viewer.append(page);
    root.append(viewer);
    document.body.append(root);
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(root, "scrollTop", { value: atBottom ? 1200 : 40, writable: true, configurable: true });
    root.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 800,
      right: 600,
      width: 600,
      height: 800,
      toJSON() { return {}; }
    });
    return root;
  }

  function feedRaw(gesture: PullToAddPageGesture, rawDelta: number): void {
    // Undo intake gain and feed in small ticks so tests don't look like flings.
    const needed = rawDelta / PULL_TO_ADD_INTAKE_GAIN;
    const step = Math.min(24, PULL_TO_ADD_MOMENTUM_DELTA_PX - 1);
    let left = needed;
    while (left > 0) {
      const chunk = Math.min(step, left);
      gesture.feedScrollAttempt(chunk, false);
      left -= chunk;
    }
  }

  /** Two timed ticks so approach-fast sees real px/ms, not a same-ms burst. */
  function feedFastApproach(gesture: PullToAddPageGesture): void {
    gesture.feedScrollAttempt(40, true);
    vi.advanceTimersByTime(16);
    gesture.feedScrollAttempt(80, true);
  }

  it("ignores casual overscroll inside the dead zone", () => {
    const root = mountScrollRoot(true);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX - 8);
    expect(gesture.snapshot().engaged).toBe(false);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
    gesture.feedScrollEnd();
    expect(committed).not.toHaveBeenCalled();
    gesture.destroy();
  });

  it("ignores high-speed momentum when slamming into the bottom", () => {
    vi.useFakeTimers();
    const root = mountScrollRoot(false);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    // Fast approach while not yet at bottom.
    feedFastApproach(gesture);
    expect(gesture.lockoutRemainingMs()).toBeGreaterThan(0);

    // Arrive at bottom with leftover fling ticks.
    Object.defineProperty(root, "scrollTop", { value: 1200, writable: true, configurable: true });
    gesture.feedScrollAttempt(90, false);
    expect(gesture.snapshot().engaged).toBe(false);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();

    // Even a medium overscroll burst during lockout must not arm.
    gesture.feedScrollAttempt(80, false);
    expect(gesture.snapshot().rawPull).toBe(0);
    expect(committed).not.toHaveBeenCalled();
    gesture.destroy();
  });

  it("does not re-arm lockout from ordinary ticks once settled at the bottom", () => {
    vi.useFakeTimers();
    const root = mountScrollRoot(false);
    const logs: Array<{ phase: string; details: Record<string, unknown> }> = [];
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: async () => undefined,
      onLog: (phase, details) => logs.push({ phase, details })
    });

    feedFastApproach(gesture);
    Object.defineProperty(root, "scrollTop", { value: 1200, writable: true, configurable: true });
    gesture.feedScrollAttempt(90, false);
    expect(gesture.lockoutRemainingMs()).toBeGreaterThan(0);
    vi.advanceTimersByTime(PULL_TO_ADD_ARRIVAL_LOCKOUT_MS + 20);

    // Deliberate medium ticks under the bottom-fling ceiling.
    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + 30);
    expect(gesture.lockoutRemainingMs()).toBe(0);
    expect(gesture.snapshot().engaged).toBe(true);
    expect(logs.some((entry) => entry.phase === "engage")).toBe(true);
    gesture.destroy();
  });

  it("allows a deliberate slow pull after momentum lockout settles", async () => {
    vi.useFakeTimers();
    const root = mountScrollRoot(false);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    feedFastApproach(gesture);
    Object.defineProperty(root, "scrollTop", { value: 1200, writable: true, configurable: true });
    gesture.feedScrollAttempt(90, false);
    expect(gesture.lockoutRemainingMs()).toBeGreaterThan(0);

    vi.advanceTimersByTime(PULL_TO_ADD_ARRIVAL_LOCKOUT_MS + 20);
    expect(gesture.lockoutRemainingMs()).toBe(0);

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + PULL_TO_ADD_THRESHOLD_PX + 8);
    expect(gesture.snapshot()).toEqual(expect.objectContaining({ armed: true, engaged: true }));
    gesture.feedScrollEnd();
    await vi.advanceTimersByTimeAsync(220);
    expect(committed).toHaveBeenCalledTimes(1);
    gesture.destroy();
  });

  it("rubber-bands from grab-pan overscroll and commits past the threshold", async () => {
    const root = mountScrollRoot(true);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + 40);
    expect(gesture.snapshot().armed).toBe(false);
    expect(gesture.snapshot().engaged).toBe(true);
    const cue = root.querySelector(".native-pdf-handwriting-pull-add-page");
    const lastPage = root.querySelector(".page");
    expect(cue).toBeTruthy();
    expect(cue?.previousElementSibling).toBe(lastPage);
    expect(root.querySelector(".pdfViewer")?.classList.contains("native-pdf-handwriting-pull-stretch")).toBe(true);

    feedRaw(gesture, PULL_TO_ADD_THRESHOLD_PX);
    expect(gesture.snapshot().armed).toBe(true);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")?.classList.contains("is-armed")).toBe(true);

    gesture.feedScrollEnd();
    await vi.waitFor(() => expect(committed).toHaveBeenCalledTimes(1));
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
    gesture.destroy();
  });

  it("springs back without committing when released early", () => {
    const root = mountScrollRoot(true);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + 20);
    expect(gesture.snapshot().engaged).toBe(true);
    gesture.feedScrollEnd();
    expect(committed).not.toHaveBeenCalled();
    gesture.destroy();
    expect(document.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
  });

  it("ignores downward scroll attempts while not at the bottom", () => {
    const root = mountScrollRoot(false);
    const committed = vi.fn(async () => undefined);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: committed
    });

    gesture.feedScrollAttempt(100, false);
    expect(gesture.snapshot().rawPull).toBe(0);
    expect(document.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
    gesture.destroy();
  });

  it("clears the cue when scroll leaves the bottom edge", () => {
    const root = mountScrollRoot(true);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: async () => undefined
    });

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + 40);
    expect(gesture.snapshot().engaged).toBe(true);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeTruthy();

    Object.defineProperty(root, "scrollTop", { value: 40, writable: true, configurable: true });
    gesture.feedScrollAttempt(30, true);
    expect(gesture.snapshot().rawPull).toBe(0);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
    gesture.destroy();
  });

  it("does not keep pulling after the edge is left mid-gesture", () => {
    const root = mountScrollRoot(true);
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: async () => undefined
    });

    feedRaw(gesture, PULL_TO_ADD_DEADZONE_PX + 40);
    expect(gesture.snapshot().engaged).toBe(true);

    Object.defineProperty(root, "scrollTop", { value: 40, writable: true, configurable: true });
    // Real scroll away from the edge drops the cue.
    gesture.feedScrollAttempt(30, true);
    expect(gesture.snapshot().rawPull).toBe(0);
    expect(root.querySelector(".native-pdf-handwriting-pull-add-page")).toBeNull();
    gesture.destroy();
  });

  it("accepts large trackpad ticks once settled at the bottom", () => {
    vi.useFakeTimers();
    const root = mountScrollRoot(true);
    const logs: Array<{ phase: string }> = [];
    const gesture = new PullToAddPageGesture(document, {
      enabled: () => true,
      scrollRoot: () => root,
      host: () => root,
      onCommit: async () => undefined,
      onLog: (phase) => logs.push({ phase })
    });

    // Mark settled at bottom (no arrival fling).
    gesture.feedScrollAttempt(10, false);
    expect(gesture.lockoutRemainingMs()).toBe(0);

    // Mac trackpad-sized deltas must intake, not re-arm bottom-fling lockout.
    gesture.feedScrollAttempt(PULL_TO_ADD_BOTTOM_FLING_DELTA_PX + 40, false);
    expect(gesture.lockoutRemainingMs()).toBe(0);
    expect(gesture.snapshot().rawPull).toBeGreaterThan(0);
    expect(logs.some((entry) => entry.phase === "lockout")).toBe(false);
    gesture.destroy();
  });
});
