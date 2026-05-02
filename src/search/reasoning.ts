import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';
import { scoreEvidenceTrust } from './trust.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];
}

function parseGraph(value: unknown, provider: string): SearchEvidenceGraph {
  if (!isRecord(value)) throw new Error('invalid-evidence-graph:' + provider);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.queries) || !Array.isArray(value.entities) || !Array.isArray(value.communities) || !Array.isArray(value.exploration) || !Array.isArray(value.claims) || !Array.isArray(value.propositions) || !Array.isArray(value.conflicts) || !isRecord(value.synthesis) || typeof value.summary !== 'string' || typeof value.confidence !== 'number') {
    throw new Error('invalid-evidence-graph:' + provider);
  }
  return value as SearchEvidenceGraph;
}

function parseStringListPayload(value: unknown, provider: string, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) throw new Error('invalid-' + key + ':' + provider);
  return parseStringArray(value[key]);
}

function reasoningPrompt<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema }, './src/search/nlu.ts');
}

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const raw = reasoningPrompt<{ queries: string[] }>(
    'synthesize search queries for an intent and strategy',
    { intent, strategy },
    {
      type: 'object',
      required: ['queries'],
      properties: {
        queries: { type: 'array' },
      },
    },
  );
  return parseStringArray(raw.queries);
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const raw = reasoningPrompt<{ hopPlan: string[] }>(
    'synthesize a hop plan for search exploration',
    { intent, strategy, results },
    {
      type: 'object',
      required: ['hopPlan'],
      properties: {
        hopPlan: { type: 'array' },
      },
    },
  );
  return parseStringArray(raw.hopPlan);
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability: Record<string, any> = {}, policy: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const trusted = scoreEvidenceTrust(intent, results, reliability, policy, policyState);
  const raw = reasoningPrompt<SearchEvidenceGraph>(
    'synthesize a proposition graph and entailment map from trusted evidence',
    { intent, queries, results: trusted, strategy, reliability, policy, policyState },
    {
      type: 'object',
      required: ['nodes', 'edges', 'queries', 'entities', 'communities', 'exploration', 'claims', 'propositions', 'conflicts', 'synthesis', 'summary', 'confidence'],
      properties: {
        nodes: { type: 'array' },
        edges: { type: 'array' },
        queries: { type: 'array' },
        entities: { type: 'array' },
        communities: { type: 'array' },
        exploration: { type: 'array' },
        claims: { type: 'array' },
        propositions: { type: 'array' },
        conflicts: { type: 'array' },
        synthesis: { type: 'object' },
        summary: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
  );
  return parseGraph(raw, 'llm-semantic-inference');
}
