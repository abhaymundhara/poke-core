import type { SearchIntent, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { average, clamp, hostname, words } from './utils.ts';

const OFFICIAL_DOMAINS = [/\.gov$/i, /\.edu$/i, /github\.com$/i, /docs\./i, /developer\./i, /openai\.com$/i];
const LOW_QUALITY_DOMAINS = [/medium\.com$/i, /substack\.com$/i, /quora\.com$/i, /reddit\.com$/i];

function daysOld(publishedAt?: string | null): number | null {
  if (!publishedAt) return null;
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (Date.now() - time) / 86_400_000);
}

function recencyScore(intent: SearchIntent, result: SearchResult): number {
  const explicit = typeof result.freshness === 'number' ? result.freshness : null;
  if (explicit !== null) return clamp(explicit);
  const age = daysOld(result.publishedAt);
  if (age === null) return intent.freshness === 'live' ? 0.45 : 0.62;
  if (intent.freshness === 'live') return clamp(1 - age / 14);
  if (intent.freshness === 'recent') return clamp(1 - age / 120);
  return clamp(0.72 + Math.min(age, 3650) / 3650 * 0.18);
}

function evidenceQuality(intent: SearchIntent, result: SearchResult): number {
  const text = `${result.title} ${result.snippet} ${(result.claims ?? []).join(' ')}`;
  const termHits = intent.evidenceTerms.filter((term) => words(text).includes(term.toLowerCase())).length;
  const claimBonus = (result.claims?.length ?? 0) > 0 ? 0.14 : 0;
  const citationBonus = /(doi:|arxiv|citation|study|official|docs|source)/i.test(text) ? 0.14 : 0;
  return clamp(0.42 + Math.min(0.28, termHits * 0.04) + claimBonus + citationBonus + (result.score ?? 0) * 0.12);
}

function provenanceScore(domain: string, source: SearchSource | string): number {
  const official = OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain));
  const lowQuality = LOW_QUALITY_DOMAINS.some((pattern) => pattern.test(domain));
  const sourceBase = source === 'scholar' || source === 'github' ? 0.82 : source === 'realtime-web' ? 0.72 : source === 'memory' ? 0.58 : 0.66;
  return clamp(sourceBase + (official ? 0.14 : 0) - (lowQuality ? 0.16 : 0));
}

function corroborationScore(result: SearchResult, all: SearchResult[]): number {
  const resultTerms = new Set(words(`${result.title} ${result.snippet} ${(result.claims ?? []).join(' ')}`));
  const overlaps = all.filter((other) => other !== result).map((other) => {
    const otherTerms = new Set(words(`${other.title} ${other.snippet} ${(other.claims ?? []).join(' ')}`));
    const shared = [...resultTerms].filter((term) => otherTerms.has(term)).length;
    return shared / Math.max(1, Math.min(resultTerms.size, otherTerms.size));
  });
  return clamp(0.45 + Math.min(0.4, average(overlaps) * 1.2) + (new Set(all.map((entry) => hostname(entry.url))).size > 1 ? 0.08 : 0));
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}): TrustedEvidence[] {
  return results.map((result) => {
    const domain = hostname(result.url);
    const official = OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain));
    const primary = official || result.source === 'github' || result.source === 'scholar';
    const breakdown: TrustScoreBreakdown = {
      evidenceQuality: evidenceQuality(intent, result),
      provenance: provenanceScore(domain, result.source),
      recency: recencyScore(intent, result),
      corroboration: corroborationScore(result, results),
      domainReliability: reliability[result.source]?.score ?? reliability[domain]?.score ?? result.trust ?? 0.62,
    };
    const trustScore = clamp(
      breakdown.evidenceQuality * 0.26 +
      breakdown.provenance * 0.24 +
      breakdown.recency * 0.16 +
      breakdown.corroboration * 0.18 +
      breakdown.domainReliability * 0.16,
    );
    return { ...result, trustScore, trustBreakdown: breakdown, trust: trustScore, provenance: { domain, source: result.source, official, primary } };
  }).sort((left, right) => right.trustScore - left.trustScore);
}

export function sourceScoreFor(source: SearchSource | string, intent: SearchIntent, reliability: Record<string, SearchSourceReliability>): number {
  const base = reliability[source]?.score ?? 0.6;
  const prior = intent.sourcePriors.find((entry) => entry.source === source)?.weight ?? 0;
  const freshnessBonus = source === 'realtime-web' && intent.freshness === 'live' ? 0.16 : 0;
  const trustBonus = (source === 'scholar' || source === 'github') && intent.trustMode === 'official-first' ? 0.12 : 0;
  return clamp(base * 0.68 + prior * 0.24 + freshnessBonus + trustBonus);
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const candidates = [...new Set([...intent.sourcePriors.map((prior) => prior.source), ...intent.sourceHints, 'web', 'realtime-web', 'github', 'scholar', 'memory'])];
  return candidates.map((source) => ({
    source,
    score: sourceScoreFor(source, intent, reliability),
    reason: intent.sourcePriors.find((prior) => prior.source === source)?.reason ?? (source === 'realtime-web' ? 'freshness coverage' : source === 'scholar' ? 'citation coverage' : 'general coverage'),
  })).sort((left, right) => right.score - left.score);
}
