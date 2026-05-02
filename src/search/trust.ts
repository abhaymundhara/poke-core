import type { PolicyDecision, SearchIntent, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence } from './types.ts';
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

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error('missing-' + label);
  return value as T[];
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  return runTrustModel<NonNullable<SearchPolicyState['epistemicModel']>>('update the epistemic trust model from a search outcome', { model, outcome }, TRUST_MODEL_SCHEMA);
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability?: Record<string, SearchSourceReliability>, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  const draft = runTrustModel<{ trustedEvidence: TrustedEvidence[] }>('score evidence trust with model reasoning only', { intent, results, reliability, decision, policy }, TRUST_SCORING_SCHEMA);
  return requireArray<TrustedEvidence>(draft.trustedEvidence, 'trustedEvidence');
}

export function buildSourceRanking(intent: SearchIntent, reliability?: Record<string, SearchSourceReliability>, rules?: SearchPolicyRule[], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const draft = runTrustModel<{ rankedSources: Array<{ source: SearchSource | string; score: number; reason: string }> }>('rank candidate sources using model reasoning only', { intent, reliability, rules, decision }, SOURCE_RANKING_SCHEMA);
  return requireArray<{ source: SearchSource | string; score: number; reason: string }>(draft.rankedSources, 'rankedSources');
}
