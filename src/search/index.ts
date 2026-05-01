import type { SearchOutcome, SearchPlan, SearchResult, SearchStrategyProfile } from './types.ts';
import { buildSourceRanking, scoreEvidenceTrust } from './trust.ts';
import { buildEvidenceGraph, buildQueries, deriveHopPlan } from './reasoning.ts';
import { forecastNextSignals } from './forecast.ts';
import { chooseStrategy, DEFAULT_STATE_PATH, SearchPolicyStore } from './policy.ts';
import { understandSearchIntent, understandSearchIntentWithNlu, type SemanticNluProvider } from './nlu.ts';
import { clamp } from './utils.ts';

export * from './types.ts';
export * from './nlu.ts';
export * from './trust.ts';
export * from './reasoning.ts';
export * from './forecast.ts';
export * from './policy.ts';

function buildTrustNotes(intent: SearchPlan['intent'], sourceRanking: SearchPlan['sourceRanking']): string[] {
  return [
    `trust-mode=${intent.trustMode}`,
    `freshness=${intent.freshness}`,
    `hop-budget=${intent.hopBudget}`,
    `nlu=${intent.nlu.provider}:${intent.nlu.confidence.toFixed(2)} fallback=${intent.nlu.fallbackUsed}`,
    ...sourceRanking.slice(0, 3).map((entry) => `${entry.source}:${entry.score.toFixed(2)}:${entry.reason}`),
  ];
}

export class SearchSession {
  private readonly store: SearchPolicyStore;
  private state;

  constructor(private readonly options: { policyPath?: string; behaviorSeed?: Record<string, unknown>; clock?: () => number; nluProvider?: SemanticNluProvider } = {}) {
    this.store = new SearchPolicyStore(options.policyPath);
    this.state = this.store.load();
  }

  get policy() { return this.state; }

  private buildPlan(intent: ReturnType<typeof understandSearchIntent>, context: Record<string, unknown>, results: SearchResult[] = [], learn = false): SearchPlan {
    this.state = this.store.load();
    const strategy = chooseStrategy(intent, this.state);
    const queries = buildQueries(intent, strategy);
    const sourceRanking = buildSourceRanking(intent, this.state.sourceReliability);
    const trustNotes = buildTrustNotes(intent, sourceRanking);
    const predictedSignals = forecastNextSignals(intent, this.state, this.options.behaviorSeed ?? context);
    const trustedResults = scoreEvidenceTrust(intent, results, this.state.sourceReliability);
    const evidenceGraph = buildEvidenceGraph(intent, queries, trustedResults, strategy, this.state.sourceReliability);
    const hopPlan = deriveHopPlan(intent, strategy, trustedResults);
    if (learn) {
      const score = clamp(evidenceGraph.confidence * 0.55 + Math.min(1, results.length / 4) * 0.25 + strategy.lastScore * 0.2);
      this.learn(intent, strategy, trustedResults, score);
    }
    return { intent, strategy, queries, sourceRanking, hopPlan, trustNotes, predictedSignals, evidenceGraph };
  }

  plan(objective: string, context: Record<string, unknown> = {}): SearchPlan {
    return this.buildPlan(understandSearchIntent(objective, context), context);
  }

  async planSemantic(objective: string, context: Record<string, unknown> = {}): Promise<SearchPlan> {
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider), context);
  }

  fuse(intent: ReturnType<typeof understandSearchIntent>, results: SearchResult[], strategy = chooseStrategy(intent, this.state)) {
    const queries = buildQueries(intent, strategy);
    const trusted = scoreEvidenceTrust(intent, results, this.state.sourceReliability);
    return buildEvidenceGraph(intent, queries, trusted, strategy, this.state.sourceReliability);
  }

  recordOutcome(outcome: SearchOutcome) {
    this.state = this.store.updateOutcome(outcome);
    return this.state;
  }

  learn(intent: ReturnType<typeof understandSearchIntent>, strategy: SearchStrategyProfile, results: SearchResult[], score = 0.5) {
    const source = results[0]?.source ?? intent.sourceHints[0] ?? 'web';
    return this.recordOutcome({ sessionKey: intent.sessionKey, strategyId: strategy.id, query: intent.semanticQuery, source, score, useful: score >= 0.7, hopsUsed: Math.max(1, intent.hopBudget), resultCount: results.length, relevantCount: results.filter((result) => (result.score ?? result.trust ?? 0.5) >= 0.7).length, notes: [] });
  }

  forecast(objective: string, context: Record<string, unknown> = {}) {
    const intent = understandSearchIntent(objective, context);
    return forecastNextSignals(intent, this.state, this.options.behaviorSeed ?? context);
  }

  choose(objective: string, context: Record<string, unknown> = {}) {
    const intent = understandSearchIntent(objective, context);
    this.state = this.store.load();
    return chooseStrategy(intent, this.state);
  }

  run(objective: string, context: Record<string, unknown> = {}, results: SearchResult[] = []): SearchPlan {
    return this.buildPlan(understandSearchIntent(objective, context), context, results, true);
  }

  async runSemantic(objective: string, context: Record<string, unknown> = {}, results: SearchResult[] = []): Promise<SearchPlan> {
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider), context, results, true);
  }

  rewritePolicyFromFeedback(feedback: Parameters<SearchPolicyStore['rewriteFromFeedback']>[0]) {
    this.state = this.store.rewriteFromFeedback(feedback);
    return this.state;
  }

  rollbackPolicy(version?: number) {
    this.state = this.store.rollback(version);
    return this.state;
  }
}

export function createSearchSession(options: { policyPath?: string; behaviorSeed?: Record<string, unknown>; clock?: () => number; nluProvider?: SemanticNluProvider } = {}): SearchSession {
  return new SearchSession(options);
}

export function buildSearchIntent(objective: string, context: Record<string, unknown> = {}) {
  return understandSearchIntent(objective, context);
}

export async function buildSemanticSearchIntent(objective: string, context: Record<string, unknown> = {}, provider?: SemanticNluProvider) {
  return understandSearchIntentWithNlu(objective, context, provider);
}

export function formatSearchAudit(): string {
  const session = createSearchSession({ policyPath: DEFAULT_STATE_PATH });
  const cases = [
    session.run('understand a live web query with semantic nlu and trust weighting', { live: true, sources: ['realtime-web', 'web'] }, [{ title: 'Semantic retrieval', url: 'https://example.com/semantic', snippet: 'semantic retrieval and trust ranking are supported by source evidence', source: 'web', trust: 0.81, freshness: 0.7, score: 0.78 }]),
    session.run('learn which sources are most reliable over time', { trust: true }, [{ title: 'Source reliability', url: 'https://example.edu/reliability', snippet: 'authoritative evidence improves ranking and cites primary sources', source: 'scholar', trust: 0.9, freshness: 0.55, score: 0.92 }]),
    session.run('chain results into multi-hop evidence fusion and contradiction checks', { multiHop: true, entities: ['Poke Core', 'autopilot'] }, [{ title: 'Hop 1', url: 'https://github.com/abhaymundhara/poke-core', snippet: 'repository evidence supports the autopilot search policy', source: 'github', trust: 0.93, freshness: 0.72, score: 0.9 }, { title: 'Hop 2', url: 'https://scholar.example/evidence', snippet: 'citation trail supports claim-level verification', source: 'scholar', trust: 0.88, freshness: 0.62, score: 0.84 }]),
  ];
  return [`cases=${cases.length}`, ...cases.map((plan) => `strategy=${plan.strategy.name} queries=${plan.queries.length} hops=${plan.hopPlan.length} claims=${plan.evidenceGraph.claims.length} conflicts=${plan.evidenceGraph.conflicts.length} confidence=${plan.evidenceGraph.confidence.toFixed(3)} forecast=${plan.predictedSignals.map((signal) => `${signal.source}:${signal.topic}`).join('|')}`)].join('\n');
}
