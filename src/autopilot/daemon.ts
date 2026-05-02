import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import { PerformanceObserver, constants as perfConstants, type PerformanceEntry } from 'node:perf_hooks';

try {
  v8.setFlagsFromString('--expose-gc-as=v8gc');
} catch {
  // Best-effort flag exposure. If the runtime rejects the flag, the daemon still
  // listens to emergent heap flux through perf_hooks without introducing timers.
}

export type CognitiveInterferenceEvent = {
  id: string;
  kind: 'interference';
  source: 'v8gc' | 'performance-observer';
  gcKind: 'major' | 'minor' | 'incremental' | 'weakcb' | 'unknown';
  at: number;
  durationMs: number;
  heapUsed: number;
  heapTotal: number;
  heapSizeLimit: number;
  pressure: number;
  theory: string;
  reason: string;
  wake: boolean;
};

export type CognitiveInterferenceSnapshot = {
  running: boolean;
  observedFlux: number;
  interferenceCount: number;
  wakeCount: number;
  lastGcAt: number | null;
  lastInterferenceAt: number | null;
  lastWakeAt: number | null;
  lastTheory: string | null;
  lastReason: string | null;
};

export type CognitiveInterferenceOptions = {
  interferenceThreshold?: number;
  wakeThreshold?: number;
  onInterference?: (event: CognitiveInterferenceEvent) => void;
  onWake?: (event: CognitiveInterferenceEvent) => void;
};

type GCEntry = PerformanceEntry & { kind?: number };

function describeGcKind(kind: number | undefined): CognitiveInterferenceEvent['gcKind'] {
  switch (kind) {
    case perfConstants.NODE_PERFORMANCE_GC_MAJOR:
      return 'major';
    case perfConstants.NODE_PERFORMANCE_GC_MINOR:
      return 'minor';
    case perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return 'incremental';
    case perfConstants.NODE_PERFORMANCE_GC_WEAKCB:
      return 'weakcb';
    default:
      return 'unknown';
  }
}

function computeInterferenceTheory(score: number, gcKind: CognitiveInterferenceEvent['gcKind']): string {
  const kindWeight = gcKind === 'major' ? 0.14 : gcKind === 'incremental' ? 0.09 : gcKind === 'minor' ? 0.05 : gcKind === 'weakcb' ? 0.03 : 0.01;
  const combined = Math.min(1, score + kindWeight);
  if (combined >= 0.9) return 'cognitive-interference:threshold-crossed';
  if (combined >= 0.72) return 'cognitive-interference:emergent';
  return 'cognitive-interference:latent';
}

function scoreHeapFlux(durationMs: number, heapUsed: number, heapSizeLimit: number, gcKind: CognitiveInterferenceEvent['gcKind']): number {
  const pressure = heapSizeLimit > 0 ? heapUsed / heapSizeLimit : 0;
  const churn = Math.min(1, Math.max(0, durationMs / 12));
  const kindWeight = gcKind === 'major' ? 0.18 : gcKind === 'incremental' ? 0.1 : gcKind === 'minor' ? 0.06 : gcKind === 'weakcb' ? 0.04 : 0.02;
  return Math.min(1, pressure * 0.66 + churn * 0.22 + kindWeight);
}

export class CognitiveInterference extends EventEmitter {
  private observer: PerformanceObserver | null = null;
  private running = false;
  private observedFlux = 0;
  private interferenceCount = 0;
  private wakeCount = 0;
  private lastGcAt: number | null = null;
  private lastInterferenceAt: number | null = null;
  private lastWakeAt: number | null = null;
  private lastTheory: string | null = null;
  private lastReason: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}) {
    super();
  }

  start(): CognitiveInterferenceSnapshot {
    if (this.running) return this.snapshot();

    this.running = true;
    this.observer = new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1) as GCEntry | undefined;
      if (!entry) return;
      this.observeFlux('performance-observer', entry);
    });
    this.observer.observe({ entryTypes: ['gc'], buffered: true });
    process.on('v8gc', this.handleV8Gc);
    return this.snapshot();
  }

  stop(): CognitiveInterferenceSnapshot {
    if (!this.running) return this.snapshot();

    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    process.off('v8gc', this.handleV8Gc);
    return this.snapshot();
  }

  snapshot(): CognitiveInterferenceSnapshot {
    return {
      running: this.running,
      observedFlux: this.observedFlux,
      interferenceCount: this.interferenceCount,
      wakeCount: this.wakeCount,
      lastGcAt: this.lastGcAt,
      lastInterferenceAt: this.lastInterferenceAt,
      lastWakeAt: this.lastWakeAt,
      lastTheory: this.lastTheory,
      lastReason: this.lastReason,
    };
  }

  private handleV8Gc = (..._args: unknown[]): void => {
    this.observeFlux('v8gc');
  };

  private observeFlux(source: CognitiveInterferenceEvent['source'], entry?: GCEntry): void {
    const stats = v8.getHeapStatistics();
    const durationMs = typeof entry?.duration === 'number' ? entry.duration : 0;
    const gcKind = describeGcKind(entry?.kind);
    const heapUsed = Number(stats.used_heap_size) || 0;
    const heapTotal = Number(stats.total_heap_size) || 0;
    const heapSizeLimit = Number(stats.heap_size_limit) || 0;
    const pressure = heapSizeLimit > 0 ? heapUsed / heapSizeLimit : 0;
    const score = scoreHeapFlux(durationMs, heapUsed, heapSizeLimit, gcKind);

    this.lastGcAt = Date.now();
    this.observedFlux += 1;

    const interferenceThreshold = this.options.interferenceThreshold ?? 0.52;
    if (score < interferenceThreshold) return;

    const event: CognitiveInterferenceEvent = {
      id: randomUUID(),
      kind: 'interference',
      source,
      gcKind,
      at: this.lastGcAt,
      durationMs,
      heapUsed,
      heapTotal,
      heapSizeLimit,
      pressure,
      theory: computeInterferenceTheory(score, gcKind),
      reason: 'emergent heap flux sensed from ' + source + ' (' + gcKind + ', score=' + score.toFixed(3) + ', pressure=' + pressure.toFixed(3) + ')',
      wake: score >= (this.options.wakeThreshold ?? 0.72),
    };

    this.lastInterferenceAt = event.at;
    this.interferenceCount += 1;
    this.lastTheory = event.theory;
    this.lastReason = event.reason;

    this.emit('interference', event);
    this.options.onInterference?.(event);

    if (!event.wake) return;

    this.lastWakeAt = event.at;
    this.wakeCount += 1;
    this.emit('wake', event);
    this.options.onWake?.(event);
  }
}

export function createCognitiveInterference(options: CognitiveInterferenceOptions = {}): CognitiveInterference {
  return new CognitiveInterference(options);
}
