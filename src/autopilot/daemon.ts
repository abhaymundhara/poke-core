import { randomUUID, createHash } from 'node:crypto';
import v8 from 'node:v8';
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

function synthesizeTheory(model: BehaviorModelBundle, sourceSeed: string): { interference: number; wake: number; entropy: number; complexity: number; cadenceMs: number } {
  const corpus = theoryCorpus(model);
  const uniqueTerms = new Set(corpus);
  const entropy = corpus.length === 0 ? ratio(token(model.theory.id, model.summary, sourceSeed)) : uniqueTerms.size / corpus.length;
  const complexityCount = [
    model.theory.latentAxes.length,
    model.theory.crossContextGeneralizations.length,
    model.theory.persistentGoals.length,
    model.policies.length,
    model.forecasts.length,
    model.theory.sessionCount,
  ].reduce((sum, value) => sum + value, 0);
  const complexity = complexityCount / (complexityCount + corpus.length + uniqueTerms.size + 1);
  const interference = average([
    entropy,
    complexity,
    ratio(token(model.summary, model.theory.id, sourceSeed, String(complexityCount))),
  ]);
  const wake = Math.max(interference, average([
    entropy,
    complexity,
    ratio(token(model.theory.summary, model.summary, sourceSeed, String(uniqueTerms.size))),
  ]));
  const cadenceRatio = average([
    ratio(token(model.theory.summary, model.summary, sourceSeed, String(model.theory.sessionCount))),
    ratio(token(model.summary, model.theory.id, sourceSeed, String(corpus.length))),
  ]);
  const cadenceMs = Math.max(125, Math.round((250 + cadenceRatio * 1750) * (1 + complexity)));
  return { interference, wake, entropy, complexity, cadenceMs };
}

function scoreFlux(model: BehaviorModelBundle, sourceSeed: string, at: number): CognitiveInterferenceFlux {
  const stats = v8.getHeapStatistics();
  const heapUsed = Number(stats.used_heap_size) || 0;
  const heapTotal = Number(stats.total_heap_size) || 0;
  const heapSizeLimit = Number(stats.heap_size_limit) || 0;
  const pressure = heapSizeLimit > 0 ? heapUsed / heapSizeLimit : 0;
  const durationMs = Math.max(0, Math.round((heapUsed + heapTotal + heapSizeLimit) % 997));
  const signature = token(model.theory.id, model.summary, sourceSeed, String(at), String(heapUsed), String(heapTotal), String(heapSizeLimit), String(durationMs));
  const entropy = ratio(token(signature, model.theory.summary, sourceSeed));
  const complexity = ratio(token(model.summary, signature, String(model.theory.latentAxes.length + model.policies.length + model.forecasts.length)));
  const score = average([pressure, entropy, complexity, ratio(token(model.theory.id, signature, model.summary))]);
  const thresholds = synthesizeTheory(model, sourceSeed);
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
  const thresholds = synthesizeTheory(model, flux.source);
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
  private timer: ReturnType<typeof setInterval> | null = null;
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
    const model = resolveBehaviorModel(this.options, this.clock);
    const cadence = synthesizeTheory(model, token(model.theory.id, model.summary, model.theory.summary)).cadenceMs;
    this.timer = setInterval(() => this.observe(), cadence);
    this.observe();
    return this.snapshot();
  }

  stop(): CognitiveInterferenceSnapshot {
    if (!this.running) return this.snapshot();
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private observe(): void {
    const model = resolveBehaviorModel(this.options, this.clock);
    const sourceSeed = token(model.theory.summary, model.summary, String(model.theory.sessionCount), String(this.observedFlux));
    const flux = scoreFlux(model, sourceSeed, this.clock());
    this.lastFluxAt = flux.at;
    this.observedFlux += 1;

    const thresholds = synthesizeTheory(model, flux.source);
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
