import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { average, clamp, stableHash, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';
import { addKnowledgeGraphNodes, canonicalizeEntities, chainOfExploration, detectEvidenceCommunities, synthesizeEvidence } from './knowledge-graph.ts';

function claimTexts(result: SearchResult): string[] {
  if (result.claims?.length) return result.claims;
  return result.snippet.split(/[.!?]\s+/).map((part) => part.trim()).filter((part) => part.length > 18).slice(0, 3);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@._:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(words(normalizeText(text)));
}

function tokenSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  const shared = [...a].filter((token) => b.has(token)).length;
  const coverage = shared / Math.max(1, Math.min(a.size, b.size));
  const jaccard = shared / Math.max(1, a.size + b.size - shared);
  return clamp(coverage * 0.65 + jaccard * 0.35);
}

function clausePolarity(text: string): 'affirmed' | 'negated' | 'conditional' {
  if (/\b(if|when|unless|should|could|would|might|may)\b/i.test(text)) return 'conditional';
  if (/\b(not|never|no longer|cannot|can't|won't|doesn't|does not|fails to|without)\b/i.test(text)) return 'negated';
  return 'affirmed';
}

function splitSubjectPredicateObject(text: string): { subject: string; predicate: string; object: string } {
  const normalized = normalizeText(text);
  const predicateMatch = normalized.match(/\b(is|are|was|were|has|have|can|cannot|should|will|supports|contradicts|entails|causes|requires|uses|drives|predicts|means|indicates|suggests|shows|proves|explains|enables|prevents|changes|matches|implies|refutes|confirms|verifies|identifies|detects|needs|wants|prefers|contains|includes)\b/);
  if (!predicateMatch) {
    const tokens = normalized.split(' ').filter(Boolean);
    return {
      subject: tokens.slice(0, 3).join(' '),
      predicate: tokens.slice(3, 6).join(' ') || 'states',
      object: tokens.slice(6).join(' '),
    };
  }
  const index = normalized.indexOf(predicateMatch[0]);
  const subject = normalized.slice(0, index).trim() || normalized.split(' ').slice(0, 3).join(' ');
  const tail = normalized.slice(index + predicateMatch[0].length).trim();
  const object = tail.replace(/^to\s+/, '').trim();
  return { subject, predicate: predicateMatch[0], object };
}

function propositionSignature(text: string): string {
  const { subject, predicate, object } = splitSubjectPredicateObject(text);
  return stableHash(`${subject}|${predicate}|${object}`);
}

function parseProposition(text: string, sourceId: string, confidence: number): Proposition {
  const { subject, predicate, object } = splitSubjectPredicateObject(text);
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
  const subjectSimilarity = tokenSimilarity(left.subject, right.subject);
  const predicateSimilarity = tokenSimilarity(left.predicate, right.predicate);
  const objectSimilarity = tokenSimilarity(left.object, right.object);
  const polarityPenalty = left.polarity !== right.polarity ? 0.18 : 0;
  return clamp(subjectSimilarity * 0.34 + predicateSimilarity * 0.38 + objectSimilarity * 0.28 - polarityPenalty);
}

function propositionEntails(left: Proposition, right: Proposition): number {
  const similarity = propositionSimilarity(left, right);
  const sameSubject = tokenSimilarity(left.subject, right.subject);
  const samePredicate = tokenSimilarity(left.predicate, right.predicate);
  const leftTokens = tokenSet(left.object);
  const rightTokens = tokenSet(right.object);
  const coverage = [...rightTokens].filter((token) => leftTokens.has(token)).length / Math.max(1, rightTokens.size);
  const refinement = left.object.length >= right.object.length ? 0.08 : 0;
  const polarityPenalty = left.polarity === 'negated' && right.polarity === 'affirmed' ? 0.42 : left.polarity !== right.polarity ? 0.26 : 0;
  return clamp(similarity * 0.3 + sameSubject * 0.26 + samePredicate * 0.26 + coverage * 0.22 + refinement - polarityPenalty);
}

function propositionContradicts(left: Proposition, right: Proposition): number {
  const similarity = propositionSimilarity(left, right);
  const sameSubject = tokenSimilarity(left.subject, right.subject);
  const samePredicate = tokenSimilarity(left.predicate, right.predicate);
  const numberConflict = /\b\d+\b/.test(left.object) && /\b\d+\b/.test(right.object) && left.object !== right.object ? 0.22 : 0;
  const polarityConflict = left.polarity !== right.polarity ? 0.35 : 0;
  const antonymic = /(increase|more|higher|up|faster|better)/i.test(left.object) && /(decrease|less|lower|down|slower|worse)/i.test(right.object) ? 0.2 : 0;
  return clamp(similarity * 0.24 + sameSubject * 0.28 + samePredicate * 0.28 + numberConflict + polarityConflict + antonymic);
}

function assessClaim(premise: Proposition, hypothesis: Proposition): ClaimAssessment {
  const contradiction = propositionContradicts(premise, hypothesis);
  if (contradiction >= 0.55) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'contradicts',
      confidence: clamp(0.42 + contradiction * 0.5),
      rationale: 'propositions share subject and predicate structure but diverge in polarity, quantity, or direction',
    };
  }
  const entailment = propositionEntails(premise, hypothesis);
  if (entailment >= 0.55) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'entails',
      confidence: clamp(0.38 + entailment * 0.54),
      rationale: 'propositions align semantically and the premise preserves the hypothesis conditions',
    };
  }
  return {
    premise: premise.text,
    hypothesis: hypothesis.text,
    relation: 'unknown',
    confidence: clamp(0.2 + propositionSimilarity(premise, hypothesis) * 0.35),
    rationale: 'propositions are related but neither entailment nor contradiction is decisive',
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

  for (let i = 0; i < propositions.length; i += 1) {
    const left = propositions[i];
    const leftEntry = propositionMap.get(propositionSignature(left.text));
    if (!leftEntry) continue;
    for (let j = 0; j < propositions.length; j += 1) {
      if (i === j) continue;
      const right = propositions[j];
      const assessment = assessClaim(left, right);
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
