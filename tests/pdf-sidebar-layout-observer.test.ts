import { describe, expect, it, vi } from "vitest";
import { PdfSidebarLayoutObserver } from "../src/integration/PdfSidebarLayoutObserver";

describe("PdfSidebarLayoutObserver", () => {
  it("observes mutations on sidebar and content containers and notifies callback", async () => {
    const host = document.createElement("div");
    const content = document.createElement("div");
    content.className = "pdf-content-container";
    const sidebar = document.createElement("div");
    sidebar.className = "pdf-sidebar-container";
    host.append(content, sidebar);
    document.body.append(host);

    const onLayout = vi.fn();
    const observer = new PdfSidebarLayoutObserver({
      host,
      getLayoutScope: () => host,
      onLayout
    });

    observer.install();

    // Toggle sidebarOpen class
    content.classList.add("sidebarOpen");

    await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
    expect(onLayout).toHaveBeenCalled();

    observer.disconnect();
    document.body.replaceChildren();
  });

  it("handles eventBus triggers and host click events", () => {
    const host = document.createElement("div");
    document.body.append(host);

    const listeners: Record<string, ((...args: unknown[]) => void) | undefined> = {};
    const eventBus = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
      },
      off: (event: string) => {
        delete listeners[event];
      }
    };

    const onLayout = vi.fn();
    const observer = new PdfSidebarLayoutObserver({
      host,
      getLayoutScope: () => host,
      onLayout,
      eventBus
    });

    observer.install();

    listeners["sidebarviewchanged"]?.();
    expect(onLayout).toHaveBeenCalledWith("sidebarviewchanged");

    listeners["togglesidebar"]?.();
    expect(onLayout).toHaveBeenCalledWith("togglesidebar");

    host.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLayout).toHaveBeenCalledWith("click");

    observer.disconnect();
    expect(Object.keys(listeners)).toHaveLength(0);
    document.body.replaceChildren();
  });
});
