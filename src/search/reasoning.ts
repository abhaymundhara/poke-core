import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionEdge, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim, CanonicalEntity, EvidenceCommunity, ExplorationStep, EvidenceSynthesis } from './types.ts';
import { clamp, stableHash, uniq, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@._:-]+/g, ' ').replace(/s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])s+|
+/).map((part) => part.trim()).filter((part) => part.length > 12).slice(0, 4);
}

function claimTextsFromResult(result: SearchResult): string[] {
  if (result.claims && result.claims.length > 0) return result.claims.map((claim) => claim.trim()).filter(Boolean);
  const sentenceClaims = splitSentences(result.snippet);
  if (sentenceClaims.length > 0) return sentenceClaims;
  return [result.title.trim()].filter(Boolean);
}

function subjectPredicateObject(text: string): { subject: string; predicate: string; object: string; polarity: 'affirmed' | 'negated' | 'conditional'; modality: 'asserted' | 'possible' | 'required' | 'temporal' | 'comparative'; qualifiers: string[] } {
  const normalized = normalizeText(text);
  const predicateMatch = normalized.match(/^(.*?)( is | are | was | were | has | have | can | could | should | would | must | may | might | means | implies | indicates | shows | supports | proves | contradicts | equals | equals to | relates to )(.*)$/i);
  let subject = text.trim();
  let predicate = 'relates-to';
  let object = normalized;
  if (predicateMatch) {
    subject = predicateMatch[1].trim() || text.trim();
    predicate = predicateMatch[2].trim();
    object = predicateMatch[3].trim();
  } else {
    const parts = normalized.split(' ');
    subject = parts.slice(0, Math.max(1, Math.min(4, parts.length - 1))).join(' ');
    object = parts.slice(Math.max(1, Math.min(4, parts.length - 1))).join(' ');
  }
  const qualifiers: string[] = [];
  if (/(not|never|no|without|lacks|missing)/i.test(text)) qualifiers.push('negated');
  if (/(may|might|could|possible|possibly|uncertain)/i.test(text)) qualifiers.push('possible');
  if (/(required|must|needs to|necessary)/i.test(text)) qualifiers.push('required');
  if (/(today|now|current|recent|latest|live|during|before|after)/i.test(text)) qualifiers.push('temporal');
  if (/(compare|versus|against|than|more|less|greater)/i.test(text)) qualifiers.push('comparative');
  const polarity: 'affirmed' | 'negated' | 'conditional' = /(not|never|no|without|lacks|missing)/i.test(text) ? 'negated' : /(may|might|could|possible|possibly|uncertain|if|when|unless)/i.test(text) ? 'conditional' : 'affirmed';
  const modality: 'asserted' | 'possible' | 'required' | 'temporal' | 'comparative' = qualifiers.includes('required') ? 'required' : qualifiers.includes('temporal') ? 'temporal' : qualifiers.includes('comparative') ? 'comparative' : qualifiers.includes('possible') ? 'possible' : 'asserted';
  return { subject, predicate, object, polarity, modality, qualifiers };
}

function makeProposition(text: string, index: number, sources: string[]): Proposition {
  const parsed = subjectPredicateObject(text);
  const normalized = normalizeText(text);
  const confidence = clamp(0.42 + Math.min(0.3, text.length / 220) + (parsed.polarity === 'affirmed' ? 0.12 : parsed.polarity === 'conditional' ? 0.06 : 0));
  const support = clamp(confidence * 0.72 + Math.min(0.18, sources.length * 0.05));
  const contradiction = clamp(parsed.polarity === 'negated' ? 0.42 + confidence * 0.35 : parsed.qualifiers.includes('possible') ? 0.18 : 0.08);
  return {
    id: stableHash(text + '|' + String(index)).slice(0, 14),
    text: text.trim(),
    subject: parsed.subject || normalized,
    predicate: parsed.predicate,
    object: parsed.object || normalized,
    polarity: parsed.polarity,
    confidence,
    support,
    contradiction,
    sources,
  };
}

function makeClaim(proposition: Proposition, sources: string[], trust: number, index: number, intent: SearchIntent): VerifiedClaim {
  const verdict: 'supported' | 'contested' | 'unsupported' = trust >= 0.68 && proposition.polarity !== 'negated' ? 'supported' : trust >= 0.48 ? 'contested' : 'unsupported';
  const relation: ClaimAssessment['relation'] = proposition.polarity === 'negated' ? 'contradicts' : verdict === 'supported' ? 'entails' : 'unknown';
  return {
    id: stableHash('claim:' + proposition.text + ':' + String(index)).slice(0, 14),
    text: proposition.text,
    confidence: clamp((trust + proposition.confidence) / 2),
    supportedBy: sources,
    contradictedBy: proposition.polarity === 'negated' ? sources : [],
    verdict,
    assessments: [{ premise: intent.semanticQuery, hypothesis: proposition.text, relation, confidence: clamp(trust), rationale: 'latent reasoning synthesis' }],
  };
}

function canonicalizeEntities(intent: SearchIntent, queries: string[], results: TrustedEvidence[], claims: VerifiedClaim[]): CanonicalEntity[] {
  const labels = uniq([
    ...intent.entities,
    ...intent.topics,
    ...queries,
    ...results.map((result) => result.title),
    ...claims.map((claim) => claim.text),
  ].map((value) => value.trim()).filter(Boolean)).slice(0, 12);
  return labels.map((label, index) => ({
    id: stableHash('entity:' + label + ':' + String(index)).slice(0, 12),
    label,
    mentions: [label],
    confidence: clamp(0.58 + Math.min(0.22, label.length / 140)),
    nil: false,
    sourceIds: results.slice(0, 3).map((result) => stableHash(result.url || result.title).slice(0, 10)),
  }));
}

function buildNodes(queries: string[], results: TrustedEvidence[], claims: VerifiedClaim[], entities: CanonicalEntity[]): SearchEvidenceNode[] {
  const nodes: SearchEvidenceNode[] = [];
  for (let index = 0; index < queries.length; index += 1) {
    nodes.push({ id: 'query:' + stableHash(queries[index]).slice(0, 12), label: queries[index], type: 'query', weight: 0.8 - index * 0.04, metadata: { index } });
  }
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    nodes.push({ id: 'result:' + stableHash(result.url || result.title).slice(0, 12), label: result.title || result.url, type: 'result', weight: result.trustScore, metadata: { source: result.source, url: result.url, trustScore: result.trustScore } });
  }
  for (const entity of entities) {
    nodes.push({ id: 'entity:' + entity.id, label: entity.label, type: 'entity', weight: entity.confidence, metadata: { mentions: entity.mentions, nil: entity.nil } });
  }
  for (const claim of claims) {
    nodes.push({ id: 'claim:' + claim.id, label: claim.text, type: 'claim', weight: claim.confidence, metadata: { verdict: claim.verdict } });
  }
  return nodes;
}

function buildCommunities(results: TrustedEvidence[], entities: CanonicalEntity[], claims: VerifiedClaim[]): EvidenceCommunity[] {
  const bySource = new Map<string, { entityIds: string[]; claimIds: string[]; sourceIds: string[]; labels: string[] }>();
  for (const result of results) {
    const key = String(result.source);
    const entry = bySource.get(key) ?? { entityIds: [], claimIds: [], sourceIds: [], labels: [] };
    entry.sourceIds.push(key);
    entry.labels.push(result.title);
    bySource.set(key, entry);
  }
  return [...bySource.entries()].map(([source, entry], index) => ({
    id: 'community:' + stableHash(source + ':' + String(index)).slice(0, 12),
    label: source + ' community',
    entityIds: entities.slice(0, 4).map((entity) => entity.id),
    claimIds: claims.slice(0, 4).map((claim) => claim.id),
    sourceIds: entry.sourceIds,
    summary: 'clustered evidence around ' + source,
    confidence: clamp(0.54 + Math.min(0.2, entry.labels.length * 0.05)),
  }));
}

function buildExploration(queries: string[], claims: VerifiedClaim[], entities: CanonicalEntity[]): ExplorationStep[] {
  return queries.slice(0, 4).map((query, index) => ({
    id: 'explore:' + stableHash(query + ':' + String(index)).slice(0, 12),
    question: query,
    entityIds: entities.slice(0, 3).map((entity) => entity.id),
    evidenceIds: claims.slice(0, 3).map((claim) => claim.id),
    inferredClaims: claims.slice(0, 3).map((claim) => claim.text),
    unresolved: claims.filter((claim) => claim.verdict !== 'supported').map((claim) => claim.text).slice(0, 3),
    confidence: clamp(0.45 + Math.min(0.3, query.length / 180)),
    frontier: uniq([query, ...entities.slice(0, 2).map((entity) => entity.label)]).slice(0, 3),
    path: [{ from: 'query', to: 'claim', relation: 'routes', weight: 0.6 }],
  }));
}

function buildPropositionEdges(propositions: Proposition[], claims: VerifiedClaim[]): PropositionEdge[] {
  const edges: PropositionEdge[] = [];
  for (let index = 0; index < propositions.length; index += 1) {
    const current = propositions[index];
    const previous = propositions[index - 1];
    if (previous) edges.push({ from: previous.id, to: current.id, relation: previous.subject === current.subject ? 'supports' : 'refines', weight: 0.52 + Math.min(0.2, current.confidence * 0.12) });
  }
  for (const claim of claims) {
    const proposition = propositions.find((entry) => entry.text === claim.text);
    if (proposition) edges.push({ from: proposition.id, to: claim.id, relation: claim.verdict === 'supported' ? 'entails' : claim.verdict === 'contested' ? 'refines' : 'contradicts', weight: clamp(claim.confidence) });
  }
  return edges;
}

function buildEdges(queries: string[], results: TrustedEvidence[], claims: VerifiedClaim[], propositions: Proposition[], entities: CanonicalEntity[]): SearchEvidenceEdge[] {
  const edges: SearchEvidenceEdge[] = [];
  for (const query of queries) {
    for (const claim of claims.slice(0, 4)) edges.push({ from: 'query:' + stableHash(query).slice(0, 12), to: 'claim:' + claim.id, relation: 'claims', weight: 0.46 });
  }
  for (const result of results) {
    const resultId = 'result:' + stableHash(result.url || result.title).slice(0, 12);
    for (const claim of claims.slice(0, 4)) edges.push({ from: resultId, to: 'claim:' + claim.id, relation: 'derived-from', weight: clamp(result.trustScore * 0.8) });
    edges.push({ from: 'source:' + String(result.source), to: resultId, relation: 'corroborates', weight: clamp(result.trustScore) });
  }
  for (const entity of entities.slice(0, 4)) {
    for (const proposition of propositions.slice(0, 4)) {
      edges.push({ from: 'entity:' + entity.id, to: 'claim:' + stableHash(proposition.text).slice(0, 14), relation: 'supports', weight: clamp(entity.confidence * 0.6) });
    }
  }
  return edges;
}

function conflictsFromClaims(claims: VerifiedClaim[]): EvidenceConflict[] {
  const conflicts: EvidenceConflict[] = [];
  const supported = claims.filter((claim) => claim.verdict === 'supported');
  const unsupported = claims.filter((claim) => claim.verdict === 'unsupported');
  if (supported.length > 0 && unsupported.length > 0) {
    conflicts.push({
      claim: unsupported[0].text,
      supporting: supported.slice(0, 3).map((claim) => claim.text),
      contradicting: unsupported.slice(0, 3).map((claim) => claim.text),
      resolution: 'continue corroborating the contested evidence before collapsing the graph',
      confidence: 0.56,
    });
  }
  return conflicts;
}

function synthesisFromClaims(claims: VerifiedClaim[], conflicts: EvidenceConflict[], trustedResults: TrustedEvidence[]): EvidenceSynthesis {
  const avgTrust = trustedResults.length ? trustedResults.reduce((sum, result) => sum + result.trustScore, 0) / trustedResults.length : 0.38;
  const avgClaim = claims.length ? claims.reduce((sum, claim) => sum + claim.confidence, 0) / claims.length : 0.35;
  const confidence = clamp(avgTrust * 0.55 + avgClaim * 0.45 + (conflicts.length > 0 ? -0.08 : 0.05));
  return {
    answerable: claims.length > 0,
    stance: conflicts.length > 0 ? 'contested' : claims.some((claim) => claim.verdict === 'supported') ? 'confirmed' : 'insufficient',
    confidence,
    primaryClaims: claims.slice(0, 3).map((claim) => claim.text),
    rejectedClaims: claims.filter((claim) => claim.verdict === 'unsupported').map((claim) => claim.text),
    reasoningTrace: claims.slice(0, 4).map((claim) => claim.text),
  };
}

export function buildQueries(intent: SearchIntent, strategy: SearchStrategyProfile): string[] {
  const subject = intent.entities[0] || intent.topics[0] || intent.semanticQuery || intent.objective;
  const queries = uniq([
    intent.semanticQuery,
    ...intent.querySeeds,
    ...intent.evidenceTerms.slice(0, 4).map((term) => term + ' evidence'),
    'verify ' + subject,
    'expand ' + subject,
    strategy.name + ' ' + subject,
  ].map((entry) => entry.trim()).filter(Boolean));
  if (intent.focus === 'trust' || intent.focus === 'multi-hop') queries.unshift('corroborate ' + subject);
  if (intent.focus === 'diagnostic') queries.unshift('diagnose ' + subject + ' root cause');
  return uniq(queries).slice(0, 8);
}

export function deriveHopPlan(intent: SearchIntent, strategy: SearchStrategyProfile, results: SearchResult[]): string[] {
  const budget = Math.max(1, Math.min(6, intent.hopBudget));
  const plan: string[] = [];
  plan.push('observe:' + intent.semanticQuery);
  const resultFocus = results.slice(0, Math.max(1, budget - 1)).map((result) => result.title || result.url || result.snippet).filter(Boolean);
  for (let index = 0; index < resultFocus.length && plan.length < budget; index += 1) {
    plan.push(index === 0 ? 'revise:' + resultFocus[index] : 'expand:' + resultFocus[index]);
  }
  if (plan.length < budget) plan.push('expand:' + strategy.name + ':' + (intent.topics[0] || intent.entities[0] || intent.semanticQuery));
  return uniq(plan).slice(0, budget);
}

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability?: Record<string, any>, policy?: PolicyDecision, policyState?: SearchPolicyState): SearchEvidenceGraph {
  const trustedResults = scoreEvidenceTrust(intent, results, reliability, policy, policyState);
  const claimCandidates = uniq([
    ...trustedResults.flatMap((result) => claimTextsFromResult(result)),
    ...queries.map((query) => 'Evidence for ' + query),
  ].map((text) => text.trim()).filter(Boolean));
  const fallbackClaim = 'Continue exploring ' + (intent.semanticQuery || intent.objective) + ' with latent evidence';
  const texts = claimCandidates.length > 0 ? claimCandidates.slice(0, 12) : [fallbackClaim];
  const propositions = texts.map((text, index) => makeProposition(text, index, trustedResults.slice(0, 3).map((result) => String(result.source))));
  const claims = propositions.map((proposition, index) => makeClaim(proposition, trustedResults.slice(0, 3).map((result) => String(result.source)), clamp(trustedResults[index]?.trustScore ?? 0.48), index, intent));
  if (claims.length === 0) {
    const proposition = makeProposition(fallbackClaim, 0, []);
    propositions.push(proposition);
    claims.push(makeClaim(proposition, [], 0.48, 0, intent));
  }
  const entities = canonicalizeEntities(intent, queries, trustedResults, claims);
  const communities = buildCommunities(trustedResults, entities, claims);
  const exploration = buildExploration(queries, claims, entities);
  const edges = buildEdges(queries, trustedResults, claims, propositions, entities);
  const propositionGraph: PropositionGraph = {
    propositions,
    edges: buildPropositionEdges(propositions, claims),
    summary: 'synthesized ' + String(propositions.length) + ' propositions across ' + String(trustedResults.length) + ' results',
    confidence: clamp((claims.reduce((sum, claim) => sum + claim.confidence, 0) / Math.max(1, claims.length)) * 0.6 + (trustedResults.reduce((sum, result) => sum + result.trustScore, 0) / Math.max(1, trustedResults.length || 1)) * 0.4),
  };
  const conflicts = conflictsFromClaims(claims);
  const synthesis = synthesisFromClaims(claims, conflicts, trustedResults);
  const confidence = clamp(Math.max(0.16, synthesis.confidence * 0.7 + propositionGraph.confidence * 0.3));
  const nodes = buildNodes(queries, trustedResults, claims, entities);
  nodes.push(...communities.map((community) => ({ id: 'community:' + community.id, label: community.label, type: 'community', weight: community.confidence, metadata: { summary: community.summary } }))); 
  nodes.push(...exploration.map((step) => ({ id: 'explore:' + step.id, label: step.question, type: 'exploration', weight: step.confidence, metadata: { frontier: step.frontier } })));
  if (conflicts.length > 0) nodes.push(...conflicts.map((conflict, index) => ({ id: 'conflict:' + stableHash(conflict.claim + ':' + String(index)).slice(0, 12), label: conflict.claim, type: 'conflict', weight: conflict.confidence, metadata: { resolution: conflict.resolution } })));
  return {
    nodes,
    edges,
    queries,
    entities,
    communities,
    exploration,
    claims,
    propositions,
    propositionGraph,
    conflicts,
    synthesis,
    summary: 'claims=' + String(claims.length) + ' propositions=' + String(propositions.length) + ' confidence=' + confidence.toFixed(3),
    confidence,
  };
}
