import { describe, expect, it, vi } from "vitest";
import { canAnnotatePointer } from "../src/input/annotationInputPolicy";
import { GestureOwnership } from "../src/input/GestureOwnership";
import { PointerRouter } from "../src/input/PointerRouter";
import type { ToolId } from "../src/model";

function pointer(
  type: string,
  pointerType: "pen" | "touch" | "mouse",
  pointerId: number,
  extra: Record<string, unknown> = {}
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    button: { value: extra.button ?? 0 },
    buttons: { value: extra.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : 1) },
    pressure: { value: extra.pressure ?? (pointerType === "pen" ? 0.5 : 0.5) },
    isPrimary: { value: extra.isPrimary ?? true },
    tiltX: { value: extra.tiltX ?? 0 },
    tiltY: { value: extra.tiltY ?? 0 },
    width: { value: extra.width ?? 1 },
    height: { value: extra.height ?? 1 },
    clientX: { value: extra.clientX ?? 10 },
    clientY: { value: extra.clientY ?? 20 },
    timeStamp: { value: extra.timeStamp ?? 1 },
    getCoalescedEvents: { value: extra.getCoalescedEvents ?? (() => []) },
    getPredictedEvents: { value: extra.getPredictedEvents ?? (() => []) }
  });
  return event;
}

describe("deterministic gesture ownership matrix", () => {
  it("emits one canonical action per pen contact and keeps predicted samples ephemeral", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const handled = new Map<number, number>();
    const starts = vi.fn();
    const moves = vi.fn();
    const predicted = vi.fn();
    const ends = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      isPointerHandled: (pointerId) => handled.has(pointerId),
      onPointerHandled: (pointerId, generation) => handled.set(pointerId, generation),
      onPointerOwnerReleased: (generation) => {
        for (const [pointerId, ownerGeneration] of handled) {
          if (ownerGeneration === generation) handled.delete(pointerId);
        }
      },
      onStart: starts,
      onMove: moves,
      onPredictedMove: predicted,
      onEnd: ends
    });

    const down = pointer("pointerdown", "pen", 7, { timeStamp: 1 });
    element.dispatchEvent(down);
    // The document fallback may see the same physical down; it must not start a second stroke.
    expect(router.acceptPointerDown(down)).toBe("ignored");
    expect(starts).toHaveBeenCalledTimes(1);

    const coalescedA = pointer("pointermove", "pen", 7, { clientX: 20, clientY: 30, pressure: 0.2, timeStamp: 2 });
    const coalescedB = pointer("pointermove", "pen", 7, { clientX: 30, clientY: 40, pressure: 0.7, timeStamp: 3 });
    const predictedPoint = pointer("pointermove", "pen", 7, { clientX: 40, clientY: 50, pressure: 0.8, timeStamp: 4 });
    const move = pointer("pointermove", "pen", 7, {
      clientX: 35,
      clientY: 45,
      pressure: 0.8,
      timeStamp: 4,
      getCoalescedEvents: () => [coalescedA, coalescedB],
      getPredictedEvents: () => [predictedPoint]
    });
    element.dispatchEvent(move);
    // The page and document paths can both observe one PointerEvent, but only one appends it.
    expect(router.acceptDocumentPenStroke(move)).toBe(true);
    expect(moves).toHaveBeenCalledTimes(1);
    expect(moves.mock.calls[0]?.[0].map((sample: PointerEvent) => sample.clientX)).toEqual([20, 30, 35]);
    expect(predicted).toHaveBeenCalledTimes(1);
    expect(predicted.mock.calls[0]?.[0].map((sample: PointerEvent) => sample.clientX)).toEqual([40]);
    expect(moves.mock.calls[0]?.[0]).not.toContainEqual(expect.objectContaining({ clientX: 40 }));

    element.dispatchEvent(pointer("pointerup", "pen", 7, { timeStamp: 5 }));
    expect(ends).toHaveBeenCalledTimes(1);
    expect(router.activeRoutedPointerIds()).toEqual([]);
    router.destroy();
    element.remove();
  });

  it("keeps fingers native, blocks a companion palm, and preserves two-touch pinch ownership", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      onRoute: (route) => routes.push(route),
      onStart: starts
    });

    element.dispatchEvent(pointer("pointerdown", "pen", 20));
    const companion = pointer("pointerdown", "touch", 21, { width: 64, height: 64 });
    element.dispatchEvent(companion);
    expect(routes.at(-1)).toBe("ignored");
    expect(companion.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledTimes(1);

    element.dispatchEvent(pointer("pointerup", "touch", 21));
    element.dispatchEvent(pointer("pointerup", "pen", 20));
    const firstFinger = pointer("pointerdown", "touch", 30);
    const secondFinger = pointer("pointerdown", "touch", 31, { isPrimary: false });
    element.dispatchEvent(firstFinger);
    element.dispatchEvent(secondFinger);
    expect(routes.slice(-2)).toEqual(["touch-pan", "touch-zoom-pan"]);
    expect(firstFinger.defaultPrevented).toBe(false);
    expect(secondFinger.defaultPrevented).toBe(false);

    element.dispatchEvent(pointer("pointerup", "touch", 30));
    element.dispatchEvent(pointer("pointerup", "touch", 31, { isPrimary: false }));
    expect(router.activeTouchPointerIds()).toEqual([]);
    router.destroy();
    element.remove();
  });

  it("gates touch fallback until explicitly enabled and never after stylus promotion", () => {
    expect(canAnnotatePointer({ pointerType: "touch" }, {
      mouseInkingEnabled: false,
      touchDrawFallback: false,
      stylusConfirmed: false
    })).toBe(false);
    expect(canAnnotatePointer({ pointerType: "touch" }, {
      mouseInkingEnabled: false,
      touchDrawFallback: true,
      stylusConfirmed: false
    })).toBe(true);
    expect(canAnnotatePointer({ pointerType: "touch" }, {
      mouseInkingEnabled: false,
      touchDrawFallback: true,
      stylusConfirmed: true
    })).toBe(false);

    const element = document.createElement("div");
    document.body.append(element);
    let fallback = false;
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen" || (event.pointerType === "touch" && fallback),
      touchAnnotationEnabled: () => fallback,
      onRoute: (route) => routes.push(route),
      onStart: starts
    });

    element.dispatchEvent(pointer("pointerdown", "touch", 40));
    expect(routes.at(-1)).toBe("touch-pan");
    fallback = true;
    element.dispatchEvent(pointer("pointerup", "touch", 40));
    element.dispatchEvent(pointer("pointerdown", "touch", 41));
    expect(routes.at(-1)).toBe("draw");
    expect(starts).toHaveBeenCalledTimes(1);
    element.dispatchEvent(pointer("pointerup", "touch", 41));
    router.destroy();
    element.remove();
  });

  it("cleans cancelled and lifecycle-owned gestures without leaking the next generation", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const cancels = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      onCancel: cancels,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("pointerdown", "pen", 50));
    element.dispatchEvent(pointer("lostpointercapture", "pen", 50));
    // Pen capture loss is not a lift; a later document pointerup still owns the terminal action.
    expect(router.activeRoutedPointerIds()).toEqual([50]);
    document.dispatchEvent(pointer("pointerup", "pen", 50));
    expect(router.activeRoutedPointerIds()).toEqual([]);

    element.dispatchEvent(pointer("pointerdown", "pen", 51));
    window.dispatchEvent(new Event("blur"));
    expect(cancels).toHaveBeenCalledTimes(1);
    expect(router.activePenIds()).toEqual([]);
    expect(router.gesturePolicy().touchNoneClassPresent).toBe(false);
    router.destroy();
    element.remove();
  });

  it("rejects UI targets, leaves non-inking mouse input native, and switches drawing tools without a Draw toggle", () => {
    const ownership = new GestureOwnership();
    const nativeMouse = ownership.pointerDown({ pointerId: 60, pointerType: "mouse", target: "page", buttons: 1 });
    expect(nativeMouse.state.owner).toBe("idle");
    expect(nativeMouse.preventDefault).toBe(false);

    const element = document.createElement("div");
    const button = document.createElement("button");
    element.append(button);
    document.body.append(element);
    let tool: ToolId = "pen";
    const routes: string[] = [];
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      canAnnotatePointer: (event) => event.pointerType === "pen" || event.pointerType === "mouse",
      onRoute: (route) => routes.push(route),
      onStart: starts
    });

    const uiDown = pointer("pointerdown", "pen", 61);
    button.dispatchEvent(uiDown);
    expect(uiDown.defaultPrevented).toBe(false);
    expect(starts).not.toHaveBeenCalled();

    element.dispatchEvent(pointer("pointerdown", "pen", 62));
    expect(routes.at(-1)).toBe("draw");
    tool = "eraser";
    router.syncToolState();
    element.dispatchEvent(pointer("pointerup", "pen", 62));
    element.dispatchEvent(pointer("pointerdown", "pen", 63, { button: 0 }));
    expect(routes.at(-1)).toBe("edit");
    expect(starts).toHaveBeenCalledTimes(2);

    router.destroy();
    element.remove();
  });

  it("lets a replacement router reuse a pointer id after the old generation is destroyed", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const handled = new Map<number, number>();
    const starts = vi.fn();
    const createRouter = (): PointerRouter => new PointerRouter(element, {
      activeTool: () => "pen",
      canAnnotatePointer: (event) => event.pointerType === "pen",
      isPointerHandled: (pointerId) => handled.has(pointerId),
      onPointerHandled: (pointerId, generation) => handled.set(pointerId, generation),
      onPointerOwnerReleased: (generation) => {
        for (const [pointerId, ownerGeneration] of handled) {
          if (ownerGeneration === generation) handled.delete(pointerId);
        }
      },
      onStart: starts
    });

    const first = createRouter();
    first.acceptPointerDown(pointer("pointerdown", "pen", 70));
    first.destroy();
    const second = createRouter();
    second.acceptPointerDown(pointer("pointerdown", "pen", 70));
    expect(starts).toHaveBeenCalledTimes(2);
    expect(second.generation).toBeGreaterThan(first.generation);
    second.destroy();
    element.remove();
  });
});
