import { resolve } from 'node:path';
import type { SearchEvidenceGraph, SearchIntent, SearchPolicyState, SearchSignalForecast, SearchSource } from './types.ts';
import { average, clamp, readJson, uniq, words, stableHash } from './utils.ts';

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
const VECTOR_DIMENSIONS = 14;

function vectorize(text: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vector = new Array(dimensions).fill(0);
  const tokens = words(text.toLowerCase());
  if (tokens.length === 0) return vector;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const hash = stableHash(`${token}:${tokenIndex % 9}:${dimensions}`);
    for (let i = 0; i < hash.length; i += 2) {
      const slice = hash.slice(i, i + 2);
      if (!slice) continue;
      vector[Number.parseInt(slice, 16) % dimensions] += ((tokenIndex % 5) + 1) / (tokens.length + 2);
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = (Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1) * (Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1);
  if (denominator === 0) return 0;
  const numerator = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  return clamp((numerator / denominator + 1) / 2);
}

function softmax(values: number[]): number[] {
  const peak = Math.max(...values, 0);
  const exps = values.map((value) => Math.exp(value - peak));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

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
  if (/calendar|schedule|meeting/i.test(topic)) return 'calendar';
  if (/email|thread|reply|relationship/i.test(topic)) return 'email';
  if (/github|repo|issue|commit/i.test(topic)) return 'github';
  if (/file|path|filesystem/i.test(topic)) return 'filesystem';
  if (/integration|notion|linear|slack/i.test(topic)) return 'integration';
  return 'memory';
}

function labelFromEvent(event: BehaviorTrajectoryEvent): string {
  return String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
}

function trajectoryText(event: BehaviorTrajectoryEvent): string {
  return [labelFromEvent(event), event.source ?? '', event.outcome ?? 'pending', event.value ?? '', event.durationMs ?? ''].join(' ');
}

function latentNeedLabels(intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): string[] {
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
  ]);
  for (const event of observations) labels.add(labelFromEvent(event));
  return [...labels].filter(Boolean).slice(0, 20);
}

function updateLatentStateMemory(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, labels: string[], observations: BehaviorTrajectoryEvent[], intent: SearchIntent): NonNullable<SearchPolicyState['latentIntentModel']> {
  const next = model ?? { version: 1, archetypes: [], transitions: {}, lastUpdatedAt: Date.now(), statePrototypes: {}, trajectoryMemory: {} };
  next.statePrototypes ??= {};
  next.trajectoryMemory ??= {};
  const sequence = observations.map(labelFromEvent);
  for (const label of labels) {
    const relevant = observations.filter((event) => labelFromEvent(event) === label);
    if (relevant.length === 0) continue;
    const prototype = vectorize([
      label,
      intent.semanticQuery,
      ...relevant.map((event) => trajectoryText(event)),
    ].join(' | '));
    next.statePrototypes[label] = next.statePrototypes[label]
      ? next.statePrototypes[label].map((value, index) => value * 0.68 + (prototype[index] ?? 0) * 0.32)
      : prototype;
    const successWeight = relevant.filter((event) => event.outcome === 'success').length;
    const failureWeight = relevant.filter((event) => event.outcome === 'failure').length;
    const trajectorySignal = relevant.length + successWeight * 0.45 - failureWeight * 0.18;
    next.trajectoryMemory[label] = (next.trajectoryMemory[label] ?? 0.2) * 0.76 + trajectorySignal;
  }
  for (let index = 1; index < sequence.length; index += 1) {
    const previous = sequence[index - 1];
    const current = sequence[index];
    const key = `${previous}->${current}`;
    next.transitions[key] = (next.transitions[key] ?? 0) * 0.79 + 1;
  }
  next.lastUpdatedAt = Date.now();
  return next;
}

function transitionLikelihood(model: NonNullable<SearchPolicyState['latentIntentModel']>, from: string, to: string): number {
  const observed = model.transitions[`${from}->${to}`] ?? 0;
  const outgoing = Object.entries(model.transitions).filter(([key]) => key.startsWith(`${from}->`)).reduce((sum, [, value]) => sum + value, 0);
  if (outgoing === 0) return 0.08;
  return clamp(0.08 + observed / Math.max(1, outgoing));
}

function generativeNeedDistribution(intent: SearchIntent, model: NonNullable<SearchPolicyState['latentIntentModel']>, observations: BehaviorTrajectoryEvent[], labels: string[], evidenceGraph?: SearchEvidenceGraph): Array<{ label: string; probability: number; trajectory: string[]; source: SearchSource | string; score: number }> {
  const latest = observations[observations.length - 1];
  const latestVector = latest ? vectorize(trajectoryText(latest)) : vectorize(intent.semanticQuery);
  const intentVector = vectorize([intent.objective, intent.semanticQuery, ...intent.topics, ...intent.entities].join(' '));
  const graphPressure = evidenceGraph ? clamp(evidenceGraph.confidence * 0.18 + (evidenceGraph.synthesis.stance === 'contested' ? 0.08 : 0) + Math.min(0.12, evidenceGraph.conflicts.length * 0.03)) : 0;
  const scores = labels.map((label) => {
    const prototype = model.statePrototypes?.[label] ?? vectorize(label);
    const memoryStrength = model.trajectoryMemory?.[label] ?? 0.25;
    const semanticFit = cosineSimilarity(latestVector, prototype);
    const intentFit = cosineSimilarity(intentVector, prototype);
    const transitionFit = observations.length > 1 ? transitionLikelihood(model, labelFromEvent(observations[observations.length - 2]), label) : 0.12;
    const trajectoryWindow = observations.slice(-4);
    const trajectoryFit = trajectoryWindow.length > 0 ? average(trajectoryWindow.map((event, index) => cosineSimilarity(vectorize(trajectoryText(event)), prototype) * (1 + index / Math.max(1, trajectoryWindow.length)))) : 0.2;
    const sourceDiversity = new Set(observations.filter((event) => labelFromEvent(event) === label).map((event) => sourceFor(label, event.source))).size;
    const recency = latest?.at ? Math.exp(-Math.max(0, Date.now() - latest.at) / 86_400_000) : 0.2;
    const novelty = 1 - cosineSimilarity(prototype, vectorize(label));
    const failurePressure = observations.filter((event) => labelFromEvent(event) === label && event.outcome === 'failure').length / Math.max(1, observations.filter((event) => labelFromEvent(event) === label).length || 1);
    const score = memoryStrength * 0.2 + semanticFit * 0.18 + intentFit * 0.18 + trajectoryFit * 0.18 + transitionFit * 0.12 + recency * 0.05 + graphPressure * 0.04 + sourceDiversity * 0.03 + novelty * 0.03 - failurePressure * 0.08;
    return { label, score, prototype };
  });
  const probabilities = softmax(scores.map((entry) => entry.score));
  return scores.map((entry, index) => {
    const probability = probabilities[index] ?? 0;
    const trajectory = [...new Set([...observations.slice(-3).map((event) => labelFromEvent(event)), entry.label])].filter(Boolean);
    return {
      label: entry.label,
      probability,
      score: entry.score,
      trajectory,
      source: sourceFor(entry.label, observations.find((event) => labelFromEvent(event) === entry.label)?.source),
    };
  }).sort((left, right) => right.probability - left.probability);
}

export function updateLatentIntentModel(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): NonNullable<SearchPolicyState['latentIntentModel']> {
  const labels = latentNeedLabels(intent, observations);
  const next = updateLatentStateMemory(model, labels, observations, intent);
  const posteriors = generativeNeedDistribution(intent, next, observations, labels);
  next.archetypes = posteriors.slice(0, 8).map((entry, index) => {
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
        transitionCount: Object.keys(next.transitions).filter((key) => key.startsWith(`${entry.label}->`)).length,
        sourceVariety: new Set(matchingEvents.map((event) => sourceFor(entry.label, event.source))).size,
        probability: entry.probability,
      },
      probability: entry.probability,
      horizon: entry.probability > 0.48 || index === 0 ? 'immediate' : entry.probability > 0.18 ? 'near-term' : 'later',
      intervention: entry.probability < 0.22 ? 'clarify-before-acting' : entry.probability < 0.5 ? 'prepare-evidence-backed-action' : 'monitor-for-confirming-signals',
      sources: uniq(matchingEvents.map((event) => sourceFor(entry.label, event.source))).slice(0, 4),
      lastObservedAt: matchingEvents.reduce((max, event) => Math.max(max, Number(event.at ?? 0)), 0) || null,
      support,
    };
  }).sort((left, right) => right.probability - left.probability);
  return next;
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const evidenceGraph = behaviorSeed?.evidenceGraph as SearchEvidenceGraph | undefined;
  const latentModel = updateLatentIntentModel(policy.latentIntentModel, intent, observations);
  const posterior = latentModel.archetypes.length > 0 ? latentModel.archetypes : [{ label: intent.topics[0] ?? intent.focus, probability: 1, features: { fallback: 1 }, horizon: 'near-term' as const, intervention: 'monitor-for-confirming-signals', sources: intent.sourceHints, lastObservedAt: null, support: 1 }];
  const graphInfluence = evidenceGraph ? clamp(evidenceGraph.confidence * 0.18 + (evidenceGraph.synthesis.stance === 'contested' ? 0.08 : 0) + Math.min(0.1, evidenceGraph.conflicts.length * 0.02)) : 0;
  const topPosterior = posterior.slice(0, 5);
  const distributionNormalizer = Math.max(1e-6, topPosterior.reduce((sum, item) => sum + item.probability, 0));
  return posterior.slice(0, 6).map((archetype, index) => {
    const source = archetype.sources[0] ?? intent.sourceHints[0] ?? sourceFor(archetype.label);
    const sourcePosterior = clamp(archetype.probability + graphInfluence * 0.5 + (intent.freshness === 'live' ? 0.05 : 0) - index * 0.01);
    const distribution = topPosterior.map((entry) => ({
      label: entry.label,
      probability: clamp(entry.probability / distributionNormalizer),
      trajectory: [...entry.trajectory],
      source: entry.source,
    }));
    return {
      source,
      topic: archetype.label,
      confidence: sourcePosterior,
      reason: `generative-posterior=${sourcePosterior.toFixed(2)} trajectory=${topPosterior.slice(0, 3).map((entry) => entry.label).join('>') || archetype.label} support=${archetype.support} graph=${evidenceGraph?.confidence?.toFixed(2) ?? '0.00'}`,
      suggestedQueries: uniq([`${intent.objective} ${archetype.label}`, `${archetype.label} ${intent.entities[0] ?? ''}`.trim(), intent.semanticQuery]).slice(0, 3),
      priority: clamp(sourcePosterior + (intent.freshness === 'live' ? 0.08 : 0) - index * 0.02),
      distribution,
      latentNeed: {
        label: archetype.label,
        features: {
          ...archetype.features,
          posterior: sourcePosterior,
          recency: archetype.lastObservedAt ? Math.exp(-Math.max(0, Date.now() - archetype.lastObservedAt) / 86_400_000) : 0.1,
          evidencePressure: observations.filter((event) => labelFromEvent(event) === archetype.label).length / Math.max(1, observations.length),
          graphConfidence: evidenceGraph?.confidence ?? 0,
        },
        horizon: archetype.horizon,
        intervention: archetype.intervention,
        posterior: sourcePosterior,
      },
    };
  }).sort((left, right) => right.priority - left.priority);
}
