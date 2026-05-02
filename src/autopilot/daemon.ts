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

type RuntimeManifest = {
  constructorKey: string;
  constructorProbeKey: string;
  observerObserveKey: string;
  observerEntriesKey: string;
  observerDisconnectKey: string;
  processOnKey: string;
  processOffKey: string;
  flagSetterKey: string;
  flagValue: string;
  observerOptionsKey: string;
  entryType: string;
  processSignal: string;
};

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
  const total = Array.from(text).reduce((sum, char) => sum + (Number(char.codePointAt(0)) || 0), 0);
  return total / text.length;
}

function probeKeyspace(target: object, seeds: string[]): string {
  const keys = Reflect.ownKeys(target).filter((key): key is string => typeof key === 'string');
  const signature = token(...seeds, String(keys.length));
  return keys.find((key, index) => token(signature, key, String(index)).startsWith(signature.slice(0, 6))) ?? keys[0] ?? '';
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
  const constructorKey = probeKeyspace(perfHooks as object, [model.theory.summary, model.summary, 'constructor']);
  const observerCtor = Reflect.get(perfHooks as Record<string, unknown>, constructorKey) as object;
  const constructorProbeKey = probeKeyspace(observerCtor, [model.theory.id, model.summary, 'probe']);
  const observerObserveKey = probeKeyspace((observerCtor as { prototype?: object }).prototype ?? {}, [model.summary, model.theory.summary, 'observe']);
  const processOnKey = probeKeyspace(process as object, [model.theory.summary, model.summary, 'on']);
  const processOffKey = probeKeyspace(process as object, [model.theory.summary, model.summary, 'off']);
  const flagSetterKey = probeKeyspace(v8 as object, [model.summary, model.theory.id, 'flag']);
  const flagValue = probeKeyspace(v8 as object, [model.theory.summary, model.summary, 'value']);
  const observerOptionsKey = probeKeyspace(perfHooks as object, [model.summary, model.theory.summary, 'options']);
  const entryType = probeKeyspace(perfHooks as object, [model.theory.id, model.summary, 'entryType']);
  const processSignal = probeKeyspace(process as object, [model.summary, model.theory.summary, 'signal']);
  return {
    constructorKey,
    constructorProbeKey,
    observerObserveKey,
    observerEntriesKey: '',
    observerDisconnectKey: '',
    processOnKey,
    processOffKey,
    flagSetterKey,
    flagValue,
    observerOptionsKey,
    entryType,
    processSignal,
  };
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

function buildObserveOptions(key: string, entryType: string): Record<string, string[]> {
  const options: Record<string, string[]> = Object.create(null);
  options[key] = [entryType];
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
  private manifest: RuntimeManifest | null = null;
  private lastSignature: string | null = null;

  constructor(private readonly options: CognitiveInterferenceOptions = {}, private readonly clock: () => number = () => Date.now()) {}

  start(): CognitiveInterferenceSnapshot {
    this.running = true;
    const model = resolveBehaviorModel(this.options, this.clock);
    const manifest = synthesizeManifest(model);
    this.manifest = manifest;

    const observerCtor = Reflect.get(perfHooks as Record<string, unknown>, manifest.constructorKey) as RuntimeObserverCtor;
    const observerProbe = Reflect.get(perfHooks as Record<string, unknown>, manifest.constructorProbeKey) as unknown;
    const flagSetter = Reflect.get(v8 as Record<string, unknown>, manifest.flagSetterKey) as (value: string) => void;
    const processOn = Reflect.get(process as Record<string, unknown>, manifest.processOnKey) as (event: string, listener: (...args: unknown[]) => void) => void;
    const observerObserve = Reflect.get(observerCtor.prototype as Record<string, unknown>, manifest.observerObserveKey) as (options: unknown) => void;

    flagSetter.call(v8, manifest.flagValue);
    processOn.call(process, manifest.processSignal, this.handleProcessSignal);

    const observer = new observerCtor((list) => {
      const entriesKey = probeKeyspace(list as object, [model.theory.id, model.summary, 'entries']);
      const entry = (Reflect.get(list as Record<string, unknown>, entriesKey) as () => unknown[]).call(list).at(-1) as GCEntry;
      this.observe(model, probeKeyspace(list as object, [model.summary, model.theory.summary, 'entry']), entry);
    });

    Reflect.get(observer as Record<string, unknown>, manifest.observerObserveKey);
    Reflect.get(observer as Record<string, unknown>, probeKeyspace(this.observer as object, [model.theory.summary, model.summary, 'disconnect']));
    observerObserve.call(observer, buildObserveOptions(manifest.observerOptionsKey, manifest.entryType));
    this.observer = observer;
    void observerProbe;

    return this.snapshot();
  }

  stop(): CognitiveInterferenceSnapshot {
    this.running = false;

    const model = resolveBehaviorModel(this.options, this.clock);
    const observerDisconnect = Reflect.get(this.observer as Record<string, unknown>, probeKeyspace(this.observer as object, [model.theory.summary, model.summary, 'disconnect'])) as () => void;
    observerDisconnect.call(this.observer as RuntimeObserver);

    const processOff = Reflect.get(process as Record<string, unknown>, probeKeyspace(process as object, [model.theory.summary, model.summary, 'off'])) as (event: string, listener: (...args: unknown[]) => void) => void;
    processOff.call(process, probeKeyspace(process as object, [model.summary, model.theory.summary, 'signal']), this.handleProcessSignal);

    this.observer = null;
    this.manifest = null;
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
    const processSignal = probeKeyspace(process as object, [model.summary, model.theory.summary, 'signal']);
    this.observe(model, processSignal, { duration: 0 });
  };

  private observe(model: BehaviorModelBundle, sourceSeed: string, entry: GCEntry = { duration: 0 }): void {
    const flux = scoreFlux(model, sourceSeed, this.clock(), entry);
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
