import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
  class MockFileView {}
  class MockMarkdownView extends MockFileView {}
  return {
    ...actual,
    FileView: MockFileView,
    MarkdownView: MockMarkdownView,
    TFile: class {},
    Platform: { isMobile: false, isPhone: false, isIosApp: false },
    Plugin: class {},
    PluginSettingTab: class {}
  };
});

import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/model";
import NativePdfInkPlugin from "../src/main";
import { MarkdownViewAdapter } from "../src/integration/MarkdownViewAdapter";
import type { AnnotationSurface } from "../src/runtime/AnnotationSurface";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";

type Scanner = {
  scanMarkdownLeaves(): Promise<void>;
};

type TestSession = Pick<ViewerInkSession, "isAttached" | "getUiLifecycleSnapshot" | "getDiagnostics"> & {
  destroy(): Promise<boolean>;
};
type MarkdownModeObserver = { view: MarkdownView; host: HTMLElement; observer: MutationObserver };
const trackedModeObservers = new Set<Map<WorkspaceLeaf, MarkdownModeObserver>>();

function markdownLeaf(mode: "preview" | "source"): {
  leaf: WorkspaceLeaf;
  file: TFile;
  host: HTMLElement;
  preview: HTMLElement;
  setMode: (mode: "preview" | "source") => void;
} {
  const file = Object.create(TFile.prototype) as TFile;
  Object.defineProperties(file, {
    path: { configurable: true, value: "Notes/meeting.md" },
    extension: { configurable: true, value: "md" }
  });
  const host = document.createElement("div");
  const preview = document.createElement("div");
  preview.className = "markdown-preview-view";
  preview.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 800,
    width: 600, height: 800, toJSON: () => ({})
  });
  host.append(preview);
  document.body.append(host);
  const view = Object.create(MarkdownView.prototype) as MarkdownView;
  let currentMode = mode;
  Object.defineProperties(view, {
    file: { configurable: true, value: file },
    containerEl: { configurable: true, value: host },
    getMode: { configurable: true, value: () => currentMode },
    getViewType: { configurable: true, value: () => "markdown" }
  });
  return {
    leaf: { view } as unknown as WorkspaceLeaf,
    file,
    host,
    preview,
    setMode: (nextMode) => { currentMode = nextMode; }
  };
}

function createPluginHarness(mode: "preview" | "source", enabled: boolean) {
  const { leaf, file, host, preview, setMode } = markdownLeaf(mode);
  const sessions = new Map<WorkspaceLeaf, ViewerInkSession>();
  const markdownModeObservers = new Map<WorkspaceLeaf, MarkdownModeObserver>();
  trackedModeObservers.add(markdownModeObservers);
  let attachedAdapter: AnnotationSurface | undefined;
  const session: TestSession = {
    isAttached: () => true,
    getUiLifecycleSnapshot: () => ({}),
    getDiagnostics: () => ({ documentPath: file.path } as ReturnType<ViewerInkSession["getDiagnostics"]>),
    destroy: async () => { attachedAdapter?.destroy(); return true; }
  };
  const createInkSession = vi.fn(async (_file: TFile, adapter: AnnotationSurface) => {
    attachedAdapter = adapter;
    return session as unknown as ViewerInkSession;
  });
  const registerSession = vi.fn((target: WorkspaceLeaf, created: ViewerInkSession) => sessions.set(target, created));
  const scheduleDebouncedScan = vi.fn();
  const destroySessionWithTelemetry = vi.fn(async (_leaf: WorkspaceLeaf, destroyed: ViewerInkSession) => {
    await (destroyed as unknown as TestSession).destroy();
    return true;
  });
  const plugin = Object.create(NativePdfInkPlugin.prototype) as NativePdfInkPlugin;
  Object.assign(plugin, {
    app: {
      vault: { configDir: ".obsidian" },
      workspace: { getLeavesOfType: (type: string) => type === "markdown" ? [leaf] : [] }
    },
    inkSettings: {
      ...structuredClone(DEFAULT_SETTINGS),
      enabledSurfaces: { ...DEFAULT_SETTINGS.enabledSurfaces, markdown: enabled }
    },
    unloaded: false,
    sessions,
    markdownModeObservers,
    attachingLeaves: new Set<WorkspaceLeaf>(),
    attachRetry: {
      clear: vi.fn(),
      canAttempt: vi.fn(() => true),
      recordFailure: vi.fn(() => 100)
    },
    pendingSessionDestroy: new Map(),
    replacementAttachLeaves: new Set<WorkspaceLeaf>(),
    missingSessionRecoveryLeaves: new Set<WorkspaceLeaf>(),
    vaultDebugLog: { write: vi.fn(), writeUrgent: vi.fn(async () => undefined) },
    saveData: vi.fn(async () => undefined),
    updateSidebarSwipeBlocker: vi.fn(),
    scheduleDebouncedScan,
    waitForSessionDestroy: vi.fn(async () => true),
    createInkSession,
    registerSession,
    removeSessionFromRegistry: vi.fn((target: WorkspaceLeaf) => sessions.delete(target)),
    syncPersistSession: vi.fn(),
    destroySessionWithTelemetry
  });
  return {
    plugin,
    leaf,
    file,
    host,
    preview,
    setMode,
    markdownModeObservers,
    sessions,
    session: session as unknown as ViewerInkSession,
    createInkSession,
    registerSession,
    destroySessionWithTelemetry,
    scheduleDebouncedScan,
    scan: (plugin as unknown as Scanner).scanMarkdownLeaves.bind(plugin)
  };
}

afterEach(() => {
  for (const observers of trackedModeObservers) {
    for (const { observer } of observers.values()) observer.disconnect();
  }
  trackedModeObservers.clear();
  document.body.replaceChildren();
});

describe("Markdown runtime attachment", () => {
  it("attaches the Markdown Reading view through the existing shared session factory", async () => {
    const harness = createPluginHarness("preview", true);

    await harness.scan();

    expect(harness.createInkSession).toHaveBeenCalledOnce();
    const [, adapter] = harness.createInkSession.mock.calls[0] ?? [];
    expect(adapter).toBeInstanceOf(MarkdownViewAdapter);
    expect(adapter?.surfaceType).toBe("markdown");
    expect(harness.sessions.get(harness.leaf)).toBe(harness.session);
    expect(harness.registerSession).toHaveBeenCalled();
  });

  it("leaves Source mode native and detaches an existing Markdown session when disabled", async () => {
    const source = createPluginHarness("source", true);
    await source.scan();
    expect(source.createInkSession).not.toHaveBeenCalled();

    const disabled = createPluginHarness("preview", false);
    disabled.sessions.set(disabled.leaf, disabled.session);
    await disabled.scan();

    expect(disabled.createInkSession).not.toHaveBeenCalled();
    expect(disabled.sessions.has(disabled.leaf)).toBe(false);
    expect(disabled.destroySessionWithTelemetry).toHaveBeenCalled();
  });

  it("uses the Markdown setting to attach and detach already-open Reading views", async () => {
    const harness = createPluginHarness("preview", false);
    const enabled = structuredClone(DEFAULT_SETTINGS);
    enabled.enabledSurfaces.markdown = true;

    await harness.plugin.saveSettings(enabled);
    expect(harness.scheduleDebouncedScan).toHaveBeenCalledWith(0);
    await harness.scan();
    expect(harness.sessions.has(harness.leaf)).toBe(true);

    const disabled = structuredClone(enabled);
    disabled.enabledSurfaces.markdown = false;
    await harness.plugin.saveSettings(disabled);
    expect(harness.sessions.has(harness.leaf)).toBe(false);
    expect(harness.destroySessionWithTelemetry).toHaveBeenCalledOnce();
  });

  it("rescans when the Markdown view switches between Reading and Source modes", async () => {
    const harness = createPluginHarness("preview", true);
    await harness.scan();
    expect(harness.sessions.has(harness.leaf)).toBe(true);

    const sourceRoot = document.createElement("div");
    sourceRoot.className = "markdown-source-view";
    harness.setMode("source");
    harness.preview.replaceWith(sourceRoot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.scheduleDebouncedScan).toHaveBeenCalledWith(0);

    await harness.scan();
    expect(harness.sessions.has(harness.leaf)).toBe(false);
    expect(harness.destroySessionWithTelemetry).toHaveBeenCalledOnce();

    const previewRoot = document.createElement("div");
    previewRoot.className = "markdown-preview-view";
    previewRoot.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 800,
      width: 600, height: 800, toJSON: () => ({})
    });
    harness.setMode("preview");
    sourceRoot.replaceWith(previewRoot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.scan();

    expect(harness.createInkSession).toHaveBeenCalledTimes(2);
    expect(harness.sessions.has(harness.leaf)).toBe(true);
  });
});
