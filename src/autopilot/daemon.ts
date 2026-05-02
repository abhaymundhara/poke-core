import { randomUUID, createHash } from 'node:crypto';
import * as perfHooks from 'node:perf_hooks';
import * as v8 from 'node:v8';
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
  interference: boolean;
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

type GCEntry = { duration?: number } & Record<string, unknown>;

type RuntimeObserver = {
  observe(options: unknown): void;
  disconnect(): void;
};

type ObserverCtor = new (callback: (list: { getEntries(): unknown[] }) => void) => RuntimeObserver;

function token(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}@._-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function words(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean);
}

function ratio(seed: string): number {
  const text = token(seed);
  const total = Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0);
  const count = Array.from(text).length;
  return count === 0 ? 0 : total / count;
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

function discoverConstructor(moduleNamespace: Record<string, unknown>, seed: string): ObserverCtor | null {
  const functions = Object.entries(moduleNamespace)
    .filter(([, value]) => typeof value === 'function')
    .map(([name, value]) => ({
      name,
      value: value as ObserverCtor,
      score: ratio(token(seed, name, String((value as Function).length), String(Object.getOwnPropertyNames(value as Function).length))),
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const [first] = functions;
  if (!first) return null;

  const staticNames = Object.getOwnPropertyNames(first.value as Function);
  const hasArrayStatic = staticNames.some((name) => Array.isArray((first.value as Record<string, unknown>)[name]));
  return hasArrayStatic ? first.value : null;
}

function discoverArrayProperty(source: object): string[] | null {
  const names = Object.getOwnPropertyNames(source);
  const arrays = names
    .map((name) => (source as Record<string, unknown>)[name])
    .filter((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
  const [first] = arrays;
  return first ?? null;
}

function discoverObserverKey(observerCtor: ObserverCtor, seed: string): string | null {
  const observeSource = String(observerCtor.prototype.observe);
  const candidates = Array.from(new Set((observeSource.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((word) => word.length > 1)));
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: ratio(token(seed, candidate, String(candidate.length))),
    }))
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));
  const [first] = scored;
  return first?.candidate ?? null;
}

function discoverFlagSetter(moduleNamespace: Record<string, unknown>, seed: string): ((value: string) => void) | null {
  const functions = Object.entries(moduleNamespace)
    .filter(([, value]) => typeof value === 'function')
    .map(([name, value]) => ({
      name,
      value: value as (value: string) => void,
      score: ratio(token(seed, name, String((value as Function).length), String(name.length))),
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const [first] = functions;
  return first?.value ?? null;
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
  const denominator = structuralMass + corpus.length + uniqueTerms.size;
  const complexity = denominator === 0 ? 0 : structuralMass / denominator;
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
    interference: score >= thresholds.interference,
    wake: score >= thresholds.wake,
  };
}

function deriveFluxSeed(model: BehaviorModelBundle): string {
  return token(model.theory.summary, model.summary, model.theory.id, String(model.theory.sessionCount), String(model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length + model.theory.persistentGoals.length));
}

function discoverEntryType(model: BehaviorModelBundle, supported: string[], fluxSeed: string): string | null {
  const candidates = supported
    .map((entryType) => ({
      entryType,
      score: ratio(token(fluxSeed, entryType, model.theory.summary, model.summary, String(model.forecasts.length))),
    }))
    .sort((left, right) => right.score - left.score || left.entryType.localeCompare(right.entryType));
  const [first] = candidates;
  return first?.entryType ?? null;
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

function buildObserveOptions(key: string, entryType: string): Record<string, string[]> {
  const options: Record<string, string[]> = Object.create(null);
  options[key] = [entryType];
  return options;
}

function buildFlagSpec(model: BehaviorModelBundle, seed: string): string {
  return phraseFromTheory(model.theory, seed, model.summary, model.theory.crossContextGeneralizations.length + model.policies.length + model.forecasts.length);
}

export class CognitiveInterference {
  private observer: RuntimeObserver | null = null;
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
  private processSignal: string | null = null;
  private lastSignature: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}, private readonly clock: () => number = () => Date.now()) {}

  start(): CognitiveInterferenceSnapshot {
    if (this.running) return this.snapshot();
    this.running = true;

    const model = resolveBehaviorModel(this.options, this.clock);
    const hookSeed = deriveFluxSeed(model);
    const observerCtor = discoverConstructor(perfHooks as Record<string, unknown>, hookSeed);
    const supported = observerCtor ? discoverArrayProperty(observerCtor as unknown as object) : null;
    const observerKey = observerCtor ? discoverObserverKey(observerCtor, hookSeed) : null;
    const flagSetter = discoverFlagSetter(v8 as Record<string, unknown>, hookSeed);
    const processSeed = token(hookSeed, model.theory.summary, model.summary, String(model.theory.sessionCount));
    const signalSeed = buildFlagSpec(model, processSeed);

    this.observerType = supported ? discoverEntryType(model, supported, hookSeed) : null;
    this.processSignal = signalSeed;

    if (flagSetter) {
      try {
        flagSetter(signalSeed);
      } catch {
        // Best-effort exposure only.
      }
    }

    if (this.processSignal) {
      process.on(this.processSignal, this.handleProcessSignal);
    }

    if (observerCtor && this.observerType && observerKey) {
      this.observer = new observerCtor((list) => {
        const entries = list.getEntries();
        const entry = entries.slice().pop() as GCEntry | undefined;
        if (!entry) return;
        this.observe(model, this.observerType ?? hookSeed, entry);
      });
      this.observer.observe(buildObserveOptions(observerKey, this.observerType));
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

    if (this.processSignal) {
      process.off(this.processSignal, this.handleProcessSignal);
      this.processSignal = null;
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
    const fluxSeed = this.processSignal ?? deriveFluxSeed(model);
    this.observe(model, fluxSeed, undefined);
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
