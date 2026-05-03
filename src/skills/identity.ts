import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { IdentityGraph, type IdentityQuery, type IdentityUpsertInput, type ResolveIdentityInput, type IdentityEdgeKind, type IdentityKind, type IdentityLinkInput } from '../identity/index.ts';
import type { SkillAdapter } from './types';

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function clamp(value: number, min = 0, max = 1): number { if (!Number.isFinite(value)) return min; return Math.min(max, Math.max(min, value)); }

function parseResolveInput(args: Record<string, unknown>): ResolveIdentityInput {
  if (text(args.identityId) || text(args.email) || text(args.phone) || text(args.handle) || text(args.query) || text(args.name)) {
    return { identityId: text(args.identityId) || undefined, email: text(args.email) || undefined, phone: text(args.phone) || undefined, handle: text(args.handle) || undefined, platform: text(args.platform) || undefined, query: text(args.query) || text(args.name) || undefined, name: text(args.name) || undefined };
  }
  return text(args.value) || text(args.identifier) || '';
}

function buildIdentityInput(args: Record<string, unknown>): IdentityUpsertInput {
  const identity = record(args.identity);
  const metadata = { ...record(identity.metadata), ...record(args.metadata) };
  const name = text(identity.name) || text(args.name) || text(args.query) || text(args.label);
  if (!name) throw new Error('identity upsert requires a name');
  return {
    identityId: text(identity.identityId) || text(args.identityId) || undefined,
    kind: (text(identity.kind) || text(args.kind) || 'contact') as IdentityKind,
    name,
    aliases: [...new Set([...list(identity.aliases), ...list(args.aliases)].map((entry) => text(entry)).filter(Boolean))],
    verifiedEmails: [...list(identity.verifiedEmails), ...list(args.verifiedEmails)] as IdentityUpsertInput['verifiedEmails'],
    phoneNumbers: [...list(identity.phoneNumbers), ...list(args.phoneNumbers)] as IdentityUpsertInput['phoneNumbers'],
    platformHandles: [...list(identity.platformHandles), ...list(args.platformHandles)] as IdentityUpsertInput['platformHandles'],
    metadata,
  };
}

function buildQuery(args: Record<string, unknown>): IdentityQuery {
  return { identityId: text(args.identityId) || undefined, query: text(args.query) || text(args.name) || text(args.term) || undefined, kind: (text(args.kind) || undefined) as IdentityKind | undefined, depth: typeof args.depth === 'number' ? args.depth : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined };
}

function defaultAction(step: PlanStep, args: Record<string, unknown>): string {
  const action = text(args.action) || text(args.operation) || text(args.mode);
  if (action) return action.toLowerCase();
  if (text(args.to) || text(args.target) || text(args.toIdentityId) || text(args.from) || text(args.fromIdentityId)) return 'path';
  if (text(args.identityId) || text(args.query) || text(args.email) || text(args.phone) || text(args.handle) || text(args.name)) return 'resolve';
  return step.skill === 'identity' ? 'query' : 'resolve';
}

const DEFAULT_IDENTITY_GRAPH = (() => { let graph: IdentityGraph | null = null; return () => { graph = graph || new IdentityGraph(); return graph; }; })();

export class IdentitySkill implements SkillAdapter {
  descriptor: SkillDescriptor = { name: 'identity', domain: 'identity-graph', capabilities: ['resolve-identity', 'query-graph', 'update-associations', 'find-relationship-path', 'upsert-identity', 'link-identities'], version: '1.0.0' };
  constructor(private readonly graph: IdentityGraph = DEFAULT_IDENTITY_GRAPH()) {}
  canHandle(step: PlanStep): boolean { return step.skill === 'identity' || step.kind === 'grounding' || step.kind === 'user-modeling'; }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = record(ctx.step.args);
    const action = defaultAction(ctx.step, args);

    try {
      if (action === 'upsert' || action === 'update' || action === 'associate') {
        const identity = this.graph.upsertIdentity(buildIdentityInput(args));
        const links = list(args.links).map((entry) => record(entry)).filter((entry) => text(entry.toIdentityId) || text(entry.to) || text(entry.target));
        const createdEdges = links.map((entry): IdentityLinkInput => ({ fromIdentityId: identity.identityId, toIdentityId: text(entry.toIdentityId) || text(entry.to) || text(entry.target), edgeKind: (text(entry.edgeKind) || text(args.edgeKind) || 'colleague') as IdentityEdgeKind, confidence: clamp(typeof entry.confidence === 'number' ? entry.confidence : typeof args.confidence === 'number' ? args.confidence : 0.9), bidirectional: typeof entry.bidirectional === 'boolean' ? entry.bidirectional : typeof args.bidirectional === 'boolean' ? args.bidirectional : undefined, metadata: { ...record(args.metadata), ...record(entry.metadata) } }));
        const edges = createdEdges.map((link) => this.graph.linkIdentities(link));
        const output = { operation: 'upsert', identity, edges };
        ctx.state.artifacts[ctx.step.id] = output;
        ctx.state.outputs[ctx.step.id] = output;
        return { ok: true, output, retryable: false, note: 'identity stored', trace: { identityId: identity.identityId, createdEdges: edges.length } };
      }

      if (action === 'link' || action === 'connect') {
        const fromInput = text(args.fromIdentityId) || text(args.from) || text(args.source) || text(args.left);
        const toInput = text(args.toIdentityId) || text(args.to) || text(args.target) || text(args.right);
        const fromResolution = await this.graph.resolveIdentity(parseResolveInput({ identityId: fromInput, query: fromInput }));
        const toResolution = await this.graph.resolveIdentity(parseResolveInput({ identityId: toInput, query: toInput }));
        const fromIdentityId = fromResolution.bestMatch ? fromResolution.bestMatch.identity.identityId : '';
        const toIdentityId = toResolution.bestMatch ? toResolution.bestMatch.identity.identityId : '';
        if (!fromIdentityId || !toIdentityId) throw new Error('unable to resolve both identities for link');
        const edge = this.graph.linkIdentities({ fromIdentityId, toIdentityId, edgeKind: (text(args.edgeKind) || 'colleague') as IdentityEdgeKind, confidence: clamp(typeof args.confidence === 'number' ? args.confidence : 0.9), bidirectional: typeof args.bidirectional === 'boolean' ? args.bidirectional : undefined, metadata: record(args.metadata) });
        const output = { operation: 'link', edge, from: fromResolution.bestMatch, to: toResolution.bestMatch };
        ctx.state.artifacts[ctx.step.id] = output;
        ctx.state.outputs[ctx.step.id] = output;
        return { ok: true, output, retryable: false, note: 'relationship stored', trace: { edgeId: edge.edgeId, edgeKind: edge.edgeKind } };
      }

      if (action === 'path' || action === 'relationship-path' || action === 'find-path') {
        const from = text(args.fromIdentityId) || text(args.from) || text(args.source) || text(args.left);
        const to = text(args.toIdentityId) || text(args.to) || text(args.target) || text(args.right);
        if (!from || !to) throw new Error('path search requires from and to identities');
        const path = await this.graph.findRelationshipPath(from, to, { maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : typeof args.depth === 'number' ? args.depth : 4, allowedEdgeKinds: list(args.allowedEdgeKinds).map((value) => text(value)).filter(Boolean) as IdentityEdgeKind[] });
        const output = { operation: 'path', path };
        ctx.state.artifacts[ctx.step.id] = output;
        ctx.state.outputs[ctx.step.id] = output;
        return { ok: Boolean(path), output, retryable: false, note: path ? 'relationship path found' : 'no relationship path found', trace: { pathFound: Boolean(path), hops: path ? path.hops : 0 } };
      }

      if (action === 'query' || action === 'lookup' || action === 'search') {
        const query = buildQuery(args);
        const result = this.graph.queryGraph(query);
        const output = { operation: 'query', result };
        ctx.state.artifacts[ctx.step.id] = output;
        ctx.state.outputs[ctx.step.id] = output;
        return { ok: true, output, retryable: false, note: 'graph query completed', trace: { matches: result.matches.length, edges: result.edges.length } };
      }

      const resolution = await this.graph.resolveIdentity(parseResolveInput(args));
      const output = { operation: 'resolve', resolution };
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;
      return { ok: Boolean(resolution.bestMatch), output, retryable: false, note: resolution.bestMatch ? 'identity resolved' : 'no matching identity found', trace: { candidates: resolution.candidates.length, bestMatchConfidence: resolution.bestMatch ? resolution.bestMatch.confidence : 0 } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = { operation: action, error: message };
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;
      return { ok: false, output, retryable: false, note: 'identity skill failed', trace: { error: message } };
    }
  }
}
