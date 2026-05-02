import { randomUUID, createHash } from 'node:crypto';
import v8 from 'node:v8';
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { buildBehavioralModel, type BehaviorModelBundle, type UserBehaviorTheory } from '../memory/behavioral-theory.ts';
import type { BehavioralObservation, BehavioralPattern, LearnedBehaviorFact } from '../memory/behavioral-learning.ts';
import { phraseFromTheory } from '../raidingai/signal-bridge.ts';

try {
  v8.setFlagsFromString('--expose-gc-as=v8gc');
} catch {
  // Best-effort exposure only.
}

export type CognitiveInterferenceFlux = {
  at: number;
  source: string;
  signature: string;
  durationMs: number;
  heapUsed: number;
  heapTotal: number;
  heapSizeLimit: number;
  pressure: number;
  score: number;
  entropy: number;
  complexity: number;
  wake: boolean;
};

export type CognitiveInterferenceEvent = {
  id: string;
  signal: string;
  descriptor: string;
  reason: string;
  source: string;
  theoryId: string;
  emittedAt: number;
  flux: CognitiveInterferenceFlux;
  thresholds: { interference: number; wake: number };
};

export type CognitiveInterferenceSnapshot = {
  running: boolean;
  observedFlux: number;
  interferenceCount: number;
  wakeCount: number;
  lastFluxAt: number | null;
  lastInterferenceAt: number | null;
  lastWakeAt: number | null;
  lastTheoryId: string | null;
  lastSignal: string | null;
  lastDescriptor: string | null;
};

export type CognitiveInterferenceOptions = {
  behaviorModel?: BehaviorModelBundle | null;
  theory?: UserBehaviorTheory | null;
  observations?: BehavioralObservation[];
  facts?: LearnedBehaviorFact[];
  patterns?: BehavioralPattern[];
  onInterference?: (event: CognitiveInterferenceEvent) => void;
  onWake?: (event: CognitiveInterferenceEvent) => void;
};

type GCEntry = PerformanceEntry & { kind?: number };

function token(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9@._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean);
}

function hashRatio(seed: string): number {
  const hex = token(seed);
  const numerator = Number.parseInt(hex, 16);
  const denominator = Math.pow(16, hex.length);
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function theoryCorpus(model: BehaviorModelBundle): string[] {
  const corpus = [
    model.summary,
    model.theory.summary,
    ...model.theory.latentAxes.flatMap((axis) => [axis.axis, axis.direction, ...(axis.domains ?? []), ...(axis.examples ?? [])]),
    ...model.theory.crossContextGeneralizations.flatMap((entry) => [entry.generalization, ...(entry.domains ?? []), ...(entry.evidence ?? [])]),
    ...model.theory.persistentGoals.flatMap((entry) => [entry.goal, ...(entry.evidence ?? [])]),
    ...model.policies.flatMap((policy) => [policy.name, policy.description, policy.rationale, policy.action.type, policy.action.value, ...(policy.contexts ?? [])]),
    ...model.forecasts.flatMap((forecast) => [forecast.need, forecast.nextBestAction, forecast.rationale, ...(forecast.signals ?? []), ...(forecast.relatedPolicies ?? [])]),
    ...model.nextBestActions,
  ];
  return corpus.flatMap((entry) => words(String(entry)));
}

function synthesizeThresholds(model: BehaviorModelBundle, sourceSignature: string): { interference: number; wake: number; entropy: number; complexity: number } {
  const corpus = theoryCorpus(model);
  const uniqueTerms = new Set(corpus);
  const entropy = corpus.length === 0 ? hashRatio(token(model.theory.id, model.summary, sourceSignature)) : uniqueTerms.size / corpus.length;
  const complexityCount = [
    model.theory.latentAxes.length,
    model.theory.crossContextGeneralizations.length,
    model.theory.persistentGoals.length,
    model.policies.length,
    model.forecasts.length,
    model.theory.sessionCount,
  ].reduce((sum, value) => sum + value, 0);
  const complexity = complexityCount / (complexityCount + corpus.length + uniqueTerms.size);
  const interferenceSeed = hashRatio(token(model.theory.id, model.summary, sourceSignature, String(complexityCount)));
  const wakeSeed = hashRatio(token(model.theory.summary, model.summary, sourceSignature, String(uniqueTerms.size)));
  const interference = average([entropy, complexity, interferenceSeed]);
  const wake = Math.max(interference, average([entropy, complexity, wakeSeed]));
  return { interference, wake, entropy, complexity };
}

function scoreFlux(entry: GCEntry | undefined, source: string, model: BehaviorModelBundle): CognitiveInterferenceFlux {
  const stats = v8.getHeapStatistics();
  const durationMs = typeof entry?.duration === 'number' ? entry.duration : 0;
  const heapUsed = Number(stats.used_heap_size) || 0;
  const heapTotal = Number(stats.total_heap_size) || 0;
  const heapSizeLimit = Number(stats.heap_size_limit) || 0;
  const pressure = heapSizeLimit > 0 ? heapUsed / heapSizeLimit : 0;
  const durationShare = heapTotal + heapUsed + durationMs > 0 ? durationMs / (heapTotal + heapUsed + durationMs) : 0;
  const signature = token(source, String(entry?.kind ?? ''), String(durationMs), String(heapUsed), String(heapTotal), String(heapSizeLimit));
  const kindEntropy = hashRatio(token(model.theory.id, source, String(entry?.kind ?? ''), signature));
  const resonance = hashRatio(token(model.summary, signature, model.theory.summary));
  const score = average([pressure, durationShare, kindEntropy, resonance]);
  const thresholds = synthesizeThresholds(model, signature);
  return {
    at: Date.now(),
    source,
    signature,
    durationMs,
    heapUsed,
    heapTotal,
    heapSizeLimit,
    pressure,
    score,
    entropy: thresholds.entropy,
    complexity: thresholds.complexity,
    wake: score >= thresholds.wake,
  };
}

function resolveBehaviorModel(options: CognitiveInterferenceOptions, clock: () => number): BehaviorModelBundle {
  if (options.behaviorModel) return options.behaviorModel;
  return buildBehavioralModel({
    now: clock(),
    observations: options.observations ?? [],
    facts: options.facts ?? [],
    patterns: options.patterns ?? [],
    priorTheory: options.theory ?? null,
  });
}

function describeFlux(model: BehaviorModelBundle, flux: CognitiveInterferenceFlux): { signal: string; descriptor: string; reason: string } {
  const seed = token(model.theory.id, model.summary, flux.signature, String(flux.at));
  const signal = token(seed, model.theory.summary, String(model.theory.sessionCount));
  const descriptor = phraseFromTheory(model.theory, seed, flux.signature, model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length);
  const reason = phraseFromTheory(model.theory, signal, descriptor, model.theory.persistentGoals.length + model.policies.length + model.forecasts.length);
  return { signal, descriptor, reason };
}

function makeEvent(model: BehaviorModelBundle, flux: CognitiveInterferenceFlux): CognitiveInterferenceEvent {
  const thresholds = synthesizeThresholds(model, flux.signature);
  const phrase = describeFlux(model, flux);
  const emittedAt = flux.at;
  return {
    id: randomUUID(),
    signal: phrase.signal,
    descriptor: phrase.descriptor,
    reason: phrase.reason,
    source: token(flux.source, model.theory.id, flux.signature),
    theoryId: model.theory.id,
    emittedAt,
    flux,
    thresholds: { interference: thresholds.interference, wake: thresholds.wake },
  };
}

export class CognitiveInterference {
  private observer: PerformanceObserver | null = null;
  private running = false;
  private observedFlux = 0;
  private interferenceCount = 0;
  private wakeCount = 0;
  private lastFluxAt: number | null = null;
  private lastInterferenceAt: number | null = null;
  private lastWakeAt: number | null = null;
  private lastTheoryId: string | null = null;
  private lastSignal: string | null = null;
  private lastDescriptor: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}, private readonly clock: () => number = () => Date.now()) {}

  start(): CognitiveInterferenceSnapshot {
    if (this.running) return this.snapshot();
    this.running = true;
    this.observer = new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1) as GCEntry | undefined;
      if (!entry) return;
      this.observe('performance-observer', entry);
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
      lastFluxAt: this.lastFluxAt,
      lastInterferenceAt: this.lastInterferenceAt,
      lastWakeAt: this.lastWakeAt,
      lastTheoryId: this.lastTheoryId,
      lastSignal: this.lastSignal,
      lastDescriptor: this.lastDescriptor,
    };
  }

  private handleV8Gc = (..._args: unknown[]): void => {
    this.observe('v8gc');
  };

  private observe(source: string, entry?: GCEntry): void {
    const model = resolveBehaviorModel(this.options, this.clock);
    const flux = scoreFlux(entry, source, model);
    this.lastFluxAt = flux.at;
    this.observedFlux += 1;

    if (flux.score < synthesizeThresholds(model, flux.signature).interference) return;

    const event = makeEvent(model, flux);
    this.lastInterferenceAt = event.emittedAt;
    this.lastTheoryId = event.theoryId;
    this.lastSignal = event.signal;
    this.lastDescriptor = event.descriptor;
    this.interferenceCount += 1;
    this.options.onInterference?.(event);

    if (!flux.wake) return;

    this.lastWakeAt = event.emittedAt;
    this.wakeCount += 1;
    this.options.onWake?.(event);
  }
}

export function createCognitiveInterference(options: CognitiveInterferenceOptions = {}, clock: () => number = () => Date.now()): CognitiveInterference {
  return new CognitiveInterference(options, clock);
}
