import { resolve } from 'node:path';
import type { SearchEvidenceGraph, SearchIntent, SearchPolicyState, SearchSignalForecast, SearchSource } from './types.ts';
import { clamp, readJson, uniq } from './utils.ts';

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
  if (/calendar|schedule|meeting/i.test(topic)) return 'calendar';
  if (/email|thread|reply|relationship/i.test(topic)) return 'email';
  if (/github|repo|issue|commit/i.test(topic)) return 'github';
  if (/file|path|filesystem/i.test(topic)) return 'filesystem';
  if (/integration|notion|linear|slack/i.test(topic)) return 'integration';
  return 'memory';
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function labelFromEvent(event: BehaviorTrajectoryEvent): string {
  return String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
}

function updateCounts(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

export function updateLatentIntentModel(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): NonNullable<SearchPolicyState['latentIntentModel']> {
  const next = model ?? { version: 1, archetypes: [], transitions: {}, lastUpdatedAt: Date.now() };
  const buckets = new Map<string, { count: number; success: number; failure: number; ignored: number; sources: Record<string, number>; lastObservedAt: number; confidence: number; value: number; durationMs: number; transitions: Record<string, number> }>();
  let previous = '';
  for (const event of observations) {
    const label = labelFromEvent(event);
    const bucket = buckets.get(label) ?? { count: 0, success: 0, failure: 0, ignored: 0, sources: {}, lastObservedAt: 0, confidence: 0, value: 0, durationMs: 0, transitions: {} };
    bucket.count += 1;
    if (event.outcome === 'success') bucket.success += 1;
    if (event.outcome === 'failure') bucket.failure += 1;
    if (event.outcome === 'ignored') bucket.ignored += 1;
    updateCounts(bucket.sources, sourceFor(label, event.source));
    bucket.lastObservedAt = Math.max(bucket.lastObservedAt, Number(event.at ?? 0));
    bucket.confidence += Number(event.confidence ?? 0.5);
    bucket.value += Number(event.value ?? (event.outcome === 'success' ? 1 : event.outcome === 'failure' ? -0.6 : 0.1));
    bucket.durationMs += Math.max(0, Number(event.durationMs ?? 0));
    if (previous && previous !== label) updateCounts(bucket.transitions, previous);
    buckets.set(label, bucket);
    previous = label;
  }
  const scores = [...buckets.entries()].map(([label, bucket]) => {
    const reliability = intent.sourcePriors.find((prior) => prior.source === sourceFor(label))?.weight ?? 0.5;
    const successRate = bucket.success / Math.max(1, bucket.count);
    const failureRate = bucket.failure / Math.max(1, bucket.count);
    const recency = bucket.lastObservedAt ? Math.exp(-Math.max(0, Date.now() - bucket.lastObservedAt) / 86_400_000) : 0;
    const durationLift = clamp(bucket.durationMs / Math.max(1, bucket.count) / 300_000) * 0.12;
    const transitionLift = clamp(Object.keys(bucket.transitions).length / Math.max(1, bucket.count)) * 0.1;
    const evidencePressure = clamp((bucket.count + successRate * 1.6 - failureRate * 0.9) / 8);
    return {
      label,
      bucket,
      score: 0.34 + reliability * 0.16 + successRate * 0.18 - failureRate * 0.08 + recency * 0.14 + durationLift + transitionLift + evidencePressure * 0.16,
    };
  });
  const probabilities = softmax(scores.map((entry) => entry.score));
  next.archetypes = scores.map((entry, index) => ({
    label: entry.label,
    features: {
      frequency: entry.bucket.count,
      successRate: entry.bucket.success / Math.max(1, entry.bucket.count),
      failureRate: entry.bucket.failure / Math.max(1, entry.bucket.count),
      ignoredRate: entry.bucket.ignored / Math.max(1, entry.bucket.count),
      confidence: entry.bucket.confidence / Math.max(1, entry.bucket.count),
      value: entry.bucket.value,
      durationMs: entry.bucket.durationMs / Math.max(1, entry.bucket.count),
      transitionCount: Object.keys(entry.bucket.transitions).length,
      sourceVariety: Object.keys(entry.bucket.sources).length,
      probability: probabilities[index] ?? 0,
    },
    probability: probabilities[index] ?? 0,
    horizon: entry.bucket.count > 6 || entry.bucket.success > entry.bucket.failure * 1.5 ? 'immediate' : entry.bucket.count > 2 ? 'near-term' : 'later',
    intervention: entry.bucket.failure > entry.bucket.success ? 'clarify-before-acting' : entry.bucket.ignored > entry.bucket.success ? 'lower-priority-monitor' : 'prepare-evidence-backed-action',
    sources: Object.keys(entry.bucket.sources).slice(0, 4),
    lastObservedAt: entry.bucket.lastObservedAt || null,
    support: entry.bucket.count,
  })).sort((left, right) => right.probability - left.probability).slice(0, 8);
  next.transitions = { ...(next.transitions ?? {}) };
  for (const event of observations) {
    const label = labelFromEvent(event);
    const key = `${label}:${event.outcome ?? 'pending'}`;
    next.transitions[key] = (next.transitions[key] ?? 0) + 1;
  }
  next.lastUpdatedAt = Date.now();
  return next;
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const evidenceGraph = behaviorSeed?.evidenceGraph as SearchEvidenceGraph | undefined;
  const latentModel = updateLatentIntentModel(policy.latentIntentModel, intent, observations);
  const distribution = latentModel.archetypes.length > 0 ? latentModel.archetypes : [{ label: intent.topics[0] ?? intent.focus, probability: 1, features: { fallback: 1 }, horizon: 'near-term' as const, intervention: 'monitor-for-confirming-signals', sources: intent.sourceHints, lastObservedAt: null, support: 1 }];
  const newest = Math.max(0, ...observations.map((event) => Number(event.at ?? 0)));
  const forecasts = distribution.map((archetype, index) => {
    const source = archetype.sources[0] ?? intent.sourceHints[0] ?? sourceFor(archetype.label);
    const relevantObs = observations.filter((event) => labelFromEvent(event) === archetype.label);
    const avgConfidence = relevantObs.length ? relevantObs.reduce((sum, event) => sum + Number(event.confidence ?? 0.5), 0) / relevantObs.length : 0.5;
    const recency = archetype.lastObservedAt && newest ? Math.exp(-(newest - archetype.lastObservedAt) / 86_400_000) : 0.1;
    const graphLift = evidenceGraph ? clamp((evidenceGraph.communities.filter((community) => community.label.includes(archetype.label.split(/\s+/)[0] ?? archetype.label)).length * 0.08) + (evidenceGraph.synthesis.stance === 'contested' ? 0.06 : 0) + evidenceGraph.confidence * 0.08) : 0;
    const probability = clamp(archetype.probability + graphLift * 0.4 + recency * 0.08 + avgConfidence * 0.08);
    const predictedNeed = {
      label: archetype.label,
      features: {
        ...archetype.features,
        posterior: probability,
        recency,
        evidencePressure: relevantObs.length / Math.max(1, observations.length),
        graphConfidence: evidenceGraph?.confidence ?? 0,
      },
      horizon: archetype.horizon,
      intervention: archetype.intervention,
    };
    return {
      source,
      topic: archetype.label,
      confidence: probability,
      reason: `posterior=${probability.toFixed(2)} horizon=${archetype.horizon} support=${archetype.support} observed=${relevantObs.length} transition=${Object.keys(latentModel.transitions).length}`,
      suggestedQueries: uniq([`${intent.objective} ${archetype.label}`, `${archetype.label} ${intent.entities[0] ?? ''}`.trim(), intent.semanticQuery]).slice(0, 3),
      priority: clamp(probability + (intent.freshness === 'live' ? 0.08 : 0) - index * 0.02),
      latentNeed: predictedNeed,
    };
  });
  if (forecasts.length === 0) {
    forecasts.push({
      source: intent.sourceHints[0] ?? 'web',
      topic: intent.topics[0] ?? intent.focus,
      confidence: 0.5,
      reason: 'posterior=0.50 fallback distribution from current intent',
      suggestedQueries: uniq([intent.semanticQuery, ...intent.querySeeds]).slice(0, 3),
      priority: 0.5,
      latentNeed: { label: intent.topics[0] ?? intent.focus, features: { fallback: 1, posterior: 0.5 }, horizon: 'near-term', intervention: 'monitor-for-confirming-signals' },
    });
  }
  return forecasts.sort((left, right) => right.priority - left.priority).slice(0, 6);
}
