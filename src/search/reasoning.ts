import type { ClaimAssessment, EvidenceConflict, SearchEvidenceEdge, SearchEvidenceGraph, SearchEvidenceNode, SearchIntent, SearchResult, SearchStrategyProfile, TrustedEvidence, VerifiedClaim } from './types.ts';
import { average, clamp, stableHash, words } from './utils.ts';
import { scoreEvidenceTrust } from './trust.ts';

function claimTexts(result: SearchResult): string[] {
  if (result.claims?.length) return result.claims;
  return result.snippet.split(/[.!?]\s+/).map((part) => part.trim()).filter((part) => part.length > 18).slice(0, 3);
}

function contradicts(left: string, right: string): boolean {
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  const negations = [['is', 'is not'], ['supports', 'does not support'], ['can', 'cannot'], ['will', 'will not'], ['true', 'false'], ['passed', 'failed']];
  return negations.some(([positive, negative]) => (l.includes(positive) && r.includes(negative)) || (l.includes(negative) && r.includes(positive)));
}

function entails(left: string, right: string): boolean {
  const shared = similarity(left, right);
  if (shared > 0.62) return true;
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  return words(r).filter((word) => words(l).includes(word)).length >= Math.max(4, Math.ceil(words(r).length * 0.55));
}

function assessClaim(premise: string, hypothesis: string, sourceConfidence: number): ClaimAssessment {
  if (contradicts(premise, hypothesis)) return { premise, hypothesis, relation: 'contradicts', confidence: clamp(0.52 + sourceConfidence * 0.35 + similarity(premise, hypothesis) * 0.2), rationale: 'negated predicate or opposing modal detected across comparable claims' };
  if (entails(premise, hypothesis)) return { premise, hypothesis, relation: 'entails', confidence: clamp(0.48 + sourceConfidence * 0.38 + similarity(premise, hypothesis) * 0.22), rationale: 'premise has high semantic overlap with the hypothesis and no detected rebuttal' };
  return { premise, hypothesis, relation: 'unknown', confidence: clamp(0.25 + similarity(premise, hypothesis) * 0.35), rationale: 'premise is related but does not decide the claim' };
}

function similarity(left: string, right: string): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.max(1, Math.min(a.size, b.size));
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

export function buildEvidenceGraph(intent: SearchIntent, queries: string[], results: SearchResult[], strategy: SearchStrategyProfile, reliability = {}): SearchEvidenceGraph {
  const trusted = scoreEvidenceTrust(intent, results, reliability);
  const nodes: SearchEvidenceNode[] = [];
  const edges: SearchEvidenceEdge[] = [];
  const claimIndex = new Map<string, { text: string; support: TrustedEvidence[]; contradiction: TrustedEvidence[]; assessments: ClaimAssessment[] }>();

  const queryIds = queries.map((query, index) => {
    const id = `query-${index}-${stableHash(query)}`;
    nodes.push({ id, label: query, type: 'query', weight: 1, metadata: { query, intent: intent.sessionKey } });
    return id;
  });

  for (const [index, result] of trusted.entries()) {
    const resultId = `result-${index}-${stableHash(result.url || result.title)}`;
    nodes.push({ id: resultId, label: result.title, type: 'result', weight: result.trustScore, metadata: { url: result.url, source: result.source, snippet: result.snippet, trust: result.trustScore, breakdown: result.trustBreakdown } });
    for (const queryId of queryIds) edges.push({ from: queryId, to: resultId, relation: 'supports', weight: clamp(0.32 + strategy.semanticBias * 0.12 + result.trustScore * 0.2) });
    for (const text of claimTexts(result)) {
      const claimId = `claim-${stableHash(text)}`;
      if (!nodes.some((node) => node.id === claimId)) nodes.push({ id: claimId, label: text, type: 'claim', weight: result.trustScore, metadata: { text } });
      edges.push({ from: resultId, to: claimId, relation: 'claims', weight: result.trustScore });
      const key = [...claimIndex.keys()].find((claim) => similarity(claim, text) > 0.42) ?? text;
      const entry = claimIndex.get(key) ?? { text: key, support: [], contradiction: [], assessments: [] };
      const assessment = assessClaim(text, key, result.trustScore);
      entry.assessments.push(assessment);
      if (assessment.relation === 'contradicts') entry.contradiction.push(result);
      else if (assessment.relation === 'entails') entry.support.push(result);
      else if (similarity(key, text) > 0.42) entry.support.push(result);
      claimIndex.set(key, entry);
    }
  }

  const claims: VerifiedClaim[] = [];
  const conflicts: EvidenceConflict[] = [];
  for (const entry of claimIndex.values()) {
    for (const other of claimIndex.values()) {
      if (entry === other) continue;
      const assessment = assessClaim(other.text, entry.text, average(other.support.map((item) => item.trustScore)));
      if (assessment.relation !== 'unknown') entry.assessments.push(assessment);
      if (assessment.relation === 'contradicts') entry.contradiction.push(...other.support);
      if (assessment.relation === 'entails') entry.support.push(...other.support);
    }
    const supportIds = entry.support.map((item) => item.url || item.title);
    const contradictionIds = entry.contradiction.map((item) => item.url || item.title);
    const support = average(entry.support.map((item) => item.trustScore));
    const contradiction = average(entry.contradiction.map((item) => item.trustScore));
    const confidence = clamp(support * 0.82 - contradiction * 0.48 + Math.min(0.16, entry.support.length * 0.04));
    const verdict: VerifiedClaim['verdict'] = contradictionIds.length > 0 && contradiction > support * 0.65 ? 'contested' : supportIds.length > 0 ? 'supported' : 'unsupported';
    claims.push({ id: `claim-${stableHash(entry.text)}`, text: entry.text, confidence, supportedBy: supportIds, contradictedBy: contradictionIds, verdict, assessments: entry.assessments });
    if (contradictionIds.length > 0) {
      conflicts.push({ claim: entry.text, supporting: supportIds, contradicting: contradictionIds, resolution: support >= contradiction ? 'prefer higher-trust corroborated support' : 'prefer higher-trust contradiction', confidence: clamp(Math.abs(support - contradiction)) });
      nodes.push({ id: `conflict-${stableHash(entry.text)}`, label: entry.text, type: 'conflict', weight: clamp(Math.abs(support - contradiction)), metadata: { support, contradiction } });
      for (const supportId of supportIds) edges.push({ from: supportId, to: `conflict-${stableHash(entry.text)}`, relation: 'entails', weight: support });
      for (const contradictionId of contradictionIds) edges.push({ from: contradictionId, to: `conflict-${stableHash(entry.text)}`, relation: 'rebuts', weight: contradiction });
    }
  }

  for (let i = 1; i < trusted.length; i += 1) {
    const left = `result-${i - 1}-${stableHash(trusted[i - 1].url || trusted[i - 1].title)}`;
    const right = `result-${i}-${stableHash(trusted[i].url || trusted[i].title)}`;
    edges.push({ from: left, to: right, relation: similarity(trusted[i - 1].snippet, trusted[i].snippet) > 0.32 ? 'corroborates' : 'derived-from', weight: clamp(0.28 + strategy.hopBias * 0.1) });
  }

  const confidence = clamp(average(claims.map((claim) => claim.confidence)) * 0.52 + average(trusted.map((item) => item.trustScore)) * 0.34 + Math.min(1, queries.length / 5) * 0.14 - conflicts.length * 0.05);
  return { nodes, edges, queries, claims, conflicts, summary: `${queries.length} query seeds, ${results.length} results, ${claims.length} claims, conflicts=${conflicts.length}, strategy=${strategy.name}`, confidence };
}
