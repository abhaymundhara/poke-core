import type { IdentityPlatform, IdentityRecord, IdentityResolution, IdentityResolutionSignal, ResolveIdentityInput } from './types.ts';

export interface IdentityLookupStore {
  getIdentity(identityId: string): IdentityRecord | null;
  findIdentityIdsByEmail(email: string): string[];
  findIdentityIdsByPhone(phone: string): string[];
  findIdentityIdsByHandle(handle: string, platform?: string): string[];
  searchIdentities(term: string, limit?: number): IdentityRecord[];
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value: string): string { return text(value).toLowerCase(); }
function normalizePhone(value: string): string {
  const trimmed = text(value);
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/D/g, '');
  return hasPlus ? '+' + digits : digits;
}
function canonicalPlatform(platform: string): string { return text(platform).toLowerCase() === 'x' ? 'twitter' : text(platform).toLowerCase(); }
function normalizeHandle(value: string): string { return text(value).replace(/^@+/, '').toLowerCase(); }
function normalizeGeneral(value: string): string { return text(value).toLowerCase(); }
function normalizeWhitespace(value: string): string { return text(value).replace(/s+/g, ' '); }

function combineConfidence(scores: number[]): number {
  let confidence = 0;
  for (const score of scores) confidence = 1 - (1 - confidence) * (1 - clamp(score, 0, 0.99));
  return clamp(confidence, 0, 0.99);
}

function parseQuery(input: ResolveIdentityInput): { query: string; email?: string; phone?: string; handle?: string; platform?: IdentityPlatform; identityId?: string; name?: string } {
  if (typeof input !== 'string') {
    const query = normalizeWhitespace([input.identityId, input.email, input.phone, input.handle, input.name, input.query].filter(Boolean).map(String).join(' '));
    return { query, identityId: input.identityId ? text(input.identityId) : undefined, email: input.email ? text(input.email) : undefined, phone: input.phone ? text(input.phone) : undefined, handle: input.handle ? text(input.handle) : undefined, platform: input.platform, name: input.name ? text(input.name) : undefined };
  }

  const query = text(input);
  if (!query) return { query: '' };
  if (/^[^s@]+@[^s@]+.[^s@]+$/.test(query)) return { query, email: query };
  if (/^+?[ds().-]{7,}$/.test(query)) return { query, phone: query };
  const platformHandle = query.match(/^([a-z0-9-]+):@?([a-z0-9._-]+)$/i);
  if (platformHandle) return { query, platform: canonicalPlatform(platformHandle[1]), handle: platformHandle[2] };
  if (query.startsWith('@') && query.length > 1) return { query, handle: query.slice(1) };
  if (query.includes('/') && /github|twitter|linkedin/i.test(query)) {
    const trailing = query.split('/').filter(Boolean).at(-1) || query;
    return { query, handle: trailing };
  }
  return { query, name: query };
}

type CandidateDraft = {
  identity: IdentityRecord;
  confidenceScores: number[];
  matchedBy: IdentityResolutionSignal;
  reasonParts: string[];
  signals: Set<string>;
  bestSignalScore: number;
};

function draftCandidate(identity: IdentityRecord, matchedBy: IdentityResolutionSignal): CandidateDraft {
  return { identity, confidenceScores: [], matchedBy, reasonParts: [], signals: new Set<string>(), bestSignalScore: 0 };
}

export class IdentityResolver {
  constructor(private readonly store: IdentityLookupStore) {}

  resolveIdentity(input: ResolveIdentityInput): IdentityResolution {
    const parsed = parseQuery(input);
    const candidates = new Map<string, CandidateDraft>();

    const add = (identity: IdentityRecord, score: number, matchedBy: IdentityResolutionSignal, reason: string, signal: string) => {
      const existing = candidates.get(identity.identityId) || draftCandidate(identity, matchedBy);
      existing.confidenceScores.push(score);
      existing.reasonParts.push(reason);
      existing.signals.add(signal);
      if (score >= existing.bestSignalScore) {
        existing.bestSignalScore = score;
        existing.matchedBy = matchedBy;
      }
      candidates.set(identity.identityId, existing);
    };

    if (parsed.identityId) {
      const direct = this.store.getIdentity(parsed.identityId);
      if (direct) add(direct, 1, 'identityId', 'matched identity id ' + parsed.identityId, 'identityId:' + parsed.identityId);
    }

    if (parsed.email) {
      const email = normalizeEmail(parsed.email);
      for (const identityId of this.store.findIdentityIdsByEmail(email)) {
        const identity = this.store.getIdentity(identityId);
        if (!identity) continue;
        const emailEntry = identity.verifiedEmails.find((entry) => normalizeEmail(entry.email) === email);
        add(identity, emailEntry && emailEntry.verified ? 0.99 : 0.84, 'email', 'matched email ' + email, 'email:' + email);
      }
    }

    if (parsed.phone) {
      const phone = normalizePhone(parsed.phone);
      for (const identityId of this.store.findIdentityIdsByPhone(phone)) {
        const identity = this.store.getIdentity(identityId);
        if (!identity) continue;
        const phoneEntry = identity.phoneNumbers.find((entry) => normalizePhone(entry.phoneNumber) === phone);
        add(identity, phoneEntry && phoneEntry.verified ? 0.96 : 0.8, 'phone', 'matched phone ' + phone, 'phone:' + phone);
      }
    }

    if (parsed.handle) {
      const handle = normalizeHandle(parsed.handle);
      const platform = parsed.platform ? canonicalPlatform(String(parsed.platform)) : undefined;
      for (const identityId of this.store.findIdentityIdsByHandle(handle, platform)) {
        const identity = this.store.getIdentity(identityId);
        if (!identity) continue;
        const handleEntry = identity.platformHandles.find((entry) => normalizeHandle(entry.handle) === handle && (!platform || canonicalPlatform(entry.platform) === platform));
        add(identity, handleEntry && handleEntry.verified ? 0.94 : 0.82, 'handle', platform ? 'matched ' + platform + ':' + handle : 'matched handle ' + handle, platform ? 'handle:' + platform + ':' + handle : 'handle:' + handle);
      }
    }

    const query = parsed.name || parsed.query;
    if (query) {
      const normalizedQuery = normalizeGeneral(query);
      for (const identity of this.store.searchIdentities(query, 20)) {
        const aliases = new Set(identity.aliases.map(normalizeGeneral));
        const nameNormalized = normalizeGeneral(identity.name);
        const isExactAlias = aliases.has(normalizedQuery);
        const isExactName = nameNormalized === normalizedQuery;
        const isPartial = nameNormalized.includes(normalizedQuery) || [...aliases].some((alias) => alias.includes(normalizedQuery));
        const score = isExactAlias ? 0.76 : isExactName ? 0.7 : isPartial ? 0.58 : 0.5;
        add(identity, score, isExactAlias ? 'alias' : 'name', isExactAlias ? 'matched alias ' + query : isExactName ? 'matched name ' + query : 'matched text ' + query, 'query:' + normalizedQuery);
      }
    }

    const ranked = [...candidates.values()].map((candidate) => ({ identity: candidate.identity, confidence: combineConfidence(candidate.confidenceScores), matchedBy: candidate.matchedBy, reason: candidate.reasonParts.join('; '), signals: [...candidate.signals] })).sort((a, b) => b.confidence - a.confidence || a.identity.name.localeCompare(b.identity.name));

    return { query: parsed.query, normalizedQuery: normalizeGeneral(parsed.query), candidates: ranked, bestMatch: ranked[0] || null };
  }
}

export async function resolveIdentity(input: ResolveIdentityInput, store: IdentityLookupStore): Promise<IdentityResolution> {
  return new IdentityResolver(store).resolveIdentity(input);
}
