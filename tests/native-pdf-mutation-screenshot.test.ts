import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativePdfMutationScreenshot } from "../src/integration/NativePdfMutationScreenshot";

const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

afterEach(() => {
  document.body.replaceChildren();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else Reflect.deleteProperty(window, "electron");
});

describe("native PDF mutation screenshot", () => {
  it("captures the composited visible PDF host through Electron", async () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 24.25, top: 48.75, right: 624.5, bottom: 648.25, width: 600.25, height: 599.5, x: 24.25, y: 48.75, toJSON: () => ({}) })
    });
    document.body.append(host);
    const capturePage = vi.fn().mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,shield"
    });
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { remote: { getCurrentWebContents: () => ({ capturePage }) } }
    });

    await expect(captureNativePdfMutationScreenshot(host)).resolves.toEqual({
      kind: "captured",
      screenshot: {
        dataUrl: "data:image/png;base64,shield",
        left: 24,
        top: 48,
        width: 601,
        height: 601
      }
    });
    expect(capturePage).toHaveBeenCalledWith({ x: 24, y: 48, width: 601, height: 601 });
  });

  it("falls back cleanly when Electron capture is unavailable", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await expect(captureNativePdfMutationScreenshot(host)).resolves.toEqual({
      kind: "skipped",
      reason: "electron-capture-unavailable"
    });
  });
});
