import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { average, clamp, stableHash, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';
import { addKnowledgeGraphNodes, canonicalizeEntities, chainOfExploration, detectEvidenceCommunities, synthesizeEvidence } from './knowledge-graph.ts';

const VECTOR_DIM = 16;

function textVector(text: string): number[] {
  const vec = Array.from({ length: VECTOR_DIM }, () => 0);
  const normalized = text.toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    const index = (code + i * 17) % VECTOR_DIM;
    vec[index] += ((code % 31) - 15) / 15;
  }
  for (const token of words(normalized)) {
    const hash = parseInt(stableHash(token), 16);
    for (let i = 0; i < VECTOR_DIM; i += 1) {
      vec[i] += (((hash >> ((i % 8) * 4)) & 0xf) / 15) * (i % 2 === 0 ? 1 : -1);
    }
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vec.map((value) => value / norm);
}

function cosine(left: number[], right: number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const ln = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1;
  const rn = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1;
  return clamp((dot / (ln * rn) + 1) / 2);
}

function propositionText(result: SearchResult): string[] {
  if (result.claims?.length) return result.claims;
  return result.snippet.split(/[.!?]\s+/).map((part) => part.trim()).filter((part) => part.length > 18).slice(0, 3);
}

function polarity(text: string): 'affirmed' | 'negated' | 'conditional' {
  const lower = text.toLowerCase();
  if (/\b(if|when|unless|should|could|would|might|may)\b/.test(lower)) return 'conditional';
  if (/\b(not|never|no longer|cannot|can't|won't|doesn't|does not|without)\b/.test(lower)) return 'negated';
  return 'affirmed';
}

function splitProposition(text: string): { subject: string; predicate: string; object: string; vector: number[] } {
  const normalized = text.trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  return {
    subject: parts.slice(0, Math.max(1, Math.min(3, Math.floor(parts.length / 3)))).join(' '),
    predicate: parts.slice(Math.max(1, Math.min(3, Math.floor(parts.length / 3))), Math.max(2, Math.min(6, Math.floor(parts.length / 2)))).join(' ') || 'relates-to',
    object: parts.slice(Math.max(2, Math.min(6, Math.floor(parts.length / 2)))).join(' '),
    vector: textVector(normalized),
  };
}

function propositionSignature(text: string): string {
  return stableHash(splitProposition(text).vector.map((value) => value.toFixed(3)).join('|'));
}

function parseProposition(text: string, sourceId: string, confidence: number): Proposition {
  const parsed = splitProposition(text);
  return {
    id: `prop-${propositionSignature(text)}`,
    text,
    subject: parsed.subject,
    predicate: parsed.predicate,
    object: parsed.object,
    polarity: polarity(text),
    confidence: clamp(confidence),
    support: clamp(confidence),
    contradiction: 0,
    sources: [sourceId],
  };
}

function propositionSimilarity(left: Proposition, right: Proposition): number {
  const leftVector = textVector(left.text);
  const rightVector = textVector(right.text);
  const structural = cosine(leftVector, rightVector);
  const polarityPenalty = left.polarity !== right.polarity ? 0.16 : 0;
  return clamp(structural - polarityPenalty);
}

function graphConsistency(proposition: Proposition, graph: PropositionGraph | undefined): number {
  if (!graph?.propositions?.length) return 0.5;
  const vector = textVector(proposition.text);
  const relevant = graph.propositions.slice(-12).map((candidate) => {
    const similarity = cosine(vector, textVector(candidate.text));
    const polarityPenalty = candidate.polarity !== proposition.polarity ? 0.18 : 0;
    const edgePenalty = graph.edges.some((edge) => edge.relation === 'contradicts' && ((edge.from === candidate.id && edge.to === proposition.id) || (edge.to === candidate.id && edge.from === proposition.id))) ? 0.24 : 0;
    return clamp(similarity - polarityPenalty - edgePenalty);
  });
  return average(relevant.length ? relevant : [0.5]);
}

function assessAgainstGraph(premise: Proposition, hypothesis: Proposition, graph?: PropositionGraph): ClaimAssessment {
  const similarity = propositionSimilarity(premise, hypothesis);
  const graphSupport = graphConsistency(hypothesis, graph);
  const premiseSupport = graphConsistency(premise, graph);
  const numericConflict = /\b\d+\b/.test(premise.text) && /\b\d+\b/.test(hypothesis.text) && premise.text !== hypothesis.text ? 0.18 : 0;
  const entailment = clamp(similarity * 0.38 + graphSupport * 0.33 + premiseSupport * 0.18 + (hypothesis.text.length <= premise.text.length ? 0.05 : 0));
  const contradiction = clamp((1 - similarity) * 0.16 + (1 - graphSupport) * 0.14 + numericConflict + (premise.polarity !== hypothesis.polarity ? 0.22 : 0));
  if (contradiction > entailment && contradiction >= 0.5) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'contradicts',
      confidence: clamp(0.42 + contradiction * 0.5),
      rationale: 'semantic model places the claims in incompatible regions of the evidence graph',
    };
  }
  if (entailment >= 0.56) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'entails',
      confidence: clamp(0.38 + entailment * 0.56),
      rationale: 'semantic model finds the hypothesis preserved by graph context and proposition structure',
    };
  }
  return {
    premise: premise.text,
    hypothesis: hypothesis.text,
    relation: 'unknown',
    confidence: clamp(0.2 + similarity * 0.32 + graphSupport * 0.12),
    rationale: 'graph-conditioned semantic similarity is insufficient to decide entailment or contradiction',
  };
}

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const seeds = [
    intent.semanticQuery,
    ...intent.querySeeds,
    ...intent.entities.map((entity) => `${entity} ${intent.topics[0] ?? ''}`.trim()),
    ...(intent.sourceHints.includes('github') ? intent.entities.map((entity) => `repo:${entity}`) : []),
    ...(intent.sourceHints.includes('scholar') ? intent.entities.map((entity) => `${entity} citation evidence`) : []),
  ];
  if (strategy.id === 'multi-hop' && intent.entities.length > 0) seeds.push(`${intent.entities[0]} ${intent.topics[0] ?? intent.objective} evidence`);
  return [...new Set(seeds.filter(Boolean))].slice(0, 6);
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const hopPlan = [intent.semanticQuery];
  for (const result of results.slice(0, Math.max(1, intent.hopBudget - 1))) {
    const extracted = propositionText(result).join(' ').split(/\s+/).slice(0, 8).join(' ');
    const sourceHint = result.source === 'github' ? 'repository evidence' : result.source === 'scholar' ? 'citation trail' : result.source === 'realtime-web' ? 'fresh source' : 'supporting source';
    hopPlan.push(`${extracted} ${sourceHint}`.trim());
  }
  if (strategy.id === 'multi-hop' && intent.entities.length > 1) hopPlan.push(`${intent.entities.slice(0, 2).join(' ')} cross-source synthesis`);
  return [...new Set(hopPlan)].slice(0, Math.max(2, intent.hopBudget + 1));
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability = {}, policy: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const trusted = scoreEvidenceTrust(intent, results, reliability, policy, policyState);
  const nodes: SearchEvidenceNode[] = [];
  const edges: SearchEvidenceEdge[] = [];
  const propositionMap = new Map<string, { proposition: Proposition; support: TrustedEvidence[]; contradiction: TrustedEvidence[]; assessments: ClaimAssessment[] }>();

  const queryIds = queries.map((query, index) => {
    const id = `query-${index}-${stableHash(query)}`;
    nodes.push({ id, label: query, type: 'query', weight: 1, metadata: { query, intent: intent.sessionKey } });
    return id;
  });

  for (const [index, result] of trusted.entries()) {
    const resultId = `result-${index}-${stableHash(result.url || result.title)}`;
    nodes.push({ id: resultId, label: result.title, type: 'result', weight: result.trustScore, metadata: { url: result.url, source: result.source, snippet: result.snippet, trust: result.trustScore, breakdown: result.trustBreakdown } });
    for (const queryId of queryIds) edges.push({ from: queryId, to: resultId, relation: 'supports', weight: clamp(0.32 + strategy.semanticBias * 0.12 + result.trustScore * 0.2) });
    const sourceId = result.provenance.domain || String(result.source);
    for (const text of propositionText(result)) {
      const proposition = parseProposition(text, sourceId, result.trustScore);
      if (!nodes.some((node) => node.id === proposition.id)) nodes.push({ id: proposition.id, label: proposition.text, type: 'claim', weight: proposition.confidence, metadata: proposition });
      edges.push({ from: resultId, to: proposition.id, relation: 'claims', weight: result.trustScore });
      const signature = propositionSignature(proposition.text);
      const entry = propositionMap.get(signature) ?? { proposition, support: [], contradiction: [], assessments: [] };
      entry.proposition.support += result.trustScore;
      entry.proposition.sources = [...new Set([...entry.proposition.sources, sourceId])];
      entry.support.push(result);
      propositionMap.set(signature, entry);
    }
  }

  const propositions: Proposition[] = [...propositionMap.values()].map((entry) => ({
    ...entry.proposition,
    confidence: clamp(entry.proposition.confidence + entry.proposition.support * 0.08),
    support: clamp(entry.support.length / Math.max(1, trusted.length)),
    contradiction: clamp(entry.contradiction.length / Math.max(1, trusted.length)),
  }));

  const claims: VerifiedClaim[] = [];
  const conflicts: EvidenceConflict[] = [];
  const propositionEdges: SearchEvidenceEdge[] = [];

  for (let i = 0; i < propositions.length; i += 1) {
    const left = propositions[i];
    const leftEntry = propositionMap.get(propositionSignature(left.text));
    if (!leftEntry) continue;
    for (let j = 0; j < propositions.length; j += 1) {
      if (i === j) continue;
      const right = propositions[j];
      const assessment = assessAgainstGraph(left, right, { propositions, edges: propositionEdges, summary: '', confidence: 0 });
      leftEntry.assessments.push(assessment);
      if (assessment.relation === 'contradicts') {
        leftEntry.contradiction.push(...(propositionMap.get(propositionSignature(right.text))?.support ?? []));
        propositionEdges.push({ from: left.id, to: right.id, relation: 'contradicts', weight: assessment.confidence });
      } else if (assessment.relation === 'entails') {
        propositionEdges.push({ from: left.id, to: right.id, relation: 'entails', weight: assessment.confidence });
      } else if (propositionSimilarity(left, right) > 0.45) {
        propositionEdges.push({ from: left.id, to: right.id, relation: 'refines', weight: assessment.confidence });
      }
    }
    const supportIds = [...new Set(leftEntry.support.map((item) => item.url || item.title))];
    const contradictionIds = [...new Set(leftEntry.contradiction.map((item) => item.url || item.title))];
    const support = average(leftEntry.support.map((item) => item.trustScore));
    const contradiction = average(leftEntry.contradiction.map((item) => item.trustScore));
    const independentSupport = new Set(leftEntry.support.map((item) => item.provenance.domain || item.source)).size;
    const corroborationMet = !policy.requireCorroboration || independentSupport >= 2;
    const confidence = clamp(support * 0.82 - contradiction * 0.46 + Math.min(0.16, leftEntry.support.length * 0.04) - (corroborationMet ? 0 : 0.18));
    const verdict: VerifiedClaim['verdict'] = contradictionIds.length > 0 && contradiction > support * 0.65 ? 'contested' : supportIds.length > 0 && corroborationMet ? 'supported' : 'unsupported';
    claims.push({ id: left.id, text: left.text, confidence, supportedBy: supportIds, contradictedBy: contradictionIds, verdict, assessments: leftEntry.assessments });
    if (contradictionIds.length > 0) {
      conflicts.push({ claim: left.text, supporting: supportIds, contradicting: contradictionIds, resolution: support >= contradiction ? 'prefer higher-trust corroborated support' : 'prefer higher-trust contradiction', confidence: clamp(Math.abs(support - contradiction)) });
      nodes.push({ id: `conflict-${stableHash(left.text)}`, label: left.text, type: 'conflict', weight: clamp(Math.abs(support - contradiction)), metadata: { support, contradiction } });
      edges.push({ from: left.id, to: `conflict-${stableHash(left.text)}`, relation: verdict === 'contested' ? 'contradicts' : 'supports', weight: confidence });
    }
  }

  const entities = canonicalizeEntities(intent, trusted);
  const communities = detectEvidenceCommunities(entities, claims, trusted);
  addKnowledgeGraphNodes(nodes, edges, entities, communities);
  edges.push(...propositionEdges);
  const exploration = chainOfExploration(intent, entities, claims, communities, nodes, edges);
  const synthesis = synthesizeEvidence(claims, conflicts, exploration);
  const propositionGraph: PropositionGraph = {
    propositions,
    edges: propositionEdges,
    summary: `${propositions.length} propositions, ${propositionEdges.filter((edge) => edge.relation === 'entails').length} entailments, ${propositionEdges.filter((edge) => edge.relation === 'contradicts').length} contradictions`,
    confidence: clamp(average(propositions.map((proposition) => proposition.confidence)) * 0.45 + synthesis.confidence * 0.55),
  };
  const confidence = clamp(synthesis.confidence * 0.42 + average(claims.map((claim) => claim.confidence)) * 0.28 + average(trusted.map((item) => item.trustScore)) * 0.18 + Math.min(1, queries.length / 5) * 0.08 - conflicts.length * 0.04);
  return { nodes, edges, queries, entities, communities, exploration, claims, propositions, propositionGraph, conflicts, synthesis: { ...synthesis, confidence }, summary: `${queries.length} query seeds, ${results.length} results, ${claims.length} claims, propositions=${propositions.length}, communities=${communities.length}, conflicts=${conflicts.length}, stance=${synthesis.stance}, strategy=${strategy.name}`, confidence };
}
