import { resolve } from 'node:path';
import type { SearchIntent, SearchPolicyState, SearchSignalForecast, SearchSource } from './types.ts';
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

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const buckets = new Map<string, { count: number; successes: number; failures: number; sources: Map<string, number>; lastAt: number }>();
  for (const event of observations) {
    const topic = String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
    const bucket = buckets.get(topic) ?? { count: 0, successes: 0, failures: 0, sources: new Map<string, number>(), lastAt: 0 };
    bucket.count += 1;
    if (event.outcome === 'success') bucket.successes += 1;
    if (event.outcome === 'failure') bucket.failures += 1;
    const source = String(event.source ?? sourceFor(topic));
    bucket.sources.set(source, (bucket.sources.get(source) ?? 0) + 1);
    bucket.lastAt = Math.max(bucket.lastAt, Number(event.at ?? 0));
    buckets.set(topic, bucket);
  }

  const forecasts = [...buckets.entries()].map(([topic, bucket], index) => {
    const source = [...bucket.sources.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? sourceFor(topic);
    const reliability = policy.sourceReliability[source]?.score ?? 0.6;
    const outcomeLift = (bucket.successes - bucket.failures * 0.5) / Math.max(1, bucket.count);
    const recencyLift = bucket.lastAt > 0 ? 0.08 : 0;
    const confidence = clamp(0.38 + bucket.count * 0.08 + reliability * 0.18 + outcomeLift * 0.18 + recencyLift);
    return {
      source,
      topic,
      confidence,
      reason: `trajectory count=${bucket.count} success=${bucket.successes} failure=${bucket.failures}`,
      suggestedQueries: uniq([`${intent.objective} ${topic}`, `${topic} ${intent.entities[0] ?? ''}`.trim(), intent.semanticQuery]).slice(0, 3),
      priority: clamp(confidence + (intent.freshness === 'live' ? 0.08 : 0) - index * 0.03),
    };
  });

  if (forecasts.length === 0) {
    forecasts.push({
      source: intent.sourceHints[0] ?? 'web',
      topic: intent.topics[0] ?? intent.focus,
      confidence: 0.52,
      reason: 'fallback forecast from current intent',
      suggestedQueries: uniq([intent.semanticQuery, ...intent.querySeeds]).slice(0, 3),
      priority: 0.65,
    });
  }
  return forecasts.sort((left, right) => right.priority - left.priority).slice(0, 6);
}
