/** Threshold-gated local layout timings. Fast layout work is intentionally silent. */
export const LAYOUT_SLOW_MS = 8;
const MAX_PHASES = 12;
const MAX_OPERATION_KEYS = 24;
const MAX_SLOW_EVENTS = 8;
const MAX_WORST_EVENTS = 8;

export interface LayoutPhaseTiming {
  phase: string;
  durationMs: number;
}

export interface LayoutSlowEvent {
  event: "layout-slow";
  operation: string;
  reason: string | null;
  durationMs: number;
  thresholdMs: number;
  phaseDurations: Record<string, number>;
  slowPhases: LayoutPhaseTiming[];
  sampleCount: number;
  operationMaxMs: number;
}

export interface LayoutOperationResult {
  operation: string;
  reason: string | null;
  durationMs: number;
  phaseDurations: Record<string, number>;
  slowPhases: LayoutPhaseTiming[];
  slowEvent: LayoutSlowEvent | null;
}

export interface LayoutWorkTraceOptions {
  enabled?: () => boolean;
  now?: () => number;
}

interface OperationStats {
  count: number;
  maxMs: number;
  loggedMaxMs: number;
  logged: boolean;
}

export interface LayoutOperation {
  phase<T>(name: string, work: () => T): T;
  finish(): LayoutOperationResult | null;
}

/**
 * Measures a bounded layout operation without retaining DOM or annotation data.
 * One slow event is emitted per operation/reason pair, with a replacement only
 * when a later sample is materially worse. This keeps a ResizeObserver or zoom
 * burst from filling the local debug log while preserving its slowest evidence.
 */
export class LayoutWorkTrace {
  private readonly enabled: () => boolean;
  private readonly now: () => number;
  private readonly stats = new Map<string, OperationStats>();
  private readonly loggedKeys = new Set<string>();
  private slowEventCount = 0;
  private readonly worst: LayoutSlowEvent[] = [];

  constructor(options: LayoutWorkTraceOptions = {}) {
    this.enabled = options.enabled ?? (() => true);
    this.now = options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  }

  start(operation: string, reason: string | null = null): LayoutOperation {
    const enabled = this.enabled();
    const startedAt = enabled ? this.now() : 0;
    const phaseDurations = new Map<string, number>();
    let finished = false;
    return {
      phase: <T>(name: string, work: () => T): T => {
        if (!enabled || finished) return work();
        const phaseStartedAt = this.now();
        try {
          return work();
        } finally {
          if (phaseDurations.size < MAX_PHASES || phaseDurations.has(name)) {
            phaseDurations.set(name, roundMs(this.now() - phaseStartedAt));
          }
        }
      },
      finish: (): LayoutOperationResult | null => {
        if (!enabled || finished) return null;
        finished = true;
        const durationMs = roundMs(this.now() - startedAt);
        const phases = Object.fromEntries(phaseDurations.entries());
        const slowPhases = [...phaseDurations.entries()]
          .filter(([, duration]) => duration >= LAYOUT_SLOW_MS)
          .map(([phase, durationMs]) => ({ phase, durationMs }));
        const slow = durationMs >= LAYOUT_SLOW_MS || slowPhases.length > 0;
        let slowEvent: LayoutSlowEvent | null = null;
        if (slow) {
          const key = `${operation}|${reason ?? ""}`;
          const stats = this.stats.get(key) ?? { count: 0, maxMs: 0, loggedMaxMs: 0, logged: false };
          stats.count += 1;
          stats.maxMs = Math.max(stats.maxMs, durationMs);
          if (this.stats.size < MAX_OPERATION_KEYS || this.stats.has(key)) this.stats.set(key, stats);
          const firstForKey = !this.loggedKeys.has(key);
          const materiallyWorse = durationMs >= Math.max(LAYOUT_SLOW_MS * 2, stats.loggedMaxMs * 1.5);
          if ((firstForKey || materiallyWorse) && this.slowEventCount < MAX_SLOW_EVENTS) {
            this.loggedKeys.add(key);
            stats.logged = true;
            stats.loggedMaxMs = Math.max(stats.loggedMaxMs, durationMs);
            const event: LayoutSlowEvent = {
              event: "layout-slow",
              operation,
              reason,
              durationMs,
              thresholdMs: LAYOUT_SLOW_MS,
              phaseDurations: phases,
              slowPhases,
              sampleCount: stats.count,
              operationMaxMs: roundMs(stats.maxMs)
            };
            slowEvent = event;
            this.slowEventCount += 1;
            this.worst.push(event);
            this.worst.sort((a, b) => b.durationMs - a.durationMs);
            if (this.worst.length > MAX_WORST_EVENTS) this.worst.length = MAX_WORST_EVENTS;
          }
        }
        return { operation, reason, durationMs, phaseDurations: phases, slowPhases, slowEvent };
      }
    };
  }

  summary(): {
    slowEventCount: number;
    byOperation: Record<string, { count: number; maxMs: number }>;
    worst: LayoutSlowEvent[];
  } {
    const byOperation: Record<string, { count: number; maxMs: number }> = {};
    for (const [key, stats] of this.stats) {
      const operation = key.split("|", 1)[0] ?? key;
      const prior = byOperation[operation] ?? { count: 0, maxMs: 0 };
      prior.count += stats.count;
      prior.maxMs = roundMs(Math.max(prior.maxMs, stats.maxMs));
      byOperation[operation] = prior;
    }
    return {
      slowEventCount: this.slowEventCount,
      byOperation,
      worst: this.worst.map((event) => ({
        ...event,
        phaseDurations: { ...event.phaseDurations },
        slowPhases: event.slowPhases.map((phase) => ({ ...phase }))
      }))
    };
  }
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}
