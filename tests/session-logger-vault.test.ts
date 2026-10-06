import { describe, expect, it, vi } from "vitest";
import { SessionLogger } from "../src/logging/SessionLogger";
import type { VaultLogSink } from "../src/logging/VaultLogSink";

describe("SessionLogger vault sink", () => {
  it("mirrors console events into the vault log sink", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const writes: Array<{ level: string; event: string; payload: Record<string, unknown> }> = [];
    const sink: VaultLogSink = {
      write(level, event, payload = {}) {
        writes.push({ level, event, payload });
      }
    };
    const logger = new SessionLogger("Notes/example.pdf", sink);

    logger.keyboardShortcut({ command: "undo" });
    logger.zoomRepaint({
      reason: "view-scalechanging",
      durationMs: 3,
      pagesRepainted: 1,
      canvasesResized: 1,
      strokesRedrawn: 4,
      skippedDisconnected: 0
    });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      level: "info",
      event: "keyboard-shortcut",
      payload: { document: "Notes/example.pdf", command: "undo" }
    });
    expect(writes[1]?.event).toBe("ink zoom repaint");
    info.mockRestore();
  });
});
