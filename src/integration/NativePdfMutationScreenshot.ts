interface NativeImageLike {
  isEmpty?(): boolean;
  toDataURL?(): string;
}

interface WebContentsLike {
  capturePage?(rect: { x: number; y: number; width: number; height: number }): Promise<NativeImageLike>;
}

interface BrowserWindowLike {
  webContents?: WebContentsLike;
}

interface ElectronRemoteLike {
  getCurrentWebContents?(): WebContentsLike;
  getCurrentWindow?(): BrowserWindowLike;
}

interface ElectronCaptureWindow extends Window {
  electron?: { remote?: ElectronRemoteLike };
}

export interface NativePdfMutationScreenshot {
  dataUrl: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type NativePdfMutationScreenshotResult =
  | { kind: "captured"; screenshot: NativePdfMutationScreenshot }
  | { kind: "skipped"; reason: string };

/**
 * Electron captures the composited renderer surface, including PDF.js page
 * backgrounds, text layers, and the viewer's scroll chrome. Canvas copies
 * alone cannot cover that container-level teardown during a source-PDF swap.
 */
export async function captureNativePdfMutationScreenshot(host: HTMLElement): Promise<NativePdfMutationScreenshotResult> {
  const view = host.ownerDocument.defaultView as ElectronCaptureWindow | null;
  const remote = view?.electron?.remote;
  const webContents = remote?.getCurrentWebContents?.() ?? remote?.getCurrentWindow?.()?.webContents;
  if (!view || !webContents?.capturePage) return { kind: "skipped", reason: "electron-capture-unavailable" };

  const hostRect = host.getBoundingClientRect();
  const left = Math.max(0, Math.floor(hostRect.left));
  const top = Math.max(0, Math.floor(hostRect.top));
  const right = Math.min(view.innerWidth, Math.ceil(hostRect.right));
  const bottom = Math.min(view.innerHeight, Math.ceil(hostRect.bottom));
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 8) return { kind: "skipped", reason: "host-not-visible" };

  try {
    const image = await webContents.capturePage({ x: left, y: top, width, height });
    if (image.isEmpty?.()) return { kind: "skipped", reason: "capture-empty" };
    const dataUrl = image.toDataURL?.();
    if (!dataUrl?.startsWith("data:image/")) return { kind: "skipped", reason: "capture-data-unavailable" };
    return { kind: "captured", screenshot: { dataUrl, left, top, width, height } };
  } catch (error) {
    return { kind: "skipped", reason: `capture-failed:${error instanceof Error ? error.name : "unknown"}` };
  }
}
