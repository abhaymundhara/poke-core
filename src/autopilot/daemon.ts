import { randomUUID, createHash } from 'node:crypto';
import v8 from 'node:v8';
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { buildBehavioralModel, type BehaviorModelBundle, type UserBehaviorTheory } from '../memory/behavioral-theory.ts';
import type { BehavioralObservation, BehavioralPattern, LearnedBehaviorFact } from '../memory/behavioral-learning.ts';
import { phraseFromTheory } from '../raidingai/signal-bridge.ts';

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

function ratio(seed: string): number {
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

function selectSupportedEntryType(model: BehaviorModelBundle): string | null {
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.length === 0) return null;
  const ordered = [...supported].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const shortest = ordered[0];
  if (!shortest) return null;
  return shortest;
}

function synthesizeThresholds(model: BehaviorModelBundle, sourceSeed: string): { interference: number; wake: number; entropy: number; complexity: number } {
  const corpus = theoryCorpus(model);
  const uniqueTerms = new Set(corpus);
  const entropy = corpus.length === 0 ? ratio(token(model.theory.id, model.summary, sourceSeed)) : uniqueTerms.size / corpus.length;
  const structuralMass = [
    model.theory.latentAxes.length,
    model.theory.crossContextGeneralizations.length,
    model.theory.persistentGoals.length,
    model.policies.length,
    model.forecasts.length,
    model.theory.sessionCount,
  ].reduce((sum, value) => sum + value, 0);
  const complexity = structuralMass / (structuralMass + corpus.length + uniqueTerms.size + 1);
  const interference = average([
    entropy,
    complexity,
    ratio(token(model.summary, model.theory.id, sourceSeed, String(structuralMass))),
  ]);
  const wake = average([
    interference,
    entropy,
    complexity,
    ratio(token(model.theory.summary, model.summary, sourceSeed, String(uniqueTerms.size))),
  ]);
  return { interference, wake, entropy, complexity };
}

function scoreFlux(model: BehaviorModelBundle, sourceSeed: string, at: number, entry?: GCEntry): CognitiveInterferenceFlux {
  const stats = v8.getHeapStatistics();
  const heapUsed = Number(stats.used_heap_size) || 0;
  const heapTotal = Number(stats.total_heap_size) || 0;
  const heapSizeLimit = Number(stats.heap_size_limit) || 0;
  const pressure = heapSizeLimit > 0 ? heapUsed / heapSizeLimit : 0;
  const durationMs = typeof entry?.duration === 'number' ? entry.duration : 0;
  const signature = token(model.theory.id, model.summary, sourceSeed, String(at), String(heapUsed), String(heapTotal), String(heapSizeLimit), String(durationMs));
  const entropy = ratio(token(signature, model.theory.summary, sourceSeed));
  const complexity = ratio(token(model.summary, signature, String(model.theory.latentAxes.length + model.policies.length + model.forecasts.length)));
  const score = average([pressure, entropy, complexity, ratio(token(model.theory.id, signature, model.summary))]);
  const thresholds = synthesizeThresholds(model, sourceSeed);
  return {
    at,
    source: token(sourceSeed, model.summary, model.theory.id),
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

function deriveRuntimeAliases(model: BehaviorModelBundle): { observerType: string | null; processEvent: string | null; sourceSeed: string } {
  const sourceSeed = token(model.theory.summary, model.summary, model.theory.id, String(model.theory.sessionCount));
  const processEvent = token(model.summary, model.theory.summary, sourceSeed, String(model.theory.latentAxes.length));
  return { observerType: selectSupportedEntryType(model), processEvent, sourceSeed };
}

function derivePhrases(model: BehaviorModelBundle, flux: CognitiveInterferenceFlux): { signal: string; descriptor: string; reason: string } {
  const signalSeed = token(model.theory.id, model.summary, flux.signature, String(flux.at), String(model.theory.sessionCount));
  const descriptorSeed = token(model.theory.summary, signalSeed, flux.source, String(model.theory.latentAxes.length));
  const reasonSeed = token(model.summary, descriptorSeed, flux.signature, String(model.theory.crossContextGeneralizations.length + model.policies.length + model.forecasts.length));
  const signal = token(signalSeed, model.theory.summary, model.summary);
  const descriptor = phraseFromTheory(model.theory, signalSeed, descriptorSeed, model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length);
  const reason = phraseFromTheory(model.theory, descriptorSeed, reasonSeed, model.theory.persistentGoals.length + model.policies.length + model.forecasts.length);
  return { signal, descriptor, reason };
}

function makeEvent(model: BehaviorModelBundle, flux: CognitiveInterferenceFlux): CognitiveInterferenceEvent {
  const thresholds = synthesizeThresholds(model, flux.source);
  const phrases = derivePhrases(model, flux);
  return {
    id: randomUUID(),
    signal: phrases.signal,
    descriptor: phrases.descriptor,
    reason: phrases.reason,
    source: token(flux.source, model.theory.id, flux.signature),
    theoryId: model.theory.id,
    emittedAt: flux.at,
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
  private observerType: string | null = null;
  private processEvent: string | null = null;
  private lastSignature: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}, private readonly clock: () => number = () => Date.now()) {}

  start(): CognitiveInterferenceSnapshot {
    if (this.running) return this.snapshot();
    this.running = true;

    const model = resolveBehaviorModel(this.options, this.clock);
    const aliases = deriveRuntimeAliases(model);
    this.observerType = aliases.observerType;
    this.processEvent = aliases.processEvent;

    if (this.processEvent) {
      try {
        v8.setFlagsFromString(['--expose-gc-as', this.processEvent].join('='));
      } catch {
        // The runtime can still emit the observer path even if the alias cannot be installed.
      }
      process.on(this.processEvent, this.handleProcessSignal);
    }

    if (this.observerType) {
      this.observer = new PerformanceObserver((list) => {
        const entry = list.getEntries().at(-1) as GCEntry | undefined;
        if (!entry) return;
        this.observe(model, this.observerType ?? token(model.summary, model.theory.id), entry);
      });
      this.observer.observe({ entryTypes: [this.observerType] });
    }

    return this.snapshot();
  }

  stop(): CognitiveInterferenceSnapshot {
    if (!this.running) return this.snapshot();
    this.running = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.processEvent) {
      process.off(this.processEvent, this.handleProcessSignal);
      this.processEvent = null;
    }

    this.observerType = null;
    this.lastSignature = null;
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

  private handleProcessSignal = (): void => {
    const model = resolveBehaviorModel(this.options, this.clock);
    const aliases = this.processEvent ?? deriveRuntimeAliases(model);
    this.observe(model, aliases, undefined);
  };

  private observe(model: BehaviorModelBundle, sourceSeed: string, entry?: GCEntry): void {
    const flux = scoreFlux(model, sourceSeed, this.clock(), entry);
    if (this.lastSignature === flux.signature) return;
    this.lastSignature = flux.signature;
    this.lastFluxAt = flux.at;
    this.observedFlux += 1;

    const thresholds = synthesizeThresholds(model, sourceSeed);
    if (flux.score < thresholds.interference) return;

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
