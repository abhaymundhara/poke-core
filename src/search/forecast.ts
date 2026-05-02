import { resolve } from 'node:path';
import type { SearchEvidenceGraph, SearchIntent, SearchPolicyState, SearchSignalForecast, SearchSource } from './types.ts';
import { average, clamp, readJson, uniq } from './utils.ts';

export type BehaviorTrajectoryEvent = {
  sessionId?: string;
  at?: number;
  source?: string;
  action?: string;
  outcome?: 'success' | 'failure' | 'ignored' | 'pending';
  topic?: string;
  category?: string;
  subject?: string;
  confidence?: number;
  durationMs?: number;
  value?: number;
};

const BEHAVIOR_PATHS = [resolve(process.cwd(), '.poke-core', 'behavioral-state.json'), resolve(process.cwd(), '.poke-core', 'behavioral-audit.json'), resolve(process.cwd(), '.poke-core', 'manual-behavioral-audit.json')];

function persistedObservations(): BehaviorTrajectoryEvent[] {
  for (const path of BEHAVIOR_PATHS) {
    const state = readJson<Record<string, unknown> | null>(path, null);
    const raw = state?.observations ?? state?.trajectory ?? state?.events;
    if (Array.isArray(raw)) return raw.filter((value): value is BehaviorTrajectoryEvent => Boolean(value) && typeof value === 'object');
  }
  return [];
}

function observationsFrom(seed?: Record<string, unknown>): BehaviorTrajectoryEvent[] {
  const raw = seed?.observations ?? seed?.trajectory ?? seed?.events ?? [];
  const explicit = Array.isArray(raw) ? raw.filter((value): value is BehaviorTrajectoryEvent => Boolean(value) && typeof value === 'object') : [];
  return explicit.length > 0 ? explicit : persistedObservations();
}

function sourceFor(topic: string, source?: string): SearchSource | string {
  if (source) return source;
  if (/calendar|schedule|meeting|availability/i.test(topic)) return 'calendar';
  if (/email|thread|reply|relationship/i.test(topic)) return 'email';
  if (/github|repo|issue|commit|pr|pull request/i.test(topic)) return 'github';
  if (/file|path|filesystem|directory/i.test(topic)) return 'filesystem';
  if (/integration|notion|linear|slack|api|webhook/i.test(topic)) return 'integration';
  return 'memory';
}

function labelFromEvent(event: BehaviorTrajectoryEvent): string {
  return String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
}

function trajectoryText(event: BehaviorTrajectoryEvent): string {
  return [labelFromEvent(event), event.source ?? '', event.outcome ?? 'pending', event.value ?? '', event.durationMs ?? ''].join(' ');
}

function trajectoryFeatures(intent: SearchIntent, observations: BehaviorTrajectoryEvent[], evidenceGraph?: SearchEvidenceGraph) {
  const recent = observations.slice(-6);
  const labels = recent.map(labelFromEvent);
  const sources = recent.map((event) => sourceFor(labelFromEvent(event), event.source));
  const uniqueLabels = new Set(labels);
  const uniqueSources = new Set(sources);
  const failures = recent.filter((event) => event.outcome === 'failure').length;
  const successes = recent.filter((event) => event.outcome === 'success').length;
  const ignored = recent.filter((event) => event.outcome === 'ignored').length;
  const averageConfidence = average(recent.map((event) => Number(event.confidence ?? 0.5)));
  const latest = recent[recent.length - 1];
  const lastGapHours = latest?.at ? Math.max(0, (Date.now() - latest.at) / 3_600_000) : 24;
  const sourceShift = sources.length > 1 && [...uniqueSources].length > 1 ? 1 : 0;
  const topicDrift = uniqueLabels.size > 2 ? 1 : 0;
  const cadence = recent.length > 1 ? average(recent.slice(1).map((event, index) => Math.max(0, Number(event.at ?? 0) - Number(recent[index].at ?? 0)))) : 0;
  const graphPressure = evidenceGraph ? clamp(evidenceGraph.confidence * 0.2 + (evidenceGraph.synthesis.stance === 'contested' ? 0.08 : 0) + Math.min(0.12, evidenceGraph.conflicts.length * 0.03)) : 0;
  return { labels, sources, failures, successes, ignored, averageConfidence, lastGapHours, sourceShift, topicDrift, cadence, graphPressure };
}

function candidateIntentLabels(intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): string[] {
  const labels = new Set<string>([
    intent.focus,
    ...intent.topics.slice(0, 4),
    ...intent.sourceHints.slice(0, 4),
    ...intent.entities.slice(0, 4),
    ...intent.semanticQuery.split(/[^a-z0-9]+/i).filter((token) => token.length > 3).slice(0, 4),
    'research',
    'verification',
    'coordination',
    'follow-up',
    'monitoring',
    'clarification',
    'synthesis',
    'retrieval',
  ]);
  for (const event of observations) labels.add(labelFromEvent(event));
  return [...labels].filter(Boolean).slice(0, 24);
}


function updateLatentStateMemory(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, labels: string[], observations: BehaviorTrajectoryEvent[], intent: SearchIntent): NonNullable<SearchPolicyState['latentIntentModel']> {
  const next = model ?? { version: 1, archetypes: [], transitions: {}, lastUpdatedAt: Date.now(), statePrototypes: {}, trajectoryMemory: {} };
  next.statePrototypes ??= {};
  next.trajectoryMemory ??= {};
  const sequence = observations.map(labelFromEvent);
  for (const label of labels) {
    const relevant = observations.filter((event) => labelFromEvent(event) === label);
    if (relevant.length === 0) continue;
    const successWeight = relevant.filter((event) => event.outcome === 'success').length;
    const failureWeight = relevant.filter((event) => event.outcome === 'failure').length;
    const intensity = relevant.length + successWeight * 0.45 - failureWeight * 0.18 + (intent.trustMode === 'official-first' ? 0.08 : 0);
    next.trajectoryMemory[label] = (next.trajectoryMemory[label] ?? 0.2) * 0.76 + intensity * 0.24;
    next.statePrototypes[label] = next.statePrototypes[label] ?? [0, 0, 0, 0, 0];
    next.statePrototypes[label] = next.statePrototypes[label].map((value, index) => value * 0.8 + (index === 0 ? intensity : index === 1 ? successWeight : index === 2 ? failureWeight : index === 3 ? relevant.length : average(relevant.map((event) => Number(event.confidence ?? 0.5)))));
  }
  for (let index = 1; index < sequence.length; index += 1) {
    const previous = sequence[index - 1];
    const current = sequence[index];
    const key = previous + '->' + current;
    next.transitions[key] = (next.transitions[key] ?? 0) * 0.82 + 1;
  }
  next.lastUpdatedAt = Date.now();
  return next;
}

function transitionLikelihood(model: NonNullable<SearchPolicyState['latentIntentModel']>, from: string, to: string): number {
  const observed = model.transitions[from + '->' + to] ?? 0;
  const outgoing = Object.entries(model.transitions).filter(([key]) => key.startsWith(from + '->')).reduce((sum, [, value]) => sum + value, 0);
  if (outgoing === 0) return 0.08;
  return clamp(0.08 + observed / Math.max(1, outgoing));
}

function generativeNeedScore(intent: SearchIntent, model: NonNullable<SearchPolicyState['latentIntentModel']>, observations: BehaviorTrajectoryEvent[], label: string, features: ReturnType<typeof trajectoryFeatures>): number {
  const prototype = model.statePrototypes?.[label] ?? [0, 0, 0, 0, 0];
  const memoryStrength = model.trajectoryMemory?.[label] ?? 0.25;
  const window = observations.slice(-4);
  const recentTransitions = window.length > 1 ? average(window.slice(1).map((event, index) => transitionLikelihood(model, labelFromEvent(window[index]), labelFromEvent(event)))) : 0.12;
  const recency = Math.exp(-features.lastGapHours / 48);
  const sourceVariety = new Set(observations.filter((event) => labelFromEvent(event) === label).map((event) => sourceFor(label, event.source))).size;
  const failurePressure = observations.filter((event) => labelFromEvent(event) === label && event.outcome === 'failure').length / Math.max(1, observations.filter((event) => labelFromEvent(event) === label).length || 1);
  const prototypeStrength = prototype[0] ? clamp((prototype[0] as number) / Math.max(1, (prototype[3] as number) || 1)) : 0.25;
  const graphPressure = features.graphPressure;
  const cadenceLift = features.cadence > 0 ? clamp(features.cadence / 10_000, 0, 0.08) : 0;
  const intentPull = intent.freshness === 'live' ? 0.06 : intent.trustMode === 'official-first' ? 0.03 : 0.02;
  return memoryStrength * 0.16 + prototypeStrength * 0.18 + recentTransitions * 0.14 + recency * 0.08 + sourceVariety * 0.03 + graphPressure * 0.12 + cadenceLift + intentPull - failurePressure * 0.08 - features.ignored * 0.01;
}

function generateIntentTrajectory(intent: SearchIntent, model: NonNullable<SearchPolicyState['latentIntentModel']>, observations: BehaviorTrajectoryEvent[], labels: string[]) {
  const features = trajectoryFeatures(intent, observations);
  const scores = labels.map((label) => ({ label, score: generativeNeedScore(intent, model, observations, label, features) }));
  const peak = Math.max(...scores.map((entry) => entry.score), 0);
  const probabilities = scores.map((entry) => Math.exp(entry.score - peak));
  const total = probabilities.reduce((sum, value) => sum + value, 0) || 1;
  return scores.map((entry, index) => {
    const probability = probabilities[index] / total;
    const matchingEvents = observations.filter((event) => labelFromEvent(event) === entry.label);
    const successRate = matchingEvents.length === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'success').length / matchingEvents.length;
    const failureRate = matchingEvents.length === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'failure').length / matchingEvents.length;
    const ignoredRate = matchingEvents.length === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'ignored').length / matchingEvents.length;
    return {
      label: entry.label,
      score: entry.score,
      probability,
      features: {
        frequency: matchingEvents.length,
        successRate,
        failureRate,
        ignoredRate,
        confidence: average(matchingEvents.map((event) => Number(event.confidence ?? 0.5))),
        value: matchingEvents.reduce((sum, event) => sum + Number(event.value ?? (event.outcome === 'success' ? 1 : event.outcome === 'failure' ? -0.6 : 0.1)), 0),
        durationMs: average(matchingEvents.map((event) => Number(event.durationMs ?? 0))),
        sourceVariety: new Set(matchingEvents.map((event) => sourceFor(entry.label, event.source))).size,
      },
    };
  });
}

export function updateLatentIntentModel(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): NonNullable<SearchPolicyState['latentIntentModel']> {
  const labels = candidateIntentLabels(intent, observations);
  const next = updateLatentStateMemory(model, labels, observations, intent);
  const scores = generateIntentTrajectory(intent, next, observations, labels);
  next.archetypes = scores.slice(0, 8).map((entry, index) => {
    const probability = entry.probability;
    const matchingEvents = observations.filter((event) => labelFromEvent(event) === entry.label);
    const support = matchingEvents.length;
    const successRate = support === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'success').length / support;
    const failureRate = support === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'failure').length / support;
    const ignoredRate = support === 0 ? 0 : matchingEvents.filter((event) => event.outcome === 'ignored').length / support;
    const confidence = average(matchingEvents.map((event) => Number(event.confidence ?? 0.5)));
    return {
      label: entry.label,
      features: {
        frequency: support,
        successRate,
        failureRate,
        ignoredRate,
        confidence,
        value: matchingEvents.reduce((sum, event) => sum + Number(event.value ?? (event.outcome === 'success' ? 1 : event.outcome === 'failure' ? -0.6 : 0.1)), 0),
        durationMs: average(matchingEvents.map((event) => Number(event.durationMs ?? 0))),
        transitionCount: Object.keys(next.transitions).filter((key) => key.startsWith(entry.label + '->')).length,
        sourceVariety: new Set(matchingEvents.map((event) => sourceFor(entry.label, event.source))).size,
        probability,
      },
      probability,
      horizon: probability > 0.5 || index === 0 ? 'immediate' : probability > 0.18 ? 'near-term' : 'later',
      intervention: probability < 0.22 ? 'clarify-before-acting' : probability < 0.5 ? 'prepare-evidence-backed-action' : 'monitor-for-confirming-signals',
      sources: uniq(matchingEvents.map((event) => sourceFor(entry.label, event.source))).slice(0, 4),
      lastObservedAt: matchingEvents.reduce((max, event) => Math.max(max, Number(event.at ?? 0)), 0) || null,
      support,
    };
  }).sort((left, right) => right.probability - left.probability);
  return next;
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const latentModel = updateLatentIntentModel(policy.latentIntentModel, intent, observations);
  const labels = latentModel.archetypes.length > 0 ? latentModel.archetypes.map((archetype) => archetype.label) : candidateIntentLabels(intent, observations);
  const scoreEntries = labels.map((label) => {
    const archetype = latentModel.archetypes.find((candidate) => candidate.label === label);
    const probability = archetype?.probability ?? (1 / Math.max(1, labels.length));
    const source = archetype?.sources[0] ?? sourceFor(label);
    const topic = archetype?.label ?? label;
    const confidence = clamp(probability * 0.72 + (archetype?.support ?? 0) * 0.06 + (archetype?.features.confidence ?? 0.5) * 0.22);
    const trajectories = archetype ? [archetype.label, archetype.label + ' ' + archetype.intervention] : [label];
    return {
      source,
      topic,
      confidence,
      reason: archetype?.intervention ?? 'latent-goal-projection',
      suggestedQueries: [intent.semanticQuery, topic + ' evidence', topic + ' next step'].filter((entry, index, list) => list.indexOf(entry) === index).slice(0, 4),
      priority: clamp(confidence + probability * 0.2),
      distribution: [
        { label: topic, probability, trajectory: trajectories, source },
        { label: intent.focus, probability: clamp((intent.focus === 'diagnostic' ? 0.32 : 0.22) + probability * 0.4), trajectory: [intent.focus, intent.semanticQuery], source: intent.sourceHints[0] ?? 'memory' },
      ],
      latentNeed: {
        label: topic,
        features: archetype?.features ?? { frequency: 0, successRate: 0, failureRate: 0, ignoredRate: 0, confidence: 0.5, value: 0, durationMs: 0, sourceVariety: 1, probability },
        horizon: archetype?.horizon ?? 'near-term',
        intervention: archetype?.intervention ?? 'monitor-for-confirming-signals',
        posterior: probability,
      },
    } as SearchSignalForecast;
  });
  return scoreEntries.sort((left, right) => right.priority - left.priority);
}
