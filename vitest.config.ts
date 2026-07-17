import { defineConfig } from "vitest/config";

export default defineConfig({
  // Local `tsc` artifacts can sit beside source while debugging. Resolve the
  // authored TypeScript first so tests never exercise a stale sibling `.js`.
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"]
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true
  }
});
