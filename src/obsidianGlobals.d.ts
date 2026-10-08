/** Obsidian injects these for popout-window compatibility. */
declare const activeDocument: Document;
declare const activeWindow: Window;

declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
