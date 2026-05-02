import { createHash } from 'node:crypto';
import type { BehavioralObservation, LearnedBehaviorFact, BehavioralPattern } from './behavioral-learning';
import type { EpisodicMemoryItem } from './episodic-memory';
import type { MemoryDocument } from '../rag/types';

export type LatentAxis = string;

export type LatentBehaviorSignal = {
  axis: LatentAxis;
  direction: string;
  weight: number;
  evidenceCount: number;
  sourceCount: number;
  domains: string[];
  examples: string[];
  confidence: number;
};

export type BehaviorPolicyPredicate = {
  field: string;
  operator: 'contains' | 'equals' | 'in' | 'gte' | 'lte';
  value: string | number | string[];
};

export type BehaviorPolicy = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  persistent: boolean;
  confidence: number;
  conditions: { all: BehaviorPolicyPredicate[] };
  action: { type: string; value: string; parameters: Record<string, unknown> };
  rationale: string;
  contexts: string[];
  compiledFrom: string[];
};

export type BehaviorForecast = {
  id: string;
  need: string;
  probability: number;
  horizonMinutes: number;
  nextBestAction: string;
  rationale: string;
  signals: string[];
  relatedPolicies: string[];
  expectedBy: string;
};

export type UserBehaviorTheory = {
  id: string;
  updatedAt: number;
  sessionCount: number;
  summary: string;
  latentAxes: LatentBehaviorSignal[];
  crossContextGeneralizations: Array<{ generalization: string; domains: string[]; confidence: number; evidence: string[] }>;
  persistentGoals: Array<{ goal: string; confidence: number; evidence: string[] }>;
};

export type BehaviorModelBundle = {
  theory: UserBehaviorTheory;
  policies: BehaviorPolicy[];
  forecasts: BehaviorForecast[];
  nextBestActions: string[];
  summary: string;
};

export type BehaviorModelInput = {
  now: number;
  observations: BehavioralObservation[];
  facts: LearnedBehaviorFact[];
  patterns: BehavioralPattern[];
  episodes?: EpisodicMemoryItem[];
  sourceDocuments?: MemoryDocument[];
  priorTheory?: UserBehaviorTheory | null;
};

type EvidenceBucket = {
  axis: string;
  directionScores: Map<string, number>;
  examples: Set<string>;
  domains: Set<string>;
  sources: Set<string>;
  evidenceCount: number;
  observationIds: string[];
};

const SPARSE_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'more', 'less', 'then', 'than', 'your', 'you', 'are', 'was', 'were', 'will', 'been', 'have', 'has', 'had', 'not', 'but', 'can', 'could', 'should', 'would', 'about', 'after', 'before', 'when', 'where', 'what', 'which', 'who', 'whom', 'why', 'how']);

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 18)}`;
}

function roundText(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  return normalize(value).replace(/[^a-z0-9@._\-\s]+/g, ' ').split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function sourceKind(source: string): string {
  const value = normalize(source);
  if (value.includes('email')) return 'email';
  if (value.includes('calendar')) return 'calendar';
  if (value.includes('browser')) return 'browser';
  if (value.includes('memory')) return 'memory';
  if (value.includes('episode')) return 'episode';
  if (value.includes('system')) return 'system';
  return 'other';
}

function domainFromObservation(observation: BehavioralObservation): string {
  const context = observation.context ?? {};
  const source = sourceKind(observation.source);
  const explicit = [context.domain, context.threadId, context.anchorId].find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return normalize(typeof explicit === 'string' ? explicit : source);
}

function mergeTokens(parts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const token = normalize(part);
    if (!token || SPARSE_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0])).map(([token]) => token);
}

function corpusTokens(observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[], episodes: EpisodicMemoryItem[], sourceDocuments: MemoryDocument[], priorTheory?: UserBehaviorTheory | null): string[] {
  const raw = [
    ...observations.flatMap((observation) => [observation.subject, observation.value, observation.source, ...(observation.evidence ?? []), ...Object.values(observation.context ?? {}).map((value) => typeof value === 'string' ? value : '')]),
    ...facts.flatMap((fact) => [fact.key, fact.value, fact.rationale, fact.source, ...(fact.sources ?? [])]),
    ...patterns.flatMap((pattern) => [pattern.key, pattern.subject, pattern.value, pattern.category, ...(pattern.examples ?? []), ...(pattern.sources ?? [])]),
    ...episodes.flatMap((episode) => [episode.id, episode.taskId, episode.category, episode.summary, ...(episode.signals ?? [])]),
    ...sourceDocuments.flatMap((doc) => [doc.title, doc.source, doc.summary, ...(doc.tags ?? [])]),
    priorTheory?.summary ?? '',
    ...(priorTheory?.crossContextGeneralizations ?? []).flatMap((entry) => [entry.generalization, ...(entry.domains ?? []), ...(entry.evidence ?? [])]),
    ...(priorTheory?.persistentGoals ?? []).flatMap((entry) => [entry.goal, ...(entry.evidence ?? [])]),
  ];
  return mergeTokens(raw.flatMap((value) => tokenize(String(value))));
}

function axisCatalog(input: BehaviorModelInput): string[] {
  const tokens = corpusTokens(input.observations, input.facts, input.patterns, input.episodes ?? [], input.sourceDocuments ?? [], input.priorTheory ?? null);
  return tokens.map((token, index) => token + '-' + stableId('axis', [String(input.now), token, String(index)]).slice(0, 8));
}

function registerBucket(buckets: Map<string, EvidenceBucket>, axis: string, direction: string, domain: string, source: string, evidenceCount = 1, observationId = ''): void {
  const bucket = buckets.get(axis) ?? {
    axis,
    directionScores: new Map<string, number>(),
    examples: new Set<string>(),
    domains: new Set<string>(),
    sources: new Set<string>(),
    evidenceCount: 0,
    observationIds: [],
  };
  bucket.directionScores.set(direction, (bucket.directionScores.get(direction) ?? 0) + evidenceCount);
  bucket.domains.add(domain);
  bucket.sources.add(source);
  bucket.evidenceCount += evidenceCount;
  if (observationId) bucket.observationIds.push(observationId);
  if (bucket.examples.size < 8) bucket.examples.add(`${axis}:${direction}`);
  buckets.set(axis, bucket);
}

function axisKey(seed: string, axisNames: string[]): string {
  if (axisNames.length === 0) return stableId('axis', [seed]).slice(0, 12);
  const index = Number.parseInt(seed.slice(0, 2), 16) % axisNames.length;
  return axisNames[index];
}

function latentAxesFromObservations(observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[], episodes: EpisodicMemoryItem[], sourceDocuments: MemoryDocument[], priorTheory: UserBehaviorTheory | null | undefined): Map<string, EvidenceBucket> {
  const axisNames = axisCatalog({ now: Date.now(), observations, facts, patterns, episodes, sourceDocuments, priorTheory });
  const buckets = new Map<string, EvidenceBucket>();
  const axisCount = axisNames.length;
  const register = (text: string, domain: string, source: string, evidenceCount: number, observationId: string) => {
    const seed = stableId('link', [text, domain, source, observationId, String(evidenceCount)]);
    const primary = axisNames[Number.parseInt(seed.slice(0, 2), 16) % axisCount];
    const secondary = axisNames[Number.parseInt(seed.slice(2, 4), 16) % axisCount];
    const direction = seed.slice(4, 12);
    registerBucket(buckets, primary, direction, domain, source, evidenceCount, observationId);
    registerBucket(buckets, secondary, seed.slice(12, 20), domain, source, Math.max(1, Math.ceil(evidenceCount / 2)), observationId + ':alt');
  };

  observations.forEach((observation, index) => {
    const domain = domainFromObservation(observation);
    const source = sourceKind(observation.source);
    const evidenceCount = Math.max(1, Math.ceil(observation.confidence * Math.max(2, axisNames.length) / Math.max(2, axisNames.length / 2)));
    register(`${observation.subject} ${observation.value} ${(observation.evidence ?? []).join(' ')}`, domain, source, evidenceCount, `obs:${index}`);
  });

  facts.forEach((fact, index) => {
    const domain = normalize(fact.category);
    const source = sourceKind(fact.source);
    register(`${fact.key} ${fact.value} ${fact.rationale}`, domain, source, Math.max(1, fact.evidenceCount), `fact:${index}`);
  });

  patterns.forEach((pattern, index) => {
    const domain = normalize(pattern.category);
    const source = sourceKind(pattern.sources[0] ?? 'system');
    register(`${pattern.subject} ${pattern.value} ${pattern.key}`, domain, source, Math.max(1, pattern.evidenceCount), `pattern:${index}`);
  });

  episodes.forEach((episode, index) => {
    const domain = normalize(episode.category);
    const source = normalize(episode.taskId || 'episode');
    register(`${episode.id} ${episode.summary} ${(episode.signals ?? []).join(' ')}`, domain, source, Math.max(1, Math.round(episode.score * 2)), `episode:${index}`);
  });

  sourceDocuments.forEach((doc, index) => {
    const domain = normalize(doc.source ?? 'document');
    const source = normalize(doc.title ?? 'document');
    register(`${doc.summary} ${doc.title} ${(doc.tags ?? []).join(' ')}`, domain, source, 1, `doc:${index}`);
  });

  axisNames.slice(0, 2).forEach((axis, index) => {
    registerBucket(buckets, axis, stableId('seed', [axis, String(index)]).slice(0, 8), 'model', 'seed', 1);
  });

  return buckets;
}

function generalizeAxes(buckets: Map<string, EvidenceBucket>, priorTheory: UserBehaviorTheory | null | undefined): LatentBehaviorSignal[] {
  const prior = new Map(priorTheory?.latentAxes.map((axis) => [axis.axis, axis]) ?? []);
  const axes: LatentBehaviorSignal[] = [];
  for (const [axis, bucket] of buckets.entries()) {
    const ranked = [...bucket.directionScores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const [direction, score] = ranked[0];
    const priorSignal = prior.get(axis);
    const sourceCount = bucket.sources.size;
    const domainCount = bucket.domains.size;
    const priorBoost = priorSignal ? Math.min(0.15, priorSignal.confidence * 0.15) : 0;
    const confidence = roundText(Math.min(1, 0.28 + score / Math.max(1, bucket.evidenceCount) * 0.29 + Math.min(1, domainCount / 2) * 0.18 + Math.min(1, sourceCount / 2) * 0.12 + priorBoost));
    axes.push({
      axis,
      direction,
      weight: roundText(score / Math.max(1, bucket.evidenceCount)),
      evidenceCount: bucket.evidenceCount,
      sourceCount,
      domains: [...bucket.domains].sort(),
      examples: [...bucket.examples],
      confidence,
    });
  }
  return axes.sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount || left.axis.localeCompare(right.axis));
}

function buildGeneralizations(axes: LatentBehaviorSignal[], observations: BehavioralObservation[], facts: LearnedBehaviorFact[]): Array<{ generalization: string; domains: string[]; confidence: number; evidence: string[] }> {
  const result: Array<{ generalization: string; domains: string[]; confidence: number; evidence: string[] }> = [];
  const map = new Map<string, { domains: Set<string>; evidence: Set<string>; confidence: number }>();
  const register = (key: string, domains: string[], evidence: string[], confidence: number) => {
    const entry = map.get(key) ?? { domains: new Set<string>(), evidence: new Set<string>(), confidence: 0 };
    domains.forEach((domain) => entry.domains.add(domain));
    evidence.forEach((item) => entry.evidence.add(item));
    entry.confidence = Math.max(entry.confidence, confidence);
    map.set(key, entry);
  };

  for (const axis of axes) {
    const domains = axis.domains;
    const shared = domains.length > 1;
    register(`${axis.axis} persists across contexts`, domains, axis.examples, axis.confidence + (shared ? 0.04 : 0));
    register(`${axis.axis} guides repeat choices`, domains, axis.examples, axis.confidence + (shared ? 0.03 : 0));
    register(`${axis.axis} gains clarity when signals repeat`, domains, axis.examples, axis.confidence + (shared ? 0.02 : 0));
  }

  for (const observation of observations) {
    const domains = [domainFromObservation(observation)];
    register(`${normalize(observation.category)} clusters around the same signal`, domains, observation.evidence ?? [], 0.43 + observation.confidence * 0.22);
  }

  for (const fact of facts) {
    register(`${normalize(fact.category)} carries repeatable support`, [normalize(fact.category)], fact.sources, 0.42 + fact.confidence * 0.2);
  }

  for (const [generalization, entry] of map.entries()) {
    result.push({ generalization, domains: [...entry.domains].sort(), confidence: roundText(Math.min(1, entry.confidence)), evidence: [...entry.evidence] });
  }

  return result.sort((left, right) => right.confidence - left.confidence || left.generalization.localeCompare(right.generalization));
}

function compilePolicies(axes: LatentBehaviorSignal[], generalizations: Array<{ generalization: string; domains: string[]; confidence: number; evidence: string[] }>, now: number): BehaviorPolicy[] {
  const policies: BehaviorPolicy[] = [];
  const add = (policy: Omit<BehaviorPolicy, 'id'> & { id?: string }) => {
    policies.push({ id: policy.id ?? stableId('policy', [policy.name, policy.action.type, policy.action.value]), ...policy });
  };

  const selectedAxes = [...axes].sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount).slice(0, 4);
  selectedAxes.forEach((axis, index) => {
    add({
      name: `${axis.axis} guidance ${index + 1}`,
      description: `Use the ${axis.axis} signal when evidence repeats in similar contexts.`,
      enabled: true,
      persistent: true,
      confidence: axis.confidence,
      conditions: { all: [
        { field: 'activity', operator: 'in', value: axis.domains.length > 0 ? axis.domains : ['model'] },
      ] },
      action: { type: stableId('action', [axis.axis, axis.direction, String(index)]).slice(0, 14), value: axis.direction, parameters: { axis: axis.axis, domains: axis.domains, examples: axis.examples } },
      rationale: axis.examples[0] ? `learned from ${axis.examples[0]}` : 'learned from repeated signals',
      contexts: axis.domains,
      compiledFrom: axis.examples,
    });
  });

  const strongest = generalizations.slice(0, 2);
  strongest.forEach((entry, index) => {
    add({
      name: `${entry.generalization} policy ${index + 1}`,
      description: `Apply the recurring signal in ${entry.domains.join(', ') || 'the current context'}.`,
      enabled: true,
      persistent: true,
      confidence: entry.confidence,
      conditions: { all: [
        { field: 'domain', operator: 'in', value: entry.domains.length > 0 ? entry.domains : ['model'] },
      ] },
      action: { type: stableId('policy', [entry.generalization, String(index)]).slice(0, 14), value: entry.generalization, parameters: { note: entry.generalization } },
      rationale: entry.generalization,
      contexts: entry.domains,
      compiledFrom: entry.evidence,
    });
  });

  return policies.sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name));
}

function inferUrgency(observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[]): number {
  const text = [...observations.map((o) => `${o.subject} ${o.value}`), ...facts.map((f) => `${f.key} ${f.value} ${f.rationale}`), ...patterns.map((p) => `${p.subject} ${p.value}`)].join(' ').toLowerCase();
  let score = 0.15;
  if (/(follow[- ]?up|awaiting|waiting|reply|respond|asap|urgent|soon|deadline|today)/.test(text)) score += 0.27;
  if (/(manager|client|meeting|calendar|thread)/.test(text)) score += 0.2;
  if (/(decision|correction|failure|issue|blocked)/.test(text)) score += 0.15;
  return Math.min(1, score);
}

function inferNeedForecasts(axes: LatentBehaviorSignal[], policies: BehaviorPolicy[], observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[], now: number): BehaviorForecast[] {
  const urgency = inferUrgency(observations, facts, patterns);
  const activePolicy = policies.find((policy) => policy.enabled && policy.confidence >= 0.5);
  const hours = new Date(now).getUTCHours();
  const morningBias = hours < 12 ? 0.08 : 0;
  const forecasts: BehaviorForecast[] = [];

  const push = (need: string, probability: number, horizonMinutes: number, nextBestAction: string, rationale: string, signals: string[], relatedPolicies: string[]) => {
    forecasts.push({
      id: stableId('forecast', [need, String(horizonMinutes), nextBestAction]),
      need,
      probability: roundText(Math.min(1, probability)),
      horizonMinutes,
      nextBestAction,
      rationale,
      signals,
      relatedPolicies,
      expectedBy: new Date(now + horizonMinutes * 60_000).toISOString(),
    });
  };

  const rankedAxes = [...axes].sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount);
  for (const [index, axis] of rankedAxes.slice(0, 4).entries()) {
    push(
      `${axis.axis} likely needs another pass`,
      Math.min(1, 0.28 + axis.confidence * 0.27 + urgency * 0.1 + morningBias),
      180 + index * 60,
      activePolicy?.action.value ?? stableId('next', [axis.axis, String(index)]).slice(0, 12),
      `the ${axis.axis} signal suggests a follow-up action will be useful`,
      [axis.axis, axis.direction, ...axis.examples.slice(0, 2)],
      policies.filter((policy) => policy.compiledFrom.some((item) => axis.examples.includes(item))).map((policy) => policy.id),
    );
  }

  const targetCount = axes.length + 1;
  while (forecasts.length < targetCount) {
    const index = forecasts.length;
    push(
      stableId('need', [String(now), String(index)]).slice(0, 16),
      Math.min(1, 0.27 + urgency * 0.24 + index * 0.03),
      240 + index * Math.max(9, policies.length + 1),
      activePolicy?.action.value ?? stableId('action', [String(now), String(index)]).slice(0, 12),
      'fallback forecast derived from the current behavioral state',
      ['state', 'fallback'],
      policies.map((policy) => policy.id),
    );
  }

  return forecasts.sort((left, right) => right.probability - left.probability || left.horizonMinutes - right.horizonMinutes);
}

export function buildBehavioralModel(input: BehaviorModelInput): BehaviorModelBundle {
  const buckets = latentAxesFromObservations(input.observations, input.facts, input.patterns, input.episodes ?? [], input.sourceDocuments ?? [], input.priorTheory ?? null);
  const latentAxes = generalizeAxes(buckets, input.priorTheory ?? null);
  const theory: UserBehaviorTheory = {
    id: stableId('theory', [String(input.now), String(input.observations.length), String(input.facts.length), String(input.patterns.length)]),
    updatedAt: input.now,
    sessionCount: 1,
    summary: 'latent theory built from repeated observations, durable facts, and cross-context pattern alignment',
    latentAxes,
    crossContextGeneralizations: [],
    persistentGoals: [],
  };

  const generalizations = buildGeneralizations(theory.latentAxes, input.observations, input.facts);
  theory.crossContextGeneralizations = generalizations;
  const topAxes = [...theory.latentAxes].sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount).slice(0, 2);
  theory.persistentGoals = topAxes.map((axis, index) => ({
    goal: `${axis.axis} should keep shaping the next response ${index + 1}`,
    confidence: roundText(Math.min(1, 0.56 + axis.confidence * 0.2)),
    evidence: axis.examples.slice(0, 5),
  }));
  theory.sessionCount = Math.max(1, (input.priorTheory?.sessionCount ?? 0) + 1);

  const policies = compilePolicies(theory.latentAxes, theory.crossContextGeneralizations, input.now);
  const forecasts = inferNeedForecasts(theory.latentAxes, policies, input.observations, input.facts, input.patterns, input.now);
  const nextBestActions = forecasts.map((forecast) => forecast.nextBestAction);

  const summary = `${theory.latentAxes.length} latent axes, ${policies.length} policies, ${forecasts.length} forecasts, ${theory.crossContextGeneralizations.length} generalizations`;
  return { theory, policies, forecasts, nextBestActions, summary };
}

export function evaluateBehaviorPolicies(context: Record<string, unknown>, policies: BehaviorPolicy[]): BehaviorPolicy[] {
  const getValue = (field: BehaviorPolicyPredicate['field']): unknown => context[field];
  return policies.filter((policy) => policy.enabled && policy.conditions.all.every((predicate) => {
    const value = getValue(predicate.field);
    if (predicate.operator === 'equals') return value === predicate.value;
    if (predicate.operator === 'contains') return typeof value === 'string' && value.toLowerCase().includes(String(predicate.value).toLowerCase());
    if (predicate.operator === 'in') return Array.isArray(predicate.value) ? predicate.value.some((candidate) => candidate === value || (typeof value === 'string' && String(value).toLowerCase() === String(candidate).toLowerCase())) : false;
    if (predicate.operator === 'gte') return typeof value === 'number' && value >= Number(predicate.value);
    if (predicate.operator === 'lte') return typeof value === 'number' && value <= Number(predicate.value);
    return false;
  }));
}
