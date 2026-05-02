import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SearchOutcome, SearchPlan, SearchResult, SearchStrategyProfile, RuntimeComposition } from './types.ts';
import { buildSourceRanking, evaluateTrustGate, scoreEvidenceTrust } from './trust.ts';
import { buildEvidenceGraph, buildQueries, deriveHopPlan } from './reasoning.ts';
import { forecastNextSignals, persistForecastTrajectory } from './forecast.ts';
import { chooseStrategy, fallbackStrategyChoose, DEFAULT_STATE_PATH, evaluatePolicy, SearchPolicyStore, createDefaultPolicyRewriteProvider, registerRuntimeCompositionMutator } from './policy.ts';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, understandSearchIntent, understandSearchIntentWithNlu, type SemanticNluProvider } from './nlu.ts';
import { clamp, stableHash, uniq } from './utils.ts';

export * from './types.ts';
export * from './nlu.ts';
export * from './trust.ts';
export * from './reasoning.ts';
export * from './knowledge-graph.ts';
export * from './forecast.ts';
export * from './policy.ts';

export const SEARCH_INDEX_SOURCE_PATH = resolve(process.cwd(), 'src/search/index.ts');

export function persistSearchIndexSourceRewrite(nextSource: string): string {
  const currentSource = existsSync(SEARCH_INDEX_SOURCE_PATH) ? readFileSync(SEARCH_INDEX_SOURCE_PATH, 'utf8') : '';
  if (currentSource !== nextSource) writeFileSync(SEARCH_INDEX_SOURCE_PATH, nextSource);
  return SEARCH_INDEX_SOURCE_PATH;
}

let activeRuntimeComposition: RuntimeComposition | null = null;

registerRuntimeCompositionMutator((composition) => {
  activeRuntimeComposition = composition;
});

export function rewriteSearchIndexRuntime(composition: RuntimeComposition): void {
  activeRuntimeComposition = composition;
}

function runtimeCompositionFromState(state: any): RuntimeComposition | null {
  return (state?.reasoningArchitecture?.runtimeComposition ?? null) as RuntimeComposition | null;
}

function activeComposition(state: any): RuntimeComposition | null {
  return activeRuntimeComposition ?? runtimeCompositionFromState(state);
}

function buildTrustNotes(intent: SearchPlan['intent'], sourceRanking: SearchPlan['sourceRanking'], state: any): string[] {
  const composition = activeComposition(state);
  const rewriteNotes = composition?.notes ?? [];
  return [
    'trust-mode=' + intent.trustMode,
    'freshness=' + intent.freshness,
    'hop-budget=' + intent.hopBudget,
    'nlu=' + intent.nlu.provider + ':' + intent.nlu.confidence.toFixed(2) + ' path=' + (intent.nlu.fallbackUsed ? 'legacy' : 'semantic'),
    'rewrite-revision=' + String(composition?.version ?? 0),
    ...rewriteNotes.slice(0, 3).map((note) => 'rewrite=' + note),
    ...sourceRanking.slice(0, 3).map((entry) => entry.source + ':' + entry.score.toFixed(2) + ':' + entry.reason),
  ];
}

export function resolveRuntimeStrategy(intent: ReturnType<typeof understandSearchIntent>, state: any): SearchStrategyProfile {
  const composition = activeComposition(state);
  const source = composition?.strategySelectorSource;
  if (!source) return chooseStrategy(intent, state);
  try {
    const evaluator = new Function('intent', 'policy', 'fallbackChoose', `const factory = (${source}); return factory(intent, policy, fallbackChoose);`) as (intent: any, policy: any, fallbackChoose: typeof fallbackStrategyChoose) => SearchStrategyProfile;
    return evaluator(intent, state, fallbackStrategyChoose) ?? fallbackStrategyChoose(intent, state);
  } catch {
    return fallbackStrategyChoose(intent, state);
  }
}

export function applyRuntimePipeline(plan: SearchPlan, state: any): SearchPlan {
  const composition = activeComposition(state);
  const source = composition?.pipelineSource;
  if (!source) return plan;
  try {
    const evaluator = new Function('plan', 'policy', `const factory = (${source}); return factory(plan, policy);`) as (plan: SearchPlan, policy: any) => SearchPlan;
    return evaluator(plan, state) ?? plan;
  } catch {
    return plan;
  }
}

export class SearchSession {
  private readonly store: SearchPolicyStore;
  private state: any;

  constructor(private options: { policyPath?: string; behaviorSeed?: Record<string, unknown>; clock?: () => number; nluProvider?: SemanticNluProvider; strictSemanticNlu?: boolean; policyRewriteProvider?: ReturnType<typeof createDefaultPolicyRewriteProvider> } = {}) {
    this.store = new SearchPolicyStore(options.policyPath);
    this.options.nluProvider ??= DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
    this.options.strictSemanticNlu ??= true;
    this.options.policyRewriteProvider ??= createDefaultPolicyRewriteProvider();
    this.state = this.store.load();
  }

  get policy() { return this.state; }

  private buildPlan(intent: ReturnType<typeof understandSearchIntent>, context: Record<string, unknown>, results: SearchResult[] = [], learn = false): SearchPlan {
    this.state = this.store.load();
    let workingIntent = intent;
    let currentState = this.state;
    let finalPlan: SearchPlan | null = null;
    let finalEvidenceGraph: SearchPlan['evidenceGraph'] | null = null;
    let finalTrustedResults: SearchResult[] = results;
    let finalStrategy = resolveRuntimeStrategy(intent, currentState);
    let previousSignature = '';
    let previousConfidence = 0;
    let pass = 0;
    const maxHops = Math.max(1, Math.min(6, intent.hopBudget));

    while (pass < maxHops) {
      const forecastSeed = { ...(this.options.behaviorSeed ?? context), pass, previousSignature, objective: workingIntent.semanticQuery };
      const forecasts = forecastNextSignals(workingIntent, currentState, forecastSeed);
      const policyDecision = evaluatePolicy(workingIntent, currentState, forecasts.map((signal) => signal.latentNeed.label));
      const effectiveIntent = policyDecision.maxHopBudget ? { ...workingIntent, hopBudget: Math.min(workingIntent.hopBudget, policyDecision.maxHopBudget) } : workingIntent;
      const strategy = resolveRuntimeStrategy(effectiveIntent, currentState);
      const queries = buildQueries(effectiveIntent, strategy);
      const sourceRanking = buildSourceRanking(effectiveIntent, currentState.sourceReliability, currentState.rules, policyDecision);
      const trustNotes = buildTrustNotes(effectiveIntent, sourceRanking, currentState);
      const trustedResults = scoreEvidenceTrust(effectiveIntent, results, currentState.sourceReliability, policyDecision, currentState);
      const trustGate = evaluateTrustGate(effectiveIntent, trustedResults, policyDecision, currentState);
      const evidenceGraph = buildEvidenceGraph(effectiveIntent, queries, trustedResults, strategy, currentState.sourceReliability, policyDecision, currentState);
      const hopPlan = deriveHopPlan(effectiveIntent, strategy, trustedResults);
      const signature = stableHash(JSON.stringify({ objective: effectiveIntent.semanticQuery, queries, hopPlan, claims: evidenceGraph.claims.map((claim) => claim.id), propositions: evidenceGraph.propositions.map((proposition) => proposition.id), confidence: Number(evidenceGraph.confidence.toFixed(3)), forecasts: forecasts.slice(0, 3).map((signal) => signal.latentNeed.label + ':' + signal.topic), trustGate: trustGate.mode }));
      const stabilized = signature === previousSignature || (previousConfidence > 0 && Math.abs(evidenceGraph.confidence - previousConfidence) < 0.025 && evidenceGraph.claims.length > 0 && evidenceGraph.propositions.length > 0);
      const gateAccept = trustGate.mode === 'accept';
      currentState = persistForecastTrajectory(currentState, { intent: effectiveIntent, forecasts, signature, pass, stabilized: stabilized && gateAccept });
      this.state = currentState;
      this.store.save(this.state);
      finalTrustedResults = trustedResults;
      finalStrategy = strategy;
      finalEvidenceGraph = evidenceGraph;
      finalPlan = { intent: effectiveIntent, strategy, queries, sourceRanking, hopPlan, trustNotes: [...trustNotes, 'policy=' + (policyDecision.matchedRules.join('|') || 'none'), 'trajectory=' + signature, 'pass=' + String(pass), 'trust-gate=' + trustGate.mode + ':' + (trustGate.reasons.join('|') || 'none')], predictedSignals: forecasts, evidenceGraph };
      previousSignature = signature;
      previousConfidence = evidenceGraph.confidence;
      if (stabilized && gateAccept) break;
      workingIntent = gateAccept
        ? (evidenceGraph.claims.length === 0
            ? {
                ...effectiveIntent,
                focus: 'multi-hop',
                hopBudget: Math.min(6, effectiveIntent.hopBudget + 1),
                querySeeds: uniq([...effectiveIntent.querySeeds, ...forecasts.flatMap((signal) => signal.suggestedQueries), ...queries]).slice(0, 8),
                evidenceTerms: uniq([...effectiveIntent.evidenceTerms, ...evidenceGraph.propositions.slice(0, 4).map((proposition) => proposition.text), ...evidenceGraph.claims.slice(0, 4).map((claim) => claim.text)]).slice(0, 16),
              }
            : {
                ...effectiveIntent,
                querySeeds: uniq([...effectiveIntent.querySeeds, ...forecasts.flatMap((signal) => signal.suggestedQueries), ...evidenceGraph.exploration.flatMap((step) => step.frontier)]).slice(0, 8),
                evidenceTerms: uniq([...effectiveIntent.evidenceTerms, ...evidenceGraph.claims.slice(0, 4).map((claim) => claim.text), ...evidenceGraph.propositions.slice(0, 4).map((proposition) => proposition.text)]).slice(0, 16),
                topics: uniq([...effectiveIntent.topics, ...evidenceGraph.entities.slice(0, 4).map((entity) => entity.label)]).slice(0, 12),
              })
        : trustGate.replanIntent;
      pass += 1;
    }

    if (!finalPlan || !finalEvidenceGraph) {
      const strategy = resolveRuntimeStrategy(workingIntent, currentState);
      const queries = buildQueries(workingIntent, strategy);
      const sourceRanking = buildSourceRanking(workingIntent, currentState.sourceReliability, currentState.rules);
      const trustedResults = scoreEvidenceTrust(workingIntent, results, currentState.sourceReliability, undefined, currentState);
      const evidenceGraph = buildEvidenceGraph(workingIntent, queries, trustedResults, strategy, currentState.sourceReliability, undefined, currentState);
      const hopPlan = deriveHopPlan(workingIntent, strategy, trustedResults);
      finalPlan = { intent: workingIntent, strategy, queries, sourceRanking, hopPlan, trustNotes: buildTrustNotes(workingIntent, sourceRanking, currentState), predictedSignals: forecastNextSignals(workingIntent, currentState, this.options.behaviorSeed ?? context), evidenceGraph };
      finalTrustedResults = trustedResults;
      finalStrategy = strategy;
      finalEvidenceGraph = evidenceGraph;
    }

    const completedPlan = finalPlan as SearchPlan;
    const completedEvidenceGraph = finalEvidenceGraph as SearchPlan['evidenceGraph'];

    if (learn) {
      const score = clamp(completedEvidenceGraph.confidence * 0.55 + Math.min(1, results.length / 4) * 0.25 + finalStrategy.lastScore * 0.2);
      void this.learn(completedPlan.intent, finalStrategy, finalTrustedResults, score).catch(() => undefined);
    }

    return applyRuntimePipeline(completedPlan, this.state);
  }

  plan(objective: string, context: Record<string, unknown> = {}): SearchPlan {
    return this.buildPlan(understandSearchIntent(objective, context), context);
  }

  async planSemantic(objective: string, context: Record<string, unknown> = {}): Promise<SearchPlan> {
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider, this.options.strictSemanticNlu), context);
  }

  async planAuto(objective: string, context: Record<string, unknown> = {}): Promise<SearchPlan> {
    this.state = this.store.load();
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, this.options.strictSemanticNlu), context);
  }

  fuse(intent: ReturnType<typeof understandSearchIntent>, results: SearchResult[], strategy = resolveRuntimeStrategy(intent, this.state)) {
    const queries = buildQueries(intent, strategy);
    const trusted = scoreEvidenceTrust(intent, results, this.state.sourceReliability, undefined, this.state);
    return buildEvidenceGraph(intent, queries, trusted, strategy, this.state.sourceReliability);
  }

  recordOutcome(outcome: SearchOutcome) {
    this.state = this.store.updateOutcome(outcome);
    return this.state;
  }

  async learn(intent: ReturnType<typeof understandSearchIntent>, strategy: SearchStrategyProfile, results: SearchResult[], score = 0.5) {
    const source = results[0]?.source ?? intent.sourceHints[0] ?? 'web';
    const state = this.recordOutcome({ sessionKey: intent.sessionKey, strategyId: strategy.id, query: intent.semanticQuery, source, score, useful: score >= 0.7, hopsUsed: Math.max(1, intent.hopBudget), resultCount: results.length, relevantCount: results.filter((result) => (result.score ?? result.trust ?? 0.5) >= 0.7).length, resultUrls: results.map((result) => result.url).filter(Boolean), resultDomains: results.map((result) => { try { return new URL(result.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean), notes: [] });
    if (score < 0.68 || results.length === 0) {
      const feedback = {
        summary: `outcome failure for ${intent.semanticQuery}`,
        failedQueries: [intent.semanticQuery],
        failedSources: [source],
        latentNeeds: intent.topics.slice(0, 3),
        desiredBehavior: 'rewrite the live search composition to emphasize the failing semantic and trust signals',
      };
      void this.rewritePolicyFromFeedbackSemantic(feedback, this.options.policyRewriteProvider).catch(() => state);
    }
    return state;
  }

  forecast(objective: string, context: Record<string, unknown> = {}) {
    const intent = understandSearchIntent(objective, context);
    return forecastNextSignals(intent, this.state, this.options.behaviorSeed ?? context);
  }

  choose(objective: string, context: Record<string, unknown> = {}) {
    const intent = understandSearchIntent(objective, context);
    this.state = this.store.load();
    return resolveRuntimeStrategy(intent, this.state);
  }

  run(objective: string, context: Record<string, unknown> = {}, results: SearchResult[] = []): SearchPlan {
    return this.buildPlan(understandSearchIntent(objective, context), context, results, true);
  }

  async runSemantic(objective: string, context: Record<string, unknown> = {}, results: SearchResult[] = []): Promise<SearchPlan> {
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, this.options.strictSemanticNlu), context, results, true);
  }

  async runAuto(objective: string, context: Record<string, unknown> = {}, results: SearchResult[] = []): Promise<SearchPlan> {
    this.state = this.store.load();
    return this.buildPlan(await understandSearchIntentWithNlu(objective, context, this.options.nluProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, this.options.strictSemanticNlu), context, results, true);
  }

  rewritePolicyFromFeedback(feedback: Parameters<SearchPolicyStore['rewriteFromFeedback']>[0]) {
    this.state = this.store.rewriteFromFeedback(feedback);
    return this.state;
  }

  async rewritePolicyFromFeedbackSemantic(feedback: Parameters<SearchPolicyStore['rewriteFromFeedbackSemantic']>[0], provider?: Parameters<SearchPolicyStore['rewriteFromFeedbackSemantic']>[1]) {
    this.state = await this.store.rewriteFromFeedbackSemantic(feedback, provider);
    return this.state;
  }

  rollbackPolicy(version?: number) {
    this.state = this.store.rollback(version);
    return this.state;
  }
}

export function createSearchSession(options: { policyPath?: string; behaviorSeed?: Record<string, unknown>; clock?: () => number; nluProvider?: SemanticNluProvider; strictSemanticNlu?: boolean; policyRewriteProvider?: ReturnType<typeof createDefaultPolicyRewriteProvider> } = {}): SearchSession {
  return new SearchSession(options);
}

export function buildSearchIntent(objective: string, context: Record<string, unknown> = {}) {
  return understandSearchIntent(objective, context);
}

export async function buildSemanticSearchIntent(objective: string, context: Record<string, unknown> = {}, provider?: SemanticNluProvider) {
  return understandSearchIntentWithNlu(objective, context, provider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, true);
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
