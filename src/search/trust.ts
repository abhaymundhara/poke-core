import type { PolicyDecision, SearchIntent, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown, EpistemicClass, EpistemicTrustEntry } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function runTrustModel<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

const TRUST_MODEL_SCHEMA = {
  type: 'object',
  required: ['version', 'calibration', 'classPriors', 'sourceMemory', 'domainMemory', 'knowledgeClassRepresentations', 'corroborationGraph'],
  properties: {
    version: { type: 'number' },
    calibration: { type: 'number' },
    classPriors: { type: 'object' },
    sourceMemory: { type: 'object' },
    domainMemory: { type: 'object' },
    knowledgeClassRepresentations: { type: 'object' },
    corroborationGraph: { type: 'object' },
  },
};

const SOURCE_RANKING_SCHEMA = {
  type: 'object',
  required: ['rankedSources'],
  properties: {
    rankedSources: { type: 'array' },
  },
};

const TRUST_SCORING_SCHEMA = {
  type: 'object',
  required: ['trustedEvidence'],
  properties: {
    trustedEvidence: { type: 'array' },
  },
};

function emptyEntry(epistemicClass: EpistemicClass): EpistemicTrustEntry {
  return {
    mean: 0,
    variance: 0,
    evidenceCount: 0,
    successes: 0,
    failures: 0,
    lastObservedAt: null,
    notes: [],
    epistemicClass,
    representation: [],
    corroboration: {},
    classPosterior: {
      primary: 0,
      expert: 0,
      institutional: 0,
      community: 0,
      unknown: 0,
    },
  };
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return {
    version: 1,
    calibration: 0.5,
    classPriors: {
      primary: 0.2,
      expert: 0.2,
      institutional: 0.2,
      community: 0.2,
      unknown: 0.2,
    },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: [],
      expert: [],
      institutional: [],
      community: [],
      unknown: [],
    },
    corroborationGraph: {},
  };
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const base = model ?? initialEpistemicTrustModel();
  const updated = runTrustModel<NonNullable<SearchPolicyState['epistemicModel']>>('update the epistemic trust model from a search outcome', { model: base, outcome }, TRUST_MODEL_SCHEMA);
  return updated ?? base;
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  const draft = runTrustModel<{ trustedEvidence?: TrustedEvidence[] }>('score evidence trust with model reasoning only', { intent, results, reliability, decision: decision ?? { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policy: policy ?? null }, TRUST_SCORING_SCHEMA);
  if (Array.isArray(draft.trustedEvidence) && draft.trustedEvidence.length > 0) return draft.trustedEvidence;
  return results.map((result) => ({
    ...result,
    trustScore: typeof result.trust === 'number' ? result.trust : 0.5,
    trustBreakdown: {
      evidenceQuality: 0,
      provenance: 0,
      recency: 0,
      corroboration: 0,
      domainReliability: 0,
      expertise: 0,
      independence: 0,
      uncertainty: 0.5,
    },
    reliability: {
      mean: 0.5,
      variance: 0.5,
      sampleSize: 0,
      failureModes: [],
      epistemicClass: 'unknown',
    },
    provenance: {
      domain: new URL(result.url).hostname,
      source: result.source,
      official: false,
      primary: false,
    },
  }));
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const draft = runTrustModel<{ rankedSources?: Array<{ source: SearchSource | string; score: number; reason: string }> }>('rank candidate sources using model reasoning only', { intent, reliability, rules, decision: decision ?? { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] } }, SOURCE_RANKING_SCHEMA);
  if (Array.isArray(draft.rankedSources) && draft.rankedSources.length > 0) return draft.rankedSources;
  return intent.sourceHints.map((source) => ({ source, score: 0.5, reason: 'model fallback' }));
}
