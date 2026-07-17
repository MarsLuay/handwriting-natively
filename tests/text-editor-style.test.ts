import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Vitest runs with cwd at the plugin package root. */
const styles = readFileSync("styles.css", "utf8");

describe("text editor styles", () => {
  it("keeps the active text editor transparent in every Obsidian theme", () => {
    const editorRules = [...styles.matchAll(/\.native-pdf-handwriting-text-input\s*\{(?<body>[^}]*)\}/gs)];
    const editorRule = editorRules.at(-1);
    expect(editorRule?.groups?.body).toContain("background: transparent");
    expect(editorRule?.groups?.body).not.toContain("--background-primary");
  });

  it("uses a theme-safe native caret and text cursor", () => {
    const editorRules = [...styles.matchAll(/\.native-pdf-handwriting-text-input\s*\{(?<body>[^}]*)\}/gs)];
    const editorRule = editorRules.at(-1);
    expect(editorRule?.groups?.body).toContain("caret-color: currentColor");
    expect(editorRule?.groups?.body).toContain("cursor: text");
    expect(editorRule?.groups?.body).toContain("z-index: 3");
  });

  it("uses only a dotted editor boundary, never the solid blue browser-style frame", () => {
    const editorRules = [...styles.matchAll(/\.native-pdf-handwriting-text-input\s*\{(?<body>[^}]*)\}/gs)];
    const editorRule = editorRules.at(-1);
    expect(styles).toContain("--native-pdf-handwriting-text-interaction-border: 1px dotted var(--interactive-accent, #2563eb)");
    expect(editorRule?.groups?.body).toContain("border: var(--native-pdf-handwriting-text-interaction-border)");
    expect(editorRule?.groups?.body).not.toContain("border: 1px solid");
    expect(editorRule?.groups?.body).toContain("box-shadow: none");
  });

  it("uses one dotted boundary with NPDE-style resize dots instead of a browser resize grip", () => {
    expect(styles).toContain(".native-pdf-handwriting-text-selection-frame");
    expect(styles).toContain(".native-pdf-handwriting-text-resize-nw");
    expect(styles).toContain("border-radius: 50%");
    expect(styles).toContain(".native-pdf-handwriting-text-box.is-editable:hover .native-pdf-handwriting-text-selection-frame");
    expect(styles).toContain(".native-pdf-handwriting-text-box.is-selected .native-pdf-handwriting-text-selection-frame");
    expect(styles).toMatch(/\.native-pdf-handwriting-text-selection-frame\s*\{[^}]*border:\s*var\(--native-pdf-handwriting-text-interaction-border\);/s);
    const editorRules = [...styles.matchAll(/\.native-pdf-handwriting-text-input\s*\{(?<body>[^}]*)\}/gs)];
    expect(editorRules.at(-1)?.groups?.body).toContain("resize: none");
  });
});
