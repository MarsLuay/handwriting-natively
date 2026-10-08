import { describe, expect, it, vi } from "vitest";
import { PointerRouter } from "../src/input/PointerRouter";

function pointerEvent(pointerType: "mouse" | "pen", pointerId: number): PointerEvent {
  const event = new Event("pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    button: { value: 0 },
    buttons: { value: 1 },
    pressure: { value: pointerType === "pen" ? 0.5 : 0 },
    isPrimary: { value: true },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    width: { value: 1 },
    height: { value: 1 },
    clientX: { value: 20 },
    clientY: { value: 24 },
    getCoalescedEvents: { value: () => [] }
  });
  return event;
}

function editorSurface(): { scroller: HTMLElement; content: HTMLElement } {
  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  const content = document.createElement("div");
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  scroller.append(content);
  document.body.append(scroller);
  return { scroller, content };
}

describe("Markdown editing input routing", () => {
  it("leaves CodeMirror input native unless a Markdown surface opts into annotation", () => {
    const { scroller, content } = editorSurface();
    const onStart = vi.fn();
    const rejected = vi.fn();
    const nativeRouter = new PointerRouter(scroller, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      onStart,
      onPointerRejected: rejected
    });

    const nativeEvent = pointerEvent("pen", 1);
    content.dispatchEvent(nativeEvent);
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith("annotation-chrome", nativeEvent, nativeRouter.generation);
    nativeRouter.destroy();

    const drawingRouter = new PointerRouter(scroller, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      allowEditableAnnotationTarget: (event) => event.target instanceof Element
        && scroller.contains(event.target)
        && Boolean(event.target.closest(".cm-content[contenteditable='true']")),
      onStart
    });
    const drawingEvent = pointerEvent("pen", 2);
    content.dispatchEvent(drawingEvent);
    expect(drawingEvent.defaultPrevented).toBe(true);
    expect(onStart).toHaveBeenCalledOnce();
    drawingRouter.destroy();
    scroller.remove();
  });

  it("keeps mouse selection native when mouse annotation is disabled", () => {
    const { scroller, content } = editorSurface();
    const onStart = vi.fn();
    const router = new PointerRouter(scroller, {
      activeTool: () => "pen",
      canAnnotatePointer: () => true,
      mouseInkingEnabled: () => false,
      allowEditableAnnotationTarget: (event) => event.target instanceof Element
        && scroller.contains(event.target)
        && Boolean(event.target.closest(".cm-content[contenteditable='true']")),
      onStart
    });

    const event = pointerEvent("mouse", 3);
    content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    router.destroy();
    scroller.remove();
  });
});
