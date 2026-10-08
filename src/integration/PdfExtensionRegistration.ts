import type { App } from "obsidian";

interface PdfViewRegistry {
  getTypeByExtension(extension: string): string | undefined;
  registerExtensions(extensions: string[], viewType: string): void;
  unregisterExtensions(extensions: string[]): void;
}

interface AppWithPdfViewRegistry extends App {
  viewRegistry?: PdfViewRegistry;
}

/**
 * Obsidian's public Plugin.registerExtensions refuses the core-owned `pdf`
 * extension. Replace that one registry entry and restore its exact owner on
 * unload, keeping all undocumented access in src/integration/.
 */
export function replaceDefaultPdfViewRegistration(app: App, pluginViewType: string): () => void {
  const registry = (app as AppWithPdfViewRegistry).viewRegistry;
  if (
    !registry ||
    typeof registry.getTypeByExtension !== "function" ||
    typeof registry.registerExtensions !== "function" ||
    typeof registry.unregisterExtensions !== "function"
  ) throw new Error("Obsidian PDF view registry is unavailable");

  const previousViewType = registry.getTypeByExtension("pdf");
  if (previousViewType !== "pdf") {
    throw new Error(`Cannot claim PDF extension; expected Obsidian's native pdf view, found ${previousViewType ?? "no owner"}`);
  }

  registry.unregisterExtensions(["pdf"]);
  try {
    registry.registerExtensions(["pdf"], pluginViewType);
  } catch (error) {
    registry.registerExtensions(["pdf"], previousViewType);
    throw error;
  }

  return () => {
    if (registry.getTypeByExtension("pdf") !== pluginViewType) return;
    registry.unregisterExtensions(["pdf"]);
    registry.registerExtensions(["pdf"], previousViewType);
  };
}
