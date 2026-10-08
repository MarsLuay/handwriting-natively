/** Bounded, opt-in diagnostics for zoom frame gaps. No probe is armed until a zoom burst starts. */

import { EffectiveFrameBudget, type RuntimeFrameProfile } from "../logging/PerformanceMetrics";
import type { MobilePdfZoomTraceMode } from "./MobilePdfZoomDiagnostics";

/** Strict synchronous plugin-work budget; presentation cadence is runtime-measured. */
export const ZOOM_FRAME_SLOW_MS = 8;
const MAX_FRAMES = 32;
const MAX_WORST_FRAMES = 10;
const MAX_RETAINED_BURSTS = 5;
const MAX_PDF_SIGNALS = 16;
const EVENT_LOOP_PROBE_INTERVAL_MS = 50;

export type ZoomDiagnosticPhase = "active-pinch" | "post-pinch-live-ink" | "handoff" | "settled";
export type FrameAttribution =
  | "event-loop-starvation"
  | "pdf-render-burst"
  | "plugin-work"
  | "raf/compositor-delay"
  | "unknown";
export type FrameTelemetryLimitation =
  | "longtask-observer-unsupported"
  | "longtask-observer-install-failed";

export interface PerformanceObserverCapability {
  performanceObserverSupported: boolean;
  supportedEntryTypes: string[];
  longtaskSupported: boolean;
  eventTimingSupported: boolean;
  paintTimingSupported: boolean;
  longTaskObserverInstalled: boolean;
  longTaskObserverError: string | null;
}

export interface PdfSignalSummary {
  count: number;
  firstAt: number | null;
  lastAt: number | null;
  callbackWorkMs: number;
}

export interface KnownOperationTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface ZoomFrameRecord {
  event: "perf-unattributed-frame-gap";
  mode: MobilePdfZoomTraceMode;
  zoomBurstId: string | null;
  phase: ZoomDiagnosticPhase;
  frameDeltaMs: number;
  rafRequestedAt: number;
  rafCallbackAt: number;
  rafRequestToCallbackMs: number;
  previousRafCallbackAt: number | null;
  pluginWorkBeforeRafMs: number;
  pluginWorkInsideRafMs: number;
  eventLoopDelayMs: number;
  measuredPluginWorkMs: number;
  measuredPdfCallbackWorkMs: number;
  longTaskObserverSupported: boolean;
  limitations: FrameTelemetryLimitation[];
  longestObservedLongTaskMs: number;
  pdfSignals: Record<string, PdfSignalSummary>;
  observerSignals: Record<string, PdfSignalSummary>;
  knownOperations: Record<string, KnownOperationTiming>;
  documentHidden: boolean | null;
  visualViewportScale: number | null;
  devicePixelRatio: number | null;
  attribution: FrameAttribution;
  frameTiming: RuntimeFrameProfile;
}

export interface FrameAttributionSummary {
  mode: MobilePdfZoomTraceMode | "mixed";
  modes: Record<string, number>;
  slowFrameCount: number;
  byAttribution: Record<string, number>;
  limitations: FrameTelemetryLimitation[];
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  maxRafSchedulingDelayMs: number;
  maxEventLoopDelayMs: number;
  maxMeasuredPluginWorkMs: number;
  maxMeasuredPdfCallbackWorkMs: number;
  knownOperations: Record<string, KnownOperationTiming>;
  unattributedFrameCount: number;
  worstFrames: ZoomFrameRecord[];
  capabilities: PerformanceObserverCapability;
  frameTiming: RuntimeFrameProfile;
}

interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface CompletedBurst {
  summary: FrameAttributionSummary;
  frameGaps: number[];
}

const defaultClock: Clock = {
  now: () => (typeof performance === "undefined" ? Date.now() : performance.now()),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs) as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: (timer) => window.clearTimeout(timer as unknown as number)
};

export function performanceObserverCapability(): PerformanceObserverCapability {
  const observer = typeof PerformanceObserver === "undefined" ? null : PerformanceObserver;
  const supportedEntryTypes: string[] = [];
  const entryTypes: unknown = observer?.supportedEntryTypes;
  if (Array.isArray(entryTypes)) {
    for (const entryType of entryTypes) {
      if (typeof entryType === "string") supportedEntryTypes.push(entryType);
    }
  }
  return {
    performanceObserverSupported: observer !== null,
    supportedEntryTypes,
    longtaskSupported: supportedEntryTypes.includes("longtask"),
    eventTimingSupported: supportedEntryTypes.includes("event"),
    paintTimingSupported: supportedEntryTypes.includes("paint"),
    longTaskObserverInstalled: false,
    longTaskObserverError: null
  };
}

function emptySignal(): PdfSignalSummary {
  return { count: 0, firstAt: null, lastAt: null, callbackWorkMs: 0 };
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function cloneSignals(signals: Map<string, PdfSignalSummary>): Record<string, PdfSignalSummary> {
  return Object.fromEntries([...signals.entries()].map(([name, value]) => [name, { ...value }]));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export class ZoomFrameDiagnostics {
  private readonly clock: Clock;
  private readonly capability: PerformanceObserverCapability;
  private readonly frames: ZoomFrameRecord[] = [];
  private readonly worst: ZoomFrameRecord[] = [];
  private readonly frameGaps: number[] = [];
  private readonly byAttribution = new Map<string, number>();
  private readonly pdfSignals = new Map<string, PdfSignalSummary>();
  private readonly observerSignals = new Map<string, PdfSignalSummary>();
  private readonly knownOperations = new Map<string, KnownOperationTiming>();
  /** Retain bounded evidence from recent bursts so a short follow-up tap cannot hide a stall. */
  private readonly completedBursts: CompletedBurst[] = [];
  private phase: ZoomDiagnosticPhase = "settled";
  private mode: MobilePdfZoomTraceMode = "native";
  private pendingMode: MobilePdfZoomTraceMode = "native";
  private zoomBurstId: string | null = null;
  private previousRafCallbackAt: number | null = null;
  private lastEventLoopDelayMs = 0;
  private longestObservedLongTaskMs = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private pluginWorkTotalMs = 0;
  private pdfCallbackWorkTotalMs = 0;

  constructor(
    clock: Clock = defaultClock,
    private readonly frameBudget = new EffectiveFrameBudget()
  ) {
    this.clock = clock;
    this.capability = performanceObserverCapability();
  }

  setMode(mode: MobilePdfZoomTraceMode): void {
    this.pendingMode = mode;
  }

  begin(zoomBurstId: string | null, at = this.clock.now(), mode = this.pendingMode): void {
    this.stopProbe();
    this.active = true;
    this.mode = mode;
    this.pendingMode = "native";
    this.zoomBurstId = zoomBurstId;
    this.phase = "active-pinch";
    this.previousRafCallbackAt = null;
    this.lastEventLoopDelayMs = 0;
    this.longestObservedLongTaskMs = 0;
    this.frames.length = 0;
    this.worst.length = 0;
    this.frameGaps.length = 0;
    this.byAttribution.clear();
    this.capability.longTaskObserverInstalled = false;
    this.capability.longTaskObserverError = null;
    this.pluginWorkTotalMs = 0;
    this.pdfCallbackWorkTotalMs = 0;
    this.knownOperations.clear();
    this.pdfSignals.clear();
    this.observerSignals.clear();
    this.scheduleProbe(at + EVENT_LOOP_PROBE_INTERVAL_MS);
  }

  setPhase(phase: ZoomDiagnosticPhase): void {
    if (this.active) this.phase = phase;
  }

  setLongTaskObserverState(installed: boolean, error: string | null = null): void {
    this.capability.longTaskObserverInstalled = installed;
    this.capability.longTaskObserverError = error;
  }

  noteLongTask(durationMs: number): void {
    if (this.active) this.longestObservedLongTaskMs = Math.max(this.longestObservedLongTaskMs, durationMs);
  }

  notePdfSignal(name: string, callbackWorkMs = 0, at = this.clock.now()): void {
    if (!this.active) return;
    this.noteSignal(this.pdfSignals, name, callbackWorkMs, at);
    this.pdfCallbackWorkTotalMs += Math.max(0, callbackWorkMs);
  }

  noteObserverSignal(name: "resizeObserver" | "mutationObserver", callbackWorkMs = 0, at = this.clock.now()): void {
    if (!this.active) return;
    this.noteSignal(this.observerSignals, name, callbackWorkMs, at);
  }

  notePluginOperation(name: string, durationMs: number): void {
    if (!this.active || durationMs < ZOOM_FRAME_SLOW_MS) return;
    const current = this.knownOperations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs = rounded(current.totalMs + durationMs);
    current.maxMs = rounded(Math.max(current.maxMs, durationMs));
    this.knownOperations.set(name, current);
  }

  recordFrame(input: {
    requestedAt: number;
    callbackAt: number;
    pluginWorkMs: number;
    pluginWorkBeforeRafMs?: number;
    context?: {
      documentHidden?: boolean | null;
      visualViewportScale?: number | null;
      devicePixelRatio?: number | null;
    };
  }): ZoomFrameRecord | null {
    if (!this.active) return null;
    this.frameBudget.observeRaf(input.callbackAt, input.context?.documentHidden === true);
    const frameTiming = this.frameBudget.snapshot();
    const rafRequestToCallbackMs = Math.max(0, input.callbackAt - input.requestedAt);
    const frameDeltaMs = this.previousRafCallbackAt === null
      ? 0
      : Math.max(0, input.callbackAt - this.previousRafCallbackAt);
    const eventLoopDelayMs = this.lastEventLoopDelayMs;
    const pdfCallbackWorkMs = this.pdfCallbackWorkTotalMs;
    const previousRafCallbackAt = this.previousRafCallbackAt;
    this.pluginWorkTotalMs += Math.max(0, input.pluginWorkMs);
    this.pdfCallbackWorkTotalMs = 0;
    this.previousRafCallbackAt = input.callbackAt;
    if (frameDeltaMs < frameTiming.lateFrameThresholdMs) return null;

    const measuredPluginWorkMs = Math.max(0, input.pluginWorkMs);
    const attribution = this.attribute({
      frameDeltaMs,
      rafRequestToCallbackMs,
      eventLoopDelayMs,
      measuredPluginWorkMs,
      pdfCallbackWorkMs,
      lateFrameThresholdMs: frameTiming.lateFrameThresholdMs
    });
    const record: ZoomFrameRecord = {
      event: "perf-unattributed-frame-gap",
      mode: this.mode,
      zoomBurstId: this.zoomBurstId,
      phase: this.phase,
      frameDeltaMs: rounded(frameDeltaMs),
      rafRequestedAt: rounded(input.requestedAt),
      rafCallbackAt: rounded(input.callbackAt),
      rafRequestToCallbackMs: rounded(rafRequestToCallbackMs),
      previousRafCallbackAt: previousRafCallbackAt === null ? null : rounded(previousRafCallbackAt),
      pluginWorkBeforeRafMs: rounded(input.pluginWorkBeforeRafMs ?? 0),
      pluginWorkInsideRafMs: rounded(measuredPluginWorkMs),
      eventLoopDelayMs: rounded(eventLoopDelayMs),
      measuredPluginWorkMs: rounded(measuredPluginWorkMs),
      measuredPdfCallbackWorkMs: rounded(pdfCallbackWorkMs),
      longTaskObserverSupported: this.capability.longtaskSupported,
      limitations: this.currentLimitations(),
      longestObservedLongTaskMs: rounded(this.longestObservedLongTaskMs),
      pdfSignals: cloneSignals(this.pdfSignals),
      observerSignals: cloneSignals(this.observerSignals),
      knownOperations: Object.fromEntries([...this.knownOperations.entries()].map(([name, value]) => [name, { ...value }])),
      documentHidden: input.context?.documentHidden ?? null,
      visualViewportScale: input.context?.visualViewportScale ?? null,
      devicePixelRatio: input.context?.devicePixelRatio ?? null,
      attribution,
      frameTiming
    };
    this.frameGaps.push(record.frameDeltaMs);
    if (this.frameGaps.length > MAX_FRAMES) this.frameGaps.shift();
    this.frames.push(record);
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    this.byAttribution.set(attribution, (this.byAttribution.get(attribution) ?? 0) + 1);
    this.worst.push(record);
    this.worst.sort((a, b) => b.frameDeltaMs - a.frameDeltaMs);
    if (this.worst.length > MAX_WORST_FRAMES) this.worst.length = MAX_WORST_FRAMES;
    return attribution === "plugin-work" ? null : record;
  }

  summary(): FrameAttributionSummary {
    const current = this.currentSummary();
    const includeCurrent = this.active || this.completedBursts.length === 0;
    const summaries = [
      ...this.completedBursts.map((burst) => burst.summary),
      ...(includeCurrent ? [current] : [])
    ];
    const gaps = [
      ...this.completedBursts.flatMap((burst) => burst.frameGaps),
      ...(includeCurrent ? this.frameGaps : [])
    ];
    const byAttribution: Record<string, number> = {};
    const limitations = new Set<FrameTelemetryLimitation>();
    const knownOperations = new Map<string, KnownOperationTiming>();
    const worstFrames = summaries.flatMap((summary) => summary.worstFrames)
      .sort((a, b) => b.frameDeltaMs - a.frameDeltaMs)
      .slice(0, MAX_WORST_FRAMES);
    for (const summary of summaries) {
      for (const [name, count] of Object.entries(summary.byAttribution)) {
        byAttribution[name] = (byAttribution[name] ?? 0) + count;
      }
      for (const limitation of summary.limitations) limitations.add(limitation);
      for (const [name, timing] of Object.entries(summary.knownOperations)) {
        const existing = knownOperations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
        existing.count += timing.count;
        existing.totalMs = rounded(existing.totalMs + timing.totalMs);
        existing.maxMs = rounded(Math.max(existing.maxMs, timing.maxMs));
        knownOperations.set(name, existing);
      }
    }
    const modes: Record<string, number> = {};
    for (const summary of summaries) {
      modes[summary.mode] = (modes[summary.mode] ?? 0) + 1;
    }
    const modeNames = Object.keys(modes);
    return {
      mode: modeNames.length === 1 ? modeNames[0] as MobilePdfZoomTraceMode : "mixed",
      modes,
      slowFrameCount: summaries.reduce((total, summary) => total + summary.slowFrameCount, 0),
      byAttribution,
      limitations: [...limitations],
      maxFrameGapMs: rounded(Math.max(0, ...gaps)),
      p95FrameGapMs: rounded(percentile(gaps, 0.95)),
      maxRafSchedulingDelayMs: rounded(Math.max(0, ...summaries.map((summary) => summary.maxRafSchedulingDelayMs))),
      maxEventLoopDelayMs: rounded(Math.max(0, ...summaries.map((summary) => summary.maxEventLoopDelayMs))),
      maxMeasuredPluginWorkMs: rounded(Math.max(0, ...summaries.map((summary) => summary.maxMeasuredPluginWorkMs))),
      maxMeasuredPdfCallbackWorkMs: rounded(Math.max(0, ...summaries.map((summary) => summary.maxMeasuredPdfCallbackWorkMs))),
      knownOperations: Object.fromEntries([...knownOperations.entries()].map(([name, value]) => [name, { ...value }])),
      unattributedFrameCount: summaries.reduce((total, summary) => total + summary.unattributedFrameCount, 0),
      worstFrames: worstFrames.map((frame) => ({
        ...frame,
        pdfSignals: { ...frame.pdfSignals },
        observerSignals: { ...frame.observerSignals },
        knownOperations: { ...frame.knownOperations },
        limitations: [...frame.limitations]
      })),
      capabilities: { ...current.capabilities, supportedEntryTypes: [...current.capabilities.supportedEntryTypes] },
      frameTiming: { ...current.frameTiming }
    };
  }

  finish(): FrameAttributionSummary {
    if (!this.active) return this.summary();
    const current = this.currentSummary();
    this.completedBursts.unshift({ summary: current, frameGaps: [...this.frameGaps] });
    if (this.completedBursts.length > MAX_RETAINED_BURSTS) this.completedBursts.length = MAX_RETAINED_BURSTS;
    this.active = false;
    this.stopProbe();
    this.phase = "settled";
    return this.summary();
  }

  private currentSummary(): FrameAttributionSummary {
    return {
      mode: this.mode,
      modes: { [this.mode]: 1 },
      slowFrameCount: this.frameGaps.length,
      byAttribution: Object.fromEntries(this.byAttribution),
      limitations: this.currentLimitations(),
      maxFrameGapMs: rounded(Math.max(0, ...this.frameGaps)),
      p95FrameGapMs: rounded(percentile(this.frameGaps, 0.95)),
      maxRafSchedulingDelayMs: rounded(Math.max(0, ...this.frames.map((frame) => frame.rafRequestToCallbackMs))),
      maxEventLoopDelayMs: rounded(Math.max(0, ...this.frames.map((frame) => frame.eventLoopDelayMs))),
      maxMeasuredPluginWorkMs: rounded(Math.max(0, ...this.frames.map((frame) => frame.measuredPluginWorkMs))),
      maxMeasuredPdfCallbackWorkMs: rounded(Math.max(0, ...this.frames.map((frame) => frame.measuredPdfCallbackWorkMs))),
      knownOperations: Object.fromEntries([...this.knownOperations.entries()].map(([name, value]) => [name, { ...value }])),
      unattributedFrameCount: this.frames.filter((frame) => frame.attribution !== "plugin-work" && frame.attribution !== "pdf-render-burst" && frame.attribution !== "event-loop-starvation").length,
      worstFrames: this.worst.map((frame) => ({ ...frame, pdfSignals: { ...frame.pdfSignals }, observerSignals: { ...frame.observerSignals }, knownOperations: { ...frame.knownOperations }, limitations: [...frame.limitations] })),
      capabilities: { ...this.capability, supportedEntryTypes: [...this.capability.supportedEntryTypes] },
      frameTiming: this.frameBudget.snapshot()
    };
  }

  private attribute(input: {
    frameDeltaMs: number;
    rafRequestToCallbackMs: number;
    eventLoopDelayMs: number;
    measuredPluginWorkMs: number;
    pdfCallbackWorkMs: number;
    lateFrameThresholdMs: number;
  }): FrameAttribution {
    if (input.measuredPluginWorkMs >= ZOOM_FRAME_SLOW_MS && input.measuredPluginWorkMs >= input.frameDeltaMs * 0.5) return "plugin-work";
    if (input.eventLoopDelayMs >= ZOOM_FRAME_SLOW_MS && input.eventLoopDelayMs >= input.frameDeltaMs * 0.5) return "event-loop-starvation";
    if (input.pdfCallbackWorkMs >= ZOOM_FRAME_SLOW_MS && input.pdfCallbackWorkMs >= input.frameDeltaMs * 0.5) return "pdf-render-burst";
    if (input.rafRequestToCallbackMs >= input.lateFrameThresholdMs && input.rafRequestToCallbackMs >= input.frameDeltaMs * 0.5) return "raf/compositor-delay";
    return "unknown";
  }

  private currentLimitations(): FrameTelemetryLimitation[] {
    if (!this.capability.longtaskSupported) return ["longtask-observer-unsupported"];
    if (!this.capability.longTaskObserverInstalled) return ["longtask-observer-install-failed"];
    return [];
  }

  private noteSignal(target: Map<string, PdfSignalSummary>, name: string, callbackWorkMs: number, at: number): void {
    if (!target.has(name) && target.size >= MAX_PDF_SIGNALS) return;
    const current = target.get(name) ?? emptySignal();
    current.count += 1;
    current.firstAt ??= rounded(at);
    current.lastAt = rounded(at);
    current.callbackWorkMs = rounded(current.callbackWorkMs + Math.max(0, callbackWorkMs));
    target.set(name, current);
  }

  private scheduleProbe(expectedAt: number): void {
    if (!this.active) return;
    const scheduledAt = this.clock.now();
    this.probeTimer = this.clock.setTimeout(() => {
      this.probeTimer = null;
      if (!this.active) return;
      const ranAt = this.clock.now();
      this.lastEventLoopDelayMs = Math.max(0, ranAt - expectedAt);
      this.scheduleProbe(ranAt + EVENT_LOOP_PROBE_INTERVAL_MS);
    }, Math.max(0, expectedAt - scheduledAt));
  }

  private stopProbe(): void {
    if (this.probeTimer !== null) this.clock.clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}
