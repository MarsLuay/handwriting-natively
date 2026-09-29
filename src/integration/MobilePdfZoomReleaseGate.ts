/**
 * Hold a temporary page-local zoom preview through a small number of display
 * frames after native PDF.js evidence arrives. This prevents a same-task
 * canvas/layout replacement from flashing during handoff.
 */
export function scheduleAfterDisplayFrames(
  view: Window | null | undefined,
  callback: () => void,
  frameCount = 2
): () => void {
  let remaining = Math.max(1, Math.floor(frameCount));
  let cancelled = false;
  let cancelCurrent: (() => void) | null = null;

  const schedule = (): void => {
    if (cancelled) return;
    if (view && view.requestAnimationFrame && view.cancelAnimationFrame) {
      const requestAnimationFrame = view.requestAnimationFrame.bind(view);
      const cancelAnimationFrame = view.cancelAnimationFrame.bind(view);
      const id = requestAnimationFrame(run);
      cancelCurrent = () => cancelAnimationFrame(id);
      return;
    }
    if (view) {
      const setTimeout = view.setTimeout.bind(view);
      const clearTimeout = view.clearTimeout.bind(view);
      const id = setTimeout(run, 16);
      cancelCurrent = () => clearTimeout(id);
      return;
    }
    if (typeof window !== "undefined") {
      const id = window.setTimeout(run, 16);
      cancelCurrent = () => window.clearTimeout(id);
    }
  };

  const run = (): void => {
    cancelCurrent = null;
    if (cancelled) return;
    remaining -= 1;
    if (remaining > 0) {
      schedule();
      return;
    }
    callback();
  };

  schedule();
  return () => {
    cancelled = true;
    cancelCurrent?.();
    cancelCurrent = null;
  };
}
