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

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const evidenceGraph = behaviorSeed?.evidenceGraph as SearchEvidenceGraph | undefined;
  const newest = Math.max(0, ...observations.map((event) => Number(event.at ?? 0)));
  const buckets = new Map<string, { count: number; successes: number; failures: number; ignored: number; sources: Map<string, number>; lastAt: number; durationMs: number; value: number; confidence: number; transitions: Map<string, number> }>();
  let previousTopic = '';
  for (const event of observations) {
    const topic = String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
    const bucket = buckets.get(topic) ?? { count: 0, successes: 0, failures: 0, ignored: 0, sources: new Map<string, number>(), lastAt: 0, durationMs: 0, value: 0, confidence: 0, transitions: new Map<string, number>() };
    bucket.count += 1;
    if (event.outcome === 'success') bucket.successes += 1;
    if (event.outcome === 'failure') bucket.failures += 1;
    if (event.outcome === 'ignored') bucket.ignored += 1;
    const source = String(event.source ?? sourceFor(topic));
    bucket.sources.set(source, (bucket.sources.get(source) ?? 0) + 1);
    bucket.lastAt = Math.max(bucket.lastAt, Number(event.at ?? 0));
    bucket.durationMs += Math.max(0, Number(event.durationMs ?? 0));
    bucket.value += Number(event.value ?? (event.outcome === 'success' ? 1 : event.outcome === 'failure' ? -0.4 : 0.1));
    bucket.confidence += Number(event.confidence ?? 0.5);
    if (previousTopic && previousTopic !== topic) bucket.transitions.set(previousTopic, (bucket.transitions.get(previousTopic) ?? 0) + 1);
    buckets.set(topic, bucket);
    previousTopic = topic;
  }

  const forecasts = [...buckets.entries()].map(([topic, bucket], index) => {
    const source = [...bucket.sources.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? sourceFor(topic);
    const reliability = policy.sourceReliability[source]?.score ?? 0.6;
    const outcomeLift = (bucket.successes - bucket.failures * 0.5) / Math.max(1, bucket.count);
    const recencyLift = bucket.lastAt > 0 && newest > 0 ? Math.exp(-(newest - bucket.lastAt) / 86_400_000) * 0.14 : 0;
    const dwellLift = clamp(bucket.durationMs / Math.max(1, bucket.count) / 300_000) * 0.1;
    const transitionLift = clamp([...bucket.transitions.values()].reduce((sum, value) => sum + value, 0) / Math.max(1, bucket.count)) * 0.12;
    const averageConfidence = bucket.confidence / Math.max(1, bucket.count);
    const graphLift = evidenceGraph ? clamp((evidenceGraph.communities.filter((community) => community.label.includes(topic.split(/\s+/)[0] ?? topic)).length * 0.08) + (evidenceGraph.synthesis.stance === 'contested' ? 0.05 : 0) + evidenceGraph.confidence * 0.08) : 0;
    const latentScore = clamp(0.26 + bucket.count * 0.055 + reliability * 0.14 + outcomeLift * 0.2 + recencyLift + dwellLift + transitionLift + averageConfidence * 0.12 + graphLift);
    const horizon = latentScore > 0.78 || intent.freshness === 'live' ? 'immediate' : latentScore > 0.58 ? 'near-term' : 'later';
    const intervention = bucket.failures > bucket.successes ? 'clarify-before-acting' : bucket.ignored > bucket.successes ? 'lower-priority-monitor' : 'prepare-evidence-backed-action';
    return {
      source,
      topic,
      confidence: latentScore,
      reason: `latent trajectory score=${latentScore.toFixed(2)} count=${bucket.count} success=${bucket.successes} failure=${bucket.failures} transitions=${bucket.transitions.size}`,
      suggestedQueries: uniq([`${intent.objective} ${topic}`, `${topic} ${intent.entities[0] ?? ''}`.trim(), intent.semanticQuery]).slice(0, 3),
      priority: clamp(latentScore + (intent.freshness === 'live' ? 0.08 : 0) - index * 0.03),
      latentNeed: {
        label: topic,
        features: { frequency: bucket.count, outcomeLift, recencyLift, dwellLift, transitionLift, averageConfidence, value: bucket.value, graphLift, graphConfidence: evidenceGraph?.confidence ?? 0 },
        horizon,
        intervention,
      },
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
      latentNeed: { label: intent.topics[0] ?? intent.focus, features: { fallback: 1 }, horizon: 'near-term', intervention: 'monitor-for-confirming-signals' },
    });
  }
  return forecasts.sort((left, right) => right.priority - left.priority).slice(0, 6);
}
