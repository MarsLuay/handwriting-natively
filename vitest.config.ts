import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Local `tsc` artifacts can sit beside source while debugging. Resolve the
  // authored TypeScript first so tests never exercise a stale sibling `.js`.
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url))
    },
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"]
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true
  }
});
