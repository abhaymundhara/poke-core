import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { average, clamp, stableHash, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';
import { addKnowledgeGraphNodes, canonicalizeEntities, chainOfExploration, detectEvidenceCommunities, synthesizeEvidence } from './knowledge-graph.ts';

const VECTOR_DIMENSIONS = 18;

function vectorize(text: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vector = new Array(dimensions).fill(0);
  const tokens = words(text.toLowerCase());
  if (tokens.length === 0) return vector;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const seed = `${token}:${tokenIndex % 11}:${dimensions}`;
    const hash = stableHash(seed);
    for (let i = 0; i < hash.length; i += 2) {
      const slice = hash.slice(i, i + 2);
      if (!slice) continue;
      const bucket = Number.parseInt(slice, 16) % dimensions;
      const weight = ((tokenIndex % 5) + 1) / (tokens.length + 2);
      vector[bucket] += weight;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = (Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1) * (Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1);
  if (denominator === 0) return 0;
  const numerator = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  return clamp((numerator / denominator + 1) / 2);
}

function claimTexts(result: SearchResult): string[] {
  if (result.claims?.length) return result.claims;
  return result.snippet.split(/[.!?]\s+/).map((part) => part.trim()).filter((part) => part.length > 18).slice(0, 3);
}

function fragments(text: string): string[] {
  return text.split(/[.!?;:\n]+/g).map((part) => part.trim()).filter(Boolean);
}

function propositionVector(text: string): number[] {
  return vectorize(text);
}

function semanticSlots(text: string): { subject: string; predicate: string; object: string } {
  const tokens = words(text.replace(/[()\[\]{}]/g, ' '));
  if (tokens.length === 0) return { subject: '', predicate: 'states', object: '' };
  const subject = tokens.slice(0, Math.min(3, Math.max(1, Math.floor(tokens.length / 3)))).join(' ');
  const predicate = tokens.slice(Math.min(tokens.length - 1, Math.max(1, Math.floor(tokens.length / 3))), Math.min(tokens.length, Math.max(2, Math.floor((tokens.length * 2) / 3)))).join(' ') || 'states';
  const object = tokens.slice(Math.max(1, Math.floor((tokens.length * 2) / 3))).join(' ');
  return { subject, predicate, object };
}

function clausePolarity(text: string): 'affirmed' | 'negated' | 'conditional' {
  const lower = text.toLowerCase();
  if (lower.includes(' if ') || lower.includes(' when ') || lower.includes(' unless ') || lower.includes(' should ') || lower.includes(' could ') || lower.includes(' would ') || lower.includes(' might ')) return 'conditional';
  if (lower.includes(' not ') || lower.includes("n't") || lower.includes(' no longer ') || lower.includes(' cannot ') || lower.includes("can't") || lower.includes("won't") || lower.includes(' without ')) return 'negated';
  return 'affirmed';
}

function propositionSignature(text: string): string {
  const { subject, predicate, object } = semanticSlots(text);
  return stableHash(`${subject}|${predicate}|${object}`);
}

function parseProposition(text: string, sourceId: string, confidence: number): Proposition {
  const { subject, predicate, object } = semanticSlots(text);
  return {
    id: `prop-${propositionSignature(text)}`,
    text,
    subject,
    predicate,
    object,
    polarity: clausePolarity(text),
    confidence: clamp(confidence),
    support: clamp(confidence),
    contradiction: 0,
    sources: [sourceId],
  };
}

function propositionSimilarity(left: Proposition, right: Proposition): number {
  const semantic = cosineSimilarity(propositionVector(`${left.text} ${left.subject} ${left.object}`), propositionVector(`${right.text} ${right.subject} ${right.object}`));
  const structure = cosineSimilarity(propositionVector(`${left.subject}|${left.predicate}`), propositionVector(`${right.subject}|${right.predicate}`));
  const polarityPenalty = left.polarity !== right.polarity ? 0.12 : 0;
  return clamp(semantic * 0.68 + structure * 0.32 - polarityPenalty);
}

function propositionEntails(left: Proposition, right: Proposition, graph: SearchEvidenceGraph): number {
  const similarity = propositionSimilarity(left, right);
  const leftVector = propositionVector(left.text);
  const rightVector = propositionVector(right.text);
  const graphAffinity = graph.nodes.filter((node) => node.type === 'claim' || node.type === 'result').reduce((sum, node) => {
    const nodeVector = propositionVector(`${node.label} ${JSON.stringify(node.metadata ?? {})}`);
    return sum + cosineSimilarity(leftVector, nodeVector) * 0.5 + cosineSimilarity(rightVector, nodeVector) * 0.5;
  }, 0) / Math.max(1, graph.nodes.length);
  const supportBias = graph.edges.filter((edge) => edge.relation === 'supports' || edge.relation === 'entails' || edge.relation === 'claims').length / Math.max(1, graph.edges.length);
  const refinement = left.object.length >= right.object.length ? 0.06 : 0;
  const polarityPenalty = left.polarity === 'negated' && right.polarity === 'affirmed' ? 0.28 : left.polarity !== right.polarity ? 0.16 : 0;
  return clamp(similarity * 0.42 + graphAffinity * 0.28 + supportBias * 0.22 + refinement - polarityPenalty);
}

function propositionContradicts(left: Proposition, right: Proposition, graph: SearchEvidenceGraph): number {
  const similarity = propositionSimilarity(left, right);
  const leftVector = propositionVector(left.text);
  const rightVector = propositionVector(right.text);
  const tensionEdges = graph.edges.filter((edge) => edge.relation === 'contradicts' || edge.relation === 'rebuts');
  const graphTension = tensionEdges.length === 0 ? 0 : tensionEdges.reduce((sum, edge) => {
    const fromNode = graph.nodes.find((node) => node.id === edge.from);
    const toNode = graph.nodes.find((node) => node.id === edge.to);
    if (!fromNode || !toNode) return sum;
    const fromVector = propositionVector(`${fromNode.label} ${JSON.stringify(fromNode.metadata ?? {})}`);
    const toVector = propositionVector(`${toNode.label} ${JSON.stringify(toNode.metadata ?? {})}`);
    return sum + Math.max(cosineSimilarity(leftVector, toVector), cosineSimilarity(rightVector, fromVector)) * edge.weight;
  }, 0) / tensionEdges.length;
  const numericalDivergence = /\d/.test(left.text) && /\d/.test(right.text) && left.text !== right.text ? 0.08 : 0;
  const polarityConflict = left.polarity !== right.polarity ? 0.24 : 0;
  return clamp(similarity * 0.34 + graphTension * 0.34 + numericalDivergence + polarityConflict);
}

function assessClaim(premise: Proposition, hypothesis: Proposition, graph: SearchEvidenceGraph): ClaimAssessment {
  const contradiction = propositionContradicts(premise, hypothesis, graph);
  if (contradiction >= 0.55) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'contradicts',
      confidence: clamp(0.42 + contradiction * 0.5),
      rationale: 'semantic proximity is high, but the proposition model and graph context indicate incompatible assertions',
    };
  }
  const entailment = propositionEntails(premise, hypothesis, graph);
  if (entailment >= 0.55) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'entails',
      confidence: clamp(0.38 + entailment * 0.54),
      rationale: 'the proposition embedding and graph neighborhood preserve the hypothesis under stronger evidence',
    };
  }
  return {
    premise: premise.text,
    hypothesis: hypothesis.text,
    relation: 'unknown',
    confidence: clamp(0.22 + propositionSimilarity(premise, hypothesis) * 0.34),
    rationale: 'the proposition model places the claims in the same semantic neighborhood, but graph support is not decisive',
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
    const extracted = claimTexts(result).join(' ').split(/\s+/).slice(0, 8).join(' ');
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
    for (const text of claimTexts(result)) {
      const proposition = parseProposition(text, sourceId, result.trustScore);
      if (!nodes.some((node) => node.id === proposition.id)) {
        nodes.push({ id: proposition.id, label: proposition.text, type: 'claim', weight: proposition.confidence, metadata: proposition });
      }
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
  const graphView: SearchEvidenceGraph = { nodes, edges, queries, entities: [], communities: [], exploration: [], claims: [], propositions, conflicts: [], synthesis: { answerable: false, stance: 'insufficient', confidence: 0, primaryClaims: [], rejectedClaims: [], reasoningTrace: [] }, summary: '', confidence: 0 };

  for (let i = 0; i < propositions.length; i += 1) {
    const left = propositions[i];
    const leftEntry = propositionMap.get(propositionSignature(left.text));
    if (!leftEntry) continue;
    for (let j = 0; j < propositions.length; j += 1) {
      if (i === j) continue;
      const right = propositions[j];
      const assessment = assessClaim(left, right, graphView);
      leftEntry.assessments.push(assessment);
      if (assessment.relation === 'contradicts') {
        leftEntry.contradiction.push(...(propositionMap.get(propositionSignature(right.text))?.support ?? []));
        propositionEdges.push({ from: left.id, to: right.id, relation: 'contradicts', weight: assessment.confidence });
      } else if (assessment.relation === 'entails') {
        propositionEdges.push({ from: left.id, to: right.id, relation: 'entails', weight: assessment.confidence });
      } else if (propositionSimilarity(left, right) > 0.42) {
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
