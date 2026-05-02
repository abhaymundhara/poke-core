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

function sessionTrajectories(observations: BehaviorTrajectoryEvent[]): string[][] {
  const grouped = new Map<string, BehaviorTrajectoryEvent[]>();
  for (const event of observations) {
    const key = event.sessionId ?? 'global';
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  return [...grouped.values()].map((events) => events.sort((left, right) => Number(left.at ?? 0) - Number(right.at ?? 0)).map(labelFromEvent));
}

function buildTrajectoryModel(observations: BehaviorTrajectoryEvent[]) {
  const transitions = new Map<string, Map<string, number>>();
  const endings = new Map<string, number>();
  const labels = new Set<string>();
  for (const trajectory of sessionTrajectories(observations)) {
    for (let i = 0; i < trajectory.length; i += 1) {
      labels.add(trajectory[i]);
      if (i < trajectory.length - 1) {
        const from = trajectory[i];
        const to = trajectory[i + 1];
        const row = transitions.get(from) ?? new Map<string, number>();
        row.set(to, (row.get(to) ?? 0) + 1);
        transitions.set(from, row);
      } else if (trajectory[i]) {
        endings.set(trajectory[i], (endings.get(trajectory[i]) ?? 0) + 1);
      }
    }
  }
  return { transitions, endings, labels: [...labels] };
}

function recencyWeight(event?: BehaviorTrajectoryEvent): number {
  if (!event?.at) return 0.2;
  const ageDays = Math.max(0, (Date.now() - Number(event.at)) / 86_400_000);
  return clamp(Math.exp(-ageDays / 7));
}

function latentNeedLabel(event: BehaviorTrajectoryEvent): string {
  return String(event.topic ?? event.category ?? event.subject ?? event.action ?? 'latent-need').toLowerCase();
}

function statePosterior(intent: SearchIntent, event: BehaviorTrajectoryEvent, evidenceGraph?: SearchEvidenceGraph): number {
  const sourceLift = intent.sourcePriors.find((prior) => prior.source === sourceFor(latentNeedLabel(event), event.source))?.weight ?? 0.5;
  const confidence = Number(event.confidence ?? 0.5);
  const utility = Number(event.value ?? (event.outcome === 'success' ? 1 : event.outcome === 'failure' ? -0.6 : 0.1));
  const recency = recencyWeight(event);
  const graphLift = evidenceGraph ? clamp(evidenceGraph.confidence * 0.1 + (evidenceGraph.communities.length > 0 ? 0.08 : 0)) : 0;
  return clamp(0.22 + sourceLift * 0.22 + confidence * 0.18 + (utility + 1) * 0.12 + recency * 0.18 + graphLift);
}

function proposeNeedDistribution(intent: SearchIntent, observations: BehaviorTrajectoryEvent[], trajectoryModel: ReturnType<typeof buildTrajectoryModel>, evidenceGraph?: SearchEvidenceGraph) {
  const currentLabels = new Set(observations.slice(-16).map(latentNeedLabel));
  const candidateSeeds = uniq([
    intent.topics[0] ?? intent.focus,
    ...observations.map(latentNeedLabel).slice(-12),
    ...intent.entities.slice(0, 3),
    ...intent.querySeeds.slice(0, 3),
  ].map((value) => value.toLowerCase()));
  const candidates = new Map<string, { label: string; trajectory: string[]; source: SearchSource | string; score: number; path: string[] }>();

  for (const seed of candidateSeeds) {
    const source = sourceFor(seed, observations.find((event) => latentNeedLabel(event) === seed)?.source);
    const trajectory = [...currentLabels].filter((label) => label !== seed).slice(0, 4);
    const path = [seed];
    let frontier = seed;
    for (let depth = 0; depth < 3; depth += 1) {
      const row = trajectoryModel.transitions.get(frontier);
      if (!row || row.size === 0) break;
      const next = [...row.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
      if (!next || path.includes(next)) break;
      path.push(next);
      frontier = next;
    }
    const localScore = path.reduce((sum, label, index) => sum + (trajectoryModel.endings.get(label) ?? 0.5) * (index === 0 ? 1 : 0.7), 0);
    candidates.set(seed, { label: seed, trajectory, source, score: localScore, path });
  }

  const scored = [...candidates.values()].map((candidate) => {
    const supportingEvents = observations.filter((event) => latentNeedLabel(event) === candidate.label);
    const posterior = clamp(0.05 + supportingEvents.reduce((sum, event) => sum + statePosterior(intent, event, evidenceGraph), 0) / Math.max(1, supportingEvents.length || 1) + candidate.score * 0.06 + (evidenceGraph?.confidence ?? 0) * 0.05);
    return { ...candidate, posterior, support: supportingEvents.length };
  });

  const weights = softmax(scored.map((entry) => entry.posterior + entry.path.length * 0.03));
  return scored.map((entry, index) => ({
    label: entry.label,
    source: entry.source,
    trajectory: entry.path,
    probability: weights[index] ?? 0,
    posterior: entry.posterior,
  })).sort((left, right) => right.probability - left.probability);
}

function horizonFor(probability: number, support: number): 'immediate' | 'near-term' | 'later' {
  if (probability >= 0.55 || support >= 4) return 'immediate';
  if (probability >= 0.25 || support >= 2) return 'near-term';
  return 'later';
}

export function updateLatentIntentModel(model: NonNullable<SearchPolicyState['latentIntentModel']> | undefined, intent: SearchIntent, observations: BehaviorTrajectoryEvent[]): NonNullable<SearchPolicyState['latentIntentModel']> {
  const next = model ?? { version: 2, archetypes: [], transitions: {}, lastUpdatedAt: Date.now() };
  const trajectories = sessionTrajectories(observations);
  const nextStateCounts = new Map<string, number>();
  const labels = new Set<string>();
  for (const trajectory of trajectories) {
    for (let i = 0; i < trajectory.length; i += 1) {
      labels.add(trajectory[i]);
      if (i < trajectory.length - 1) {
        const key = `${trajectory[i]}→${trajectory[i + 1]}`;
        next.transitions[key] = (next.transitions[key] ?? 0) + 1;
        nextStateCounts.set(trajectory[i + 1], (nextStateCounts.get(trajectory[i + 1]) ?? 0) + 1);
      }
    }
  }
  next.archetypes = [...labels].map((label) => {
    const relevant = observations.filter((event) => latentNeedLabel(event) === label);
    const successRate = relevant.filter((event) => event.outcome === 'success').length / Math.max(1, relevant.length);
    const failureRate = relevant.filter((event) => event.outcome === 'failure').length / Math.max(1, relevant.length);
    const probability = clamp(0.05 + successRate * 0.35 - failureRate * 0.18 + (nextStateCounts.get(label) ?? 0) * 0.05 + recencyWeight(relevant[relevant.length - 1]) * 0.2);
    return {
      label,
      features: {
        frequency: relevant.length,
        successRate,
        failureRate,
        ignoredRate: relevant.filter((event) => event.outcome === 'ignored').length / Math.max(1, relevant.length),
        confidence: relevant.reduce((sum, event) => sum + Number(event.confidence ?? 0.5), 0) / Math.max(1, relevant.length),
        value: relevant.reduce((sum, event) => sum + Number(event.value ?? 0), 0),
        durationMs: relevant.reduce((sum, event) => sum + Number(event.durationMs ?? 0), 0) / Math.max(1, relevant.length),
        transitionCount: trajectories.filter((trajectory) => trajectory.includes(label)).length,
        sourceVariety: new Set(relevant.map((event) => sourceFor(label, event.source))).size,
        probability,
      },
      probability,
      horizon: horizonFor(probability, relevant.length),
      intervention: failureRate > successRate ? 'clarify-before-acting' : relevant.length > 2 ? 'prepare-evidence-backed-action' : 'monitor-for-confirming-signals',
      sources: [...new Set(relevant.map((event) => sourceFor(label, event.source)))].slice(0, 4),
      lastObservedAt: relevant.reduce((max, event) => Math.max(max, Number(event.at ?? 0)), 0) || null,
      support: relevant.length,
    };
  }).sort((left, right) => right.probability - left.probability).slice(0, 8);
  next.lastUpdatedAt = Date.now();
  return next;
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const evidenceGraph = behaviorSeed?.evidenceGraph as SearchEvidenceGraph | undefined;
  const latentModel = updateLatentIntentModel(policy.latentIntentModel, intent, observations);
  const trajectoryModel = buildTrajectoryModel(observations);
  const distribution = proposeNeedDistribution(intent, observations, trajectoryModel, evidenceGraph);
  const fallbackDistribution = distribution.length > 0 ? distribution : [{ label: intent.topics[0] ?? intent.focus, source: intent.sourceHints[0] ?? 'web', trajectory: [intent.semanticQuery], probability: 1, posterior: 0.5 }];
  return fallbackDistribution.slice(0, 6).map((entry, index) => {
    const relevantObs = observations.filter((event) => latentNeedLabel(event) === entry.label);
    const confidence = clamp((entry.probability ?? 0.5) * 0.7 + (entry.posterior ?? 0.5) * 0.3 + (evidenceGraph?.confidence ?? 0) * 0.05 - index * 0.02);
    return {
      source: entry.source,
      topic: entry.label,
      confidence,
      reason: `posterior=${(entry.posterior ?? confidence).toFixed(2)} trajectory=${entry.trajectory.join('>')} support=${relevantObs.length} transitions=${Object.keys(latentModel.transitions).length}`,
      suggestedQueries: uniq([`${intent.objective} ${entry.label}`, `${entry.label} ${intent.entities[0] ?? ''}`.trim(), intent.semanticQuery]).slice(0, 3),
      priority: clamp(confidence + (intent.freshness === 'live' ? 0.08 : 0) - index * 0.02),
      distribution: fallbackDistribution.slice(0, 6).map((candidate) => ({ label: candidate.label, probability: candidate.probability, trajectory: candidate.trajectory, source: candidate.source })),
      latentNeed: {
        label: entry.label,
        features: {
          probability: entry.probability ?? confidence,
          posterior: entry.posterior ?? confidence,
          support: relevantObs.length,
          graphConfidence: evidenceGraph?.confidence ?? 0,
        },
        horizon: horizonFor(confidence, relevantObs.length),
        intervention: relevantObs.length > 0 && relevantObs.every((event) => event.outcome === 'failure') ? 'clarify-before-acting' : 'monitor-for-confirming-signals',
        posterior: entry.posterior ?? confidence,
      },
    };
  });
}
