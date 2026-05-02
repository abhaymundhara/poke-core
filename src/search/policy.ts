import { resolve } from 'node:path';
import type { PolicyDecision, SearchFocus, SearchIntent, SearchOutcome, SearchPolicyRule, SearchPolicyState, SearchSignalForecast, SearchSource, SearchSourceReliability, SearchStrategyProfile, RuntimeComposition } from './types.ts';
import { clamp, nowMs, readJson, stableHash, uniq, writeJson } from './utils.ts';
import { updateEpistemicTrustModel } from './trust.ts';

export const DEFAULT_STATE_PATH = resolve(process.cwd(), '.poke-core', 'search-policy.json');

type PolicySnapshot = Omit<SearchPolicyState, 'history'>;

type StrategyLogic = NonNullable<NonNullable<SearchPolicyState['reasoningArchitecture']>['strategyLogic']>;

export type PolicyRewriteProvider = {
  name: string;
  synthesize(input: { feedback: SearchPolicyFeedback; current: SearchPolicyState; guardrails: string[] }): Promise<unknown>;
};

export type SearchPolicyFeedback = {
  summary: string;
  failedQueries?: string[];
  successfulSources?: Array<SearchSource | string>;
  failedSources?: Array<SearchSource | string>;
  latentNeeds?: string[];
  desiredBehavior?: string;
  rules?: SearchPolicyRule[];
  sourceReliability?: Record<string, number>;
  forecasts?: SearchSignalForecast[];
  strategyLogic?: Partial<StrategyLogic>;
  architecture?: Partial<NonNullable<SearchPolicyState['reasoningArchitecture']>>;
  runtimeComposition?: Partial<RuntimeComposition>;
};

function snapshotPolicy(state: SearchPolicyState): PolicySnapshot {
  const { history: _history, ...snapshot } = state;
  return snapshot;
}

function strategyTemplate(id: string, name: string, description: string, sourceWeights: Partial<Record<SearchSource, number>>, hopBias: number, freshnessBias: number, trustBias: number, semanticBias: number): SearchStrategyProfile {
  return { id, name, description, sourceWeights: { web: 1, 'realtime-web': 1, scholar: 0.9, github: 0.9, memory: 0.7, email: 0.6, calendar: 0.6, filesystem: 0.7, integration: 0.8, ...sourceWeights }, hopBias, freshnessBias, trustBias, semanticBias, uses: 0, successes: 0, failures: 0, lastScore: 0.5, lastUsedAt: null };
}

function reliability(source: SearchSource, score: number): SearchSourceReliability {
  return { source, score, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] };
}

function baseStrategyLogic(): StrategyLogic {
  return { search: 'semantic-decomposition', trust: 'epistemic-calibration', conflict: 'semantic-entailment-resolution', searchSources: ['web', 'realtime-web', 'scholar', 'github'], trustSignals: ['corroboration', 'recency', 'domainMemory', 'outcome-evidence'], conflictSignals: ['contradiction', 'entailment', 'semantic-incompatibility'] };
}

function baseRuntimeComposition(): RuntimeComposition {
  return {
    version: 1,
    generatedAt: nowMs(),
    producer: 'policy-baseline',
    strategySelectorSource: `(intent, policy, fallbackChoose) => {\n  const architecture = policy.reasoningArchitecture ?? {};\n  const selectorBias = architecture.strategyBias ?? {};\n  const strategies = policy.strategies ?? [];\n  const base = fallbackChoose(intent, policy);\n  const focus = intent.focus;\n  const trustMode = intent.trustMode;\n  const freshness = intent.freshness;\n  const ranking = strategies\n    .map((strategy) => ({ strategy, score: (selectorBias[strategy.id] ?? 1) * (strategy.lastScore ?? 0.5) * (focus === 'trust' ? strategy.trustBias : focus === 'multi-hop' ? strategy.hopBias : focus === 'semantic' ? strategy.semanticBias : 1) * (trustMode === 'official-first' ? 1.1 : 1) * (freshness === 'live' ? strategy.freshnessBias : 1) }))\n    .sort((left, right) => right.score - left.score);\n  return ranking[0]?.strategy ?? base;\n}`,
    pipelineSource: `(plan, policy) => {\n  const architecture = policy.reasoningArchitecture ?? {};\n  const modifications = architecture.runtimeComposition?.notes ?? [];\n  const next = { ...plan };\n  if (modifications.some((note) => note.includes('trust'))) {\n    next.trustNotes = [...next.trustNotes, 'runtime:trust-adjustment'];\n  }\n  if (modifications.some((note) => note.includes('multi-hop'))) {\n    next.hopPlan = [...next.hopPlan, next.intent.semanticQuery + ' evidence reconciliation'];\n  }\n  if (modifications.some((note) => note.includes('freshness'))) {\n    next.queries = [...new Set([...(next.queries ?? []), next.intent.semanticQuery + ' latest'])].slice(0, 6);\n  }\n  return next;\n}`,
    notes: ['baseline-runtime-composition'],
  };
}

function ensureArchitecture(state: SearchPolicyState): NonNullable<SearchPolicyState['reasoningArchitecture']> {
  return state.reasoningArchitecture ?? (state.reasoningArchitecture = {
    version: 2,
    name: 'llm-first-adaptive-architecture',
    activeModules: ['semantic-nlu', 'epistemic-trust', 'proposition-reasoning', 'intent-forecasting', 'policy-rewrite'],
    primaryReasoner: 'llm-default',
    strategyBias: {},
    selfModificationCount: 0,
    explanationStyle: 'balanced',
    rewriteHistory: [],
    guardrails: ['bounded-hop-budget', 'audit-required'],
    strategyLogic: baseStrategyLogic(),
    runtimeComposition: baseRuntimeComposition(),
    revisionLog: [],
  });
}

function mergeStrategyLogic(current: StrategyLogic | undefined, patch: Partial<StrategyLogic> | undefined, summary: string): StrategyLogic {
  const next = { ...(current ?? baseStrategyLogic()), ...(patch ?? {}) };
  if (/semantic|intent|ambigu|decompose/i.test(summary)) next.search = 'llm-semantic-decomposition';
  if (/trust|reliable|verify|evidence|source/i.test(summary)) next.trust = 'epistemic-corroboration-learning';
  if (/conflict|contradict|entail|claim|proposition|logical/i.test(summary)) next.conflict = 'semantic-entailment-and-contradiction-resolution';
  return {
    search: next.search,
    trust: next.trust,
    conflict: next.conflict,
    searchSources: [...new Set(next.searchSources ?? baseStrategyLogic().searchSources)],
    trustSignals: [...new Set(next.trustSignals ?? baseStrategyLogic().trustSignals)],
    conflictSignals: [...new Set(next.conflictSignals ?? baseStrategyLogic().conflictSignals)],
  };
}

function runtimeCompositionFromFeedback(feedback: SearchPolicyFeedback, current: SearchPolicyState): RuntimeComposition {
  const sourceNotes = [feedback.summary, feedback.desiredBehavior ?? '', ...(feedback.failedQueries ?? []), ...(feedback.failedSources ?? []).map(String), ...(feedback.successfulSources ?? []).map(String)].filter(Boolean).join(' | ');
  const normalized = sourceNotes.toLowerCase();
  const notes = [
    `summary:${feedback.summary}`,
    ...(feedback.failedQueries ?? []).slice(0, 4).map((query) => `failed-query:${query}`),
    ...(feedback.failedSources ?? []).slice(0, 4).map((source) => `failed-source:${source}`),
    ...(feedback.successfulSources ?? []).slice(0, 4).map((source) => `successful-source:${source}`),
  ];
  const selectorSource = `(intent, policy, fallbackChoose) => {\n  const architecture = policy.reasoningArchitecture ?? {};\n  const selectorBias = architecture.strategyBias ?? {};\n  const strategies = policy.strategies ?? [];\n  const base = fallbackChoose(intent, policy);\n  const adjustment = { trust: ${/trust|verify|reliable|source|evidence/i.test(normalized) ? '1.15' : '1.0'}, hop: ${/multi-hop|contradict|entail|conflict|proposition/i.test(normalized) ? '1.18' : '1.0'}, freshness: ${/live|latest|fresh|current/i.test(normalized) ? '1.12' : '1.0'}, semantic: ${/semantic|intent|ambiguous|nlu/i.test(normalized) ? '1.16' : '1.0'} };\n  const ranked = strategies\n    .map((strategy) => ({ strategy, score: (selectorBias[strategy.id] ?? 1) * (strategy.lastScore ?? 0.5) * (strategy.id === 'trust-first' ? adjustment.trust : 1) * (strategy.id === 'multi-hop' ? adjustment.hop : 1) * (strategy.id === 'freshness-first' ? adjustment.freshness : 1) * (strategy.id === 'semantic-first' ? adjustment.semantic : 1) }))\n    .sort((left, right) => right.score - left.score);\n  return ranked[0]?.strategy ?? base;\n}`;
  const pipelineSource = `(plan, policy) => {\n  const architecture = policy.reasoningArchitecture ?? {};\n  const changes = architecture.runtimeComposition?.notes ?? [];\n  const next = { ...plan };\n  if (changes.some((note) => note.includes('failed-query'))) {\n    next.trustNotes = [...next.trustNotes, 'runtime:query-failure'];\n  }\n  if (changes.some((note) => note.includes('failed-source'))) {\n    next.sourceRanking = [...next.sourceRanking].sort((left, right) => right.score - left.score);\n  }\n  if (changes.some((note) => note.includes('semantic'))) {\n    next.queries = [...new Set([...(next.queries ?? []), next.intent.semanticQuery, ...(next.intent.decomposedQuestions ?? [])])].slice(0, 6);\n  }\n  if (changes.some((note) => note.includes('trust'))) {\n    next.trustNotes = [...new Set([...(next.trustNotes ?? []), 'runtime:trust-sensitivity'])];\n  }\n  return next;\n}`;
  return {
    version: (current.reasoningArchitecture?.runtimeComposition?.version ?? 0) + 1,
    generatedAt: nowMs(),
    producer: 'policy-feedback-synthesizer',
    strategySelectorSource: selectorSource,
    pipelineSource,
    notes,
  };
}

export function defaultPolicy(): SearchPolicyState {
  const runtimeComposition = baseRuntimeComposition();
  return {
    version: 2,
    updatedAt: nowMs(),
    strategies: [
      strategyTemplate('semantic-first', 'semantic-first', 'favor semantic expansion', { web: 1.1, 'realtime-web': 0.9 }, 0.8, 0.7, 0.6, 1.2),
      strategyTemplate('trust-first', 'trust-first', 'favor authoritative and corroborated sources', { scholar: 1.2, github: 1.1, web: 0.8 }, 0.7, 0.6, 1.35, 0.9),
      strategyTemplate('multi-hop', 'multi-hop', 'chain query hops and verify claims', { web: 1, 'realtime-web': 1, github: 0.9, scholar: 0.9 }, 1.45, 0.85, 0.95, 1),
      strategyTemplate('freshness-first', 'freshness-first', 'favor latest results and live signals', { 'realtime-web': 1.35, web: 0.9, memory: 0.4 }, 0.75, 1.35, 0.75, 0.9),
      strategyTemplate('blend', 'blend', 'blend trust, freshness, and semantic recall', {}, 1, 1, 1, 1),
    ],
    sourceReliability: {
      web: reliability('web', 0.72),
      'realtime-web': reliability('realtime-web', 0.78),
      scholar: reliability('scholar', 0.84),
      github: reliability('github', 0.86),
      memory: reliability('memory', 0.66),
      email: reliability('email', 0.62),
      calendar: reliability('calendar', 0.62),
      filesystem: reliability('filesystem', 0.68),
      integration: reliability('integration', 0.74),
    },
    epistemicModel: {
      version: 2,
      calibration: 0.68,
      classPriors: { primary: 0.9, expert: 0.84, institutional: 0.76, community: 0.62, unknown: 0.5 },
      sourceMemory: {},
      domainMemory: {},
      knowledgeClassRepresentations: {
        primary: [1, 0, 0, 0],
        expert: [0, 1, 0, 0],
        institutional: [0, 0, 1, 0],
        community: [0, 0, 0, 1],
        unknown: [0.25, 0.25, 0.25, 0.25],
      },
      corroborationGraph: {},
    },
    latentIntentModel: {
      version: 2,
      archetypes: [],
      transitions: {},
      lastUpdatedAt: nowMs(),
    },
    reasoningArchitecture: {
      version: 2,
      name: 'llm-first-adaptive-architecture',
      activeModules: ['semantic-nlu', 'epistemic-trust', 'proposition-reasoning', 'intent-forecasting', 'policy-rewrite'],
      primaryReasoner: 'llm-default',
      strategyBias: { 'semantic-first': 0.12, 'trust-first': 0.16, 'multi-hop': 0.14, 'freshness-first': 0.08, blend: 0.1 },
      selfModificationCount: 0,
      explanationStyle: 'balanced',
      rewriteHistory: [],
      guardrails: ['bounded-hop-budget', 'audit-required'],
      strategyLogic: baseStrategyLogic(),
      runtimeComposition,
      revisionLog: [],
    },
    queryProfiles: {},
    forecasts: [],
    rules: [{ id: 'guard-source-trust', description: 'Prefer sources with corroboration or first-party provenance for trust-sensitive searches.', enabled: true, minTrustScore: 0.55, guardrails: ['no-disable-audit', 'bounded-hop-budget'] }],
    history: [],
    auditLog: [],
  };
}

export function loadPolicy(path = DEFAULT_STATE_PATH): SearchPolicyState {
  const defaults = defaultPolicy();
  const loaded = readJson<SearchPolicyState>(path, defaultPolicy());
  return {
    ...defaults,
    ...loaded,
    strategies: Array.isArray(loaded.strategies) && loaded.strategies.length > 0 ? loaded.strategies : defaults.strategies,
    sourceReliability: { ...defaults.sourceReliability, ...(loaded.sourceReliability ?? {}) },
    queryProfiles: loaded.queryProfiles ?? {},
    forecasts: Array.isArray(loaded.forecasts) ? loaded.forecasts : [],
    rules: Array.isArray(loaded.rules) && loaded.rules.length > 0 ? loaded.rules : defaults.rules,
    history: Array.isArray(loaded.history) ? loaded.history : [],
    auditLog: Array.isArray(loaded.auditLog) ? loaded.auditLog : [],
  };
}

export function savePolicy(state: SearchPolicyState, path = DEFAULT_STATE_PATH): void {
  state.updatedAt = nowMs();
  writeJson(path, state);
}

function scoreStrategy(intent: SearchIntent, strategy: SearchStrategyProfile, policy: SearchPolicyState): number {
  const sourceScore = intent.sourcePriors.reduce((sum, prior) => sum + (strategy.sourceWeights[prior.source as SearchSource] ?? 0.5) * prior.weight, 0) / Math.max(1, intent.sourcePriors.length);
  const freshnessBoost = intent.freshness === 'live' ? strategy.freshnessBias * 1.2 : intent.freshness === 'recent' ? strategy.freshnessBias : strategy.freshnessBias * 0.72;
  const trustBoost = intent.trustMode === 'official-first' ? strategy.trustBias * 1.25 : intent.trustMode === 'diverse' ? strategy.trustBias : strategy.trustBias * 0.86;
  const hopBoost = Math.min(1.4, 0.7 + intent.hopBudget * 0.15) * strategy.hopBias;
  const semanticBoost = strategy.semanticBias * (intent.focus === 'semantic' ? 1.1 : 1);
  const profile = policy.queryProfiles[intent.sessionKey];
  const historicalBoost = profile ? 0.8 + profile.averageScore * 0.4 : 1;
  return sourceScore * freshnessBoost * trustBoost * hopBoost * semanticBoost * historicalBoost;
}

export function compileRuntimeStrategySelector(state: SearchPolicyState) {
  const source = state.reasoningArchitecture?.runtimeComposition?.strategySelectorSource ?? baseRuntimeComposition().strategySelectorSource;
  return new Function('intent', 'policy', 'fallbackChoose', `const fn = (${source}); return fn(intent, policy, fallbackChoose);`) as (intent: SearchIntent, policy: SearchPolicyState, fallbackChoose: typeof chooseStrategy) => SearchStrategyProfile;
}

export function compileRuntimePipeline(state: SearchPolicyState) {
  const source = state.reasoningArchitecture?.runtimeComposition?.pipelineSource ?? baseRuntimeComposition().pipelineSource;
  return new Function('plan', 'policy', `const fn = (${source}); return fn(plan, policy);`) as (plan: unknown, policy: SearchPolicyState) => unknown;
}

export function chooseStrategy(intent: SearchIntent, policy: SearchPolicyState): SearchStrategyProfile {
  const architecture = policy.reasoningArchitecture ?? ensureArchitecture(policy);
  const runtimeSelector = architecture.runtimeComposition?.strategySelectorSource ? compileRuntimeStrategySelector(policy) : null;
  if (runtimeSelector) {
    try {
      const selected = runtimeSelector(intent, policy, fallbackStrategyChoose);
      if (selected) return selected;
    } catch {
      // fall through to the canonical selector if the generated code is invalid.
    }
  }
  return fallbackStrategyChoose(intent, policy);
}

export function fallbackStrategyChoose(intent: SearchIntent, policy: SearchPolicyState): SearchStrategyProfile {
  const architecture = policy.reasoningArchitecture ?? ensureArchitecture(policy);
  const scored = policy.strategies.map((strategy) => ({ strategy, score: scoreStrategy(intent, strategy, policy) * (0.7 + strategy.lastScore * 0.3) * (architecture.strategyBias[strategy.id] ?? 1) }));
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.strategy ?? defaultPolicy().strategies[0];
}

function ruleMatches(rule: SearchPolicyRule, intent: SearchIntent, latentLabels: string[] = []): boolean {
  if (!rule.enabled) return false;
  if (rule.when?.focus && !rule.when.focus.includes(intent.focus)) return false;
  if (rule.when?.freshness && !rule.when.freshness.includes(intent.freshness)) return false;
  if (rule.when?.sources && !rule.when.sources.some((source) => intent.sourceHints.includes(source as SearchSource) || intent.entities.some((entity) => entity.toLowerCase().includes(String(source).toLowerCase())))) return false;
  if (rule.when?.latentNeed && !latentLabels.includes(rule.when.latentNeed) && !intent.topics.includes(rule.when.latentNeed)) return false;
  return true;
}

export function evaluatePolicy(intent: SearchIntent, policy: SearchPolicyState, latentLabels: string[] = []): PolicyDecision {
  const decision: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] };
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, intent, latentLabels)) continue;
    decision.matchedRules.push(rule.id);
    if (rule.maxHopBudget !== undefined) decision.maxHopBudget = Math.min(decision.maxHopBudget ?? rule.maxHopBudget, rule.maxHopBudget);
    if (rule.minTrustScore !== undefined) decision.minTrustScore = Math.max(decision.minTrustScore ?? 0, rule.minTrustScore);
    for (const [source, weight] of Object.entries(rule.sourceWeights ?? {})) decision.sourceBoosts[source] = (decision.sourceBoosts[source] ?? 0) + Number(weight) - 1;
    for (const action of rule.actions ?? []) {
      if (action.type === 'boost-source') decision.sourceBoosts[action.value] = (decision.sourceBoosts[action.value] ?? 0) + action.weight;
      if (action.type === 'require-corroboration') decision.requireCorroboration = true;
      if (action.type === 'prefer-provider-nlu') decision.preferProviderNlu = true;
      if (action.type === 'cap-hop-budget') decision.maxHopBudget = Math.min(decision.maxHopBudget ?? Number(action.value), Number(action.value));
    }
  }
  return decision;
}

function validateRules(rules: SearchPolicyRule[]): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    if (!rule.id || !rule.description) violations.push('rule-missing-identity');
    if (rule.maxHopBudget !== undefined && (rule.maxHopBudget < 1 || rule.maxHopBudget > 6)) violations.push(`invalid-hop-budget:${rule.id}`);
    if (rule.minTrustScore !== undefined && (rule.minTrustScore < 0 || rule.minTrustScore > 1)) violations.push(`invalid-min-trust:${rule.id}`);
    if (rule.guardrails.includes('disable-audit')) violations.push(`forbidden-guardrail:${rule.id}`);
    for (const action of rule.actions ?? []) {
      if (!Number.isFinite(action.weight) || action.weight < -1 || action.weight > 1) violations.push(`invalid-action-weight:${rule.id}`);
    }
  }
  return violations;
}

function rulesFromFeedback(feedback: SearchPolicyFeedback): SearchPolicyRule[] {
  const rules: SearchPolicyRule[] = [];
  for (const source of feedback.successfulSources ?? []) {
    rules.push({
      id: `learn-boost-${String(source).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`,
      description: `Boost ${source} when session feedback marks it as successful evidence.`,
      enabled: true,
      when: { sources: [source], latentNeed: feedback.latentNeeds?.[0] },
      actions: [{ type: 'boost-source', value: String(source), weight: 0.16 }],
      sourceWeights: typeof source === 'string' ? { [source]: 1.12 } as Partial<Record<SearchSource, number>> : undefined,
      guardrails: ['bounded-hop-budget', 'audit-required'],
    });
  }
  if (/contradict|conflict|wrong|unverified|hallucinat/i.test(feedback.summary) || feedback.failedSources?.length) {
    rules.push({
      id: 'require-corroboration-on-risk',
      description: 'Require corroboration when feedback reports contradictions or unreliable source behavior.',
      enabled: true,
      minTrustScore: 0.68,
      actions: [{ type: 'require-corroboration', value: 'independent-source', weight: 0.24 }],
      guardrails: ['no-disable-audit', 'bounded-hop-budget'],
    });
  }
  if (/semantic|intent|misread|ambiguous/i.test(feedback.summary)) {
    rules.push({
      id: 'prefer-provider-nlu-on-ambiguity',
      description: 'Use provider-backed semantic NLU for ambiguous or previously misread objectives.',
      enabled: true,
      when: { latentNeed: feedback.latentNeeds?.[0] },
      actions: [{ type: 'prefer-provider-nlu', value: 'semantic-frame-required', weight: 0.3 }],
      guardrails: ['fallback-required', 'audit-required'],
    });
  }
  return rules;
}

function asFeedback(value: SearchPolicyFeedback): SearchPolicyFeedback {
  return value;
}

function asSynthesizedOutput(value: unknown): (SearchPolicyFeedback & { rules?: SearchPolicyRule[]; strategyLogic?: Partial<StrategyLogic>; architecture?: Partial<NonNullable<SearchPolicyState['reasoningArchitecture']>>; runtimeComposition?: Partial<RuntimeComposition> }) | null {
  if (!value || typeof value !== 'object') return null;
  return value as SearchPolicyFeedback & { rules?: SearchPolicyRule[]; strategyLogic?: Partial<StrategyLogic>; architecture?: Partial<NonNullable<SearchPolicyState['reasoningArchitecture']>>; runtimeComposition?: Partial<RuntimeComposition> };
}

function applySynthesizedArchitecture(state: SearchPolicyState, synthesized: SearchPolicyFeedback & { rules?: SearchPolicyRule[]; strategyLogic?: Partial<StrategyLogic>; architecture?: Partial<NonNullable<SearchPolicyState['reasoningArchitecture']>>; runtimeComposition?: Partial<RuntimeComposition> }, source: string): void {
  const architecture = ensureArchitecture(state);
  architecture.strategyLogic = mergeStrategyLogic(architecture.strategyLogic, synthesized.strategyLogic, synthesized.summary);
  if (synthesized.architecture?.explanationStyle) architecture.explanationStyle = synthesized.architecture.explanationStyle;
  if (synthesized.architecture?.activeModules?.length) architecture.activeModules = synthesized.architecture.activeModules as NonNullable<SearchPolicyState['reasoningArchitecture']>['activeModules'];
  architecture.runtimeComposition = {
    ...architecture.runtimeComposition,
    ...synthesized.runtimeComposition,
    generatedAt: nowMs(),
    producer: synthesized.runtimeComposition?.producer ?? architecture.runtimeComposition?.producer ?? source,
    notes: uniq([...(architecture.runtimeComposition?.notes ?? []), ...(synthesized.runtimeComposition?.notes ?? [])]),
    strategySelectorSource: synthesized.runtimeComposition?.strategySelectorSource ?? architecture.runtimeComposition?.strategySelectorSource ?? baseRuntimeComposition().strategySelectorSource,
    pipelineSource: synthesized.runtimeComposition?.pipelineSource ?? architecture.runtimeComposition?.pipelineSource ?? baseRuntimeComposition().pipelineSource,
    version: (architecture.runtimeComposition?.version ?? 0) + 1,
  };
  architecture.rewriteHistory.push({ at: nowMs(), source, change: synthesized.summary });
  architecture.selfModificationCount += 1;
}

function synthesizeRuntimePolicy(outcome: SearchOutcome, current: SearchPolicyState): SearchPolicyFeedback & { strategyLogic: Partial<StrategyLogic>; architecture: Partial<NonNullable<SearchPolicyState['reasoningArchitecture']>>; runtimeComposition: Partial<RuntimeComposition> } {
  const source = outcome.source ? String(outcome.source) : 'web';
  const utility = outcome.useful ?? outcome.score >= 0.7;
  const priorLogic = current.reasoningArchitecture?.strategyLogic ?? baseStrategyLogic();
  const sourceNeighborhood = [...new Set([source, ...(outcome.resultDomains ?? []).slice(0, 3)])].filter(Boolean);
  const logicHash = stableHash([outcome.sessionKey, outcome.strategyId, source, ...(outcome.resultDomains ?? [])].join('|')).slice(0, 12);
  const summaryBits = [utility ? 'reinforce' : 'correct', outcome.strategyId, outcome.query, source, `score=${outcome.score.toFixed(2)}`, `logic=${logicHash}`];
  const strategyLogic: Partial<StrategyLogic> = {
    search: outcome.hopsUsed && outcome.hopsUsed > 2 ? 'llm-semantic-decomposition+cross-hop-planning' : utility ? 'llm-semantic-decomposition' : 'llm-semantic-decomposition+counterevidence-expansion',
    trust: utility ? 'epistemic-corroboration-learning+domain-expertise-model' : 'epistemic-corroboration-learning+domain-expertise-model+outcome-calibration',
    conflict: outcome.relevantCount && outcome.relevantCount > 1 ? 'semantic-entailment-and-contradiction-resolution' : 'semantic-entailment-check+contradiction-resolution',
    searchSources: [...new Set([...(priorLogic.searchSources ?? []), ...sourceNeighborhood])],
    trustSignals: [...new Set([...(priorLogic.trustSignals ?? []), 'cross-corroboration', 'evidence-outcome', 'domain-memory', 'expertise-embedding'])],
    conflictSignals: [...new Set([...(priorLogic.conflictSignals ?? []), 'semantic-entailment', 'logical-consistency', 'counterevidence', 'graph-neighborhood'])],
  };
  const runtimeComposition: Partial<RuntimeComposition> = {
    producer: `outcome:${source}`,
    notes: [
      `session:${outcome.sessionKey}`,
      `strategy:${outcome.strategyId}`,
      `resultCount:${outcome.resultCount ?? 0}`,
      `useful:${String(utility)}`,
      ...(utility ? [] : ['trust', 'semantic', 'freshness']),
    ],
    strategySelectorSource: runtimeCompositionFromFeedback({ summary: summaryBits.join(' | '), failedSources: utility ? [] : [source], successfulSources: utility ? [source] : [], latentNeeds: outcome.resultDomains ?? [] }, current).strategySelectorSource,
    pipelineSource: runtimeCompositionFromFeedback({ summary: summaryBits.join(' | '), failedSources: utility ? [] : [source], successfulSources: utility ? [source] : [], latentNeeds: outcome.resultDomains ?? [] }, current).pipelineSource,
  };
  return {
    summary: summaryBits.join(' | '),
    latentNeeds: outcome.resultDomains ?? [],
    successfulSources: utility ? [source] : [],
    failedSources: utility ? [] : [source],
    sourceReliability: utility ? { [source]: clamp((current.sourceReliability[source]?.score ?? 0.6) * 0.88 + 0.12 * outcome.score) } : { [source]: clamp((current.sourceReliability[source]?.score ?? 0.6) * 0.92 - 0.02) },
    strategyLogic,
    architecture: {
      explanationStyle: outcome.score >= 0.8 ? 'thorough' : outcome.score >= 0.6 ? 'balanced' : 'compact',
      activeModules: ['semantic-nlu', 'epistemic-trust', 'proposition-reasoning', 'intent-forecasting', 'policy-rewrite'],
    },
    runtimeComposition,
  };
}

export class SearchPolicyStore {
  constructor(private readonly statePath = DEFAULT_STATE_PATH) {}
  load(): SearchPolicyState { return loadPolicy(this.statePath); }
  save(state: SearchPolicyState): void { savePolicy(state, this.statePath); }
  reset(): SearchPolicyState { const state = defaultPolicy(); this.save(state); return state; }
  updateOutcome(outcome: SearchOutcome): SearchPolicyState {
    const state = this.load();
    const strategy = state.strategies.find((entry) => entry.id === outcome.strategyId) ?? state.strategies[0];
    const useful = outcome.useful ?? outcome.score >= 0.7;
    if (strategy) {
      strategy.uses += 1;
      strategy.lastUsedAt = nowMs();
      strategy.lastScore = strategy.lastScore * 0.72 + outcome.score * 0.28;
      if (useful) strategy.successes += 1; else strategy.failures += 1;
    }

    state.epistemicModel = updateEpistemicTrustModel(state.epistemicModel, { source: outcome.source ?? outcome.resultDomains?.[0] ?? 'web', resultDomains: outcome.resultDomains ?? [], useful, score: outcome.score, notes: outcome.notes ?? [] });

    const source = String(outcome.source ?? outcome.resultDomains?.[0] ?? 'web');
    const sourceEntry = state.sourceReliability[source] ?? (state.sourceReliability[source] = { source, score: 0.6, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] });
    const learnedSource = state.epistemicModel?.sourceMemory[source];
    sourceEntry.uses += 1;
    sourceEntry.lastObservedAt = nowMs();
    if (learnedSource) {
      sourceEntry.score = clamp(learnedSource.mean * (1 - learnedSource.variance * 0.5));
      sourceEntry.successes = learnedSource.successes;
      sourceEntry.failures = learnedSource.failures;
    } else {
      sourceEntry.score = clamp(sourceEntry.score * 0.92 + outcome.score * 0.08);
      if (useful) sourceEntry.successes += 1; else sourceEntry.failures += 1;
    }

    const domain = outcome.resultDomains?.[0] ?? source;
    const domainEntry = state.sourceReliability[domain] ?? (state.sourceReliability[domain] = { source: domain, score: 0.6, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] });
    const learnedDomain = state.epistemicModel?.domainMemory[domain];
    domainEntry.uses += 1;
    domainEntry.lastObservedAt = nowMs();
    if (learnedDomain) {
      domainEntry.score = clamp(learnedDomain.mean * (1 - learnedDomain.variance * 0.5));
      domainEntry.successes = learnedDomain.successes;
      domainEntry.failures = learnedDomain.failures;
    } else {
      domainEntry.score = clamp(domainEntry.score * 0.92 + outcome.score * 0.08);
      if (useful) domainEntry.successes += 1; else domainEntry.failures += 1;
    }

    const profile = state.queryProfiles[outcome.sessionKey] ?? { count: 0, lastScore: 0, lastUpdatedAt: nowMs(), averageScore: 0, focus: 'factual' as SearchFocus, sourceHints: [] };
    profile.count += 1;
    profile.lastScore = outcome.score;
    profile.lastUpdatedAt = nowMs();
    profile.averageScore = profile.averageScore === 0 ? outcome.score : profile.averageScore * 0.7 + outcome.score * 0.3;
    state.queryProfiles[outcome.sessionKey] = profile;

    const runtimeFeedback = synthesizeRuntimePolicy(outcome, state);
    if (!useful || outcome.score < 0.72) {
      applySynthesizedArchitecture(state, runtimeFeedback, 'outcome');
    }

    const architecture = ensureArchitecture(state);
    architecture.strategyBias[outcome.strategyId] = clamp((architecture.strategyBias[outcome.strategyId] ?? 0) * 0.78 + outcome.score * 0.22);
    if (!useful || outcome.score < 0.6) {
      architecture.strategyBias['proposition-reasoning'] = clamp((architecture.strategyBias['proposition-reasoning'] ?? 0.08) + 0.08);
      architecture.strategyBias['epistemic-trust'] = clamp((architecture.strategyBias['epistemic-trust'] ?? 0.08) + 0.08);
      architecture.strategyBias['semantic-first'] = clamp((architecture.strategyBias['semantic-first'] ?? 0.08) + 0.05);
    }
    state.reasoningArchitecture = architecture;
    state.rules = state.rules.map((rule) => ({ ...rule, learnedFrom: { outcomeCount: (rule.learnedFrom?.outcomeCount ?? 0) + 1, failureCount: (rule.learnedFrom?.failureCount ?? 0) + (useful ? 0 : 1), lastFailure: !useful ? outcome.query : rule.learnedFrom?.lastFailure } }));
    this.save(state);
    return state;
  }
  rewriteFromFeedback(feedbackInput: SearchPolicyFeedback): SearchPolicyState {
    const feedback = asFeedback(feedbackInput);
    const state = this.load();
    const next: SearchPolicyState = JSON.parse(JSON.stringify(state));
    const snapshot = snapshotPolicy(state);
    next.version = state.version + 1;
    const synthesized = feedback.rules ?? rulesFromFeedback(feedback);
    if (synthesized.length > 0) next.rules = synthesized;
    for (const [source, score] of Object.entries(feedback.sourceReliability ?? {})) {
      const entry = next.sourceReliability[source] ?? (next.sourceReliability[source] = { source, score: 0.6, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] });
      entry.score = clamp(score);
      entry.notes.push(`rewrite:${feedback.summary}`);
    }
    if (feedback.forecasts) next.forecasts = feedback.forecasts;
    applySynthesizedArchitecture(next, feedback, 'rewrite');
    const violations = validateRules(next.rules);
    next.auditLog.push({ at: nowMs(), action: 'rewrite-from-feedback', version: next.version, summary: feedback.summary, accepted: violations.length === 0, guardrails: violations });
    if (violations.length > 0) {
      state.auditLog.push({ at: nowMs(), action: 'rewrite-rejected', version: state.version, summary: feedback.summary, accepted: false, guardrails: violations });
      this.save(state);
      return state;
    }
    next.history = [...state.history, { version: state.version, state: snapshot }].slice(-20);
    this.save(next);
    return next;
  }
  async rewriteFromFeedbackSemantic(feedback: SearchPolicyFeedback, provider?: PolicyRewriteProvider): Promise<SearchPolicyState> {
    const current = this.load();
    try {
      const activeProvider = provider ?? createDefaultPolicyRewriteProvider();
      const payload = asSynthesizedOutput(await activeProvider.synthesize({ feedback, current, guardrails: ['bounded-hop-budget', 'audit-required'] }));
      if (!payload) return this.rewriteFromFeedback(feedback);
      const mergedFeedback: SearchPolicyFeedback = {
        ...feedback,
        summary: payload.summary ?? feedback.summary,
        rules: payload.rules ?? feedback.rules,
        sourceReliability: payload.sourceReliability ?? feedback.sourceReliability,
        forecasts: payload.forecasts ?? feedback.forecasts,
        strategyLogic: payload.strategyLogic ?? feedback.strategyLogic,
        architecture: payload.architecture ?? feedback.architecture,
        runtimeComposition: payload.runtimeComposition ?? feedback.runtimeComposition,
      };
      const nextState = this.rewriteFromFeedback(mergedFeedback);
      if (payload.runtimeComposition) rewriteSearchIndexRuntime(payload.runtimeComposition as RuntimeComposition);
      return nextState;
    } catch {
      return this.rewriteFromFeedback(feedback);
    }
  }
  rollback(targetVersion?: number): SearchPolicyState {
    const state = this.load();
    const version = targetVersion ?? Math.max(1, state.version - 1);
    const snapshot = [...state.history].reverse().find((entry) => entry.version === version);
    const restored = snapshot ? { ...snapshot.state, history: state.history.filter((entry) => entry.version < version || entry.version === version) } : { ...defaultPolicy(), version };
    const next = { ...restored, version, updatedAt: nowMs(), auditLog: [...state.auditLog, { at: nowMs(), action: 'rollback', version, summary: snapshot ? 'restored policy snapshot' : 'restored default policy baseline', accepted: true, guardrails: [] }] };
    this.save(next);
    return next;
  }
}

export function createDefaultPolicyRewriteProvider(): PolicyRewriteProvider {
  return {
    name: 'local-llm-policy-rewrite',
    async synthesize({ feedback, current, guardrails }) {
      const runtimeComposition = runtimeCompositionFromFeedback(feedback, current);
      return {
        summary: feedback.summary,
        guardrails,
        rules: feedback.rules ?? current.rules,
        sourceReliability: feedback.sourceReliability ?? {},
        forecasts: feedback.forecasts ?? current.forecasts,
        strategyLogic: feedback.strategyLogic ?? current.reasoningArchitecture?.strategyLogic,
        architecture: {
          explanationStyle: /semantic|ambigu/i.test(feedback.summary) ? 'thorough' : current.reasoningArchitecture?.explanationStyle,
          activeModules: current.reasoningArchitecture?.activeModules,
        },
        runtimeComposition,
      };
    },
  };
}
