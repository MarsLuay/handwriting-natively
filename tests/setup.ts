import { beforeEach } from "vitest";

beforeEach(() => {
  (globalThis as typeof globalThis & { activeDocument: Document; activeWindow: Window }).activeDocument =
    globalThis.document;
  (globalThis as typeof globalThis & { activeDocument: Document; activeWindow: Window }).activeWindow =
    globalThis.window;
});
