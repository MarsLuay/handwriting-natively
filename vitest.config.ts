import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  // Agent worktrees can live under `.git/modules/...`; allow Vite to read this tree.
  server: {
    fs: {
      strict: false,
      allow: [rootDir]
    }
  },
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
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true
  }
});
