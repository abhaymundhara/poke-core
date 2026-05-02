import type { PolicyDecision, SearchIntent, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];
}

function cloneEpistemicModel(model: NonNullable<SearchPolicyState['epistemicModel']>): NonNullable<SearchPolicyState['epistemicModel']> {
  return JSON.parse(JSON.stringify(model)) as NonNullable<SearchPolicyState['epistemicModel']>;
}

function neutralEpistemicModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return {
    version: 1,
    calibration: 0.5,
    classPriors: { primary: 0.5, expert: 0.5, institutional: 0.5, community: 0.5, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: [1, 0, 0, 0, 0],
      expert: [0, 1, 0, 0, 0],
      institutional: [0, 0, 1, 0, 0],
      community: [0, 0, 0, 1, 0],
      unknown: [0.2, 0.2, 0.2, 0.2, 0.2],
    },
    corroborationGraph: {},
  };
}

function parseModel(value: unknown, provider: string): NonNullable<SearchPolicyState['epistemicModel']> {
  if (!isRecord(value)) throw new Error('invalid-epistemic-model:' + provider);
  if (typeof value.version !== 'number' || typeof value.calibration !== 'number' || !isRecord(value.classPriors) || !isRecord(value.sourceMemory) || !isRecord(value.domainMemory) || !isRecord(value.knowledgeClassRepresentations) || !isRecord(value.corroborationGraph)) {
    throw new Error('invalid-epistemic-model:' + provider);
  }
  return cloneEpistemicModel(value as NonNullable<SearchPolicyState['epistemicModel']>);
}

function parseTrustedEvidence(value: unknown, provider: string): TrustedEvidence[] {
  if (!Array.isArray(value)) throw new Error('invalid-trusted-evidence:' + provider);
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('invalid-trusted-evidence:' + provider);
    return entry as TrustedEvidence;
  });
}

function parseRanking(value: unknown, provider: string): Array<{ source: SearchSource | string; score: number; reason: string }> {
  if (!Array.isArray(value)) throw new Error('invalid-source-ranking:' + provider);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.source !== 'string' || typeof entry.score !== 'number' || typeof entry.reason !== 'string') {
      throw new Error('invalid-source-ranking:' + provider);
    }
    return { source: entry.source, score: entry.score, reason: entry.reason };
  });
}

function trustPrompt<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>, providerPath: string, extractKey: keyof T | null = null): T {
  const raw = extractWithDefaultProviderSync<T>({ objective, context, schema }, providerPath);
  return raw;
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return neutralEpistemicModel();
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const raw = trustPrompt<{ model: NonNullable<SearchPolicyState['epistemicModel']> }>(
    'update an epistemic reliability model from outcome data',
    { currentModel: model ?? neutralEpistemicModel(), outcome },
    {
      type: 'object',
      required: ['model'],
      properties: {
        model: { type: 'object' },
      },
    },
    './src/search/nlu.ts',
  );
  return parseModel(raw.model, 'llm-semantic-inference');
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  const raw = trustPrompt<{ evidence: TrustedEvidence[] }>(
    'score the trustworthiness of evidence items',
    { intent, results, reliability, decision, policy },
    {
      type: 'object',
      required: ['evidence'],
      properties: {
        evidence: { type: 'array' },
      },
    },
    './src/search/nlu.ts',
  );
  return parseTrustedEvidence(raw.evidence, 'llm-semantic-inference');
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const raw = trustPrompt<{ ranking: Array<{ source: SearchSource | string; score: number; reason: string }> }>(
    'rank search sources by epistemic reliability and strategic usefulness',
    { intent, reliability, rules, decision },
    {
      type: 'object',
      required: ['ranking'],
      properties: {
        ranking: { type: 'array' },
      },
    },
    './src/search/nlu.ts',
  );
  return parseRanking(raw.ranking, 'llm-semantic-inference');
}
