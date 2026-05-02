import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function runReasoningModel<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

const QUERY_SCHEMA = {
  type: 'object',
  required: ['queries'],
  properties: {
    queries: { type: 'array' },
  },
};

const HOP_SCHEMA = {
  type: 'object',
  required: ['hopPlan'],
  properties: {
    hopPlan: { type: 'array' },
  },
};

const GRAPH_SCHEMA = {
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
    propositionGraph: { type: 'object' },
    conflicts: { type: 'array' },
    synthesis: { type: 'object' },
    summary: { type: 'string' },
    confidence: { type: 'number' },
  },
};

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const draft = runReasoningModel<{ queries?: string[] }>('generate search queries from the model only', { intent, strategy }, QUERY_SCHEMA);
  return Array.isArray(draft.queries) && draft.queries.length > 0 ? draft.queries.map((query) => String(query)) : [intent.semanticQuery];
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const draft = runReasoningModel<{ hopPlan?: string[] }>('derive the hop plan from the model only', { intent, strategy, results }, HOP_SCHEMA);
  return Array.isArray(draft.hopPlan) && draft.hopPlan.length > 0 ? draft.hopPlan.map((step) => String(step)) : [intent.semanticQuery];
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability: Record<string, any> = {}, policy: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const draft = runReasoningModel<SearchEvidenceGraph>('synthesize the evidence graph from the model only', { intent, queries, results, strategy, reliability, policy, policyState }, GRAPH_SCHEMA);
  return {
    nodes: Array.isArray(draft.nodes) ? draft.nodes : [],
    edges: Array.isArray(draft.edges) ? draft.edges : [],
    queries: Array.isArray(draft.queries) && draft.queries.length > 0 ? draft.queries.map((query) => String(query)) : queries,
    entities: Array.isArray(draft.entities) ? draft.entities : [],
    communities: Array.isArray(draft.communities) ? draft.communities : [],
    exploration: Array.isArray(draft.exploration) ? draft.exploration : [],
    claims: Array.isArray(draft.claims) ? draft.claims : [],
    propositions: Array.isArray(draft.propositions) ? draft.propositions : [],
    propositionGraph: draft.propositionGraph,
    conflicts: Array.isArray(draft.conflicts) ? draft.conflicts : [],
    synthesis: draft.synthesis,
    summary: typeof draft.summary === 'string' ? draft.summary : '',
    confidence: typeof draft.confidence === 'number' ? draft.confidence : 0,
  };
}
