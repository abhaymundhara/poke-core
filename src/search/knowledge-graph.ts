import type { CanonicalEntity, EvidenceCommunity, EvidenceSynthesis, ExplorationStep, SearchEvidenceEdge, SearchEvidenceNode, SearchIntent, TrustedEvidence, VerifiedClaim, EvidenceConflict } from './types.ts';
import { average, clamp, normalize, stableHash, words } from './utils.ts';

function mentionCandidates(intent: SearchIntent, evidence: TrustedEvidence[]): Array<{ mention: string; sourceId: string; confidence: number }> {
  const candidates: Array<{ mention: string; sourceId: string; confidence: number }> = [];
  for (const entity of intent.entities) candidates.push({ mention: entity, sourceId: 'intent', confidence: 0.78 });
  for (const item of evidence) {
    const sourceId = item.url || item.title;
    for (const claim of item.claims ?? []) {
      const nounish = claim.match(/\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3}\b/g) ?? [];
      for (const mention of nounish) candidates.push({ mention, sourceId, confidence: item.trustScore });
    }
  }
  return candidates;
}

function similarity(left: string, right: string): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  const lexical = [...a].filter((word) => b.has(word)).length / Math.max(1, Math.min(a.size, b.size));
  const canonical = normalize(left) === normalize(right) ? 1 : 0;
  return Math.max(lexical, canonical);
}

export function canonicalizeEntities(intent: SearchIntent, evidence: TrustedEvidence[]): CanonicalEntity[] {
  const entities: CanonicalEntity[] = [];
  for (const candidate of mentionCandidates(intent, evidence)) {
    const existing = entities.find((entity) => similarity(entity.label, candidate.mention) > 0.66);
    if (existing) {
      existing.mentions = [...new Set([...existing.mentions, candidate.mention])];
      existing.sourceIds = [...new Set([...existing.sourceIds, candidate.sourceId])];
      existing.confidence = clamp((existing.confidence + candidate.confidence) / 2 + 0.08);
      continue;
    }
    entities.push({ id: `entity-${stableHash(candidate.mention)}`, label: candidate.mention, mentions: [candidate.mention], confidence: candidate.confidence, nil: candidate.confidence < 0.42, sourceIds: [candidate.sourceId] });
  }
  return entities.sort((left, right) => right.confidence - left.confidence).slice(0, 24);
}

export function detectEvidenceCommunities(entities: CanonicalEntity[], claims: VerifiedClaim[], evidence: TrustedEvidence[]): EvidenceCommunity[] {
  const groups = new Map<string, EvidenceCommunity>();
  for (const entity of entities) {
    const relatedClaims = claims.filter((claim) => similarity(claim.text, entity.label) > 0.12 || entity.mentions.some((mention) => claim.text.toLowerCase().includes(mention.toLowerCase())));
    const relatedSources = evidence.filter((item) => entity.sourceIds.includes(item.url || item.title) || relatedClaims.some((claim) => claim.supportedBy.includes(item.url || item.title)));
    const key = entity.label.split(/\s+/)[0]?.toLowerCase() || entity.id;
    const existing = groups.get(key);
    const next: EvidenceCommunity = existing ?? { id: `community-${stableHash(key)}`, label: key, entityIds: [], claimIds: [], sourceIds: [], summary: '', confidence: 0 };
    next.entityIds = [...new Set([...next.entityIds, entity.id])];
    next.claimIds = [...new Set([...next.claimIds, ...relatedClaims.map((claim) => claim.id)])];
    next.sourceIds = [...new Set([...next.sourceIds, ...relatedSources.map((item) => item.url || item.title)])];
    next.confidence = clamp(average([entity.confidence, ...relatedClaims.map((claim) => claim.confidence), ...relatedSources.map((item) => item.trustScore)]));
    next.summary = `${next.label}: ${next.claimIds.length} claims, ${next.sourceIds.length} sources`;
    groups.set(key, next);
  }
  return [...groups.values()].filter((community) => community.claimIds.length > 0 || community.sourceIds.length > 0).sort((left, right) => right.confidence - left.confidence).slice(0, 12);
}

function adjacencyFor(nodes: SearchEvidenceNode[], edges: SearchEvidenceEdge[]): Map<string, Array<{ to: string; relation: string; weight: number }>> {
  const graph = new Map<string, Array<{ to: string; relation: string; weight: number }>>();
  for (const edge of edges) {
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), { to: edge.to, relation: edge.relation, weight: edge.weight }]);
    graph.set(edge.to, [...(graph.get(edge.to) ?? []), { to: edge.from, relation: edge.relation, weight: edge.weight * 0.82 }]);
  }
  return graph;
}

function traverseFrontier(startIds: string[], nodes: SearchEvidenceNode[], edges: SearchEvidenceEdge[], depth: number) {
  const graph = adjacencyFor(nodes, edges);
  const visited = new Set(startIds);
  const paths: Array<{ from: string; to: string; relation: string; weight: number }> = [];
  let frontier = startIds;
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.get(id) ?? []) {
        paths.push({ from: id, to: edge.to, relation: edge.relation, weight: edge.weight });
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next.sort((left, right) => (nodes.find((node) => node.id === right)?.weight ?? 0) - (nodes.find((node) => node.id === left)?.weight ?? 0)).slice(0, 8);
    if (frontier.length === 0) break;
  }
  return { frontier: [...visited], paths };
}

export function addKnowledgeGraphNodes(nodes: SearchEvidenceNode[], edges: SearchEvidenceEdge[], entities: CanonicalEntity[], communities: EvidenceCommunity[]): void {
  for (const entity of entities) {
    nodes.push({ id: entity.id, label: entity.label, type: 'entity', weight: entity.confidence, metadata: { mentions: entity.mentions, nil: entity.nil } });
    for (const sourceId of entity.sourceIds) edges.push({ from: entity.id, to: sourceId, relation: 'derived-from', weight: entity.confidence });
  }
  for (const community of communities) {
    nodes.push({ id: community.id, label: community.label, type: 'community', weight: community.confidence, metadata: { summary: community.summary } });
    for (const entityId of community.entityIds) edges.push({ from: community.id, to: entityId, relation: 'refines', weight: community.confidence });
    for (const claimId of community.claimIds) edges.push({ from: community.id, to: claimId, relation: 'supports', weight: community.confidence });
    for (const sourceId of community.sourceIds) edges.push({ from: community.id, to: sourceId, relation: 'corroborates', weight: community.confidence });
  }
}

export function chainOfExploration(intent: SearchIntent, entities: CanonicalEntity[], claims: VerifiedClaim[], communities: EvidenceCommunity[], nodes: SearchEvidenceNode[], edges: SearchEvidenceEdge[]): ExplorationStep[] {
  const questions = intent.decomposedQuestions.length > 0 ? intent.decomposedQuestions : [`Resolve ${intent.objective}`];
  return questions.slice(0, Math.max(2, intent.hopBudget)).map((question, index) => {
    const focusedEntities = entities.filter((entity) => words(question).some((word) => normalize(entity.label).includes(word))).slice(0, 4);
    const entityPool = focusedEntities.length > 0 ? focusedEntities : entities.slice(index, index + 3);
    const relatedClaims = claims.filter((claim) => entityPool.some((entity) => entity.mentions.some((mention) => claim.text.toLowerCase().includes(mention.toLowerCase())))).slice(0, 6);
    const relatedCommunities = communities.filter((community) => entityPool.some((entity) => community.entityIds.includes(entity.id))).slice(0, 3);
    const startIds = [...entityPool.map((entity) => entity.id), ...relatedCommunities.map((community) => community.id), ...relatedClaims.map((claim) => claim.id)];
    const traversed = traverseFrontier(startIds.length > 0 ? startIds : nodes.filter((node) => node.type === 'query').map((node) => node.id), nodes, edges, Math.max(1, Math.min(3, intent.hopBudget)));
    const unresolved = relatedClaims.filter((claim) => claim.verdict !== 'supported').map((claim) => claim.text).slice(0, 4);
    const step = {
      id: `explore-${index}-${stableHash(question)}`,
      question,
      entityIds: entityPool.map((entity) => entity.id),
      evidenceIds: [...new Set([...relatedClaims.flatMap((claim) => claim.supportedBy), ...relatedCommunities.flatMap((community) => community.sourceIds)])],
      inferredClaims: relatedClaims.map((claim) => claim.text),
      unresolved,
      confidence: clamp(average([...entityPool.map((entity) => entity.confidence), ...relatedClaims.map((claim) => claim.confidence), ...relatedCommunities.map((community) => community.confidence), ...traversed.paths.map((path) => path.weight)])),
      frontier: traversed.frontier,
      path: traversed.paths.slice(0, 24),
    };
    nodes.push({ id: step.id, label: question, type: 'exploration', weight: step.confidence, metadata: { unresolved: step.unresolved, frontier: step.frontier } });
    for (const path of step.path) edges.push({ from: step.id, to: path.to, relation: 'routes', weight: path.weight });
    return step;
  });
}

export function synthesizeEvidence(claims: VerifiedClaim[], conflicts: EvidenceConflict[], exploration: ExplorationStep[]): EvidenceSynthesis {
  const supported = claims.filter((claim) => claim.verdict === 'supported').sort((left, right) => right.confidence - left.confidence);
  const contested = claims.filter((claim) => claim.verdict === 'contested');
  const confidence = clamp(average([...supported.map((claim) => claim.confidence), ...exploration.map((step) => step.confidence)]) - conflicts.length * 0.06);
  const stance = supported.length === 0 ? 'insufficient' : contested.length > 0 || conflicts.length > 0 ? 'contested' : 'confirmed';
  return {
    answerable: supported.length > 0 && confidence > 0.38,
    stance,
    confidence,
    primaryClaims: supported.slice(0, 5).map((claim) => claim.text),
    rejectedClaims: contested.flatMap((claim) => claim.contradictedBy).slice(0, 5),
    reasoningTrace: exploration.map((step) => `${step.question} -> ${step.inferredClaims.length} claims / ${step.unresolved.length} unresolved`),
  };
}
