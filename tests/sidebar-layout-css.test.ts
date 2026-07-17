import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Vitest runs with cwd at the plugin package root. */
const styles = readFileSync("styles.css", "utf8");

describe("side toolbar viewport layout", () => {
  it("does not override Obsidian's inset-managed native viewport width", () => {
    const viewportRule = styles.match(/\.native-pdf-handwriting-chrome > \.pdf-viewer-scroll-container,[\s\S]*?\.native-pdf-handwriting-chrome > \.pdfViewer \{([\s\S]*?)\n\}/)?.[1];
    expect(viewportRule).toContain("min-width: 0");
    expect(viewportRule).not.toMatch(/^\s*width\s*:/m);
  });

  it("offsets only the left rail instead of padding the native PDF viewport", () => {
    const leftRule = styles.match(/\.native-pdf-handwriting-chrome\.is-toolbar-left \{([\s\S]*?)\n\}/)?.[1];
    const offsetRule = styles.match(/\.native-pdf-handwriting-chrome\.is-toolbar-left\[data-pdf-sidebar-offset\] > \.native-pdf-handwriting-rail \{([\s\S]*?)\n\}/)?.[1];
    expect(leftRule).not.toMatch(/padding-left\s*:/);
    expect(offsetRule).toContain("transform: translateX(var(--ink-pdf-sidebar-offset))");
  });
});
