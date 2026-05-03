import type { IdentityEdge, IdentityEdgeKind, IdentityLinkInput, IdentityPath, IdentityPathStep, IdentityQuery, IdentityRecord, IdentityResolution, ResolveIdentityInput, IdentityUpsertInput } from './types.ts';
import { IdentityResolver, type IdentityLookupStore } from './resolver.ts';
import { IdentityStore } from './store.ts';

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function identityIdOf(resolution: IdentityResolution | null | undefined): string | null {
  return resolution && resolution.bestMatch ? resolution.bestMatch.identity.identityId : null;
}

function pathConfidence(steps: IdentityPathStep[]): number {
  if (steps.length === 0) return 1;
  const average = steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length;
  const attenuation = Math.max(0.55, 1 - Math.max(0, steps.length - 1) * 0.05);
  return clamp(average * attenuation);
}

export class IdentityGraph implements IdentityLookupStore {
  readonly resolver: IdentityResolver;

  constructor(public readonly store: IdentityStore = new IdentityStore()) {
    this.resolver = new IdentityResolver(this);
  }

  close(): void { this.store.close(); }
  withTransaction<T>(fn: () => T): T { return this.store.withTransaction(fn); }
  getIdentity(identityId: string): IdentityRecord | null { return this.store.getIdentity(identityId); }
  findIdentityIdsByEmail(email: string): string[] { return this.store.findIdentityIdsByEmail(email); }
  findIdentityIdsByPhone(phone: string): string[] { return this.store.findIdentityIdsByPhone(phone); }
  findIdentityIdsByHandle(handle: string, platform?: string): string[] { return this.store.findIdentityIdsByHandle(handle, platform); }
  searchIdentities(term: string, limit = 20): IdentityRecord[] { return this.store.searchIdentities(term, limit); }
  getIdentitiesByIds(identityIds: string[]): IdentityRecord[] { return this.store.getIdentitiesByIds(identityIds); }
  getAllIdentities(): IdentityRecord[] { return this.store.getAllIdentities(); }
  getAllEdges(): IdentityEdge[] { return this.store.getAllEdges(); }
  getEdgesForIdentity(identityId: string): IdentityEdge[] { return this.store.getEdgesForIdentity(identityId); }

  upsertIdentity(input: IdentityUpsertInput): IdentityRecord { return this.withTransaction(() => this.store.upsertIdentity(input)); }
  linkIdentities(input: IdentityLinkInput): IdentityEdge { return this.withTransaction(() => this.store.upsertEdge(input)); }
  async resolveIdentity(input: ResolveIdentityInput): Promise<IdentityResolution> { return this.resolver.resolveIdentity(input); }

  getNeighborhood(identityId: string, depth = 1): { center: IdentityRecord | null; identities: IdentityRecord[]; edges: IdentityEdge[]; depth: number } {
    const center = this.getIdentity(identityId);
    if (!center) return { center: null, identities: [], edges: [], depth };

    const allEdges = this.getAllEdges();
    const seen = new Set<string>([identityId]);
    let frontier = new Set<string>([identityId]);
    const edgeIds = new Set<string>();

    for (let level = 0; level < depth; level += 1) {
      const next = new Set<string>();
      for (const edge of allEdges) {
        if (frontier.has(edge.fromIdentityId)) {
          edgeIds.add(edge.edgeId);
          if (!seen.has(edge.toIdentityId)) next.add(edge.toIdentityId);
          seen.add(edge.toIdentityId);
        }
        if (frontier.has(edge.toIdentityId)) {
          edgeIds.add(edge.edgeId);
          if (!seen.has(edge.fromIdentityId)) next.add(edge.fromIdentityId);
          seen.add(edge.fromIdentityId);
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    return { center, identities: this.getIdentitiesByIds([...seen]), edges: allEdges.filter((edge) => edgeIds.has(edge.edgeId)), depth };
  }

  queryGraph(query: IdentityQuery): { query: string; kind?: string; center: IdentityRecord | null; matches: IdentityRecord[]; identities: IdentityRecord[]; edges: IdentityEdge[]; depth: number } {
    const depth = Math.max(0, Math.min(6, query.depth ?? 1));
    const limit = Math.max(1, Math.min(100, query.limit ?? 10));
    const rawQuery = query.query ? query.query.trim() : '';
    let center: IdentityRecord | null = null;
    let matches: IdentityRecord[] = [];
    let identities: IdentityRecord[] = [];
    let edges: IdentityEdge[] = [];

    if (query.identityId) {
      center = this.getIdentity(query.identityId);
      if (center) {
        const neighborhood = this.getNeighborhood(center.identityId, depth);
        matches = [center];
        identities = neighborhood.identities;
        edges = neighborhood.edges;
      }
    } else if (rawQuery) {
      matches = this.searchIdentities(rawQuery, limit).filter((identity) => !query.kind || identity.kind === query.kind).slice(0, limit);
      center = matches[0] || null;
      if (center) {
        const neighborhood = this.getNeighborhood(center.identityId, depth);
        identities = neighborhood.identities;
        edges = neighborhood.edges;
      }
    }

    return { query: rawQuery, kind: query.kind, center, matches, identities: identities.length > 0 ? identities : matches, edges, depth };
  }

  async findRelationshipPaths(from: ResolveIdentityInput, to: ResolveIdentityInput, options: { maxDepth?: number; allowedEdgeKinds?: IdentityEdgeKind[] } = {}): Promise<IdentityPath[]> {
    const path = await this.findRelationshipPath(from, to, options);
    return path ? [path] : [];
  }

  async findRelationshipPath(from: ResolveIdentityInput, to: ResolveIdentityInput, options: { maxDepth?: number; allowedEdgeKinds?: IdentityEdgeKind[] } = {}): Promise<IdentityPath | null> {
    const fromResolution = await this.resolveIdentity(from);
    const toResolution = await this.resolveIdentity(to);
    const fromIdentityId = identityIdOf(fromResolution);
    const toIdentityId = identityIdOf(toResolution);
    if (!fromIdentityId || !toIdentityId) return null;
    if (fromIdentityId === toIdentityId) {
      const identity = this.getIdentity(fromIdentityId);
      return identity ? { fromIdentityId, toIdentityId, nodes: [identity], edges: [], confidence: 1, hops: 0 } : null;
    }

    const maxDepth = Math.max(1, Math.min(8, options.maxDepth ?? 4));
    const allowed = options.allowedEdgeKinds ? new Set(options.allowedEdgeKinds) : null;
    const nodeMap = new Map(this.getAllIdentities().map((identity) => [identity.identityId, identity] as const));
    const adjacency = new Map<string, Array<{ nextId: string; step: IdentityPathStep }>>();

    for (const edge of this.getAllEdges()) {
      if (allowed && !allowed.has(edge.edgeKind)) continue;
      const forward: IdentityPathStep = { fromIdentityId: edge.fromIdentityId, toIdentityId: edge.toIdentityId, edgeId: edge.edgeId, edgeKind: edge.edgeKind, direction: 'forward', confidence: edge.confidence };
      const reverse: IdentityPathStep = { fromIdentityId: edge.toIdentityId, toIdentityId: edge.fromIdentityId, edgeId: edge.edgeId, edgeKind: edge.edgeKind, direction: 'reverse', confidence: edge.bidirectional ? edge.confidence : Math.max(0.55, edge.confidence - 0.08) };
      const forwardList = adjacency.get(edge.fromIdentityId) || [];
      forwardList.push({ nextId: edge.toIdentityId, step: forward });
      adjacency.set(edge.fromIdentityId, forwardList);
      const reverseList = adjacency.get(edge.toIdentityId) || [];
      reverseList.push({ nextId: edge.fromIdentityId, step: reverse });
      adjacency.set(edge.toIdentityId, reverseList);
    }

    const queue: Array<{ id: string; path: IdentityPathStep[] }> = [{ id: fromIdentityId, path: [] }];
    const bestDepth = new Map<string, number>([[fromIdentityId, 0]]);

    while (queue.length > 0) {
      const current = queue.shift() as { id: string; path: IdentityPathStep[] };
      if (current.path.length >= maxDepth) continue;
      const neighbors = adjacency.get(current.id) || [];
      for (const neighbor of neighbors) {
        const nextPath = current.path.concat([neighbor.step]);
        if (neighbor.nextId === toIdentityId) {
          const nodes = [fromIdentityId].concat(nextPath.map((step) => step.toIdentityId)).map((id) => nodeMap.get(id)).filter(Boolean) as IdentityRecord[];
          return { fromIdentityId, toIdentityId, nodes, edges: nextPath, confidence: pathConfidence(nextPath), hops: nextPath.length };
        }
        const nextDepth = nextPath.length;
        const recorded = bestDepth.get(neighbor.nextId);
        if (recorded !== undefined && recorded <= nextDepth) continue;
        bestDepth.set(neighbor.nextId, nextDepth);
        queue.push({ id: neighbor.nextId, path: nextPath });
      }
    }

    return null;
  }
}
