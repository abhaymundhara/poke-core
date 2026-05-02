import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { average, clamp, stableHash, uniq, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';
import { addKnowledgeGraphNodes, canonicalizeEntities, chainOfExploration, detectEvidenceCommunities, synthesizeEvidence } from './knowledge-graph.ts';

type NumericFact = {
  value: number;
  raw: string;
  unit: string | null;
};

type SemanticPropositionShape = {
  subject: string;
  predicate: string;
  object: string;
  polarity: 'affirmed' | 'negated' | 'conditional';
  modality: 'asserted' | 'possible' | 'required' | 'temporal' | 'comparative';
  qualifiers: string[];
  numericFacts: NumericFact[];
  entities: string[];
};

const PROPOSITION_PREDICATES = /\b(is|are|was|were|has|have|can|cannot|should|will|supports|contradicts|entails|causes|requires|uses|drives|predicts|means|indicates|suggests|shows|proves|explains|enables|prevents|changes|matches|implies|refutes|confirms|verifies|identifies|detects|needs|wants|prefers|contains|includes|reduces|increases|improves|degrades|matches|equals|differs|returns|produces)\b/;

function splitFragments(text: string): string[] {
  return text.split(/[.!?;:\n]+/g).map((part) => part.trim()).filter(Boolean);
}

function claimTexts(result: SearchResult): string[] {
  if (result.claims?.length) return result.claims;
  return splitFragments(result.snippet).filter((part) => part.length > 18).slice(0, 4);
}

function normalizeClauseText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.%:/\-+\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractNumericFacts(text: string): NumericFact[] {
  const facts: NumericFact[] = [];
  const matches = [...text.matchAll(/(?<![a-z0-9])(-?\d+(?:\.\d+)?)(%|ms|s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hour|hours|gb|mb|tb|k|m|b|x)?\b/gi)];
  for (const match of matches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    facts.push({ value, raw: match[0], unit: match[2] ? match[2].toLowerCase() : null });
  }
  return facts;
}

function extractEntities(text: string): string[] {
  const candidates = text.match(/(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+|[A-Z]{2,}(?:-[A-Z0-9]+)?|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/\S+|\b[a-z0-9_.-]+\/[a-z0-9_.-]+\b)/gi) ?? [];
  return uniq(candidates.map((value) => value.replace(/[),.;]+$/g, ''))).slice(0, 12);
}

function detectPolarity(text: string): 'affirmed' | 'negated' | 'conditional' {
  if (/(?:\bnot\b|\bnever\b|\bno\b|\bwithout\b|\bfalse\b|\binvalid\b|\bdeny\b|\bdenies\b|\bdoesn't\b|\bwon't\b|\bcan't\b)/i.test(text)) return 'negated';
  if (/(?:\bif\b|\bwhen\b|\bmay\b|\bmight\b|\bcould\b|\bpossibly\b|\bpotentially\b|\bcontingent\b|\bhypothetical\b)/i.test(text)) return 'conditional';
  return 'affirmed';
}

function detectModality(text: string): SemanticPropositionShape['modality'] {
  if (/(?:\bmust\b|\bshould\b|\brequired\b|\bneed to\b|\bneeds to\b|\bshall\b)/i.test(text)) return 'required';
  if (/(?:\bwill\b|\bwould\b|\bcan\b|\bmay\b|\bmight\b|\bcould\b|\bpossibly\b|\bpotentially\b)/i.test(text)) return 'possible';
  if (/(?:\bbefore\b|\bafter\b|\btoday\b|\btomorrow\b|\bnow\b|\brecently\b|\blatest\b|\bcurrent\b)/i.test(text)) return 'temporal';
  if (/(?:\bmore\b|\bless\b|\bhigher\b|\blower\b|\bincrease\b|\bdecrease\b|\bbetter\b|\bworse\b|\bvs\b|\bthan\b)/i.test(text)) return 'comparative';
  return 'asserted';
}

function clauseSubject(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const cut = Math.max(1, Math.min(4, Math.ceil(tokens.length / 3)));
  return tokens.slice(0, cut).join(' ');
}

function clausePredicate(tokens: string[]): string {
  if (tokens.length === 0) return 'states';
  const matchIndex = tokens.findIndex((token) => PROPOSITION_PREDICATES.test(token));
  if (matchIndex >= 0) return tokens.slice(matchIndex, Math.min(tokens.length, matchIndex + 3)).join(' ');
  const start = Math.max(1, Math.floor(tokens.length / 3));
  const end = Math.max(start + 1, Math.floor((tokens.length * 2) / 3));
  return tokens.slice(start, end).join(' ') || 'states';
}

function clauseObject(tokens: string[]): string {
  if (tokens.length === 0) return '';
  return tokens.slice(Math.max(1, Math.floor((tokens.length * 2) / 3))).join(' ');
}

function parseProposition(text: string, sourceId: string, confidence: number): Proposition {
  const normalized = normalizeClauseText(text);
  const tokens = words(normalized).filter((token) => token.length > 1);
  const subject = clauseSubject(tokens);
  const predicate = clausePredicate(tokens);
  const object = clauseObject(tokens);
  return {
    id: `prop-${stableHash(`${subject}|${predicate}|${object}|${sourceId}`)}`,
    text: text.trim(),
    subject,
    predicate,
    object,
    polarity: detectPolarity(text),
    confidence: clamp(confidence),
    support: clamp(confidence),
    contradiction: 0,
    sources: [sourceId],
  };
}

function propositionSignature(proposition: Proposition): string {
  const facts = extractNumericFacts(proposition.text).map((fact) => `${fact.value}:${fact.unit ?? ''}`).join(',');
  return stableHash([proposition.subject, proposition.predicate, proposition.object, proposition.polarity, facts].join('|'));
}

function propositionShape(text: string): SemanticPropositionShape {
  const normalized = normalizeClauseText(text);
  const tokens = words(normalized).filter((token) => token.length > 1);
  return {
    subject: clauseSubject(tokens),
    predicate: clausePredicate(tokens),
    object: clauseObject(tokens),
    polarity: detectPolarity(text),
    modality: detectModality(text),
    qualifiers: uniq(tokens.filter((token) => /^(not|never|only|always|often|sometimes|likely|unlikely|must|should|will|would|could|may|might|before|after|more|less|higher|lower|increase|decrease|better|worse|than|vs|via|for|of|to)$/.test(token))),
    numericFacts: extractNumericFacts(text),
    entities: extractEntities(text),
  };
}

function headMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = left.split(' ');
  const rightTokens = right.split(' ');
  return leftTokens.some((token) => rightTokens.includes(token)) || left.includes(right) || right.includes(left);
}

function numericContradiction(left: SemanticPropositionShape, right: SemanticPropositionShape): number {
  if (left.numericFacts.length === 0 || right.numericFacts.length === 0) return 0;
  const sharedUnits = left.numericFacts.flatMap((l) => right.numericFacts.filter((r) => l.unit === r.unit && l.unit !== null).map((r) => ({ l, r })));
  if (sharedUnits.length === 0) return 0;
  const mismatch = sharedUnits.some(({ l, r }) => Math.abs(l.value - r.value) > Math.max(1, Math.abs(l.value) * 0.05));
  return mismatch ? 0.26 : 0;
}

function semanticFeatures(left: SemanticPropositionShape, right: SemanticPropositionShape) {
  const subjectAgreement = headMatch(left.subject, right.subject) ? 1 : 0;
  const predicateAgreement = headMatch(left.predicate, right.predicate) ? 1 : 0;
  const objectCoverage = right.object && (left.object.includes(right.object) || right.object.includes(left.object)) ? 1 : 0;
  const entityOverlap = right.entities.length === 0 ? 0 : right.entities.filter((entity) => left.entities.some((candidate) => headMatch(candidate, entity))).length / right.entities.length;
  const qualifierOverlap = right.qualifiers.length === 0 ? 0 : right.qualifiers.filter((qualifier) => left.qualifiers.includes(qualifier)).length / right.qualifiers.length;
  const polarityCompatibility = left.polarity === right.polarity ? 1 : left.polarity === 'conditional' || right.polarity === 'conditional' ? 0.46 : 0;
  const modalityCompatibility = left.modality === right.modality ? 1 : left.modality === 'asserted' && right.modality !== 'required' ? 0.68 : 0.38;
  const numericConflict = numericContradiction(left, right);
  const directionalWords = /(increase|more|higher|up|faster|better|expand|grow|improve)/i.test(left.object) && /(decrease|less|lower|down|slower|worse|shrink|decline|degrade)/i.test(right.object) ? 1 : 0;
  return {
    subjectAgreement,
    predicateAgreement,
    objectCoverage,
    entityOverlap,
    qualifierOverlap,
    polarityCompatibility,
    modalityCompatibility,
    numericConflict,
    directionalWords,
  };
}

function neuralEntailment(left: SemanticPropositionShape, right: SemanticPropositionShape): number {
  const features = semanticFeatures(left, right);
  const projection = features.subjectAgreement * 0.28 + features.predicateAgreement * 0.22 + features.objectCoverage * 0.14 + features.entityOverlap * 0.1 + features.qualifierOverlap * 0.08 + features.polarityCompatibility * 0.1 + features.modalityCompatibility * 0.06;
  const numericPenalty = features.numericConflict > 0 ? 0.12 : 0;
  const specificity = left.object.length >= right.object.length ? 0.1 : 0.04;
  return clamp(projection + specificity - numericPenalty);
}

function neuralContradiction(left: SemanticPropositionShape, right: SemanticPropositionShape): number {
  const features = semanticFeatures(left, right);
  const polarityPressure = features.polarityCompatibility < 1 ? 0.24 : 0;
  const modalityPressure = left.modality === 'required' && right.modality === 'possible' || left.modality === 'possible' && right.modality === 'required' ? 0.16 : 0;
  const directNegation = features.subjectAgreement > 0 && features.predicateAgreement > 0 && left.polarity !== right.polarity ? 0.28 : 0;
  const objectConflict = features.objectCoverage === 0 && features.directionalWords ? 0.2 : 0;
  return clamp(features.subjectAgreement * 0.18 + features.predicateAgreement * 0.16 + polarityPressure + modalityPressure + directNegation + objectConflict + features.numericConflict);
}

function graphNeighborhoodSupport(graph: SearchEvidenceGraph, proposition: Proposition): number {
  const edges = [...graph.edges, ...(graph.propositionGraph?.edges ?? [])].filter((edge) => edge.from === proposition.id || edge.to === proposition.id);
  if (edges.length === 0) return 0.5;
  const support = edges.reduce((sum, edge) => sum + (edge.relation === 'supports' || edge.relation === 'entails' || edge.relation === 'corroborates' ? edge.weight : -edge.weight * 0.6), 0);
  return clamp(0.5 + support / Math.max(3, edges.length * 2));
}

function propositionEntails(left: Proposition, right: Proposition, _graph?: SearchEvidenceGraph): number {
  const leftShape = propositionShape(left.text);
  const rightShape = propositionShape(right.text);
  const semanticFit = neuralEntailment(leftShape, rightShape);
  const qualifierFit = rightShape.qualifiers.every((qualifier) => leftShape.qualifiers.includes(qualifier) || left.text.toLowerCase().includes(qualifier)) ? 0.12 : 0.04;
  const modalityFit = leftShape.modality === rightShape.modality ? 0.16 : leftShape.modality === 'asserted' ? 0.1 : 0.05;
  const numericAgreement = numericContradiction(leftShape, rightShape) > 0 ? -0.18 : 0.08;
  return clamp(semanticFit * 0.62 + qualifierFit + modalityFit + numericAgreement);
}

function propositionContradicts(left: Proposition, right: Proposition, _graph?: SearchEvidenceGraph): number {
  const leftShape = propositionShape(left.text);
  const rightShape = propositionShape(right.text);
  const semanticConflict = neuralContradiction(leftShape, rightShape);
  const polarityPressure = leftShape.polarity !== rightShape.polarity ? 0.24 : 0.04;
  const modalityPressure = leftShape.modality === 'required' && rightShape.modality !== 'required' || rightShape.modality === 'required' && leftShape.modality !== 'required' ? 0.16 : 0.05;
  const numericConflict = numericContradiction(leftShape, rightShape);
  return clamp(semanticConflict * 0.72 + polarityPressure + modalityPressure + numericConflict);
}

function assessClaim(premise: Proposition, hypothesis: Proposition, _graph?: SearchEvidenceGraph): ClaimAssessment {
  const contradiction = propositionContradicts(premise, hypothesis);
  const entailment = propositionEntails(premise, hypothesis);
  const consistency = clamp(1 - contradiction * 0.72 + entailment * 0.18);
  if (contradiction >= Math.max(0.5, entailment + 0.06)) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'contradicts',
      confidence: clamp(0.42 + contradiction * 0.5 + (1 - consistency) * 0.08),
      rationale: 'the proposition comparison detects incompatible polarity, modality, or quantitative content',
    };
  }
  if (entailment >= Math.max(0.48, contradiction + 0.08) && consistency >= 0.46) {
    return {
      premise: premise.text,
      hypothesis: hypothesis.text,
      relation: 'entails',
      confidence: clamp(0.38 + entailment * 0.52 + consistency * 0.1),
      rationale: 'the structured proposition representation supports a stable entailment path through compatible claims',
    };
  }
  return {
    premise: premise.text,
    hypothesis: hypothesis.text,
    relation: 'unknown',
    confidence: clamp(0.24 + entailment * 0.36 + (1 - contradiction) * 0.2),
    rationale: 'the proposition engine cannot establish a definitive entailment or contradiction from the current semantic evidence',
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
    const extracted = claimTexts(result).join(' ').split(/\s+/).slice(0, 10).join(' ');
    const sourceHint = result.source === 'github' ? 'repository evidence' : result.source === 'scholar' ? 'citation trail' : result.source === 'realtime-web' ? 'fresh source' : 'supporting source';
    hopPlan.push(`${extracted} ${sourceHint}`.trim());
  }
  if (strategy.id === 'multi-hop' && intent.entities.length > 1) hopPlan.push(`${intent.entities.slice(0, 2).join(' ')} cross-source synthesis`);
  return [...new Set(hopPlan)].slice(0, Math.max(2, intent.hopBudget + 1));
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability: Record<string, any> = {}, policy: PolicyDecision = { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] }, policyState?: SearchPolicyState): SearchEvidenceGraph {
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
    for (const queryId of queryIds) edges.push({ from: queryId, to: resultId, relation: 'supports', weight: clamp(0.26 + strategy.semanticBias * 0.12 + result.trustScore * 0.22) });
    const sourceId = result.provenance.domain || String(result.source);
    for (const text of claimTexts(result)) {
      const proposition = parseProposition(text, sourceId, result.trustScore);
      if (!nodes.some((node) => node.id === proposition.id)) {
        nodes.push({ id: proposition.id, label: proposition.text, type: 'claim', weight: proposition.confidence, metadata: proposition });
      }
      edges.push({ from: resultId, to: proposition.id, relation: 'claims', weight: result.trustScore });
      const signature = propositionSignature(proposition);
      const entry = propositionMap.get(signature) ?? { proposition, support: [], contradiction: [], assessments: [] };
      entry.proposition.support = clamp(entry.proposition.support + result.trustScore * 0.1);
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
  const graphView: SearchEvidenceGraph = { nodes, edges: [...edges], queries, entities: [], communities: [], exploration: [], claims: [], propositions, propositionGraph: { propositions, edges: [], summary: '', confidence: 0 }, conflicts: [], synthesis: { answerable: false, stance: 'insufficient', confidence: 0, primaryClaims: [], rejectedClaims: [], reasoningTrace: [] }, summary: '', confidence: 0 };

  for (let i = 0; i < propositions.length; i += 1) {
    const left = propositions[i];
    const leftEntry = propositionMap.get(propositionSignature(left));
    if (!leftEntry) continue;
    for (let j = 0; j < propositions.length; j += 1) {
      if (i === j) continue;
      const right = propositions[j];
      const assessment = assessClaim(left, right, graphView);
      leftEntry.assessments.push(assessment);
      if (assessment.relation === 'contradicts') {
        leftEntry.contradiction.push(...(propositionMap.get(propositionSignature(right))?.support ?? []));
        propositionEdges.push({ from: left.id, to: right.id, relation: 'contradicts', weight: assessment.confidence });
      } else if (assessment.relation === 'entails') {
        propositionEdges.push({ from: left.id, to: right.id, relation: 'entails', weight: assessment.confidence });
      } else if (headMatch(left.subject, right.subject) && headMatch(left.predicate, right.predicate)) {
        propositionEdges.push({ from: left.id, to: right.id, relation: 'refines', weight: assessment.confidence });
      }
    }
    const supportIds = [...new Set(leftEntry.support.map((item) => item.url || item.title))];
    const contradictionIds = [...new Set(leftEntry.contradiction.map((item) => item.url || item.title))];
    const support = average(leftEntry.support.map((item) => item.trustScore));
    const contradiction = average(leftEntry.contradiction.map((item) => item.trustScore));
    const independentSupport = new Set(leftEntry.support.map((item) => item.provenance.domain || item.source)).size;
    const corroborationMet = !policy.requireCorroboration || independentSupport >= 2;
    const confidence = clamp(support * 0.82 - contradiction * 0.48 + Math.min(0.16, leftEntry.support.length * 0.04) - (corroborationMet ? 0 : 0.16));
    const verdict: VerifiedClaim['verdict'] = contradictionIds.length > 0 && contradiction > support * 0.6 ? 'contested' : supportIds.length > 0 && corroborationMet ? 'supported' : 'unsupported';
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
