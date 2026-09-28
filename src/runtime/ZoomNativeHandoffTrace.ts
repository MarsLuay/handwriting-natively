/** Bounded, local-only correlation for native PDF.js replacement and zoom handoff. */

const MAX_SIGNAL_TYPES = 8;
const MAX_PAGES = 64;
const MAX_VIEWER_GENERATIONS = 8;
const MAX_PHASES = 6;

export type NativeHandoffSignalName =
  | "canvasReplacement"
  | "pagerendered"
  | "resizeObserver"
  | "mutationObserver";

export type NativeHandoffPhase = "active-pinch" | "post-pinch-live-ink" | "handoff" | "settled";

export interface ZoomNativeHandoffSignalSummary {
  count: number;
  firstAt: number | null;
  lastAt: number | null;
  firstCallbackAt: number | null;
  lastCallbackAt: number | null;
  callbackWorkMs: number;
  pagesTouched: number[];
  viewerGenerations: number[];
  mountGenerations: Record<string, number>;
  replacementRecordCount: number;
}

export interface ZoomNativeHandoffPhaseSummary {
  firstAt: number;
  lastAt: number;
}

export interface ZoomNativeHandoffSummary {
  event: "zoom-native-handoff";
  zoomBurstId: string | null;
  firstNativeSignal: NativeHandoffSignalName | null;
  lastNativeSignal: NativeHandoffSignalName | null;
  firstNativeSignalAt: number | null;
  lastNativeSignalAt: number | null;
  firstCallbackAt: number | null;
  lastCallbackAt: number | null;
  firstStableRafAt: number | null;
  lastStableRafAt: number | null;
  nativeWaitMs: number | null;
  callbackToStableRafMs: number | null;
  nativeSignalCount: number;
  canvasReplacementCount: number;
  pagerenderedCount: number;
  observerCallbackCount: number;
  replacementRecordCount: number;
  pagesTouched: number[];
  viewerGenerations: number[];
  stableRafCount: number;
  stableRafHeldCount: number;
  stableRafReleasedCount: number;
  compositorHeldAtLastStableRaf: boolean | null;
  phases: Record<string, ZoomNativeHandoffPhaseSummary>;
  signals: Record<string, ZoomNativeHandoffSignalSummary>;
}

interface Clock {
  now(): number;
}

interface SignalInput {
  name: NativeHandoffSignalName;
  signalAt?: number;
  callbackAt?: number;
  callbackWorkMs?: number;
  pageNumbers?: number[] | undefined;
  viewerGeneration?: number | undefined;
  mountGenerations?: Record<string, number> | undefined;
  replacementRecordCount?: number;
  phase?: NativeHandoffPhase;
}

interface StableRafInput {
  at?: number;
  compositorHeld: boolean;
  phase?: NativeHandoffPhase;
}

const defaultClock: Clock = {
  now: () => (typeof performance === "undefined" ? Date.now() : performance.now())
};

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function finiteTime(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneSignal(signal: ZoomNativeHandoffSignalSummary): ZoomNativeHandoffSignalSummary {
  return {
    ...signal,
    pagesTouched: [...signal.pagesTouched],
    viewerGenerations: [...signal.viewerGenerations],
    mountGenerations: { ...signal.mountGenerations }
  };
}

function cloneSummary(summary: ZoomNativeHandoffSummary): ZoomNativeHandoffSummary {
  return {
    ...summary,
    pagesTouched: [...summary.pagesTouched],
    viewerGenerations: [...summary.viewerGenerations],
    phases: Object.fromEntries(Object.entries(summary.phases).map(([name, phase]) => [name, { ...phase }])),
    signals: Object.fromEntries(Object.entries(summary.signals).map(([name, signal]) => [name, cloneSignal(signal)]))
  };
}

function emptySignal(): ZoomNativeHandoffSignalSummary {
  return {
    count: 0,
    firstAt: null,
    lastAt: null,
    firstCallbackAt: null,
    lastCallbackAt: null,
    callbackWorkMs: 0,
    pagesTouched: [],
    viewerGenerations: [],
    mountGenerations: {},
    replacementRecordCount: 0
  };
}

function appendBoundedNumber(values: number[], value: number, limit: number): void {
  if (!Number.isFinite(value) || values.includes(value) || values.length >= limit) return;
  values.push(value);
  values.sort((left, right) => left - right);
}

function appendBoundedPages(values: number[], pages: number[] | undefined): void {
  for (const page of pages ?? []) {
    if (!Number.isFinite(page) || page < 1) continue;
    appendBoundedNumber(values, Math.floor(page), MAX_PAGES);
  }
}

function updatePhase(
  phases: Map<string, ZoomNativeHandoffPhaseSummary>,
  phase: NativeHandoffPhase | undefined,
  at: number
): void {
  if (!phase) return;
  if (!phases.has(phase) && phases.size >= MAX_PHASES) return;
  const current = phases.get(phase) ?? { firstAt: at, lastAt: at };
  current.firstAt = Math.min(current.firstAt, at);
  current.lastAt = Math.max(current.lastAt, at);
  phases.set(phase, current);
}

/**
 * Collects only the bounded timing breadcrumbs needed to explain a native
 * canvas replacement burst. It emits nothing until the owning session copies
 * the summary into its local diagnostics.
 */
export class ZoomNativeHandoffTrace {
  private readonly clock: Clock;
  private active = false;
  private zoomBurstId: string | null = null;
  private firstNativeSignal: NativeHandoffSignalName | null = null;
  private lastNativeSignal: NativeHandoffSignalName | null = null;
  private firstNativeSignalAt: number | null = null;
  private lastNativeSignalAt: number | null = null;
  private firstCallbackAt: number | null = null;
  private lastCallbackAt: number | null = null;
  private firstStableRafAt: number | null = null;
  private lastStableRafAt: number | null = null;
  private nativeSignalCount = 0;
  private canvasReplacementCount = 0;
  private pagerenderedCount = 0;
  private observerCallbackCount = 0;
  private replacementRecordCount = 0;
  private stableRafCount = 0;
  private stableRafHeldCount = 0;
  private stableRafReleasedCount = 0;
  private compositorHeldAtLastStableRaf: boolean | null = null;
  private readonly pagesTouched: number[] = [];
  private readonly viewerGenerations: number[] = [];
  private readonly phases = new Map<string, ZoomNativeHandoffPhaseSummary>();
  private readonly signals = new Map<string, ZoomNativeHandoffSignalSummary>();
  private lastSummary: ZoomNativeHandoffSummary | null = null;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? defaultClock;
  }

  isActive(): boolean {
    return this.active;
  }

  begin(zoomBurstId: string | null, at = this.clock.now()): void {
    this.active = true;
    this.zoomBurstId = zoomBurstId;
    this.firstNativeSignal = null;
    this.lastNativeSignal = null;
    this.firstNativeSignalAt = null;
    this.lastNativeSignalAt = null;
    this.firstCallbackAt = null;
    this.lastCallbackAt = null;
    this.firstStableRafAt = null;
    this.lastStableRafAt = null;
    this.nativeSignalCount = 0;
    this.canvasReplacementCount = 0;
    this.pagerenderedCount = 0;
    this.observerCallbackCount = 0;
    this.replacementRecordCount = 0;
    this.stableRafCount = 0;
    this.stableRafHeldCount = 0;
    this.stableRafReleasedCount = 0;
    this.compositorHeldAtLastStableRaf = null;
    this.pagesTouched.length = 0;
    this.viewerGenerations.length = 0;
    this.phases.clear();
    this.signals.clear();
    this.lastSummary = null;
    updatePhase(this.phases, "active-pinch", at);
  }

  noteSignal(input: SignalInput): void {
    if (!this.active) return;
    const signalAt = finiteTime(input.signalAt, this.clock.now());
    const callbackAt = input.callbackAt === undefined ? null : finiteTime(input.callbackAt, signalAt);
    const callbackWorkMs = Number.isFinite(input.callbackWorkMs) ? Math.max(0, input.callbackWorkMs ?? 0) : 0;
    if (!this.signals.has(input.name) && this.signals.size >= MAX_SIGNAL_TYPES) return;
    const signal = this.signals.get(input.name) ?? emptySignal();
    signal.count = Math.min(999, signal.count + 1);
    signal.firstAt = signal.firstAt === null ? roundMs(signalAt) : Math.min(signal.firstAt, roundMs(signalAt));
    signal.lastAt = signal.lastAt === null ? roundMs(signalAt) : Math.max(signal.lastAt, roundMs(signalAt));
    if (callbackAt !== null) {
      signal.firstCallbackAt = signal.firstCallbackAt === null
        ? roundMs(callbackAt)
        : Math.min(signal.firstCallbackAt, roundMs(callbackAt));
      signal.lastCallbackAt = signal.lastCallbackAt === null
        ? roundMs(callbackAt)
        : Math.max(signal.lastCallbackAt, roundMs(callbackAt));
      signal.callbackWorkMs = roundMs(signal.callbackWorkMs + callbackWorkMs);
      this.firstCallbackAt = this.firstCallbackAt === null
        ? roundMs(callbackAt)
        : Math.min(this.firstCallbackAt, roundMs(callbackAt));
      this.lastCallbackAt = this.lastCallbackAt === null
        ? roundMs(callbackAt)
        : Math.max(this.lastCallbackAt, roundMs(callbackAt));
    }
    appendBoundedPages(signal.pagesTouched, input.pageNumbers);
    appendBoundedPages(this.pagesTouched, input.pageNumbers);
    if (input.viewerGeneration !== undefined && Number.isFinite(input.viewerGeneration)) {
      appendBoundedNumber(signal.viewerGenerations, Math.floor(input.viewerGeneration), MAX_VIEWER_GENERATIONS);
      appendBoundedNumber(this.viewerGenerations, Math.floor(input.viewerGeneration), MAX_VIEWER_GENERATIONS);
    }
    for (const [page, generation] of Object.entries(input.mountGenerations ?? {}).slice(0, MAX_PAGES)) {
      if (Number.isFinite(generation) && Number.isFinite(Number(page))) {
        signal.mountGenerations[page] = Math.floor(generation);
      }
    }
    const replacements = Math.max(0, Math.floor(input.replacementRecordCount ?? 0));
    signal.replacementRecordCount = Math.min(999, signal.replacementRecordCount + replacements);
    this.signals.set(input.name, signal);
    this.nativeSignalCount = Math.min(999, this.nativeSignalCount + 1);
    if (input.name === "canvasReplacement") {
      this.canvasReplacementCount = Math.min(999, this.canvasReplacementCount + 1);
      this.replacementRecordCount = Math.min(999, this.replacementRecordCount + replacements);
    }
    if (input.name === "pagerendered") this.pagerenderedCount = Math.min(999, this.pagerenderedCount + 1);
    if (input.name === "resizeObserver" || input.name === "mutationObserver") {
      this.observerCallbackCount = Math.min(999, this.observerCallbackCount + 1);
    }
    if (this.firstNativeSignalAt === null || signalAt < this.firstNativeSignalAt) {
      this.firstNativeSignalAt = roundMs(signalAt);
      this.firstNativeSignal = input.name;
    }
    if (this.lastNativeSignalAt === null || signalAt >= this.lastNativeSignalAt) {
      this.lastNativeSignalAt = roundMs(signalAt);
      this.lastNativeSignal = input.name;
    }
    updatePhase(this.phases, input.phase, signalAt);
    this.signals.set(input.name, signal);
  }

  noteStableRaf(input: StableRafInput): void {
    if (!this.active || this.nativeSignalCount === 0) return;
    const at = finiteTime(input.at, this.clock.now());
    this.stableRafCount = Math.min(999, this.stableRafCount + 1);
    if (input.compositorHeld) this.stableRafHeldCount = Math.min(999, this.stableRafHeldCount + 1);
    else this.stableRafReleasedCount = Math.min(999, this.stableRafReleasedCount + 1);
    this.compositorHeldAtLastStableRaf = input.compositorHeld;
    this.firstStableRafAt = this.firstStableRafAt === null ? roundMs(at) : Math.min(this.firstStableRafAt, roundMs(at));
    this.lastStableRafAt = this.lastStableRafAt === null ? roundMs(at) : Math.max(this.lastStableRafAt, roundMs(at));
    updatePhase(this.phases, input.phase, at);
  }

  summary(): ZoomNativeHandoffSummary | null {
    return this.active ? this.buildSummary() : this.latestSummary();
  }

  finish(): ZoomNativeHandoffSummary | null {
    if (!this.active) return this.latestSummary();
    this.active = false;
    this.lastSummary = this.buildSummary();
    return cloneSummary(this.lastSummary);
  }

  latestSummary(): ZoomNativeHandoffSummary | null {
    return this.lastSummary ? cloneSummary(this.lastSummary) : null;
  }

  private buildSummary(): ZoomNativeHandoffSummary {
    const nativeWaitMs = this.firstNativeSignalAt !== null && this.firstCallbackAt !== null
      ? roundMs(Math.max(0, this.firstCallbackAt - this.firstNativeSignalAt))
      : null;
    const callbackToStableRafMs = this.lastCallbackAt !== null && this.firstStableRafAt !== null
      ? roundMs(Math.max(0, this.firstStableRafAt - this.lastCallbackAt))
      : null;
    return {
      event: "zoom-native-handoff",
      zoomBurstId: this.zoomBurstId,
      firstNativeSignal: this.firstNativeSignal,
      lastNativeSignal: this.lastNativeSignal,
      firstNativeSignalAt: this.firstNativeSignalAt,
      lastNativeSignalAt: this.lastNativeSignalAt,
      firstCallbackAt: this.firstCallbackAt,
      lastCallbackAt: this.lastCallbackAt,
      firstStableRafAt: this.firstStableRafAt,
      lastStableRafAt: this.lastStableRafAt,
      nativeWaitMs,
      callbackToStableRafMs,
      nativeSignalCount: this.nativeSignalCount,
      canvasReplacementCount: this.canvasReplacementCount,
      pagerenderedCount: this.pagerenderedCount,
      observerCallbackCount: this.observerCallbackCount,
      replacementRecordCount: this.replacementRecordCount,
      pagesTouched: [...this.pagesTouched],
      viewerGenerations: [...this.viewerGenerations],
      stableRafCount: this.stableRafCount,
      stableRafHeldCount: this.stableRafHeldCount,
      stableRafReleasedCount: this.stableRafReleasedCount,
      compositorHeldAtLastStableRaf: this.compositorHeldAtLastStableRaf,
      phases: Object.fromEntries([...this.phases.entries()].map(([name, phase]) => [name, { ...phase }])),
      signals: Object.fromEntries([...this.signals.entries()].map(([name, signal]) => [name, cloneSignal(signal)]))
    };
  }
}
