import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function runReasoningModel<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    queries: { type: 'array' },
  },
};

const HOP_SCHEMA = {
  type: 'object',
  properties: {
    hopPlan: { type: 'array' },
  },
};

const GRAPH_SCHEMA = {
  type: 'object',
  properties: {
    nodes: { type: 'array' },
    edges: { type: 'array' },
    queries: { type: 'array' },
    entities: { type: 'array' },
    communities: { type: 'array' },
    exploration: { type: 'array' },
    claims: { type: 'array' },
    propositions: { type: 'array' },
    propositionGraph: { type: 'object' },
    conflicts: { type: 'array' },
    synthesis: { type: 'object' },
    summary: { type: 'string' },
    confidence: { type: 'number' },
  },
};

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const draft = runReasoningModel<{ queries?: string[] }>('generate search queries from the model only', { intent, strategy }, QUERY_SCHEMA);
  return draft.queries as string[];
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const draft = runReasoningModel<{ hopPlan?: string[] }>('derive the hop plan from the model only', { intent, strategy, results }, HOP_SCHEMA);
  return draft.hopPlan as string[];
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability?: Record<string, any>, policy?: PolicyDecision, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const draft = runReasoningModel<SearchEvidenceGraph>('synthesize the evidence graph from the model only', { intent, queries, results, strategy, reliability, policy, policyState }, GRAPH_SCHEMA);
  return draft;
}
