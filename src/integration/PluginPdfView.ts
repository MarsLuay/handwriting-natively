import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";
import type { ViewerInkSession } from "../runtime/ViewerInkSession";
import type { AnnotationSurfaceCallbacks } from "../runtime/AnnotationSurface";
import { PdfJsViewAdapter } from "./PdfJsViewAdapter";

export const PLUGIN_PDF_VIEW_TYPE = "handwriting-natively-pdf";

export interface PluginPdfViewOptions {
  pluginDir: string;
  createAdapter(file: TFile, host: HTMLElement, callbacks: AnnotationSurfaceCallbacks, view: PluginPdfView): Promise<PdfJsViewAdapter>;
  createSession(file: TFile, adapter: PdfJsViewAdapter, view: PluginPdfView): Promise<ViewerInkSession>;
  onSessionAttached?(view: PluginPdfView, session: ViewerInkSession): void;
  onSessionDetached?(view: PluginPdfView, session: ViewerInkSession, reason: string): void;
  onFallbackToNative?(view: PluginPdfView, file: TFile, error: unknown): void;
  onDiagnostic?(event: string, payload: Record<string, unknown>): void;
}

function pathFromState(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const file = (state as { file?: unknown }).file;
  return typeof file === "string" && file.trim() ? file.trim() : undefined;
}

/** Public Obsidian ItemView wrapper; private PDF.js details stay in the adapter. */
export class PluginPdfView extends ItemView {
  readonly navigation = true;
  file: TFile | null = null;
  private readonly options: PluginPdfViewOptions;
  private adapter: PdfJsViewAdapter | null = null;
  private session: ViewerInkSession | null = null;
  private opened = false;
  private loadGeneration = 0;
  private state: Record<string, unknown> = {};

  constructor(leaf: WorkspaceLeaf, options: PluginPdfViewOptions) {
    super(leaf);
    this.options = options;
    this.icon = "file-text";
    this.containerEl.addClass("hn-owned-pdf-view-container");
  }

  getViewType(): string { return PLUGIN_PDF_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename || this.file?.name || "PDF"; }
  getIcon(): string { return "file-text"; }

  getState(): Record<string, unknown> {
    return {
      ...this.state,
      ...(this.file ? { file: this.file.path } : {}),
      ...(this.adapter ? { viewer: this.adapter.getViewState() } : {})
    };
  }

  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    this.state = state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
    const path = pathFromState(state);
    if (path && this.opened) await this.loadFile(path, result.history ? "navigation" : "restore");
  }

  protected async onOpen(): Promise<void> {
    this.opened = true;
    const path = pathFromState(this.state) || pathFromState(this.leaf.getViewState().state) || this.file?.path;
    if (path) await this.loadFile(path, "open");
    else this.renderError("No PDF file was supplied to the plugin-owned viewer.");
  }

  protected async onClose(): Promise<void> {
    this.opened = false;
    this.loadGeneration += 1;
    await this.closeDocument("view-close");
  }

  onResize(): void { this.adapter?.onResize(); }

  private async loadFile(path: string, reason: string): Promise<void> {
    const generation = ++this.loadGeneration;
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile) || abstract.extension.toLowerCase() !== "pdf") {
      this.renderError(`Cannot open PDF: ${path}`);
      return;
    }
    await this.closeDocument("replace");
    if (!this.opened || generation !== this.loadGeneration) return;
    this.file = abstract;
    this.state = { ...this.state, file: abstract.path };
    let adapter: PdfJsViewAdapter | null = null;
    try {
      adapter = await this.options.createAdapter(abstract, this.contentEl, this.callbacks(), this);
      if (!this.opened || generation !== this.loadGeneration) { adapter.destroy(); return; }
      const session = await this.options.createSession(abstract, adapter, this);
      if (!this.opened || generation !== this.loadGeneration) { await session.destroy({ silent: true }); adapter.destroy(); return; }
      this.adapter = adapter;
      this.session = session;
      this.options.onSessionAttached?.(this, session);
      const viewer = this.state.viewer;
      if (viewer && typeof viewer === "object") this.adapter.restoreViewState(viewer as Parameters<PdfJsViewAdapter["restoreViewState"]>[0]);
      this.options.onDiagnostic?.("owned-pdf-view-ready", { document: abstract.path, reason });
    } catch (error) {
      adapter?.destroy();
      if (this.adapter && this.adapter !== adapter) this.adapter.destroy();
      this.adapter = null;
      this.session = null;
      if (!this.opened || generation !== this.loadGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      this.options.onDiagnostic?.("owned-pdf-view-failed", { document: abstract.path, reason, error: message });
      this.renderError(message);
      this.options.onFallbackToNative?.(this, abstract, error);
    }
  }

  private callbacks(): AnnotationSurfaceCallbacks {
    return {
      onViewStateChange: (state, source) => { this.state = { ...this.state, viewer: state }; this.session?.onViewStateChange(state, source); },
      onPagesChanged: (reason) => this.session?.onPagesChanged(reason),
      onPageLifecycleChange: (change) => this.session?.onPageLifecycleChange(change),
      onZoomChange: (change) => this.session?.onZoomChange(change),
      onPageContentMutationTrace: (change) => this.session?.onPdfPageContentMutation(change),
      onCompatibilityWarning: (message) => this.options.onDiagnostic?.("owned-pdf-compatibility-warning", { message }),
      onDebugLog: (level, event, payload) => this.options.onDiagnostic?.(event, { level, ...(payload ?? {}) })
    };
  }

  private async closeDocument(reason: string): Promise<void> {
    const session = this.session;
    const adapter = this.adapter;
    this.session = null;
    this.adapter = null;
    if (session) {
      this.options.onSessionDetached?.(this, session, reason);
      await session.destroy({ silent: reason !== "view-close", alreadyPersisted: false }).catch((error) => {
        this.options.onDiagnostic?.("owned-pdf-session-close-failed", { document: this.file?.path ?? null, reason, error: error instanceof Error ? error.message : String(error) });
      });
    } else adapter?.destroy();
    this.options.onDiagnostic?.("owned-pdf-view-close", { document: this.file?.path ?? null, reason });
  }

  private renderError(message: string): void {
    this.contentEl.replaceChildren();
    const error = this.contentEl.createDiv({ cls: "hn-owned-pdf-error" });
    error.createEl("h2", { text: "Plugin-owned PDF viewer unavailable" });
    error.createEl("p", { text: message });
    const button = error.createEl("button", { text: "Use Obsidian PDF viewer" });
    button.addEventListener("click", () => { if (this.file) this.options.onFallbackToNative?.(this, this.file, new Error(message)); });
  }
}
