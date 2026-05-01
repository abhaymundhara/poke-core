import { createHash } from 'node:crypto';
import type { BehavioralObservation, LearnedBehaviorFact, BehavioralPattern } from './behavioral-learning';
import type { EpisodicMemoryItem } from './episodic-memory';
import type { MemoryDocument } from '../rag/types';

export type LatentAxis = 'brevity' | 'formality' | 'responsiveness' | 'channel' | 'schedule' | 'relationship' | 'structure' | 'stability' | 'curiosity';

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
  field: 'sourceKind' | 'category' | 'domain' | 'subject' | 'value' | 'hourOfDay' | 'relationship' | 'urgency' | 'activity';
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
  axis: LatentAxis;
  directionScores: Map<string, number>;
  examples: Set<string>;
  domains: Set<string>;
  sources: Set<string>;
  evidenceCount: number;
  observationIds: string[];
};

const BRIEFNESS = ['brief', 'concise', 'short', 'succinct', 'compact', 'minimal', 'to the point'];
const FORMALITY = ['professional', 'formal', 'polite', 'respectful', 'business', 'corporate'];
const RESPONSIVENESS = ['reply', 'follow up', 'follow-up', 'soon', 'today', 'prompt', 'quick', 'asap'];
const CHANNEL = ['email', 'whatsapp', 'chat', 'message', 'call', 'discord', 'calendar', 'browser'];
const SCHEDULE = ['morning', 'afternoon', 'evening', 'night', 'weekly', 'daily', 'later', 'tomorrow', 'today'];
const RELATIONSHIP = ['manager', 'line manager', 'colleague', 'client', 'team', 'family', 'friend', 'mentor', 'flatmate'];
const STRUCTURE = ['bullet', 'numbered', 'outline', 'step', 'plan', 'structured', 'organized', 'clear'];
const STABILITY = ['consistent', 'stable', 'repeat', 'same', 'always', 'usually', 'habit', 'routine'];
const CURIOSITY = ['explore', 'learn', 'test', 'try', 'iterate', 'build', 'experiment'];

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 18)}`;
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
  const explicit = [context.domain, context.threadId, context.relationshipId].find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return normalize(typeof explicit === 'string' ? explicit : source);
}

function containsAny(text: string, terms: string[]): boolean {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(term));
}

function matchSignalAxis(observation: BehavioralObservation): Array<{ axis: LatentAxis; direction: string; weight: number }> {
  const text = `${observation.subject} ${observation.value} ${(observation.evidence ?? []).join(' ')}`.toLowerCase();
  const matches: Array<{ axis: LatentAxis; direction: string; weight: number }> = [];
  if (containsAny(text, BRIEFNESS)) matches.push({ axis: 'brevity', direction: containsAny(text, ['short', 'compact', 'minimal']) ? 'short' : 'concise', weight: 1 });
  if (containsAny(text, FORMALITY)) matches.push({ axis: 'formality', direction: containsAny(text, ['professional', 'business', 'corporate']) ? 'professional' : 'formal', weight: 1 });
  if (containsAny(text, RESPONSIVENESS)) matches.push({ axis: 'responsiveness', direction: containsAny(text, ['asap', 'prompt', 'quick']) ? 'fast' : 'timely', weight: 1 });
  if (containsAny(text, CHANNEL)) matches.push({ axis: 'channel', direction: ['email', 'whatsapp', 'chat', 'call', 'calendar', 'browser', 'discord'].find((ch) => text.includes(ch)) ?? 'multi-channel', weight: 1 });
  if (containsAny(text, SCHEDULE)) matches.push({ axis: 'schedule', direction: ['morning', 'afternoon', 'evening', 'night', 'weekly', 'daily', 'tomorrow', 'today', 'later'].find((word) => text.includes(word)) ?? 'time-aware', weight: 1 });
  if (containsAny(text, RELATIONSHIP)) matches.push({ axis: 'relationship', direction: ['manager', 'client', 'team', 'family', 'friend', 'mentor', 'flatmate', 'colleague'].find((word) => text.includes(word)) ?? 'relationship-sensitive', weight: 1 });
  if (containsAny(text, STRUCTURE)) matches.push({ axis: 'structure', direction: 'structured', weight: 0.9 });
  if (containsAny(text, STABILITY)) matches.push({ axis: 'stability', direction: 'consistent', weight: 0.85 });
  if (containsAny(text, CURIOSITY)) matches.push({ axis: 'curiosity', direction: 'exploratory', weight: 0.8 });
  return matches;
}

function latentAxesFromObservations(observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[]): Map<LatentAxis, EvidenceBucket> {
  const buckets = new Map<LatentAxis, EvidenceBucket>();
  const register = (axis: LatentAxis, direction: string, domain: string, source: string, evidenceCount = 1, observationId = '') => {
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
  };

  observations.forEach((observation, index) => {
    const matches = matchSignalAxis(observation);
    const domain = domainFromObservation(observation);
    const source = sourceKind(observation.source);
    for (const match of matches) register(match.axis, match.direction, domain, source, Math.max(1, Math.round(observation.confidence * 3)), `obs:${index}`);
  });

  facts.forEach((fact, index) => {
    const text = `${fact.key} ${fact.value} ${fact.rationale}`;
    const matches = matchSignalAxis({ subject: fact.key, value: text, category: fact.category, source: fact.source, confidence: fact.confidence, observedAt: fact.updatedAt, evidence: fact.sources, context: { key: fact.key } });
    const domain = normalize(fact.category);
    const source = sourceKind(fact.source);
    for (const match of matches) register(match.axis, match.direction, domain, source, Math.max(1, fact.evidenceCount), `fact:${index}`);
  });

  patterns.forEach((pattern, index) => {
    const matches = matchSignalAxis({ subject: pattern.subject, value: pattern.value, category: pattern.category, source: pattern.sources[0] ?? 'system', confidence: pattern.confidence, observedAt: pattern.lastObservedAt, evidence: pattern.examples, context: { pattern: pattern.key } });
    const domain = normalize(pattern.category);
    const source = sourceKind(pattern.sources[0] ?? 'system');
    for (const match of matches) register(match.axis, match.direction, domain, source, Math.max(1, pattern.evidenceCount), `pattern:${index}`);
  });

  return buckets;
}

function generalizeAxes(buckets: Map<LatentAxis, EvidenceBucket>, priorTheory: UserBehaviorTheory | null | undefined): LatentBehaviorSignal[] {
  const prior = new Map(priorTheory?.latentAxes.map((axis) => [axis.axis, axis]) ?? []);
  const axes: LatentBehaviorSignal[] = [];
  for (const [axis, bucket] of buckets.entries()) {
    const ranked = [...bucket.directionScores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const [direction, score] = ranked[0] ?? ['general', 0];
    const sourceCount = bucket.sources.size;
    const domainCount = bucket.domains.size;
    const priorSignal = prior.get(axis);
    const priorBoost = priorSignal ? Math.min(0.15, priorSignal.confidence * 0.15) : 0;
    const confidence = Math.min(1, Number((0.26 + score / Math.max(1, bucket.evidenceCount) * 0.34 + Math.min(1, domainCount / 2) * 0.18 + Math.min(1, sourceCount / 2) * 0.12 + priorBoost).toFixed(3)));
    axes.push({
      axis,
      direction,
      weight: Number((score / Math.max(1, bucket.evidenceCount)).toFixed(3)),
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
    if (axis.axis === 'brevity') register('concise across contexts', domains, axis.examples, axis.confidence + (shared ? 0.05 : 0));
    if (axis.axis === 'formality') register('professional tone when stakes are social or work-related', domains, axis.examples, axis.confidence + (shared ? 0.05 : 0));
    if (axis.axis === 'responsiveness') register('prefers fast acknowledgment and follow-through', domains, axis.examples, axis.confidence + (shared ? 0.05 : 0));
    if (axis.axis === 'channel') register('channel choice is context-sensitive rather than fixed', domains, axis.examples, axis.confidence);
    if (axis.axis === 'schedule') register('timing is used strategically to reduce lag', domains, axis.examples, axis.confidence);
    if (axis.axis === 'relationship') register('relationship hierarchy changes communication style', domains, axis.examples, axis.confidence);
    if (axis.axis === 'structure') register('structured outputs are preferred for multi-step work', domains, axis.examples, axis.confidence);
    if (axis.axis === 'stability') register('repeated behaviors become durable routines', domains, axis.examples, axis.confidence);
    if (axis.axis === 'curiosity') register('new tools are explored by building and iterating', domains, axis.examples, axis.confidence);
  }

  for (const [generalization, entry] of map.entries()) {
    result.push({ generalization, domains: [...entry.domains].sort(), confidence: Number(Math.min(1, entry.confidence).toFixed(3)), evidence: [...entry.evidence].slice(0, 6) });
  }

  return result.sort((left, right) => right.confidence - left.confidence || left.generalization.localeCompare(right.generalization));
}

function compilePolicies(axes: LatentBehaviorSignal[], generalizations: Array<{ generalization: string; domains: string[]; confidence: number; evidence: string[] }>, now: number): BehaviorPolicy[] {
  const policies: BehaviorPolicy[] = [];
  const add = (policy: Omit<BehaviorPolicy, 'id'> & { id?: string }) => {
    policies.push({ id: policy.id ?? stableId('policy', [policy.name, policy.action.type, policy.action.value]), ...policy });
  };

  const brevity = axes.find((axis) => axis.axis === 'brevity' && axis.confidence >= 0.55);
  if (brevity) add({
    name: 'keep replies concise',
    description: 'When composing messages in work or coordination contexts, prefer short replies that preserve all required details.',
    enabled: true,
    persistent: true,
    confidence: brevity.confidence,
    conditions: { all: [
      { field: 'activity', operator: 'in', value: ['compose', 'reply', 'follow-up'] },
      { field: 'category', operator: 'in', value: ['tone', 'preference'] },
    ] },
    action: { type: 'communication-style', value: 'concise', parameters: { verbosity: 'low', preserveDetails: true } },
    rationale: 'compressed from repeated brevity signals across multiple contexts',
    contexts: brevity.domains,
    compiledFrom: brevity.examples,
  });

  const formality = axes.find((axis) => axis.axis === 'formality' && axis.confidence >= 0.55);
  if (formality) add({
    name: 'default to professional tone',
    description: 'When the relationship involves work, hierarchy, or administrative coordination, prefer professional language and structured closings.',
    enabled: true,
    persistent: true,
    confidence: formality.confidence,
    conditions: { all: [
      { field: 'relationship', operator: 'in', value: ['manager', 'client', 'colleague', 'team'] },
      { field: 'activity', operator: 'in', value: ['compose', 'draft', 'reply'] },
    ] },
    action: { type: 'communication-style', value: 'professional', parameters: { greeting: 'formal', closing: 'polite' } },
    rationale: 'observed formal/professional preference across work-like contexts',
    contexts: formality.domains,
    compiledFrom: formality.examples,
  });

  const responsiveness = axes.find((axis) => axis.axis === 'responsiveness' && axis.confidence >= 0.5);
  if (responsiveness) add({
    name: 'follow through quickly on open loops',
    description: 'If a task or thread is waiting on a response, prioritize a next action instead of leaving it ambiguous.',
    enabled: true,
    persistent: true,
    confidence: responsiveness.confidence,
    conditions: { all: [
      { field: 'activity', operator: 'in', value: ['reply', 'follow-up', 'task'] },
      { field: 'urgency', operator: 'gte', value: 0.5 },
    ] },
    action: { type: 'next-step', value: 'send_follow_up', parameters: { priority: 'high', sameDay: true } },
    rationale: 'derived from repeated follow-up and prompt-response cues',
    contexts: responsiveness.domains,
    compiledFrom: responsiveness.examples,
  });

  const channel = axes.find((axis) => axis.axis === 'channel' && axis.confidence >= 0.5);
  if (channel) add({
    name: 'pick the fastest useful channel',
    description: 'For rapid back-and-forth, select the lower-friction channel; for durable records, use email or calendar.',
    enabled: true,
    persistent: true,
    confidence: channel.confidence,
    conditions: { all: [
      { field: 'activity', operator: 'in', value: ['reply', 'coordinate', 'schedule'] },
      { field: 'domain', operator: 'in', value: channel.domains.length > 0 ? channel.domains : ['email'] },
    ] },
    action: { type: 'channel-selection', value: channel.direction, parameters: { preferred: channel.direction, fallback: 'email' } },
    rationale: 'cross-context channel choice follows task friction rather than a single fixed medium',
    contexts: channel.domains,
    compiledFrom: channel.examples,
  });

  const structure = axes.find((axis) => axis.axis === 'structure' && axis.confidence >= 0.45);
  if (structure) add({
    name: 'prefer structured output for complex work',
    description: 'When a task has multiple steps or dependencies, organize the output as a sequence of explicit actions.',
    enabled: true,
    persistent: true,
    confidence: structure.confidence,
    conditions: { all: [
      { field: 'activity', operator: 'in', value: ['plan', 'analyze', 'execute'] },
    ] },
    action: { type: 'output-format', value: 'structured', parameters: { format: 'bulleted' } },
    rationale: 'structured artifacts correlate with reliable completion on multi-step tasks',
    contexts: structure.domains,
    compiledFrom: structure.examples,
  });

  const generalizationPolicy = generalizations.find((entry) => /concise across contexts/.test(entry.generalization) || /professional tone/.test(entry.generalization));
  if (generalizationPolicy) add({
    name: 'generalize communication style across contexts',
    description: 'Treat communication style as a durable preference that transfers across domains unless context strongly contradicts it.',
    enabled: true,
    persistent: true,
    confidence: generalizationPolicy.confidence,
    conditions: { all: [
      { field: 'activity', operator: 'in', value: ['compose', 'reply', 'draft'] },
    ] },
    action: { type: 'policy-applier', value: 'use_theory_defaults', parameters: { mode: 'cross-context' } },
    rationale: generalizationPolicy.generalization,
    contexts: generalizationPolicy.domains,
    compiledFrom: generalizationPolicy.evidence,
  });

  return policies.sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name));
}

function inferUrgency(observations: BehavioralObservation[], facts: LearnedBehaviorFact[], patterns: BehavioralPattern[]): number {
  const text = [...observations.map((o) => `${o.subject} ${o.value}`), ...facts.map((f) => `${f.key} ${f.value} ${f.rationale}`), ...patterns.map((p) => `${p.subject} ${p.value}`)].join(' ').toLowerCase();
  let score = 0.15;
  if (/(follow[- ]?up|awaiting|waiting|reply|respond|asap|urgent|soon|deadline|today)/.test(text)) score += 0.35;
  if (/(manager|client|meeting|calendar|schedule|thread)/.test(text)) score += 0.2;
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
      probability: Number(Math.min(1, probability).toFixed(3)),
      horizonMinutes,
      nextBestAction,
      rationale,
      signals,
      relatedPolicies,
      expectedBy: new Date(now + horizonMinutes * 60_000).toISOString(),
    });
  };

  const hasBrevity = axes.some((axis) => axis.axis === 'brevity' && axis.confidence >= 0.55);
  const hasFormality = axes.some((axis) => axis.axis === 'formality' && axis.confidence >= 0.55);
  const hasResponsiveness = axes.some((axis) => axis.axis === 'responsiveness' && axis.confidence >= 0.5);
  const hasChannel = axes.some((axis) => axis.axis === 'channel' && axis.confidence >= 0.5);

  if (hasBrevity || hasFormality) {
    push(
      'compose a concise, professional reply',
      Math.min(1, 0.52 + (hasBrevity ? 0.18 : 0) + (hasFormality ? 0.12 : 0) + urgency * 0.12 + morningBias),
      180,
      activePolicy?.action.value ?? 'draft_reply',
      'latent communication style suggests a short, professional response is likely to be accepted',
      ['brevity', 'formality'],
      policies.filter((policy) => /concise|professional/.test(policy.name)).map((policy) => policy.id),
    );
  }

  if (hasResponsiveness || urgency >= 0.45) {
    push(
      'resolve the open loop before it ages',
      Math.min(1, 0.46 + urgency * 0.4 + (hasResponsiveness ? 0.1 : 0)),
      240,
      'send_follow_up',
      'open-loop signals indicate a likely need for a follow-up or acknowledgement',
      ['follow-up', 'open-loop', 'urgency'],
      policies.filter((policy) => /follow through quickly/.test(policy.name)).map((policy) => policy.id),
    );
  }

  if (hasChannel) {
    const preferred = axes.find((axis) => axis.axis === 'channel')?.direction ?? 'email';
    push(
      'choose the lowest-friction channel for the next exchange',
      Math.min(1, 0.42 + (hasChannel ? 0.2 : 0) + urgency * 0.08),
      360,
      `use_${preferred}`,
      'the theory indicates channel selection is context-sensitive and should reduce interaction cost',
      ['channel', 'friction', 'coordination'],
      policies.filter((policy) => /fastest useful channel/.test(policy.name)).map((policy) => policy.id),
    );
  }

  push(
    'prepare a structured plan for multi-step work',
    Math.min(1, 0.35 + (axes.some((axis) => axis.axis === 'structure' && axis.confidence >= 0.45) ? 0.2 : 0) + (patterns.some((pattern) => pattern.category === 'decision') ? 0.1 : 0)),
    720,
    'outline_steps',
    'durable structure preference suggests the next user intent may be a plan or checklist',
    ['structure', 'planning'],
    policies.filter((policy) => /structured output/.test(policy.name)).map((policy) => policy.id),
  );

  return forecasts.sort((left, right) => right.probability - left.probability || left.horizonMinutes - right.horizonMinutes);
}

export function buildBehavioralModel(input: BehaviorModelInput): BehaviorModelBundle {
  const buckets = latentAxesFromObservations(input.observations, input.facts, input.patterns);
  const theory: UserBehaviorTheory = {
    id: stableId('theory', [String(input.now), String(input.observations.length), String(input.facts.length), String(input.patterns.length)]),
    updatedAt: input.now,
    sessionCount: 1,
    summary: 'latent theory built from repeated observations, durable facts, and cross-context pattern alignment',
    latentAxes: generalizeAxes(buckets, input.priorTheory ?? null),
    crossContextGeneralizations: [],
    persistentGoals: [],
  };

  const generalizations = buildGeneralizations(theory.latentAxes, input.observations, input.facts);
  theory.crossContextGeneralizations = generalizations;
  theory.persistentGoals = [
    {
      goal: 'keep communication concise without losing required detail',
      confidence: Number(Math.min(1, 0.58 + (theory.latentAxes.find((axis) => axis.axis === 'brevity')?.confidence ?? 0) * 0.2).toFixed(3)),
      evidence: generalizations.filter((entry) => /concise/.test(entry.generalization)).flatMap((entry) => entry.evidence).slice(0, 5),
    },
    {
      goal: 'preserve professional tone when hierarchy or work is involved',
      confidence: Number(Math.min(1, 0.56 + (theory.latentAxes.find((axis) => axis.axis === 'formality')?.confidence ?? 0) * 0.2).toFixed(3)),
      evidence: generalizations.filter((entry) => /professional/.test(entry.generalization)).flatMap((entry) => entry.evidence).slice(0, 5),
    },
  ];
  theory.sessionCount = Math.max(1, (input.priorTheory?.sessionCount ?? 0) + 1);

  const policies = compilePolicies(theory.latentAxes, theory.crossContextGeneralizations, input.now);
  const forecasts = inferNeedForecasts(theory.latentAxes, policies, input.observations, input.facts, input.patterns, input.now);
  const nextBestActions = forecasts.slice(0, 3).map((forecast) => forecast.nextBestAction);

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
