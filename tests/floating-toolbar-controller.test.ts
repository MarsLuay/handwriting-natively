import { describe, expect, it, vi } from "vitest";
import { FloatingToolbarController } from "../src/runtime/FloatingToolbarController";

describe("FloatingToolbarController", () => {
  it("mounts toolbar into a portal with drag handle and applies orientation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const toolbar = document.createElement("div");

    let currentOrientation: "horizontal" | "vertical" = "horizontal";
    const persistSpy = vi.fn();

    const controller = new FloatingToolbarController({
      host,
      toolbar,
      initialPosition: { left: 100, top: 50 },
      getOrientation: () => currentOrientation,
      onPositionPersist: persistSpy
    });

    expect(controller.getPortal()).toBeNull();
    controller.mount();

    const portal = controller.getPortal();
    expect(portal).not.toBeNull();
    expect(portal?.isConnected).toBe(true);
    expect(portal?.classList.contains("native-pdf-handwriting-toolbar-portal")).toBe(true);
    expect(toolbar.parentElement).toBe(portal);
    expect(toolbar.classList.contains("native-pdf-handwriting-toolbar-floating-fallback")).toBe(true);
    expect(toolbar.classList.contains("is-horizontal")).toBe(true);

    const handle = toolbar.querySelector(".native-pdf-handwriting-toolbar-drag-handle");
    expect(handle).not.toBeNull();

    // Toggle orientation
    currentOrientation = "vertical";
    const changed = controller.applyOrientation();
    expect(changed).toBe(true);
    expect(toolbar.classList.contains("is-vertical")).toBe(true);
    expect(toolbar.classList.contains("is-horizontal")).toBe(false);

    // Update position
    controller.setPosition({ left: 200, top: 120 });
    expect(controller.getPosition()).toEqual({ left: 200, top: 120 });

    // Destroy
    controller.destroy();
    expect(portal?.isConnected).toBe(false);
    expect(controller.getPortal()).toBeNull();
    expect(toolbar.querySelector(".native-pdf-handwriting-toolbar-drag-handle")).toBeNull();
    expect(toolbar.classList.contains("native-pdf-handwriting-toolbar-floating-fallback")).toBe(false);

    host.remove();
  });
});
