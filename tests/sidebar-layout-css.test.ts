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

  it("uses a fixed rail track and pins rail.is-right so the rail cannot stretch full-pane", () => {
    const chromeRule = styles.match(/(?:^|\n)\.native-pdf-handwriting-chrome \{([\s\S]*?)\n\}/)?.[1];
    const rightRule = styles.match(/\.native-pdf-handwriting-chrome\.is-toolbar-right \{([\s\S]*?)\n\}/)?.[1];
    const leftRule = styles.match(/\.native-pdf-handwriting-chrome\.is-toolbar-left \{([\s\S]*?)\n\}/)?.[1];
    const railRule = styles.match(/(?:^|\n)\.native-pdf-handwriting-rail \{([\s\S]*?)\n\}/)?.[1];
    const railRightRule = styles.match(/(?:^|\n)\.native-pdf-handwriting-rail\.is-right \{([\s\S]*?)\n\}/)?.[1];
    const viewerRightRule = styles.match(
      /\.native-pdf-handwriting-chrome\.is-toolbar-right > \.pdf-viewer-container,[\s\S]*?#viewerContainer \{([\s\S]*?)\n\}/
    )?.[1];
    expect(chromeRule).toContain("position: absolute");
    expect(chromeRule).toContain("--ink-rail-width: 44px");
    expect(rightRule).toContain("minmax(0, 1fr) var(--ink-rail-width)");
    expect(rightRule).not.toContain("max-content");
    expect(leftRule).toContain("var(--ink-rail-width) minmax(0, 1fr)");
    expect(leftRule).not.toMatch(/max-content/);
    expect(railRule).toContain("max-width: var(--ink-rail-width)");
    expect(railRightRule).toContain("grid-column: 2");
    expect(railRightRule).toContain("justify-self: end");
    expect(viewerRightRule).toContain("inset-inline-end: var(--ink-rail-width)");
    expect(viewerRightRule).toContain("width: auto");
  });
});
