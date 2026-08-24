import { describe, expect, it, vi } from "vitest";
import { PointerRouter } from "../src/input/PointerRouter";
import { ViewerMousePan, type MousePanPhase } from "../src/input/ViewerMousePan";

function pointer(type: string, pointerId: number, extra: Record<string, unknown> = {}): PointerEvent {
  const event = new Event(extra.eventType as string || "pointerdown", { bubbles: true, cancelable: true });
  const eventExtra = { pointerType: type, pointerId, button: 0, buttons: 1, ...extra };
  Object.assign(event, eventExtra);
  return event as PointerEvent;
}

describe("Combined Integration", () => {
  it("Draw off + blank-area drag routes correctly without multiple pans", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    let scrollTop = 100;
    Object.defineProperty(root, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });

    const page = document.createElement("div");
    root.append(page);
    document.body.append(root);

    Object.assign(page, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });

    const pointerRoutes: string[] = [];
    const router = new PointerRouter(page, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => root,
      onRoute: (route) => pointerRoutes.push(route)
    });

    const panPhases: MousePanPhase[] = [];
    const viewerPan = new ViewerMousePan(root, {
      enabled: () => true,
      touchPanEnabled: () => false,
      scrollRoot: () => root,
      withinTarget: () => true,
      captureElement: () => root,
      onPan: (phase) => panPhases.push(phase)
    });

    const downEvent = pointer("mouse", 42, { clientX: 10, clientY: 100 });
    page.dispatchEvent(downEvent);

    expect(pointerRoutes.at(-1)).toBe("native");
    expect(page.setPointerCapture).not.toHaveBeenCalled();
    expect(downEvent.defaultPrevented).toBe(false);

    const moveEvent = pointer("mouse", 42, { eventType: "pointermove", clientX: 10, clientY: 150 });
    page.dispatchEvent(moveEvent);

    expect(panPhases).toContain("activate");
    expect(scrollTop).toBe(50);

    router.destroy();
    viewerPan.destroy();
    root.remove();
  });
});
