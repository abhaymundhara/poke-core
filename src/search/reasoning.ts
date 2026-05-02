import type { ClaimAssessment, EvidenceConflict, PolicyDecision, Proposition, PropositionEdge, PropositionGraph, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchPolicyState, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim, CanonicalEntity, EvidenceCommunity, ExplorationStep, EvidenceSynthesis } from './types.ts';
import { clamp, stableHash, uniq, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@._:-]+/g, ' ').replace(/s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])s+|
+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 12)
    .slice(0, 4);
}

function claimTextsFromResult(result: SearchResult): string[] {
  if (result.claims && result.claims.length > 0) return result.claims.map((claim) => claim.trim()).filter(Boolean);
  const sentenceClaims = splitSentences(result.snippet);
  if (sentenceClaims.length > 0) return sentenceClaims;
  return [result.title.trim()].filter(Boolean);
}

type GroundedSpan = {
  sourceId: string;
  source: string;
  url: string;
  kind: 'title' | 'snippet' | 'claim';
  text: string;
  normalized: string;
  start: number;
  end: number;
  tokens: string[];
  trust: number;
};

type GroundedMatch = {
  result: TrustedEvidence;
  span: GroundedSpan;
  score: number;
  overlap: number;
  exact: boolean;
};

type GroundedCandidate = {
  text: string;
  normalized: string;
  tokens: string[];
  matches: GroundedMatch[];
  supportSources: string[];
  supportCount: number;
  crossVerified: boolean;
  conflict: boolean;
  confidence: number;
  rationale: string;
};

function tokenize(text: string): string[] {
  return uniq(words(normalizeText(text))).filter((token) => token.length > 1);
}

function sourceIdFor(result: TrustedEvidence): string {
  return stableHash((result.url || result.title || result.snippet || String(result.source)) + '|' + String(result.source)).slice(0, 12);
}

function collectGroundedSpans(result: TrustedEvidence): GroundedSpan[] {
  const sourceId = sourceIdFor(result);
  const trust = clamp(result.trustScore ?? result.score ?? result.trust ?? 0.5);
  const source = String(result.source);
  const spans: GroundedSpan[] = [];
  const pushSpan = (kind: GroundedSpan['kind'], text: string, start: number, end: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    spans.push({
      sourceId,
      source,
      url: result.url,
      kind,
      text: trimmed,
      normalized: normalizeText(trimmed),
      start,
      end,
      tokens: tokenize(trimmed),
      trust,
    });
  };

  pushSpan('title', result.title, 0, result.title.length);
  if (result.snippet) {
    let cursor = 0;
    for (const sentence of splitSentences(result.snippet)) {
      const index = result.snippet.toLowerCase().indexOf(sentence.toLowerCase(), cursor);
      const start = index >= 0 ? index : cursor;
      const end = start + sentence.length;
      cursor = Math.max(cursor, end);
      pushSpan('snippet', sentence, start, end);
    }
  }
  for (const claim of result.claims ?? []) {
    pushSpan('claim', claim, 0, claim.length);
  }
  return spans;
}

function scoreSpanMatch(candidateTokens: string[], candidateNormalized: string, span: GroundedSpan, result: TrustedEvidence): GroundedMatch | null {
  if (!span.normalized) return null;
  const spanTokens = span.tokens.length > 0 ? span.tokens : tokenize(span.text);
  const candidateSet = new Set(candidateTokens);
  const spanSet = new Set(spanTokens);
  let overlapCount = 0;
  for (const token of candidateSet) {
    if (spanSet.has(token)) overlapCount += 1;
  }
  const union = new Set([...candidateSet, ...spanSet]).size || 1;
  const overlap = overlapCount / union;
  const exact = span.normalized === candidateNormalized || span.normalized.includes(candidateNormalized) || candidateNormalized.includes(span.normalized);
  const containment = span.normalized.includes(candidateNormalized) || candidateNormalized.includes(span.normalized) ? 1 : 0;
  const kindBoost = span.kind === 'claim' ? 0.09 : span.kind === 'snippet' ? 0.06 : 0.03;
  const score = clamp(0.16 + overlap * 0.54 + containment * 0.17 + kindBoost + clamp(result.trustScore ?? result.trust ?? result.score ?? 0.5) * 0.11);
  if (score < 0.24) return null;
  return { result, span, score, overlap, exact };
}

function buildGroundedCandidate(text: string, trustedResults: TrustedEvidence[]): GroundedCandidate {
  const normalized = normalizeText(text);
  const tokens = tokenize(text);
  const matches: GroundedMatch[] = [];
  for (const result of trustedResults) {
    const spans = collectGroundedSpans(result);
    let best: GroundedMatch | null = null;
    for (const span of spans) {
      const match = scoreSpanMatch(tokens, normalized, span, result);
      if (!match) continue;
      if (!best || match.score > best.score) best = match;
    }
    if (best) matches.push(best);
  }
  matches.sort((left, right) => right.score - left.score);
  const supportSources = uniq(matches.map((match) => String(match.result.source)));
  const supportCount = supportSources.length;
  const independentSources = new Set(matches.map((match) => String(match.result.source))).size;
  const avgScore = matches.length > 0 ? matches.reduce((sum, match) => sum + match.score, 0) / matches.length : 0;
  const hasNegation = /(not|never|no|without|lacks|missing)/i.test(normalized);
  const conflictingPolarity = matches.some((match) => /(not|never|no|without|lacks|missing)/i.test(match.span.normalized)) && matches.some((match) => !/(not|never|no|without|lacks|missing)/i.test(match.span.normalized));
  const crossVerified = supportCount >= 2 && independentSources >= 2 && (avgScore >= 0.38 || matches.some((match) => match.exact));
  const conflict = Boolean(conflictingPolarity || (hasNegation && !matches.some((match) => /(not|never|no|without|lacks|missing)/i.test(match.span.normalized))));
  const confidence = clamp(0.2 + avgScore * 0.36 + supportCount * 0.07 + (crossVerified ? 0.22 : 0) - (conflict ? 0.16 : 0));
  const rationale = 'grounded-spans=' + String(matches.length) + ';cross-source=' + (crossVerified ? 'verified' : 'pending') + ';conflict=' + (conflict ? 'yes' : 'no');
  return { text, normalized, tokens, matches, supportSources, supportCount, crossVerified, conflict, confidence, rationale };
}

function candidateTextsFromResults(results: TrustedEvidence[], queries: string[]): string[] {
  const groundedTexts = results.flatMap((result) => [
    ...claimTextsFromResult(result),
    ...collectGroundedSpans(result).map((span) => span.text),
  ]);
  return uniq([
    ...groundedTexts,
    ...queries.map((query) => 'Evidence for ' + query),
  ].map((value) => value.trim()).filter(Boolean)).slice(0, 12);
}

function subjectPredicateObject(text: string): { subject: string; predicate: string; object: string; polarity: 'affirmed' | 'negated' | 'conditional'; modality: 'asserted' | 'possible' | 'required' | 'temporal' | 'comparative'; qualifiers: string[] } {
  const normalized = normalizeText(text);
  const predicateMatch = normalized.match(/^(.*?)(?:s+(is|are|was|were|has|have|can|could|should|would|must|may|might|means|implies|indicates|shows|supports|proves|contradicts|equals|relates to)s+)(.*)$/i);
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
} {
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

function makeProposition(text: string, index: number, grounding: GroundedCandidate): Proposition {
  const parsed = subjectPredicateObject(text);
  const trustMass = grounding.matches.length > 0 ? grounding.matches.reduce((sum, match) => sum + clamp(match.result.trustScore ?? match.result.trust ?? match.result.score ?? 0.5) * match.score, 0) / grounding.matches.length : 0.42;
  const confidence = clamp(0.24 + trustMass * 0.34 + (grounding.crossVerified ? 0.2 : 0) + Math.min(0.12, grounding.supportCount * 0.03) - (grounding.conflict ? 0.18 : 0));
  const support = clamp(Math.max(confidence * 0.72, 0.38 + Math.min(0.22, grounding.supportCount * 0.08) + (grounding.crossVerified ? 0.12 : 0)));
  const contradiction = clamp(parsed.polarity === 'negated' || grounding.conflict ? 0.36 + (1 - confidence) * 0.28 : parsed.qualifiers.includes('possible') ? 0.18 : 0.08);
  return {
    id: stableHash(text + '|' + String(index)).slice(0, 14),
    text: text.trim(),
    subject: parsed.subject || grounding.normalized,
    predicate: parsed.predicate,
    object: parsed.object || grounding.normalized,
    polarity: parsed.polarity,
    confidence,
    support,
    contradiction,
    sources: grounding.supportSources.length > 0 ? grounding.supportSources : grounding.matches.map((match) => String(match.result.source)),
  };
}

function makeClaim(proposition: Proposition, grounding: GroundedCandidate, index: number, intent: SearchIntent): VerifiedClaim {
  const supportedBy = grounding.supportSources.length > 0 ? grounding.supportSources : proposition.sources;
  const verdict: 'supported' | 'contested' | 'unsupported' = grounding.crossVerified && proposition.confidence >= 0.58 && !grounding.conflict && proposition.polarity !== 'negated'
    ? 'supported'
    : grounding.supportCount > 0 && proposition.confidence >= 0.42
      ? 'contested'
      : 'unsupported';
  const relation: ClaimAssessment['relation'] = proposition.polarity === 'negated' || grounding.conflict ? 'contradicts' : verdict === 'supported' ? 'entails' : 'unknown';
  const rationale = [
    grounding.rationale,
    'support-sources=' + (supportedBy.join('|') || 'none'),
    'intent=' + intent.semanticQuery,
  ].join(';');
  return {
    id: stableHash('claim:' + proposition.text + ':' + String(index)).slice(0, 14),
    text: proposition.text,
    confidence: clamp((grounding.confidence + proposition.confidence) / 2),
    supportedBy,
    contradictedBy: relation === 'contradicts' ? supportedBy : [],
    verdict,
    assessments: [{ premise: intent.semanticQuery, hypothesis: proposition.text, relation, confidence: clamp(grounding.confidence), rationale }],
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
  const claimCandidates = candidateTextsFromResults(trustedResults, queries);
  const fallbackClaim = 'Continue exploring ' + (intent.semanticQuery || intent.objective) + ' with grounded evidence';
  const texts = claimCandidates.length > 0 ? claimCandidates : [fallbackClaim];
  const grounded = texts.map((text) => buildGroundedCandidate(text, trustedResults));
  const propositions = texts.map((text, index) => makeProposition(text, index, grounded[index]));
  const claims = propositions.map((proposition, index) => makeClaim(proposition, grounded[index], index, intent));
  if (claims.length === 0) {
    const fallbackGrounding = buildGroundedCandidate(fallbackClaim, trustedResults);
    const proposition = makeProposition(fallbackClaim, 0, fallbackGrounding);
    propositions.push(proposition);
    claims.push(makeClaim(proposition, fallbackGrounding, 0, intent));
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
  const confidence = clamp(Math.max(0.2, synthesis.confidence * 0.68 + propositionGraph.confidence * 0.32));
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
