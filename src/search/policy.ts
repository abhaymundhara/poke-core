import { resolve } from 'node:path';
import type { SearchFocus, SearchIntent, SearchOutcome, SearchPolicyRule, SearchPolicyState, SearchSignalForecast, SearchSource, SearchSourceReliability, SearchStrategyProfile } from './types.ts';
import { clamp, nowMs, readJson, writeJson } from './utils.ts';

export const DEFAULT_STATE_PATH = resolve(process.cwd(), '.poke-core', 'search-policy.json');

type PolicySnapshot = Omit<SearchPolicyState, 'history'>;

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

export function defaultPolicy(): SearchPolicyState {
  return {
    version: 1,
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

export function chooseStrategy(intent: SearchIntent, policy: SearchPolicyState): SearchStrategyProfile {
  const scored = policy.strategies.map((strategy) => ({ strategy, score: scoreStrategy(intent, strategy, policy) * (0.7 + strategy.lastScore * 0.3) }));
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.strategy ?? defaultPolicy().strategies[0];
}

function validateRules(rules: SearchPolicyRule[]): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    if (!rule.id || !rule.description) violations.push('rule-missing-identity');
    if (rule.maxHopBudget !== undefined && (rule.maxHopBudget < 1 || rule.maxHopBudget > 6)) violations.push(`invalid-hop-budget:${rule.id}`);
    if (rule.minTrustScore !== undefined && (rule.minTrustScore < 0 || rule.minTrustScore > 1)) violations.push(`invalid-min-trust:${rule.id}`);
    if (rule.guardrails.includes('disable-audit')) violations.push(`forbidden-guardrail:${rule.id}`);
  }
  return violations;
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
      strategy.lastScore = strategy.lastScore * 0.75 + outcome.score * 0.25;
      if (useful) strategy.successes += 1; else strategy.failures += 1;
    }
    const source = outcome.source ? String(outcome.source) : 'web';
    const sourceReliability = state.sourceReliability[source] ?? (state.sourceReliability[source] = { source, score: 0.6, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] });
    sourceReliability.uses += 1;
    sourceReliability.lastObservedAt = nowMs();
    if (useful) { sourceReliability.successes += 1; sourceReliability.score = clamp(sourceReliability.score * 0.9 + outcome.score * 0.1); }
    else { sourceReliability.failures += 1; sourceReliability.score = clamp(sourceReliability.score * 0.96 - 0.03); }
    const profile = state.queryProfiles[outcome.sessionKey] ?? { count: 0, lastScore: 0, lastUpdatedAt: nowMs(), averageScore: 0, focus: 'factual' as SearchFocus, sourceHints: [] };
    profile.count += 1;
    profile.lastScore = outcome.score;
    profile.lastUpdatedAt = nowMs();
    profile.averageScore = profile.averageScore === 0 ? outcome.score : profile.averageScore * 0.7 + outcome.score * 0.3;
    state.queryProfiles[outcome.sessionKey] = profile;
    this.save(state);
    return state;
  }
  rewriteFromFeedback(feedback: { summary: string; rules?: SearchPolicyRule[]; sourceReliability?: Record<string, number>; forecasts?: SearchSignalForecast[] }): SearchPolicyState {
    const state = this.load();
    const next: SearchPolicyState = JSON.parse(JSON.stringify(state));
    const snapshot = snapshotPolicy(state);
    next.version = state.version + 1;
    if (feedback.rules) next.rules = feedback.rules;
    for (const [source, score] of Object.entries(feedback.sourceReliability ?? {})) {
      const entry = next.sourceReliability[source] ?? (next.sourceReliability[source] = { source, score: 0.6, uses: 0, successes: 0, failures: 0, lastObservedAt: null, notes: [] });
      entry.score = clamp(score);
      entry.notes.push(`rewrite:${feedback.summary}`);
    }
    if (feedback.forecasts) next.forecasts = feedback.forecasts;
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
