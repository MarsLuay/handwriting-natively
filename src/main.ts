import {
  FileView,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  apiVersion,
  normalizePath,
  type WorkspaceLeaf
} from "obsidian";
import type { SelectionShortcutAction } from "./input/SelectionShortcuts";
import { EmbeddedPdfAdapter } from "./integration/EmbeddedPdfAdapter";
import { NativePdfViewAdapter } from "./integration/NativePdfViewAdapter";
import type { ObsidianPdfAdapter, PdfAdapterCallbacks } from "./integration/ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./integration/PdfViewerCompatibility";
import { describePdfPageDom } from "./integration/pdfPageSelectors";
import { EmbedAnnotateChrome, findExistingEmbedChrome } from "./focus-view/EmbedAnnotateChrome";
import { resolvePdfFileFromEmbed } from "./focus-view/embedFocusHelpers";
import { ViewerInkSession } from "./runtime/ViewerInkSession";
import { AttachRetryPolicy } from "./runtime/AttachRetryPolicy";
import { ScanDebounce } from "./runtime/ScanDebounce";
import { VaultDebugLog } from "./logging/VaultDebugLog";
import {
  createGoodNotesNotebook,
  createPdfFromTemplate,
  deletePdfPages,
  insertMatchingBlankPage
} from "./pdf/PdfNoteService";
import { mergeSettings, NativePdfInkSettingTab } from "./settings";
import { RecoveryRepository } from "./storage/RecoveryRepository";
import { createDocumentIdentity } from "./storage/DocumentIdentity";
import { insertPageIntoSidecar, removePageFromSidecar } from "./storage/SidecarPageRemoval";
import { SidecarRepository } from "./storage/SidecarRepository";
import type { CloseChoice } from "./storage/SaveCoordinator";
import type { PluginSettings, ToolPreferences } from "./model";
import { createVaultFsTextAdapter, createVaultSyncWriter } from "./storage/VaultFs";
import { parsePageRanges } from "./util/parsePageRanges";

class UnsavedChangesModal extends Modal {
  private readonly abort = new AbortController();
  constructor(
    app: NativePdfInkPlugin["app"],
    private readonly resolveChoice: (choice: CloseChoice) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Save PDF annotations?");
    this.contentEl.createEl("p", {
      text: "This PDF has unsaved handwriting. Save it, discard it, or keep the view open."
    });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    for (const [label, choice, className] of [
      ["Save", "save", "mod-cta"],
      ["Discard", "discard", "mod-warning"],
      ["Cancel", "cancel", ""]
    ] as const) {
      const button = actions.createEl("button", { text: label, cls: className });
      button.addEventListener("click", () => {
        this.resolveChoice(choice);
        this.close();
      }, { signal: this.abort.signal });
    }
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.empty();
  }
}

/** Prompt for pages like `1, 3-5` — no default hotkey; used by clear-freehand command. */
class PageRangePromptModal extends Modal {
  private readonly abort = new AbortController();
  private inputEl: HTMLInputElement | null = null;
  private focusTimer: number | null = null;

  constructor(
    app: NativePdfInkPlugin["app"],
    private readonly onSubmit: (pages: number[]) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Clear freehand on pages");
    this.contentEl.createEl("p", {
      text: "Enter page numbers or ranges (example: 1, 3-5, 8)."
    });
    this.inputEl = this.contentEl.createEl("input", {
      type: "text",
      placeholder: "1, 3-5"
    });
    this.inputEl.addClass("native-pdf-handwriting-page-range-input");
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    }, { signal: this.abort.signal });

    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    const clearButton = actions.createEl("button", { text: "Clear", cls: "mod-cta" });
    clearButton.addEventListener("click", () => this.submit(), { signal: this.abort.signal });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close(), { signal: this.abort.signal });
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      this.inputEl?.focus();
    }, 0);
  }

  private submit(): void {
    const pages = parsePageRanges(this.inputEl?.value ?? "");
    if (!pages) {
      new Notice("Enter valid page numbers or ranges (example: 1, 3-5).");
      return;
    }
    this.onSubmit(pages);
    this.close();
  }

  onClose(): void {
    if (this.focusTimer !== null) {
      window.clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    this.abort.abort();
    this.contentEl.empty();
    this.inputEl = null;
  }
}

export default class NativePdfInkPlugin extends Plugin {
  inkSettings: PluginSettings = mergeSettings(undefined, "config");
  private readonly sessions = new Map<WorkspaceLeaf, ViewerInkSession>();
  private readonly attachingLeaves = new Set<WorkspaceLeaf>();
  private readonly embedChrome = new Map<HTMLElement, EmbedAnnotateChrome>();
  private readonly persistEpochByDoc = new Map<string, number>();
  /** Back off repeated attach failures so layout rescans cannot storm a not-ready PDF. */
  private readonly attachRetry = new AttachRetryPolicy();
  private readonly scanDebounce = new ScanDebounce();
  private scanAgain = false;
  private unloaded = false;
  private readonly vaultDebugLog = new VaultDebugLog(
    () => this.app.vault,
    () => this.inkSettings.vaultDebugLogPath,
    () => this.inkSettings.vaultDebugLog,
    () => ({
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion
    })
  );

  async onload(): Promise<void> {
    this.inkSettings = mergeSettings(
      await this.loadData() as Partial<PluginSettings> | null,
      this.app.vault.configDir
    );
    this.addSettingTab(new NativePdfInkSettingTab(this.app, this));
    this.addRibbonIcon("file-plus-2", "Create handwritten PDF", () => void this.createPdfNote());

    this.addCommand({
      id: "create-handwritten-pdf",
      name: "Create handwritten PDF from template",
      callback: () => void this.createPdfNote()
    });
    this.addCommand({
      id: "create-notebook",
      name: "Create notebook",
      callback: () => void this.createNotebook()
    });
    this.registerFolderCreatePdfMenu();
    this.addCommand({
      id: "add-page-to-active-pdf",
      name: "Add page at end of active PDF",
      checkCallback: (checking) => {
        const session = this.activeSession();
        if (!session) return false;
        if (!checking) void session.addPageAt(Number.MAX_SAFE_INTEGER);
        return true;
      }
    });

    this.addCommand({
      id: "save-active-pdf-annotations",
      name: "Save active PDF annotations",
      callback: () => void this.activeSession()?.manualSave()
    });
    this.addCommand({
      id: "export-active-annotated-pdf",
      name: "Export active annotated PDF",
      callback: () => void this.activeSession()?.exportCopy()
    });
    this.addCommand({
      id: "export-selected-pdf-ink-as-svg",
      name: "Export selected PDF ink as SVG",
      checkCallback: (checking) => {
        const session = this.activeSession();
        if (!session?.canExportSelectedInkSvg()) return false;
        if (!checking) {
          void session.exportSelectedInkSvg().catch((error) => {
            new Notice(`SVG export failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        return true;
      }
    });
    this.registerSelectionCommands();
    this.registerToolbarHotkeyCommands();
    this.registerClearDrawingCommands();
    this.registerCrashBreadcrumbs();

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      void this.logWorkspacePulse("layout-change");
      this.scheduleDebouncedScan();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      for (const [sessionLeaf, session] of this.sessions) {
        if (sessionLeaf !== leaf) void session.flush();
      }
      void this.logWorkspacePulse("active-leaf-change", leaf);
      this.scheduleDebouncedScan();
    }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      for (const session of this.sessions.values()) void session.flush();
      void this.vaultDebugLog.writeUrgent("info", "file-open", {
        path: file?.path ?? null,
        extension: file?.extension ?? null,
        mobile: Platform.isMobile,
        phone: Platform.isPhone
      });
      this.scheduleDebouncedScan(Platform.isMobile ? 400 : 100);
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.vaultDebugLog.writeUrgent("info", "layout-ready", {
        mobile: Platform.isMobile,
        phone: Platform.isPhone
      });
      this.scheduleDebouncedScan();
    });
    this.registerDomEvent(window, "beforeunload", () => {
      this.emergencyPersistAllSessions();
    });
    this.registerDomEvent(window, "keydown", (event) => {
      this.activeSession()?.handleKeyDown(event);
    }, { capture: true });
    this.registerDomEvent(window, "keyup", (event) => {
      for (const session of this.sessions.values()) session.handleKeyUp(event);
    }, { capture: true });
    this.registerDomEvent(window, "blur", () => {
      for (const session of this.sessions.values()) session.clearTemporaryEraserModifier();
    });
    void this.vaultDebugLog.writeUrgent("info", "plugin-onload", {
      mobile: Platform.isMobile,
      phone: Platform.isPhone,
      vaultDebugLog: this.inkSettings.vaultDebugLog
    });
  }

  /** Catch uncaught errors before the WebView dies so mobile crash logs still land on disk. */
  private registerCrashBreadcrumbs(): void {
    this.registerDomEvent(window, "error", (event) => {
      void this.vaultDebugLog.writeUrgent("error", "window-error", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error instanceof Error ? event.error.stack ?? null : null,
        mobile: Platform.isMobile,
        phone: Platform.isPhone
      });
    });
    this.registerDomEvent(window, "unhandledrejection", (event) => {
      const reason: unknown = event.reason;
      void this.vaultDebugLog.writeUrgent("error", "unhandled-rejection", {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack ?? null : null,
        mobile: Platform.isMobile,
        phone: Platform.isPhone
      });
    });
  }

  private async logWorkspacePulse(reason: string, leaf?: WorkspaceLeaf | null): Promise<void> {
    if (!this.inkSettings.vaultDebugLog) return;
    const pdfLeaves = this.app.workspace.getLeavesOfType("pdf");
    if (pdfLeaves.length === 0 && reason === "layout-change") return;
    const leafFile = leaf?.view instanceof FileView ? leaf.view.file : null;
    const file = leafFile ?? this.app.workspace.getActiveFile();
    await this.vaultDebugLog.writeUrgent("info", "workspace-pulse", {
      reason,
      pdfLeafCount: pdfLeaves.length,
      sessions: this.sessions.size,
      attachingLeaves: this.attachingLeaves.size,
      activePath: file?.path ?? null,
      activeExtension: file?.extension ?? null,
      mobile: Platform.isMobile,
      phone: Platform.isPhone
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.scanDebounce.clear();
    this.attachRetry.clearAll();
    this.attachingLeaves.clear();
    for (const chrome of this.embedChrome.values()) chrome.destroy();
    this.embedChrome.clear();
    this.emergencyPersistAllSessions();
    for (const session of this.sessions.values()) {
      void session.destroy({ silent: true, alreadyPersisted: true });
    }
    this.sessions.clear();
    this.vaultDebugLog.destroy();
  }

  private allSessions(): ViewerInkSession[] {
    return [...this.sessions.values()];
  }

  private emergencyPersistAllSessions(): void {
    const writeSync = createVaultSyncWriter(this.app.vault);
    const sessions = this.allSessions();
    if (!writeSync) {
      this.vaultDebugLog.write("warn", "emergency persist unavailable", {
        reason: "no-filesystem-adapter",
        sessions: sessions.length
      });
      return;
    }
    const winners = new Map<string, ViewerInkSession>();
    for (const session of sessions) {
      const id = session.getDocumentId();
      const current = winners.get(id);
      if (!current || this.isBetterPersistWriter(session, current)) {
        winners.set(id, session);
      }
    }
    const openPdfLeaves = this.app.workspace.getLeavesOfType("pdf").length;
    this.vaultDebugLog.write("info", "emergency persist begin", {
      sessions: sessions.length,
      documents: winners.size,
      openPdfLeaves,
      attachingLeaves: this.attachingLeaves.size,
      mobile: Platform.isMobile,
      phone: Platform.isPhone
    });
    for (const session of sessions) {
      const winner = winners.get(session.getDocumentId());
      if (winner !== session) {
        session.abandonWrites("plugin-unload-stale-session");
      }
    }
    for (const session of winners.values()) {
      session.emergencyPersist(writeSync, { force: true, reason: "plugin-unload" });
    }
  }

  /** Dirty beats clean; otherwise higher persistEpoch wins. */
  private isBetterPersistWriter(candidate: ViewerInkSession, current: ViewerInkSession): boolean {
    const candDirty = candidate.isDirty();
    const currDirty = current.isDirty();
    if (candDirty !== currDirty) return candDirty;
    return candidate.getPersistEpoch() > current.getPersistEpoch();
  }

  private claimPersistEpoch(documentId: string): number {
    const next = (this.persistEpochByDoc.get(documentId) ?? 0) + 1;
    this.persistEpochByDoc.set(documentId, next);
    return next;
  }

  private livePersistEpoch(documentId: string): number {
    return this.persistEpochByDoc.get(documentId) ?? 0;
  }

  private syncPersistSession(session: ViewerInkSession, reason: string): void {
    const writeSync = createVaultSyncWriter(this.app.vault);
    if (!writeSync) {
      this.vaultDebugLog.write("warn", "sync persist unavailable", {
        reason,
        document: session.getDiagnostics().pdfPath
      });
      return;
    }
    const live = this.livePersistEpoch(session.getDocumentId());
    if (live !== session.getPersistEpoch()) {
      session.abandonWrites(`${reason}-stale-session`);
      return;
    }
    for (const other of this.allSessions()) {
      if (other === session) continue;
      if (other.getDocumentId() !== session.getDocumentId()) continue;
      if (other.getPersistEpoch() < session.getPersistEpoch()) {
        other.abandonWrites(`${reason}-superseded`);
      }
    }
    session.emergencyPersist(writeSync, { force: true, reason });
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    const previousPlacement = this.inkSettings.toolbarPlacement;
    const previousBoostedZoom = this.inkSettings.boostedPdfZoom;
    this.inkSettings = settings;
    await this.saveData(settings);
    this.vaultDebugLog.write("info", "plugin settings saved", {
      changedKeys: [
        ...(previousPlacement !== settings.toolbarPlacement ? ["toolbarPlacement"] : []),
        ...(previousBoostedZoom !== settings.boostedPdfZoom ? ["boostedPdfZoom"] : [])
      ]
    });
    if (previousPlacement !== settings.toolbarPlacement) {
      for (const session of this.allSessions()) session.remountToolbar();
    }
    if (previousBoostedZoom !== settings.boostedPdfZoom) {
      for (const session of this.allSessions()) session.setBoostedPdfZoom(settings.boostedPdfZoom);
    }
  }

  async readAllLogs(): Promise<string | null> {
    await this.vaultDebugLog.flush();
    const path = normalizePath(this.inkSettings.vaultDebugLogPath);
    if (!path || !await this.app.vault.adapter.exists(path)) return null;
    const logs = await this.app.vault.adapter.read(path);
    return logs.trim() ? logs : null;
  }

  private scheduleDebouncedScan(delayMs = 100): void {
    this.scanAgain = true;
    if (this.unloaded) return;
    // Soonest wake wins: layout can still scan other leaves quickly, while
    // AttachRetryPolicy.canAttempt blocks the cooling path until its deadline.
    this.scanDebounce.schedule(delayMs, () => {
      void this.scanPdfViews();
    });
  }

  private async scanPdfViews(): Promise<void> {
    if (this.unloaded) return;
    this.scanAgain = false;
    await this.scanPdfLeaves();
    this.scanPdfEmbeds();
    if (this.scanAgain && !this.unloaded) this.scheduleDebouncedScan(0);
  }

  private async scanPdfLeaves(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    await this.vaultDebugLog.writeUrgent("info", "scan-pdf-leaves", {
      pdfLeafCount: leaves.length,
      sessions: this.sessions.size,
      attachingLeaves: this.attachingLeaves.size,
      mobile: Platform.isMobile,
      phone: Platform.isPhone
    });
    const live = new Set(leaves);
    const livePaths = new Set<string>();
    for (const [leaf, session] of [...this.sessions]) {
      if (!live.has(leaf)) {
        this.sessions.delete(leaf);
        this.syncPersistSession(session, "leaf-closed");
        void session.destroy({ silent: true, alreadyPersisted: true });
        continue;
      }
      if (!session.isAttached()) {
        this.sessions.delete(leaf);
        this.syncPersistSession(session, "detach-rescan");
        void session.destroy({ silent: true, alreadyPersisted: true });
      }
    }

    for (const leaf of leaves) {
      if (this.sessions.has(leaf) || this.attachingLeaves.has(leaf)) continue;
      const view = leaf.view;
      const file = view instanceof FileView ? view.file : (view as FileView).file;
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") continue;
      livePaths.add(file.path);
      if (!this.attachRetry.canAttempt(file.path)) {
        await this.vaultDebugLog.writeUrgent("info", "session attach cooling", {
          document: file.path,
          mobile: Platform.isMobile
        });
        continue;
      }

      this.attachingLeaves.add(leaf);
      let session: ViewerInkSession | undefined;
      try {
        await this.vaultDebugLog.writeUrgent("info", "session attach prepare", {
          document: file.path,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          hostChildCount: view.containerEl?.childElementCount ?? null
        });
        await this.vaultDebugLog.writeUrgent("info", "session attach resolve-viewer", {
          document: file.path
        });
        const graph = await PdfViewerCompatibility.resolveViewerGraphFromPdfView(view);
        const privateViewer = graph.privateViewer;
        // Large textbooks on phone need a longer first paint before page nodes exist.
        const pageWaitMs = Platform.isMobile ? 12_000 : 5_000;
        await this.vaultDebugLog.writeUrgent("info", "session attach begin", {
          document: file.path,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          pageWaitMs,
          hasPrivateViewer: Boolean(privateViewer),
          hasFindController: Boolean(graph.findController)
        });
        const attachOptions: {
          privateViewer?: import("./integration/PdfViewerCompatibility").PdfJsViewerLike;
          findController?: import("./integration/PdfViewerCompatibility").PdfFindControllerLike;
          pageWaitMs: number;
        } = { pageWaitMs };
        if (privateViewer) attachOptions.privateViewer = privateViewer;
        if (graph.findController) attachOptions.findController = graph.findController;
        const adapter = await NativePdfViewAdapter.attach(
          view.containerEl,
          this.sessionAdapterCallbacks(() => session),
          attachOptions
        );
        await this.vaultDebugLog.writeUrgent("info", "session attach adapter-ok", {
          document: file.path,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          domPageCount: adapter.pages().length,
          currentPage: adapter.getViewState().pageNumber
        });
        session = await this.createInkSession(file, adapter, {
          onDetached: () => {
            const current = this.sessions.get(leaf);
            if (!current || current !== session) return;
            this.sessions.delete(leaf);
            this.syncPersistSession(current, "on-detached");
            void current.destroy({ silent: true, alreadyPersisted: true });
            this.scheduleDebouncedScan(300);
          }
        });
        if (this.unloaded) {
          this.syncPersistSession(session, "unloaded-during-attach");
          void session.destroy({ silent: true, alreadyPersisted: true });
          continue;
        }
        this.sessions.set(leaf, session);
        this.attachRetry.clear(file.path);
        await this.vaultDebugLog.writeUrgent("info", "session attach ok", {
          document: file.path,
          mobile: Platform.isMobile
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pagesMissing = message.includes("PDF page nodes missing");
        let dom: Record<string, unknown> = { viewerRoot: false };
        try {
          const preview = PdfViewerCompatibility.direct(view.containerEl);
          dom = describePdfPageDom(preview.viewerRoot);
        } catch (domError) {
          dom = {
            viewerRoot: false,
            domDescribeError: domError instanceof Error ? domError.message : String(domError)
          };
        }
        console.warn("[Handwriting Natively] PDF view not ready or incompatible", error);
        await this.vaultDebugLog.writeUrgent("warn", "session attach failed", {
          document: file.path,
          error: message,
          stack: error instanceof Error ? error.stack ?? null : null,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          pagesMissing,
          ...dom
        });
        // After waiting for pages, keep mobile from re-attach-storming large PDFs.
        const delayMs = pagesMissing && Platform.isMobile
          ? this.attachRetry.recordHardFailure(file.path)
          : this.attachRetry.recordFailure(file.path);
        this.scheduleDebouncedScan(delayMs);
      } finally {
        this.attachingLeaves.delete(leaf);
      }
    }

    // Paths seen above omit leaves that already have sessions — still retain those paths
    // so we do not prune an open doc's cooldown incorrectly when attach is in-flight only.
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view instanceof FileView ? view.file : (view as FileView).file;
      if (file instanceof TFile && file.extension.toLowerCase() === "pdf") livePaths.add(file.path);
    }
    this.attachRetry.retainOnly(livePaths);
    const wait = this.attachRetry.msUntilNextRetry(livePaths);
    if (wait != null) this.scheduleDebouncedScan(wait);
  }

  private scanPdfEmbeds(): void {
    const liveHosts = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const sourcePath = view.file.path;
      const root = view.contentEl ?? view.containerEl;
      for (const host of EmbeddedPdfAdapter.discover(root)) {
        liveHosts.add(host);
        if (this.embedChrome.has(host) || findExistingEmbedChrome(host)) continue;
        const file = resolvePdfFileFromEmbed(this.app, host, sourcePath);
        if (!file) continue;
        const chrome = new EmbedAnnotateChrome(host, {
          onAnnotate: () => void this.openPdfInNewTab(file)
        });
        this.embedChrome.set(host, chrome);
      }
    }
    for (const [host, chrome] of [...this.embedChrome]) {
      if (!host.isConnected || !liveHosts.has(host)) {
        chrome.destroy();
        this.embedChrome.delete(host);
      }
    }
  }

  private sessionAdapterCallbacks(getSession: () => ViewerInkSession | undefined): PdfAdapterCallbacks {
    return {
      onPagesChanged: (reason) => getSession()?.onPagesChanged(reason),
      onViewStateChange: (state, source) => getSession()?.onViewStateChange(state, source),
      onPageContentMutation: (recordCount) => getSession()?.onPdfPageContentMutation(recordCount),
      onCompatibilityWarning: (message) => {
        console.warn(`[Handwriting Natively] ${message}`);
        this.vaultDebugLog.write("warn", "compatibility", { message });
      },
      onDebugLog: (level, event, payload) => {
        this.vaultDebugLog.write(level, event, payload ?? {});
      }
    };
  }

  private async createInkSession(
    file: TFile,
    adapter: ObsidianPdfAdapter,
    options: { onDetached?: () => void } = {}
  ): Promise<ViewerInkSession> {
    const textFiles = createVaultFsTextAdapter(this.app.vault);
    return ViewerInkSession.create({
      adapter,
      pdfPath: file.path,
      settings: this.inkSettings,
      sidecars: new SidecarRepository(textFiles, this.inkSettings.sidecarFolder),
      recovery: new RecoveryRepository(textFiles, `${this.inkSettings.sidecarFolder}/recovery`),
      saveSettings: async (preferences) => this.saveToolPreferences(preferences),
      savePluginSettings: async (patch) => {
        await this.saveSettings({ ...this.inkSettings, ...patch });
      },
      readSourcePdf: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      writeExport: async (name, bytes) => this.writeAndOpenExport(file, name, bytes),
      onInsertPage: (pageNumber) => this.insertPageInPlace(file, pageNumber),
      onDeletePage: (pageNumber) => this.deletePageInPlace(file, pageNumber),
      onDeletePages: (pageNumbers) => this.deletePagesInPlace(file, pageNumbers),
      writeSvgExport: async (name, svg) => this.writeSvgExport(file, name, svg),
      notice: (message) => new Notice(message),
      decideUnsaved: () => this.decideUnsaved(),
      mouseDragScrollEnabled: () => this.inkSettings.mouseDragScroll,
      pressureProfile: () => this.inkSettings.pressureProfile,
      pressureCalibration: () => this.inkSettings.pressureCalibration,
      simplifyStrokesEnabled: () => this.inkSettings.simplifyStrokes,
      toolbarPlacement: () => this.inkSettings.toolbarPlacement,
      vaultLog: this.vaultDebugLog,
      debugEnabled: () => this.inkSettings.vaultDebugLog,
      writeSync: createVaultSyncWriter(this.app.vault),
      claimPersistEpoch: (documentId) => this.claimPersistEpoch(documentId),
      livePersistEpoch: (documentId) => this.livePersistEpoch(documentId),
      runtimePlatform: () => ({ mobile: Platform.isMobile, phone: Platform.isPhone }),
      ...(options.onDetached ? { onDetached: options.onDetached } : {})
    });
  }

  private async openPdfInNewTab(file: TFile): Promise<void> {
    if (this.unloaded) return;
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      this.vaultDebugLog.write("info", "embed annotate open tab", { document: file.path });
    } catch (error) {
      console.warn("[Handwriting Natively] open PDF tab failed", error);
      this.vaultDebugLog.write("warn", "embed annotate open tab failed", {
        document: file.path,
        error: error instanceof Error ? error.message : String(error)
      });
      new Notice(`Could not open PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activeSession(): ViewerInkSession | undefined {
    const mostRecent = this.app.workspace.getMostRecentLeaf();
    if (mostRecent && this.sessions.has(mostRecent)) return this.sessions.get(mostRecent);
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return undefined;
    for (const [leaf, session] of this.sessions) {
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === activeFile.path) return session;
    }
    return undefined;
  }

  private registerSelectionCommands(): void {
    // Commands stay in the palette, but no default hotkeys — Obsidian does not fall through
    // when checkCallback is false, which breaks Delete/Backspace/Cmd+C in normal Markdown.
    // Shortcuts still work on PDF ink via window capture in ViewerInkSession.
    const register = (id: string, name: string, action: SelectionShortcutAction): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const session = this.activeSession();
          if (!session?.canSelectionShortcut(action)) return false;
          if (!checking) session.applySelectionShortcut(action);
          return true;
        }
      });
    };
    register("delete-selected-pdf-ink", "Delete selected PDF ink", "delete");
    register("copy-selected-pdf-ink", "Copy selected PDF ink", "copy");
    register("cut-selected-pdf-ink", "Cut selected PDF ink", "cut");
    register("paste-selected-pdf-ink", "Paste PDF ink", "paste");
    register("select-all-pdf-ink", "Select all PDF ink", "selectAll");
  }

  /**
   * Palette commands intentionally have no default hotkeys. They become
   * assignable in Settings → Hotkeys while remaining inactive outside a live
   * Handwriting Natively PDF session.
   */
  private registerToolbarHotkeyCommands(): void {
    const registerTool = (
      id: string,
      name: string,
      tool: ToolPreferences["activeTool"]
    ): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const session = this.activeSession();
          if (!session?.canSelectTool()) return false;
          if (!checking) session.selectTool(tool);
          return true;
        }
      });
    };
    const registerHistory = (id: string, name: string, action: "undo" | "redo"): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const session = this.activeSession();
          if (!session || !(action === "undo" ? session.canUndo() : session.canRedo())) return false;
          if (!checking) {
            if (action === "undo") session.undo();
            else session.redo();
          }
          return true;
        }
      });
    };

    registerTool("select-pdf-pen", "Switch to pen", "pen");
    registerTool("select-pdf-eraser", "Switch to eraser", "eraser");
    registerTool("select-pdf-laser-pointer", "Switch to laser pointer", "laser");
    registerTool("select-pdf-lasso", "Switch to lasso", "lasso");
    registerTool("select-pdf-text", "Switch to text", "text");
    registerHistory("undo-pdf-annotation", "Undo annotation", "undo");
    registerHistory("redo-pdf-annotation", "Redo annotation", "redo");
  }

  /**
   * Palette-only clear commands (no default hotkeys). Bind in Settings → Hotkeys.
   * Clears freehand ink strokes only; text annotations are left alone.
   */
  private registerClearDrawingCommands(): void {
    const runClear = (scope: "all" | "selected" | readonly number[]): void => {
      const session = this.activeSession();
      if (!session?.canClearFreehandDrawings()) {
        new Notice("Open a PDF with handwriting annotations first.");
        return;
      }
      const cleared = session.clearFreehandDrawings(scope);
      if (cleared === 0) new Notice("No freehand drawings to clear.");
      else new Notice(`Cleared ${cleared} freehand drawing${cleared === 1 ? "" : "s"}.`);
    };

    this.addCommand({
      id: "clear-all-pdf-freehand",
      name: "Clear all freehand drawings",
      checkCallback: (checking) => {
        const session = this.activeSession();
        if (!session?.canClearFreehandDrawings()) return false;
        if (!checking) runClear("all");
        return true;
      }
    });

    this.addCommand({
      id: "clear-selected-pages-pdf-freehand",
      name: "Clear freehand drawings on selected pages",
      checkCallback: (checking) => {
        const session = this.activeSession();
        if (!session?.canClearFreehandDrawings()) return false;
        if (!checking) runClear("selected");
        return true;
      }
    });

    this.addCommand({
      id: "clear-specific-pages-pdf-freehand",
      name: "Clear freehand drawings on specific pages",
      checkCallback: (checking) => {
        const session = this.activeSession();
        if (!session?.canClearFreehandDrawings()) return false;
        if (!checking) {
          new PageRangePromptModal(this.app, (pages) => runClear(pages)).open();
        }
        return true;
      }
    });
  }

  private async saveToolPreferences(preferences: ToolPreferences): Promise<void> {
    this.inkSettings = {
      ...this.inkSettings,
      toolPreferences: structuredClone(preferences)
    };
    await this.saveData(this.inkSettings);
  }

  /** Read the configured vault PDF. Empty setting deliberately means blank Letter paper. */
  private async readPdfTemplate(): Promise<Uint8Array | undefined> {
    const configuredPath = this.inkSettings.pdfTemplatePath.trim();
    if (!configuredPath) return undefined;
    const path = normalizePath(configuredPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") {
      throw new Error(`Configured PDF template was not found: ${configuredPath}`);
    }
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  private templateLogValue(): string {
    return this.inkSettings.pdfTemplatePath.trim() || "blank-us-letter";
  }

  /** Insert in place: source pages and every later sidecar page move together. */
  private async insertPageInPlace(file: TFile, requestedPageNumber: number): Promise<number> {
    const source = new Uint8Array(await this.app.vault.readBinary(file));
    const inserted = await insertMatchingBlankPage(source, requestedPageNumber);
    const files = createVaultFsTextAdapter(this.app.vault);
    const sidecars = new SidecarRepository(files, this.inkSettings.sidecarFolder);
    const recovery = new RecoveryRepository(files, `${this.inkSettings.sidecarFolder}/recovery`);
    const documentId = createDocumentIdentity({ vaultPath: file.path }).id;
    const sidecarBefore = await sidecars.load(documentId);
    const recoveryBefore = await recovery.load(documentId);
    const sidecarAfter = sidecarBefore ? insertPageIntoSidecar(sidecarBefore, inserted.pageNumber) : null;
    const recoveryAfter = recoveryBefore ? insertPageIntoSidecar(recoveryBefore, inserted.pageNumber) : null;
    let pdfWritten = false;
    try {
      await this.vaultDebugLog.writeUrgent("info", "pdf-page-insert-start", {
        document: file.path,
        page: inserted.pageNumber,
        requestedPage: requestedPageNumber,
        hasSidecar: Boolean(sidecarBefore),
        hasRecovery: Boolean(recoveryBefore)
      });
      await this.app.vault.modifyBinary(file, inserted.bytes.slice().buffer);
      pdfWritten = true;
      if (sidecarAfter) await sidecars.save(sidecarAfter);
      if (recoveryAfter) await recovery.save(recoveryAfter);
      await this.vaultDebugLog.writeUrgent("info", "pdf-page-insert-complete", {
        document: file.path,
        page: inserted.pageNumber,
        sourceBytes: source.byteLength,
        resultBytes: inserted.bytes.byteLength,
        sidecarRemapped: Boolean(sidecarAfter),
        recoveryRemapped: Boolean(recoveryAfter)
      });
      return inserted.pageNumber;
    } catch (error) {
      if (pdfWritten) await this.app.vault.modifyBinary(file, source.slice().buffer).catch(() => undefined);
      if (sidecarBefore) await sidecars.save(sidecarBefore).catch(() => undefined);
      if (recoveryBefore) await recovery.save(recoveryBefore).catch(() => undefined);
      await this.vaultDebugLog.writeUrgent("error", "pdf-page-insert-failed", {
        document: file.path,
        requestedPage: requestedPageNumber,
        rolledBackPdf: pdfWritten,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Delete one source page and its matching sidecar/recovery annotations together. */
  private async deletePageInPlace(file: TFile, pageNumber: number): Promise<void> {
    await this.deletePagesInPlace(file, [pageNumber]);
  }

  /** Delete one or more original source pages and remap annotations in one write transaction. */
  private async deletePagesInPlace(file: TFile, requestedPageNumbers: readonly number[]): Promise<void> {
    const source = new Uint8Array(await this.app.vault.readBinary(file));
    const deletion = await deletePdfPages(source, requestedPageNumbers);
    const { bytes: updated, pageNumbers, pageCountBefore, pageCountAfter } = deletion;
    const files = createVaultFsTextAdapter(this.app.vault);
    const sidecars = new SidecarRepository(files, this.inkSettings.sidecarFolder);
    const recovery = new RecoveryRepository(files, `${this.inkSettings.sidecarFolder}/recovery`);
    const documentId = createDocumentIdentity({ vaultPath: file.path }).id;
    const sidecarBefore = await sidecars.load(documentId);
    const recoveryBefore = await recovery.load(documentId);
    const sidecarAfter = sidecarBefore
      ? pageNumbers.reduce((sidecar, pageNumber) => removePageFromSidecar(sidecar, pageNumber), sidecarBefore)
      : null;
    const recoveryAfter = recoveryBefore
      ? pageNumbers.reduce((sidecar, pageNumber) => removePageFromSidecar(sidecar, pageNumber), recoveryBefore)
      : null;
    const range = pageNumbers.length > 1;
    const eventPrefix = range ? "pdf-pages-delete" : "pdf-page-delete";
    let pdfWritten = false;
    let writeStage = "prepared";
    try {
      await this.vaultDebugLog.writeUrgent("info", `${eventPrefix}-start`, {
        document: file.path,
        page: pageNumbers[0],
        pageNumbers,
        count: pageNumbers.length,
        firstPage: pageNumbers.at(-1),
        lastPage: pageNumbers[0],
        pageCountBefore,
        pageCountAfter,
        hasSidecar: Boolean(sidecarBefore),
        hasRecovery: Boolean(recoveryBefore)
      });
      writeStage = "pdf";
      await this.app.vault.modifyBinary(file, updated.slice().buffer);
      pdfWritten = true;
      if (sidecarAfter) {
        writeStage = "sidecar";
        await sidecars.save(sidecarAfter);
      }
      if (recoveryAfter) {
        writeStage = "recovery";
        await recovery.save(recoveryAfter);
      }
      await this.vaultDebugLog.writeUrgent("info", `${eventPrefix}-complete`, {
        document: file.path,
        page: pageNumbers[0],
        pageNumbers,
        count: pageNumbers.length,
        firstPage: pageNumbers.at(-1),
        lastPage: pageNumbers[0],
        pageCountBefore,
        pageCountAfter,
        sourceBytes: source.byteLength,
        resultBytes: updated.byteLength,
        sidecarRemapped: Boolean(sidecarAfter),
        recoveryRemapped: Boolean(recoveryAfter)
      });
    } catch (error) {
      let rolledBackPdf = false;
      let rolledBackSidecar = false;
      let rolledBackRecovery = false;
      if (pdfWritten) {
        try {
          await this.app.vault.modifyBinary(file, source.slice().buffer);
          rolledBackPdf = true;
        } catch {
          // The failure log records incomplete compensation below.
        }
      }
      if (sidecarBefore) {
        try {
          await sidecars.save(sidecarBefore);
          rolledBackSidecar = true;
        } catch {
          // The failure log records incomplete compensation below.
        }
      }
      if (recoveryBefore) {
        try {
          await recovery.save(recoveryBefore);
          rolledBackRecovery = true;
        } catch {
          // The failure log records incomplete compensation below.
        }
      }
      await this.vaultDebugLog.writeUrgent("error", `${eventPrefix}-failed`, {
        document: file.path,
        page: pageNumbers[0],
        pageNumbers,
        count: pageNumbers.length,
        writeStage,
        rolledBackPdf,
        rolledBackSidecar,
        rolledBackRecovery,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Folder context menu: create a GoodNotes-sized blank PDF in that folder. */
  private registerFolderCreatePdfMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) => {
          item
            .setTitle("New PDF")
            .setIcon("file-plus-2")
            .onClick(() => void this.createNotebook(file.path));
        });
      })
    );
  }

  private async createPdfNote(): Promise<void> {
    const template = this.templateLogValue();
    try {
      await this.vaultDebugLog.writeUrgent("info", "pdf-create-start", { template });
      const bytes = await createPdfFromTemplate(await this.readPdfTemplate());
      const folder = this.app.workspace.getActiveFile()?.parent?.path ?? "";
      const created = await this.createUniquePdf(folder, this.handwrittenPdfName(), bytes);
      await this.openPdfInNewTab(created);
      await this.vaultDebugLog.writeUrgent("info", "pdf-create-complete", {
        document: created.path,
        template,
        resultBytes: bytes.byteLength
      });
      new Notice("New handwritten PDF created.");
    } catch (error) {
      console.error("[Handwriting Natively] create PDF from template failed", error);
      await this.vaultDebugLog.writeUrgent("error", "pdf-create-failed", {
        template,
        error: error instanceof Error ? error.message : String(error)
      });
      new Notice(`Could not create handwritten PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Blank one-page PDF at GoodNotes Standard size (~6.32 × 8.17 in).
   * Optional `folderPath` targets a file-explorer folder (context menu).
   */
  private async createNotebook(folderPath?: string): Promise<void> {
    try {
      await this.vaultDebugLog.writeUrgent("info", "notebook-create-start", {
        pageSize: "goodnotes-standard",
        folder: folderPath ?? null
      });
      const bytes = await createGoodNotesNotebook();
      const folder =
        folderPath ?? this.app.workspace.getActiveFile()?.parent?.path ?? "";
      const created = await this.createUniquePdf(folder, this.notebookPdfName(), bytes);
      await this.openPdfInNewTab(created);
      await this.vaultDebugLog.writeUrgent("info", "notebook-create-complete", {
        document: created.path,
        resultBytes: bytes.byteLength
      });
      new Notice("New notebook created.");
    } catch (error) {
      await this.vaultDebugLog.writeUrgent("error", "notebook-create-failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      new Notice(`Could not create notebook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handwrittenPdfName(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `Handwritten note ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.pdf`;
  }

  private notebookPdfName(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `Notebook ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.pdf`;
  }

  private async createUniquePdf(folder: string, name: string, bytes: Uint8Array): Promise<TFile> {
    const stem = name.replace(/\.pdf$/i, "");
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.pdf` : `${stem}-${suffix}.pdf`);
      suffix += 1;
    }
    return this.app.vault.createBinary(path, bytes.slice().buffer);
  }

  private async writeAndOpenExport(source: TFile, name: string, bytes: Uint8Array): Promise<string> {
    const folder = source.parent?.path ?? "";
    const stem = name.replace(/\.pdf$/i, "");
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.pdf` : `${stem}-${suffix}.pdf`);
      suffix += 1;
    }
    const created = await this.app.vault.createBinary(path, bytes.slice().buffer);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(created, { active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return created.path;
  }

  /** SVG exports stay separate from PDFs and never mutate the source document. */
  private async writeSvgExport(source: TFile, name: string, svg: string): Promise<string> {
    const folder = source.parent?.path ?? "";
    const stem = name.replace(/\.svg$/i, "") || "selected_ink";
    let path = normalizePath(folder ? `${folder}/${stem}.svg` : `${stem}.svg`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.svg` : `${stem}-${suffix}.svg`);
      suffix += 1;
    }
    return (await this.app.vault.create(path, svg)).path;
  }

  private decideUnsaved(): Promise<CloseChoice> {
    return new Promise((resolve) => new UnsavedChangesModal(this.app, resolve).open());
  }
}
