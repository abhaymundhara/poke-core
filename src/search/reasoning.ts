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

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error('missing-' + label);
  return value as T[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing-' + label);
  return value as Record<string, unknown>;
}

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const draft = runReasoningModel<{ queries: string[] }>('generate search queries from the model only', { intent, strategy }, QUERY_SCHEMA);
  return requireArray<string>(draft.queries, 'queries').map((query) => String(query));
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const draft = runReasoningModel<{ hopPlan: string[] }>('derive the hop plan from the model only', { intent, strategy, results }, HOP_SCHEMA);
  return requireArray<string>(draft.hopPlan, 'hopPlan').map((step) => String(step));
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability: Record<string, any> = {}, policy: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const draft = runReasoningModel<SearchEvidenceGraph>('synthesize the evidence graph from the model only', { intent, queries, results, strategy, reliability, policy, policyState }, GRAPH_SCHEMA);
  return {
    nodes: requireArray<SearchEvidenceNode>(draft.nodes, 'nodes'),
    edges: requireArray<SearchEvidenceEdge>(draft.edges, 'edges'),
    queries: requireArray<string>(draft.queries, 'queries').map((query) => String(query)),
    entities: requireArray<string>(draft.entities, 'entities').map((entity) => String(entity)),
    communities: requireArray<string>(draft.communities, 'communities').map((community) => String(community)),
    exploration: requireArray<Record<string, unknown>>(draft.exploration, 'exploration'),
    claims: requireArray<ClaimAssessment>(draft.claims, 'claims'),
    propositions: requireArray<Proposition>(draft.propositions, 'propositions'),
    propositionGraph: requireObject(draft.propositionGraph, 'propositionGraph') as PropositionGraph,
    conflicts: requireArray<EvidenceConflict>(draft.conflicts, 'conflicts'),
    synthesis: requireObject(draft.synthesis, 'synthesis'),
    summary: String(draft.summary),
    confidence: Number(draft.confidence),
  };
}
