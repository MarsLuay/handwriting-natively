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
import { ImageViewAdapter } from "./integration/ImageViewAdapter";
import { NativePdfViewAdapter } from "./integration/NativePdfViewAdapter";
import { isSupportedImageFile } from "./integration/ImageFileTypes";
import type { AnnotationSurface, AnnotationSurfaceCallbacks } from "./runtime/AnnotationSurface";
import { pdfSurfaceExtensions } from "./integration/ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./integration/PdfViewerCompatibility";
import { describePdfPageDom } from "./integration/pdfPageSelectors";
import { getDebugNodeId } from "./dom/debugNodeId";
import { EmbedAnnotateChrome, findExistingEmbedChrome } from "./focus-view/EmbedAnnotateChrome";
import { resolvePdfFileFromEmbed } from "./focus-view/embedFocusHelpers";
import { ViewerInkSession, type AddPageMutationRestoreState } from "./runtime/ViewerInkSession";
import { AttachRetryPolicy } from "./runtime/AttachRetryPolicy";
import { ScanDebounce } from "./runtime/ScanDebounce";
import { VaultDebugLog } from "./logging/VaultDebugLog";
import { PROFILE_SCHEMA_VERSION } from "./logging/SessionLogger";
import {
  createGoodNotesNotebook,
  createPdfFromTemplate,
  deletePdfPages,
  getPdfPageCount,
  importPdfPages,
  insertScannedPages,
  insertMatchingBlankPage,
  type ImportedPdfPages
} from "./pdf/PdfNoteService";
import { writePdfAndAnnotationStoresAtomic } from "./pdf/PdfPageMutation";
import { PdfImportFilePicker, PdfPageSelectionModal } from "./ui/PdfPageImport";
import { mergeSettings, NativePdfInkSettingTab, type CopiedLogDiagnostics } from "./settings";
import { RecoveryRepository } from "./storage/RecoveryRepository";
import { createDocumentIdentity, hashDocumentContent } from "./storage/DocumentIdentity";
import { insertPageIntoSidecar, insertPagesIntoSidecar, removePageFromSidecar } from "./storage/SidecarPageRemoval";
import { SidecarRepository } from "./storage/SidecarRepository";
import type { CloseChoice } from "./storage/SaveCoordinator";
import type { PluginSettings, ToolPreferences } from "./model";
import { createVaultFsTextAdapter, createVaultSyncWriter } from "./storage/VaultFs";
import { parsePageRanges } from "./util/parsePageRanges";
import { ScanDocumentModal } from "./ui/ScanDocumentModal";
import type { ScanDocumentPage } from "./scanning/ScanDocument";
import {
  handwritingSessionMissingPayload,
  missingHandwritingSession,
  needsMissingHandwritingSessionRecovery,
  type HandwritingSessionRegistrySnapshot
} from "./runtime/HandwritingSessionRegistry";

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

export function scheduleSessionRecoveryAfterDestroy(
  destroyPromise: Promise<boolean>,
  scheduleScan: () => void,
  reportBlocked: (reason: "stale-session-destroy-incomplete" | "stale-session-destroy-failed", error?: unknown) => void
): void {
  void destroyPromise.then(
    (destroyed) => {
      if (!destroyed) reportBlocked("stale-session-destroy-incomplete");
      scheduleScan();
    },
    (error: unknown) => {
      reportBlocked("stale-session-destroy-failed", error);
      scheduleScan();
    }
  );
}

export default class NativePdfInkPlugin extends Plugin {
  inkSettings: PluginSettings = mergeSettings(undefined, "config");
  private readonly sessions = new Map<WorkspaceLeaf, ViewerInkSession>();
  private readonly attachingLeaves = new Set<WorkspaceLeaf>();
  private readonly embedChrome = new Map<HTMLElement, EmbedAnnotateChrome>();
  private readonly persistEpochByDoc = new Map<string, number>();
  /** Short-lived Add Page state survives the source-PDF viewer reload. */
  private readonly pendingAddPageRestore = new Map<string, AddPageMutationRestoreState>();
  /** Back off repeated attach failures so layout rescans cannot storm a not-ready PDF. */
  private readonly attachRetry = new AttachRetryPolicy();
  /** Replacement sessions wait for old listeners/adapters to finish tearing down. */
  private readonly pendingSessionDestroy = new Map<WorkspaceLeaf, {
    session: ViewerInkSession;
    promise: Promise<boolean>;
  }>();
  /** Leaves whose previous session detached and should be reported as replacement attaches. */
  private readonly replacementAttachLeaves = new Set<WorkspaceLeaf>();
  /** Leaves currently recovering the exact visible-viewer/session-absent invariant. */
  private readonly missingSessionRecoveryLeaves = new Set<WorkspaceLeaf>();
  private readonly scanDebounce = new ScanDebounce();
  private readonly flushDebounce = new ScanDebounce();
  private scanAgain = false;
  private unloaded = false;
  private lastMissingSessionKey = "";
  private lastMissingRecoveryKey = "";
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
    await this.vaultDebugLog.clear();
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
      this.requestFlushAllSessions();
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
    // A plugin can be enabled/reloaded after Obsidian has already published
    // layout-ready. Mobile does not always emit another layout or file-open
    // event for the PDF that is already visible, so make the first attach
    // attempt independent of those lifecycle notifications.
    void this.vaultDebugLog.writeUrgent("info", "session attach scan requested", {
      reason: "plugin-onload",
      delayMs: 0,
      mobile: Platform.isMobile,
      phone: Platform.isPhone
    });
    this.scheduleDebouncedScan(0);
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
    this.replacementAttachLeaves.clear();
    this.missingSessionRecoveryLeaves.clear();
    this.pendingAddPageRestore.clear();
    for (const chrome of this.embedChrome.values()) chrome.destroy();
    this.embedChrome.clear();
    this.emergencyPersistAllSessions();
    for (const [leaf, session] of [...this.sessions]) {
      this.removeSessionFromRegistry(leaf, session, "plugin-unload");
      void this.destroySessionWithTelemetry(leaf, session, "plugin-unload", { silent: true, alreadyPersisted: true })
        .catch(() => undefined);
    }
    this.sessions.clear();
    this.vaultDebugLog.destroy();
  }

  private allSessions(): ViewerInkSession[] {
    return [...this.sessions.values()];
  }

  private fileForLeaf(leaf: WorkspaceLeaf): TFile | null {
    const view = leaf.view;
    const file = view instanceof FileView ? view.file : (view as { file?: unknown }).file;
    return file instanceof TFile ? file : null;
  }

  private containerForLeaf(leaf: WorkspaceLeaf): HTMLElement | null {
    const container = (leaf.view as { containerEl?: unknown }).containerEl;
    return container instanceof HTMLElement ? container : null;
  }

  private sessionRegistryDetails(
    leaf: WorkspaceLeaf,
    session: ViewerInkSession,
    reason: string
  ): Record<string, unknown> {
    const file = this.fileForLeaf(leaf);
    const view = leaf.view as { getViewType?: () => string };
    return {
      document: file?.path ?? session.getDiagnostics().documentPath,
      filePath: file?.path ?? null,
      leafViewType: typeof view.getViewType === "function" ? view.getViewType() : null,
      leafContainerDebugId: getDebugNodeId(this.containerForLeaf(leaf)),
      reason,
      ...session.getUiLifecycleSnapshot(reason)
    };
  }

  private registerSession(leaf: WorkspaceLeaf, session: ViewerInkSession, reason: string): void {
    this.sessions.set(leaf, session);
    this.vaultDebugLog.write("info", "handwriting-session-registered", {
      ...this.sessionRegistryDetails(leaf, session, reason),
      registrySizeAfter: this.sessions.size
    });
  }

  private removeSessionFromRegistry(leaf: WorkspaceLeaf, session: ViewerInkSession, reason: string): boolean {
    if (this.sessions.get(leaf) !== session) return false;
    const details = this.sessionRegistryDetails(leaf, session, reason);
    this.sessions.delete(leaf);
    this.vaultDebugLog.write("info", "handwriting-session-removed", {
      ...details,
      registrySizeAfter: this.sessions.size
    });
    return true;
  }

  private async destroySessionWithTelemetry(
    leaf: WorkspaceLeaf,
    session: ViewerInkSession,
    reason: string,
    options: { silent?: boolean; alreadyPersisted?: boolean }
  ): Promise<boolean> {
    const details = this.sessionRegistryDetails(leaf, session, reason);
    this.vaultDebugLog.write("info", "handwriting-session-destroy-requested", {
      ...details,
      registrySize: this.sessions.size,
      silent: Boolean(options.silent),
      alreadyPersisted: Boolean(options.alreadyPersisted)
    });
    try {
      const destroyed = await session.destroy(options);
      this.vaultDebugLog.write("info", "handwriting-session-destroy-completed", {
        ...details,
        destroyed,
        registrySizeAfter: this.sessions.size
      });
      return destroyed;
    } catch (error) {
      this.vaultDebugLog.write("warn", "handwriting-session-destroy-failed", {
        ...details,
        registrySizeAfter: this.sessions.size,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private trackSessionDestroy(
    leaf: WorkspaceLeaf,
    session: ViewerInkSession,
    reason: string,
    options: { silent?: boolean; alreadyPersisted?: boolean }
  ): Promise<boolean> {
    const existing = this.pendingSessionDestroy.get(leaf);
    if (existing?.session === session) return existing.promise;

    const destroy = (existing?.promise ?? Promise.resolve(true)).then((previousDestroyed) => {
      if (!previousDestroyed) return false;
      return this.destroySessionWithTelemetry(leaf, session, reason, options);
    });
    let tracked!: Promise<boolean>;
    tracked = destroy.finally(() => {
      if (this.pendingSessionDestroy.get(leaf)?.promise === tracked) {
        this.pendingSessionDestroy.delete(leaf);
      }
    });
    this.pendingSessionDestroy.set(leaf, { session, promise: tracked });
    return tracked;
  }

  private async waitForSessionDestroy(leaf: WorkspaceLeaf): Promise<boolean> {
    const pending = this.pendingSessionDestroy.get(leaf);
    if (!pending) return true;
    try {
      return await pending.promise;
    } catch (error) {
      await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-recovery", {
        phase: "blocked",
        reason: "stale-session-destroy-failed",
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private pdfSessionRegistrySnapshot(): HandwritingSessionRegistrySnapshot {
    const pdfLeaves = this.app.workspace.getLeavesOfType("pdf");
    const mostRecent = this.app.workspace.getMostRecentLeaf();
    const activeFile = this.app.workspace.getActiveFile();
    const activePdfLeaf = (mostRecent && pdfLeaves.includes(mostRecent) ? mostRecent : undefined)
      ?? pdfLeaves.find((leaf) => this.fileForLeaf(leaf)?.path === activeFile?.path)
      ?? null;
    const activePdfFile = activePdfLeaf ? this.fileForLeaf(activePdfLeaf) : null;
    const activePdfPath = activePdfFile?.extension.toLowerCase() === "pdf"
      ? activePdfFile.path
      : null;
    const roots = new Set<HTMLElement>();
    for (const leaf of pdfLeaves) {
      const root = this.containerForLeaf(leaf);
      if (root) roots.add(root);
    }
    const count = (selector: string): number => [...roots]
      .reduce((total, root) => total + root.querySelectorAll(selector).length, 0);
    return {
      pdfLeafCount: pdfLeaves.length,
      sessions: this.sessions.size,
      attachingLeaves: this.attachingLeaves.size,
      activePdfPath,
      expectedPdfSession: Boolean(activePdfPath && this.inkSettings.enabledSurfaces.pdf),
      activeSessionFound: Boolean(activePdfLeaf && this.sessions.has(activePdfLeaf)),
      viewerShellCount: count(".pdf-viewer, .pdfViewer"),
      handwritingToolbarCount: count(".native-pdf-handwriting-toolbar"),
      handwritingRailCount: count(".native-pdf-handwriting-rail")
    };
  }

  private writePluginCopiedLogUiSnapshot(): void {
    const snapshot = this.pdfSessionRegistrySnapshot();
    this.vaultDebugLog.write("info", "handwriting-ui-snapshot", {
      scope: "plugin",
      ...snapshot
    });
    if (missingHandwritingSession(snapshot)) {
      this.vaultDebugLog.write("warn", "handwriting-session-missing", {
        scope: "plugin",
        ...handwritingSessionMissingPayload(snapshot)
      });
    }
  }

  private reportMissingPdfSessionAfterSettle(): void {
    if (this.attachingLeaves.size > 0) return;
    const snapshot = this.pdfSessionRegistrySnapshot();
    if (!missingHandwritingSession(snapshot)) {
      this.lastMissingSessionKey = "";
      this.lastMissingRecoveryKey = "";
      return;
    }
    const key = JSON.stringify(snapshot);
    if (key === this.lastMissingSessionKey) return;
    this.lastMissingSessionKey = key;
    this.vaultDebugLog.write("warn", "handwriting-session-missing", {
      scope: "settled-scan",
      ...handwritingSessionMissingPayload(snapshot)
    });
  }

  private async prepareMissingPdfSessionRecovery(leaves: readonly WorkspaceLeaf[]): Promise<void> {
    const snapshot = this.pdfSessionRegistrySnapshot();
    if (!needsMissingHandwritingSessionRecovery(snapshot) || !snapshot.activePdfPath) {
      if (snapshot.attachingLeaves === 0) this.lastMissingRecoveryKey = "";
      return;
    }

    const activeLeaf = leaves.find((leaf) => this.fileForLeaf(leaf)?.path === snapshot.activePdfPath);
    if (!activeLeaf) {
      await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-recovery", {
        phase: "blocked",
        reason: "active-pdf-leaf-not-found",
        ...handwritingSessionMissingPayload(snapshot)
      });
      return;
    }

    const key = JSON.stringify(snapshot);
    if (key === this.lastMissingRecoveryKey) return;
    this.lastMissingRecoveryKey = key;
    this.lastMissingSessionKey = key;
    this.attachRetry.clear(snapshot.activePdfPath);
    this.replacementAttachLeaves.add(activeLeaf);
    this.missingSessionRecoveryLeaves.add(activeLeaf);
    await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-missing", {
      scope: "recovery",
      ...handwritingSessionMissingPayload(snapshot)
    });
    await this.vaultDebugLog.writeUrgent("info", "handwriting-session-recovery", {
      phase: "requested",
      reason: "visible-pdf-without-registered-session",
      document: snapshot.activePdfPath,
      ...handwritingSessionMissingPayload(snapshot)
    });
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
        document: session.getDiagnostics().documentPath
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

  private async detachDisabledPdfSessions(): Promise<void> {
    for (const [leaf, session] of [...this.sessions]) {
      const file = this.fileForLeaf(leaf);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") continue;
      if (!this.removeSessionFromRegistry(leaf, session, "pdf-disabled")) continue;
      this.syncPersistSession(session, "pdf-disabled");
      try {
        await this.destroySessionWithTelemetry(leaf, session, "pdf-disabled", { silent: true, alreadyPersisted: true });
      } catch (error) {
        await this.vaultDebugLog.writeUrgent("warn", "pdf session disable failed", {
          document: file.path,
          pdfHandwritingEnabled: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async detachDisabledImageSessions(): Promise<void> {
    for (const [leaf, session] of [...this.sessions]) {
      const file = this.fileForLeaf(leaf);
      if (!(file instanceof TFile) || !isSupportedImageFile(file)) continue;
      if (!this.removeSessionFromRegistry(leaf, session, "image-disabled")) continue;
      this.syncPersistSession(session, "image-disabled");
      try {
        await this.destroySessionWithTelemetry(leaf, session, "image-disabled", { silent: true, alreadyPersisted: true });
      } catch (error) {
        await this.vaultDebugLog.writeUrgent("warn", "image session disable failed", {
          document: file.path,
          imageHandwritingEnabled: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    const previousPlacement = this.inkSettings.toolbarPlacement;
    const previousBoostedZoom = this.inkSettings.boostedPdfZoom;
    const previousPdfEnabled = this.inkSettings.enabledSurfaces.pdf;
    const previousImageEnabled = this.inkSettings.enabledSurfaces.image;
    const previousAutomaticAnnotationRecovery = this.inkSettings.automaticAnnotationRecovery;
    const previousAnnotationBackupPath = this.inkSettings.annotationBackupPath;
    const previousMouseLeftDragDraw = this.inkSettings.mouseLeftDragDraw;
    const previousMouseRightDragErase = this.inkSettings.mouseRightDragErase;
    settings = mergeSettings(settings, this.app.vault.configDir);
    this.inkSettings = settings;
    await this.saveData(settings);
    if (previousPdfEnabled !== settings.enabledSurfaces.pdf) {
      this.vaultDebugLog.write("info", "content-surface-setting-changed", {
        surface: "pdf",
        previous: previousPdfEnabled,
        current: settings.enabledSurfaces.pdf,
        pdfHandwritingEnabled: settings.enabledSurfaces.pdf
      });
      if (!settings.enabledSurfaces.pdf) await this.detachDisabledPdfSessions();
      this.scheduleDebouncedScan(0);
    }
    if (previousImageEnabled !== settings.enabledSurfaces.image) {
      this.vaultDebugLog.write("info", "content-surface-setting-changed", {
        surface: "image",
        previous: previousImageEnabled,
        current: settings.enabledSurfaces.image,
        imageHandwritingEnabled: settings.enabledSurfaces.image
      });
      if (!settings.enabledSurfaces.image) await this.detachDisabledImageSessions();
      this.scheduleDebouncedScan(0);
    }
    this.vaultDebugLog.write("info", "plugin settings saved", {
      changedKeys: [
        ...(previousPlacement !== settings.toolbarPlacement ? ["toolbarPlacement"] : []),
        ...(previousBoostedZoom !== settings.boostedPdfZoom ? ["boostedPdfZoom"] : []),
        ...(previousMouseLeftDragDraw !== settings.mouseLeftDragDraw ? ["mouseLeftDragDraw"] : []),
        ...(previousMouseRightDragErase !== settings.mouseRightDragErase ? ["mouseRightDragErase"] : [])
      ]
    });
    if (previousPlacement !== settings.toolbarPlacement) {
      for (const session of this.allSessions()) session.remountToolbar();
    }
    if (previousBoostedZoom !== settings.boostedPdfZoom) {
      for (const session of this.allSessions()) session.setBoostedPdfZoom(settings.boostedPdfZoom);
    }
    if (
      previousMouseLeftDragDraw !== settings.mouseLeftDragDraw ||
      previousMouseRightDragErase !== settings.mouseRightDragErase
    ) {
      for (const session of this.allSessions()) session.updateMouseInputBindings();
    }
    if (
      previousAutomaticAnnotationRecovery !== settings.automaticAnnotationRecovery ||
      previousAnnotationBackupPath !== settings.annotationBackupPath
    ) {
      for (const session of this.allSessions()) session.updateAnnotationRecoveryOptions(settings);
    }
  }

  async readAllLogs(): Promise<string | null> {
    await this.vaultDebugLog.flush();
    const path = normalizePath(this.inkSettings.vaultDebugLogPath);
    if (!path || !await this.app.vault.adapter.exists(path)) return null;
    const logs = await this.app.vault.adapter.read(path);
    return logs.trim() ? logs : null;
  }

  /** Snapshot runtime metadata only when the user explicitly copies logs. */
  getCopiedLogDiagnostics(): CopiedLogDiagnostics {
    // The plugin-level snapshot is independent of the session map. A detached
    // session can leave stale listeners behind while making the map empty.
    this.writePluginCopiedLogUiSnapshot();
    for (const session of this.sessions.values()) {
      try {
        session.writeCopiedLogUiSnapshot();
      } catch (error) {
        this.vaultDebugLog.write("warn", "handwriting-ui-snapshot-failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const platform = Platform.isIosApp
      ? "iOS"
      : Platform.isAndroidApp
        ? "Android"
        : Platform.isMacOS
          ? "macOS"
          : Platform.isWin
            ? "Windows"
            : Platform.isLinux
              ? "Linux"
              : "unknown";
    const appMode = Platform.isMobile ? "mobile" : Platform.isDesktop ? "desktop" : "unknown";
    const runtime = Platform.isDesktopApp
      ? "Electron desktop"
      : Platform.isMobileApp
        ? "Capacitor mobile"
        : "Obsidian WebView";
    const devicePixelRatio = typeof window !== "undefined" ? window.devicePixelRatio : undefined;
    return {
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion,
      platform,
      appMode,
      runtime,
      profileSchemaVersion: PROFILE_SCHEMA_VERSION,
      ...(typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio) ? { devicePixelRatio } : {})
    };
  }

  private requestFlushAllSessions(): void {
    if (this.unloaded) return;
    this.flushDebounce.schedule(100, () => {
      for (const session of this.sessions.values()) {
        void session.flush();
      }
    });
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
    const leaves = [...new Set([
      ...this.app.workspace.getLeavesOfType("pdf"),
      ...this.app.workspace.getLeavesOfType("image")
    ])];
    await this.vaultDebugLog.writeUrgent("info", "scan-pdf-leaves", {
      pdfLeafCount: this.app.workspace.getLeavesOfType("pdf").length,
      imageLeafCount: this.app.workspace.getLeavesOfType("image").length,
      sessions: this.sessions.size,
      attachingLeaves: this.attachingLeaves.size,
      pdfHandwritingEnabled: this.inkSettings.enabledSurfaces.pdf,
      imageHandwritingEnabled: this.inkSettings.enabledSurfaces.image,
      mobile: Platform.isMobile,
      phone: Platform.isPhone
    });
    const live = new Set(leaves);
    const livePaths = new Set<string>();
    for (const [leaf, session] of [...this.sessions]) {
      const file = this.fileForLeaf(leaf);
      const pdfDisabled = file instanceof TFile
        && file.extension.toLowerCase() === "pdf"
        && !this.inkSettings.enabledSurfaces.pdf;
      const imageDisabled = file instanceof TFile
        && isSupportedImageFile(file)
        && !this.inkSettings.enabledSurfaces.image;
      if (!live.has(leaf) || pdfDisabled || imageDisabled) {
        const reason = pdfDisabled ? "pdf-disabled" : imageDisabled ? "image-disabled" : "leaf-closed";
        if (!this.removeSessionFromRegistry(leaf, session, reason)) continue;
        this.replacementAttachLeaves.delete(leaf);
        this.missingSessionRecoveryLeaves.delete(leaf);
        this.syncPersistSession(session, reason);
        await this.trackSessionDestroy(leaf, session, reason, { silent: true, alreadyPersisted: true })
          .catch(() => undefined);
        if (pdfDisabled || imageDisabled) {
          await this.vaultDebugLog.writeUrgent("info", `${pdfDisabled ? "pdf" : "image"} session disabled`, {
            document: file?.path ?? session.getDiagnostics().documentPath,
            ...(pdfDisabled ? { pdfHandwritingEnabled: false } : { imageHandwritingEnabled: false }),
            reason: "content-surface-setting-changed"
          });
        }
        continue;
      }
      if (!session.isAttached()) {
        if (!this.removeSessionFromRegistry(leaf, session, "detach-rescan")) continue;
        this.replacementAttachLeaves.add(leaf);
        this.syncPersistSession(session, "detach-rescan");
        await this.trackSessionDestroy(leaf, session, "detach-rescan", { silent: true, alreadyPersisted: true })
          .catch(() => undefined);
      }
    }

    await this.prepareMissingPdfSessionRecovery(leaves);

    for (const leaf of leaves) {
      if (this.sessions.has(leaf) || this.attachingLeaves.has(leaf)) continue;
      const view = leaf.view;
      const file = this.fileForLeaf(leaf);
      if (!(file instanceof TFile)) continue;
      const isPdf = file.extension.toLowerCase() === "pdf";
      const isImage = isSupportedImageFile(file);
      if (!isPdf && !isImage) continue;
      livePaths.add(file.path);
      if (isPdf && !this.inkSettings.enabledSurfaces.pdf) {
        await this.vaultDebugLog.writeUrgent("info", "pdf session disabled", {
          document: file.path,
          pdfHandwritingEnabled: false,
          reason: "content-surface-setting-disabled"
        });
        continue;
      }
      if (isImage && !this.inkSettings.enabledSurfaces.image) {
        await this.vaultDebugLog.writeUrgent("info", "image session disabled", {
          document: file.path,
          imageHandwritingEnabled: false,
          reason: "content-surface-setting-disabled"
        });
        continue;
      }
      if (!await this.waitForSessionDestroy(leaf)) {
        this.attachRetry.recordFailure(file.path);
        continue;
      }
      if (!this.attachRetry.canAttempt(file.path)) {
        await this.vaultDebugLog.writeUrgent("info", "session attach cooling", {
          document: file.path,
          mobile: Platform.isMobile
        });
        continue;
      }

      this.attachingLeaves.add(leaf);
      const replacementAttach = this.replacementAttachLeaves.has(leaf);
      await this.vaultDebugLog.writeUrgent("info", "handwriting-session-attach", {
        phase: "started",
        document: file.path,
        replacement: replacementAttach,
        leafContainerDebugId: getDebugNodeId(this.containerForLeaf(leaf)),
        registrySize: this.sessions.size,
        attachingLeaves: this.attachingLeaves.size
      });
      let adapter: AnnotationSurface | undefined;
      let attachStage = "started";
      let session: ViewerInkSession | undefined;
      let detached = false;
      try {
        attachStage = "resolve-viewer";
        await this.vaultDebugLog.writeUrgent("info", "session attach prepare", {
          document: file.path,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          hostChildCount: view.containerEl?.childElementCount ?? null
        });
        if (isPdf) {
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
          adapter = await NativePdfViewAdapter.attach(
            view.containerEl,
            this.sessionAdapterCallbacks(() => session),
            attachOptions
          );
        } else {
          await this.vaultDebugLog.writeUrgent("info", "image session attach begin", {
            document: file.path,
            extension: file.extension,
            mobile: Platform.isMobile,
            phone: Platform.isPhone
          });
          adapter = ImageViewAdapter.attach(
            view.containerEl,
            this.sessionAdapterCallbacks(() => session)
          );
        }
        if (!adapter) throw new Error("Annotation adapter unavailable after attach");
        attachStage = "adapter-attached";
        await this.vaultDebugLog.writeUrgent("info", "session attach adapter-ok", {
          document: file.path,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          domPageCount: adapter.pages().length,
          currentPage: adapter.getViewState().pageNumber
        });
        const pendingAddPage = isPdf ? this.pendingAddPageRestore.get(file.path) : undefined;
        const restoredAddPage = pendingAddPage && Date.now() - pendingAddPage.capturedAt <= 15_000
          ? pendingAddPage
          : undefined;
        if (pendingAddPage && !restoredAddPage) this.pendingAddPageRestore.delete(file.path);
        if (restoredAddPage) {
          adapter.restoreViewState(restoredAddPage.viewState);
          this.pendingAddPageRestore.delete(file.path);
          await this.vaultDebugLog.writeUrgent("info", "add-page lifecycle", {
            document: file.path,
            phase: "restore-before-session",
            addPageOperationId: restoredAddPage.operationId,
            beforeScale: restoredAddPage.viewState.scale,
            beforeScaleMode: restoredAddPage.viewState.scaleMode ?? null,
            pageCountBefore: restoredAddPage.pageCountBefore,
            pageCountAfter: adapter.pages().length
          });
        }
        attachStage = "session-create";
        session = await this.createInkSession(file, adapter, {
          ...(restoredAddPage ? { restoredAddPageMutation: restoredAddPage } : {}),
          onAddPageMutationStart: (state) => this.pendingAddPageRestore.set(file.path, state),
          onAddPageMutationResolved: (state) => {
            if (!detached && this.pendingAddPageRestore.get(file.path)?.operationId === state.operationId) {
              this.pendingAddPageRestore.delete(file.path);
            }
          },
          onDetached: () => {
            detached = true;
            const current = this.sessions.get(leaf);
            if (!current || current !== session) return;
            this.replacementAttachLeaves.add(leaf);
            if (!this.removeSessionFromRegistry(leaf, current, "on-detached")) return;
            this.syncPersistSession(current, "on-detached");
            scheduleSessionRecoveryAfterDestroy(
              this.trackSessionDestroy(leaf, current, "on-detached", { silent: true, alreadyPersisted: true }),
              () => {
                // The replacement viewer may already be present in this same
                // host mutation. Do not attach until stale listeners and the
                // old adapter have finished tearing down.
                this.scheduleDebouncedScan(0);
              },
              (reason, error) => {
                void this.vaultDebugLog.writeUrgent("warn", "handwriting-session-recovery", {
                  phase: "blocked",
                  reason,
                  document: file.path,
                  retryDelayMs: 0,
                  ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) })
                }).catch(() => undefined);
              }
            );
          }
        });
        attachStage = "session-created";
        if (this.unloaded) {
          this.syncPersistSession(session, "unloaded-during-attach");
          await this.trackSessionDestroy(leaf, session, "unloaded-during-attach", { silent: true, alreadyPersisted: true })
            .catch(() => undefined);
          continue;
        }
        if (detached) {
          const reason = "detached-during-attach";
          this.replacementAttachLeaves.add(leaf);
          this.syncPersistSession(session, reason);
          await this.trackSessionDestroy(leaf, session, reason, { silent: true, alreadyPersisted: true })
            .catch(() => undefined);
          await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-attach", {
            phase: "aborted",
            document: file.path,
            replacement: true,
            reason
          });
          this.scheduleDebouncedScan(0);
          continue;
        }
        const recoveringMissingSession = this.missingSessionRecoveryLeaves.has(leaf);
        attachStage = "session-register";
        this.registerSession(leaf, session, replacementAttach ? "replacement-attach" : "attach");
        attachStage = "registered";
        this.replacementAttachLeaves.delete(leaf);
        this.missingSessionRecoveryLeaves.delete(leaf);
        this.attachRetry.clear(file.path);
        await this.vaultDebugLog.writeUrgent("info", "handwriting-session-attach", {
          phase: "completed",
          document: file.path,
          replacement: replacementAttach,
          ...session.getUiLifecycleSnapshot("attach-completed")
        });
        if (recoveringMissingSession) {
          await this.vaultDebugLog.writeUrgent("info", "handwriting-session-recovery", {
            phase: "attached",
            reason: "visible-pdf-without-registered-session",
            document: file.path,
            registrySize: this.sessions.size,
            ...session.getUiLifecycleSnapshot("recovery-attached")
          });
        }
        await this.vaultDebugLog.writeUrgent("info", "session attach ok", {
          document: file.path,
          mobile: Platform.isMobile
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!session && adapter) {
          try {
            adapter.destroy();
            await this.vaultDebugLog.writeUrgent("info", "session attach adapter cleanup", {
              document: file.path,
              stage: attachStage,
              reason: "attach-failed-before-session-registration",
              destroyed: true
            });
          } catch (cleanupError) {
            await this.vaultDebugLog.writeUrgent("warn", "session attach adapter cleanup failed", {
              document: file.path,
              stage: attachStage,
              reason: "attach-failed-before-session-registration",
              destroyed: false,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            });
          }
        }
        const pagesMissing = message.includes("PDF page nodes missing");
        let dom: Record<string, unknown> = { viewerRoot: false };
        try {
          if (isPdf) {
            const preview = PdfViewerCompatibility.direct(view.containerEl);
            dom = describePdfPageDom(preview.viewerRoot);
          } else {
            dom = { imageElement: Boolean(view.containerEl.querySelector("img")) };
          }
        } catch (domError) {
          dom = {
            viewerRoot: false,
            domDescribeError: domError instanceof Error ? domError.message : String(domError)
          };
        }
        await this.vaultDebugLog.writeUrgent("warn", "session attach failed", {
          document: file.path,
          error: message,
          stack: error instanceof Error ? error.stack ?? null : null,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          stage: attachStage,
          pagesMissing,
          ...dom
        });
        await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-attach", {
          phase: "failed",
          document: file.path,
          replacement: replacementAttach,
          error: message
        });
        // After waiting for pages, keep mobile from re-attach-storming large PDFs.
        const delayMs = isPdf && pagesMissing && Platform.isMobile
          ? this.attachRetry.recordHardFailure(file.path)
          : this.attachRetry.recordFailure(file.path);
        if (this.missingSessionRecoveryLeaves.has(leaf)) {
          await this.vaultDebugLog.writeUrgent("warn", "handwriting-session-recovery", {
            phase: "blocked",
            reason: "session-attach-failed",
            document: file.path,
            retryDelayMs: delayMs,
            error: message
          });
        }
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
      if (file instanceof TFile && (file.extension.toLowerCase() === "pdf" || isSupportedImageFile(file))) {
        livePaths.add(file.path);
      }
    }
    this.attachRetry.retainOnly(livePaths);
    const wait = this.attachRetry.msUntilNextRetry(livePaths);
    if (wait != null) this.scheduleDebouncedScan(wait);
    this.reportMissingPdfSessionAfterSettle();
  }

  private scanPdfEmbeds(): void {
    if (!this.inkSettings.enabledSurfaces.pdf) {
      for (const [host, chrome] of [...this.embedChrome]) {
        chrome.destroy();
        this.embedChrome.delete(host);
      }
      return;
    }
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

  private sessionAdapterCallbacks(getSession: () => ViewerInkSession | undefined): AnnotationSurfaceCallbacks {
    return {
      onPagesChanged: (reason) => getSession()?.onPagesChanged(reason),
      onPageLifecycleChange: (change) => getSession()?.onPageLifecycleChange(change),
      onZoomChange: (change) => getSession()?.onZoomChange(change),
      onViewStateChange: (state, source) => getSession()?.onViewStateChange(state, source),
      onPageContentMutation: (recordCount) => getSession()?.onPdfPageContentMutation(recordCount),
      onCompatibilityWarning: (message) => {
        this.vaultDebugLog.write("warn", "compatibility", { message });
      },
      onDebugLog: (level, event, payload) => {
        this.vaultDebugLog.write(level, event, payload ?? {});
      }
    };
  }

  private async createInkSession(
    file: TFile,
    adapter: AnnotationSurface,
    options: {
      onDetached?: () => void;
      onAddPageMutationStart?: (state: AddPageMutationRestoreState) => void;
      onAddPageMutationResolved?: (state: AddPageMutationRestoreState) => void;
      restoredAddPageMutation?: AddPageMutationRestoreState;
    } = {}
  ): Promise<ViewerInkSession> {
    const textFiles = createVaultFsTextAdapter(this.app.vault);
    return ViewerInkSession.create({
      adapter,
      documentPath: file.path,
      pluginVersion: this.manifest.version,
      settings: this.inkSettings,
      sidecars: new SidecarRepository(textFiles, this.inkSettings.sidecarFolder, {
        automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
        backupFolder: this.inkSettings.annotationBackupPath
      }),
      recovery: new RecoveryRepository(textFiles, `${this.inkSettings.sidecarFolder}/recovery`, {
        automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
        backupFolder: this.inkSettings.annotationBackupPath
      }),
      saveSettings: async (preferences) => this.saveToolPreferences(preferences),
      savePluginSettings: async (patch) => {
        await this.saveSettings({ ...this.inkSettings, ...patch });
      },
      readDocument: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      // Flattened exports are shared by PDF and supported image surfaces; only
      // source-PDF mutations remain behind the PDF adapter extension.
      writeExport: async (name: string, bytes: Uint8Array) => this.writeAndOpenExport(file, name, bytes),
      ...(pdfSurfaceExtensions(adapter) ? {
        writeSourcePdf: async (bytes: Uint8Array) => {
          await this.app.vault.modifyBinary(file, bytes.slice().buffer);
        },
        onInsertPage: (pageNumber: number) => this.insertPageInPlace(file, pageNumber),
        onImportPages: (afterPage: number) => this.prepareImportedPages(file, afterPage),
        openScanDocument: () => new Promise((resolve) => new ScanDocumentModal(this.app, resolve).open()),
        onInsertScannedPages: (pageNumber: number, pages: readonly ScanDocumentPage[]) => this.insertScannedPagesInPlace(file, pageNumber, pages),
        onDeletePage: (pageNumber: number) => this.deletePageInPlace(file, pageNumber),
        onDeletePages: (pageNumbers: readonly number[]) => this.deletePagesInPlace(file, pageNumbers),
        writeSvgExport: async (name: string, svg: string) => this.writeSvgExport(file, name, svg)
      } : {}),
      notice: (message) => new Notice(message),
      decideUnsaved: () => this.decideUnsaved(),
      mouseDragScrollEnabled: () => this.inkSettings.mouseDragScroll,
      mouseLeftDragDrawEnabled: () => this.inkSettings.mouseLeftDragDraw,
      mouseRightDragEraseEnabled: () => this.inkSettings.mouseRightDragErase,
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
      ...(options.onDetached ? { onDetached: options.onDetached } : {}),
      ...(options.onAddPageMutationStart ? { onAddPageMutationStart: options.onAddPageMutationStart } : {}),
      ...(options.onAddPageMutationResolved ? { onAddPageMutationResolved: options.onAddPageMutationResolved } : {}),
      ...(options.restoredAddPageMutation ? { restoredAddPageMutation: options.restoredAddPageMutation } : {})
    });
  }

  private async prepareImportedPages(destination: TFile, afterPage: number): Promise<ImportedPdfPages | null> {
    const source = await new Promise<TFile | null>((resolve) => {
      new PdfImportFilePicker(
        this.app,
        destination.path,
        resolve,
        () => resolve(null)
      ).open();
    });
    if (!source) return null;

    const sourceBytes = new Uint8Array(await this.app.vault.readBinary(source));
    const sourcePageCount = await getPdfPageCount(sourceBytes);
    if (sourcePageCount < 1) throw new Error("The selected PDF has no pages.");

    let pageNumbers: number[] | null;
    if (sourcePageCount === 1) {
      pageNumbers = [1];
    } else {
      pageNumbers = await new Promise<number[] | null>((resolve) => {
        new PdfPageSelectionModal(
          this.app,
          sourcePageCount,
          (selected) => resolve(selected),
          () => resolve(null)
        ).open();
      });
    }
    if (!pageNumbers) return null;

    // Re-read destination after selection so a concurrent edit is not overwritten
    // with a stale snapshot, and so self-import uses an independent byte copy.
    const destinationBytes = new Uint8Array(await this.app.vault.readBinary(destination));
    return importPdfPages(destinationBytes, sourceBytes, afterPage, pageNumbers);
  }

  private async openPdfInNewTab(file: TFile): Promise<void> {
    if (this.unloaded) return;
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      this.vaultDebugLog.write("info", "embed annotate open tab", { document: file.path });
    } catch (error) {
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
      toolPreferences: structuredClone(preferences),
      mouseRightDragErase: preferences.eraser.eraseWithRightMouseButton
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

  /** Insert a blank page in place and remap persisted page-numbered stores. */
  private async insertPageInPlace(file: TFile, requestedPageNumber: number): Promise<number> {
    const source = new Uint8Array(await this.app.vault.readBinary(file));
    const inserted = await insertMatchingBlankPage(source, requestedPageNumber);
    const files = createVaultFsTextAdapter(this.app.vault);
    const sidecars = new SidecarRepository(files, this.inkSettings.sidecarFolder, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const recovery = new RecoveryRepository(files, `${this.inkSettings.sidecarFolder}/recovery`, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const identityInput = { vaultPath: file.path, contentHash: hashDocumentContent(source) };
    const sidecarBefore = await sidecars.loadForDocument(identityInput);
    const recoveryBefore = await recovery.loadForDocument(identityInput);
    const sidecarAfter = sidecarBefore ? insertPageIntoSidecar(sidecarBefore, inserted.pageNumber) : null;
    const recoveryAfter = recoveryBefore ? insertPageIntoSidecar(recoveryBefore, inserted.pageNumber) : null;
    let writeStage = "prepared";
    try {
      await this.vaultDebugLog.writeUrgent("info", "pdf-page-insert-start", {
        document: file.path,
        page: inserted.pageNumber,
        requestedPage: requestedPageNumber,
        hasSidecar: Boolean(sidecarBefore),
        hasRecovery: Boolean(recoveryBefore)
      });
      await writePdfAndAnnotationStoresAtomic({
        sourceBytes: source,
        updatedBytes: inserted.bytes,
        sidecarBefore,
        sidecarAfter,
        recoveryBefore,
        recoveryAfter,
        writePdf: async (bytes) => this.app.vault.modifyBinary(file, bytes.slice().buffer),
        saveSidecar: (value) => sidecars.save(value),
        saveRecovery: (value) => recovery.save(value),
        onStage: (stage) => { writeStage = stage; }
      });
      await this.vaultDebugLog.writeUrgent("info", "pdf-page-insert-complete", {
        document: file.path,
        page: inserted.pageNumber,
        requestedPage: requestedPageNumber,
        sourceBytes: source.byteLength,
        resultBytes: inserted.bytes.byteLength,
        sidecarRemapped: Boolean(sidecarAfter),
        recoveryRemapped: Boolean(recoveryAfter)
      });
      return inserted.pageNumber;
    } catch (error) {
      await this.vaultDebugLog.writeUrgent("error", "pdf-page-insert-failed", {
        document: file.path,
        page: inserted.pageNumber,
        requestedPage: requestedPageNumber,
        writeStage,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Inserts confirmed scanner pages and remaps all persisted page stores once. */
  private async insertScannedPagesInPlace(
    file: TFile,
    requestedPageNumber: number,
    pages: readonly ScanDocumentPage[]
  ): Promise<number> {
    const source = new Uint8Array(await this.app.vault.readBinary(file));
    const inserted = await insertScannedPages(source, requestedPageNumber, pages);
    const files = createVaultFsTextAdapter(this.app.vault);
    const sidecars = new SidecarRepository(files, this.inkSettings.sidecarFolder, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const recovery = new RecoveryRepository(files, `${this.inkSettings.sidecarFolder}/recovery`, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const documentId = createDocumentIdentity({ vaultPath: file.path }).id;
    const sidecarBefore = await sidecars.load(documentId);
    const recoveryBefore = await recovery.load(documentId);
    const sidecarAfter = sidecarBefore ? insertPagesIntoSidecar(sidecarBefore, inserted.pageNumber, inserted.count) : null;
    const recoveryAfter = recoveryBefore ? insertPagesIntoSidecar(recoveryBefore, inserted.pageNumber, inserted.count) : null;
    let writeStage = "prepared";
    try {
      await this.vaultDebugLog.writeUrgent("info", "pdf-scan-insert-start", {
        document: file.path,
        page: inserted.pageNumber,
        requestedPage: requestedPageNumber,
        count: inserted.count,
        hasSidecar: Boolean(sidecarBefore),
        hasRecovery: Boolean(recoveryBefore)
      });
      await writePdfAndAnnotationStoresAtomic({
        sourceBytes: source,
        updatedBytes: inserted.bytes,
        sidecarBefore,
        sidecarAfter,
        recoveryBefore,
        recoveryAfter,
        writePdf: async (bytes) => this.app.vault.modifyBinary(file, bytes.slice().buffer),
        saveSidecar: (value) => sidecars.save(value),
        saveRecovery: (value) => recovery.save(value),
        onStage: (stage) => { writeStage = stage; }
      });
      await this.vaultDebugLog.writeUrgent("info", "pdf-scan-insert-complete", {
        document: file.path,
        page: inserted.pageNumber,
        count: inserted.count,
        sourceBytes: source.byteLength,
        resultBytes: inserted.bytes.byteLength,
        sidecarRemapped: Boolean(sidecarAfter),
        recoveryRemapped: Boolean(recoveryAfter)
      });
      return inserted.pageNumber;
    } catch (error) {
      await this.vaultDebugLog.writeUrgent("error", "pdf-scan-insert-failed", {
        document: file.path,
        page: inserted.pageNumber,
        count: inserted.count,
        writeStage,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Delete one source page and its matching sidecar/recovery annotations together. */
  private async deletePageInPlace(file: TFile, pageNumber: number): Promise<void> {
    await this.deletePagesInPlace(file, [pageNumber]);
  }

  /** Delete one or more source pages in one PDF/store transaction. */
  private async deletePagesInPlace(file: TFile, requestedPageNumbers: readonly number[]): Promise<void> {
    const source = new Uint8Array(await this.app.vault.readBinary(file));
    const deletion = await deletePdfPages(source, requestedPageNumbers);
    const files = createVaultFsTextAdapter(this.app.vault);
    const sidecars = new SidecarRepository(files, this.inkSettings.sidecarFolder, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const recovery = new RecoveryRepository(files, `${this.inkSettings.sidecarFolder}/recovery`, {
      automaticRecovery: this.inkSettings.automaticAnnotationRecovery,
      backupFolder: this.inkSettings.annotationBackupPath
    });
    const identityInput = { vaultPath: file.path, contentHash: hashDocumentContent(source) };
    const sidecarBefore = await sidecars.loadForDocument(identityInput);
    const recoveryBefore = await recovery.loadForDocument(identityInput);
    const sidecarAfter = sidecarBefore
      ? deletion.pageNumbers.reduce((sidecar, pageNumber) => removePageFromSidecar(sidecar, pageNumber), sidecarBefore)
      : null;
    const recoveryAfter = recoveryBefore
      ? deletion.pageNumbers.reduce((recoverySnapshot, pageNumber) => removePageFromSidecar(recoverySnapshot, pageNumber), recoveryBefore)
      : null;
    const range = deletion.pageNumbers.length > 1;
    const eventPrefix = range ? "pdf-pages-delete" : "pdf-page-delete";
    let writeStage = "prepared";
    try {
      await this.vaultDebugLog.writeUrgent("info", `${eventPrefix}-start`, {
        document: file.path,
        page: deletion.pageNumbers[0],
        pageNumbers: deletion.pageNumbers,
        count: deletion.pageNumbers.length,
        firstPage: deletion.pageNumbers.at(-1),
        lastPage: deletion.pageNumbers[0],
        pageCountBefore: deletion.pageCountBefore,
        pageCountAfter: deletion.pageCountAfter,
        hasSidecar: Boolean(sidecarBefore),
        hasRecovery: Boolean(recoveryBefore)
      });
      await writePdfAndAnnotationStoresAtomic({
        sourceBytes: source,
        updatedBytes: deletion.bytes,
        sidecarBefore,
        sidecarAfter,
        recoveryBefore,
        recoveryAfter,
        writePdf: async (bytes) => this.app.vault.modifyBinary(file, bytes.slice().buffer),
        saveSidecar: (value) => sidecars.save(value),
        saveRecovery: (value) => recovery.save(value),
        onStage: (stage) => { writeStage = stage; }
      });
      await this.vaultDebugLog.writeUrgent("info", `${eventPrefix}-complete`, {
        document: file.path,
        page: deletion.pageNumbers[0],
        pageNumbers: deletion.pageNumbers,
        count: deletion.pageNumbers.length,
        firstPage: deletion.pageNumbers.at(-1),
        lastPage: deletion.pageNumbers[0],
        sourceBytes: source.byteLength,
        resultBytes: deletion.bytes.byteLength,
        sidecarRemapped: Boolean(sidecarAfter),
        recoveryRemapped: Boolean(recoveryAfter)
      });
    } catch (error) {
      await this.vaultDebugLog.writeUrgent("error", `${eventPrefix}-failed`, {
        document: file.path,
        page: deletion.pageNumbers[0],
        pageNumbers: deletion.pageNumbers,
        count: deletion.pageNumbers.length,
        writeStage,
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
    const extension = name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin";
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.${extension}` : `${stem}-${suffix}.${extension}`);
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
