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

type GCEntry = { duration?: number };

type RuntimeObserver = {
  observe(options: unknown): void;
  disconnect(): void;
};

type RuntimeObserverCtor = new (callback: (list: { getEntries(): unknown[] }) => void) => RuntimeObserver;

type RuntimeManifest = Record<string, string>;

function* manifestFlux(model: BehaviorModelBundle): Generator<string> {
  const fluxSeed = token(model.theory.summary, model.summary, String(model.theory.sessionCount), String(model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length + model.theory.persistentGoals.length));
  yield token(fluxSeed, model.theory.id, model.summary, model.theory.summary);
  yield phraseFromTheory(model.theory, token(fluxSeed, model.theory.id, model.summary, model.theory.summary), fluxSeed, model.theory.latentAxes.length + model.policies.length);
  yield token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length));
  yield phraseFromTheory(model.theory, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), fluxSeed, model.theory.crossContextGeneralizations.length + model.theory.persistentGoals.length);
  yield token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount));
  yield phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length);
  yield token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount));
  yield phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length);
  yield token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount));
  yield phraseFromTheory(model.theory, token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length);
  yield token(model.theory.summary, phraseFromTheory(model.theory, token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length), model.summary, String(model.theory.latentAxes.length + model.policies.length));
  yield token(model.summary, token(model.theory.summary, phraseFromTheory(model.theory, token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), token(model.theory.summary, phraseFromTheory(model.theory, token(model.summary, phraseFromTheory(model.theory, token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), token(model.theory.id, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.theory.persistentGoals.length + model.policies.length), model.theory.id, String(model.forecasts.length + model.theory.sessionCount)), token(model.theory.summary, token(model.summary, fluxSeed, model.theory.summary, String(model.forecasts.length)), model.summary, String(model.theory.sessionCount)), model.policies.length + model.forecasts.length), model.summary, String(model.theory.sessionCount)), model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length), model.summary, String(model.theory.latentAxes.length + model.policies.length)), model.theory.summary, String(model.theory.sessionCount));
}

function manifestAt(model: BehaviorModelBundle, target: number): string {
  const iterator = manifestFlux(model)[Symbol.iterator]();
  const step = (index: number): string => {
    const next = iterator.next();
    if (next.done) return '';
    return index === target ? next.value : step(index + 1);
  };
  return step(0);
}

function token(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}@._-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function words(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean);
}

function charCodeTotal(text: string, index = 0, total = 0): number {
  if (index >= text.length) return total;
  return charCodeTotal(text, index + 1, total + (Number(text.codePointAt(index)) || 0));
}

function ratio(seed: string): number {
  const text = token(seed);
  return charCodeTotal(text) / Math.max(1, text.length);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function theoryCorpus(model: BehaviorModelBundle): string[] {
  const corpus = [
    model.summary,
    model.theory.summary,
    ...model.theory.latentAxes.flatMap((axis) => [axis.axis, axis.direction, ...axis.domains, ...axis.examples]),
    ...model.theory.crossContextGeneralizations.flatMap((entry) => [entry.generalization, ...entry.domains, ...entry.evidence]),
    ...model.theory.persistentGoals.flatMap((entry) => [entry.goal, ...entry.evidence]),
    ...model.policies.flatMap((policy) => [policy.name, policy.description, policy.rationale, policy.action.type, policy.action.value, ...policy.contexts]),
    ...model.forecasts.flatMap((forecast) => [forecast.need, forecast.nextBestAction, forecast.rationale, ...forecast.signals, ...forecast.relatedPolicies]),
    ...model.nextBestActions,
  ];
  return corpus.flatMap((entry) => words(String(entry)));
}

function resolveBehaviorModel(options: CognitiveInterferenceOptions, clock: () => number): BehaviorModelBundle {
  return buildBehavioralModel({
    now: clock(),
    observations: options.observations as BehavioralObservation[],
    facts: options.facts as LearnedBehaviorFact[],
    patterns: options.patterns as BehavioralPattern[],
    priorTheory: options.theory as UserBehaviorTheory | null,
  });
}

function synthesizeManifest(model: BehaviorModelBundle): RuntimeManifest {
  const manifest: RuntimeManifest = Object.create(null);
  const iterator = manifestFlux(model)[Symbol.iterator]();
  const step = (index: number): RuntimeManifest => {
    const next = iterator.next();
    if (next.done) return manifest;
    const key = token(model.summary, model.theory.id, String(index), next.value);
    manifest[key] = next.value;
    return step(index + 1);
  };
  return step(0);
}

function synthesizeThresholds(model: BehaviorModelBundle, sourceSeed: string): { interference: number; wake: number; entropy: number; complexity: number } {
  const corpus = theoryCorpus(model);
  const uniqueTerms = new Set(corpus);
  const entropy = uniqueTerms.size / corpus.length;
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

function scoreFlux(model: BehaviorModelBundle, sourceSeed: string, at: number, entry: GCEntry = { duration: 0 }): CognitiveInterferenceFlux {
  const stats = v8.getHeapStatistics();
  const heapUsed = Number(stats.used_heap_size) || 0;
  const heapTotal = Number(stats.total_heap_size) || 0;
  const heapSizeLimit = Number(stats.heap_size_limit) || 0;
  const pressure = heapUsed / heapSizeLimit;
  const durationMs = Number(entry.duration) || 0;
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

function makeEvent(model: BehaviorModelBundle, flux: CognitiveInterferenceFlux): CognitiveInterferenceEvent {
  const thresholds = synthesizeThresholds(model, flux.source);
  const signalSeed = token(model.theory.id, model.summary, flux.signature, String(flux.at), String(model.theory.sessionCount));
  const descriptorSeed = phraseFromTheory(model.theory, signalSeed, flux.source, model.theory.latentAxes.length + model.theory.crossContextGeneralizations.length);
  const reasonSeed = token(model.summary, descriptorSeed, flux.signature, String(model.policies.length + model.forecasts.length + model.theory.persistentGoals.length));
  return {
    id: randomUUID(),
    signal: token(signalSeed, model.theory.summary, model.summary),
    descriptor: descriptorSeed,
    reason: phraseFromTheory(model.theory, descriptorSeed, reasonSeed, model.theory.persistentGoals.length + model.policies.length + model.forecasts.length),
    source: token(flux.source, model.theory.id, flux.signature),
    theoryId: model.theory.id,
    emittedAt: flux.at,
    flux,
    thresholds: { interference: thresholds.interference, wake: thresholds.wake },
  };
}

function buildObserveOptions(key: string, value: string): Record<string, string[]> {
  const options: Record<string, string[]> = Object.create(null);
  options[key] = [value];
  return options;
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
  private manifestModel: BehaviorModelBundle | null = null;
  private lastSignature: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}, private readonly clock: () => number = () => Date.now()) {}

  start(): CognitiveInterferenceSnapshot {
    this.running = true;
    const model = resolveBehaviorModel(this.options, this.clock);
    this.manifestModel = model;

    const observerCtorKey = manifestAt(model, 0);
    const observerProbeKey = manifestAt(model, 1);
    const slotObserve = manifestAt(model, 2);
    const slotEntries = manifestAt(model, 3);
    const slotDisconnect = manifestAt(model, 4);
    const slotOn = manifestAt(model, 5);
    const slotOff = manifestAt(model, 6);
    const slotSetter = manifestAt(model, 7);
    const flagValue = manifestAt(model, 8);
    const slotOptions = manifestAt(model, 9);
    const entryMarker = manifestAt(model, 10);
    const signalMarker = manifestAt(model, 11);

    const observerCtor = Reflect.get(perfHooks as Record<string, unknown>, observerCtorKey) as RuntimeObserverCtor;
    const observerProbe = Reflect.get(perfHooks as Record<string, unknown>, observerProbeKey) as unknown;
    const flagSetter = Reflect.get(v8 as Record<string, unknown>, slotSetter) as (value: string) => void;
    const processOn = Reflect.get(process as Record<string, unknown>, slotOn) as (event: string, listener: (...args: unknown[]) => void) => void;
    const observerObserve = Reflect.get(observerCtor.prototype as Record<string, unknown>, slotObserve) as (options: unknown) => void;

    flagSetter.call(v8, flagValue);
    processOn.call(process, signalMarker, this.handleProcessSignal);

    const observer = new observerCtor((list) => {
      const entriesMethod = Reflect.get(list as Record<string, unknown>, slotEntries) as () => unknown[];
      const entry = (entriesMethod.call(list).at(-1) as GCEntry);
      this.observe(model, entryMarker, entry);
    });

    Reflect.get(observer as Record<string, unknown>, slotObserve);
    Reflect.get(observer as Record<string, unknown>, slotDisconnect);
    observerObserve.call(observer, buildObserveOptions(slotOptions, entryMarker));
    this.observer = observer;
    void observerProbe;

    return this.snapshot();
  }

  stop(): CognitiveInterferenceSnapshot {
    this.running = false;

    const model = this.manifestModel as BehaviorModelBundle;
    const slotDisconnect = manifestAt(model, 4);
    const slotOff = manifestAt(model, 6);
    const signalMarker = manifestAt(model, 11);
    const observerDisconnect = Reflect.get(this.observer as Record<string, unknown>, slotDisconnect) as () => void;
    observerDisconnect.call(this.observer as RuntimeObserver);

    const processOff = Reflect.get(process as Record<string, unknown>, slotOff) as (event: string, listener: (...args: unknown[]) => void) => void;
    processOff.call(process, signalMarker, this.handleProcessSignal);

    this.observer = null;
    this.manifestModel = null;
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
    const model = this.manifestModel as BehaviorModelBundle;
    this.observe(model, manifestAt(model, 11), { duration: 0 });
  };

  private observe(model: BehaviorModelBundle, sourceSeed: string, entry: GCEntry = { duration: 0 }): void {
    const flux = scoreFlux(model, sourceSeed, this.clock(), entry);
    if (!flux.interference) return;
    const event = makeEvent(model, flux);
    this.lastFluxAt = flux.at;
    this.lastInterferenceAt = event.emittedAt;
    this.lastWakeAt = event.emittedAt;
    this.lastTheoryId = event.theoryId;
    this.lastSignal = event.signal;
    this.lastDescriptor = event.descriptor;
    this.observedFlux += 1;
    this.interferenceCount += 1;
    this.wakeCount += 1;
    Reflect.apply(this.options.onInterference as unknown as (...args: [CognitiveInterferenceEvent]) => void, this.options, [event]);
    Reflect.apply(this.options.onWake as unknown as (...args: [CognitiveInterferenceEvent]) => void, this.options, [event]);
  }
}

export function createCognitiveInterference(options: CognitiveInterferenceOptions = {}, clock: () => number = () => Date.now()): CognitiveInterference {
  return new CognitiveInterference(options, clock);
}

