import type { EpistemicTrustModel, PolicyDecision, SearchIntent, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence } from './types.ts';
import { clamp, stableHash, uniq } from './utils.ts';

function baseModel(): EpistemicTrustModel {
  return {
    version: 2,
    calibration: 0.66,
    classPriors: { primary: 0.5, expert: 0.5, institutional: 0.5, community: 0.5, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: [1, 0, 0, 0],
      expert: [0, 1, 0, 0],
      institutional: [0, 0, 1, 0],
      community: [0, 0, 0, 1],
      unknown: [0.25, 0.25, 0.25, 0.25],
    },
    corroborationGraph: {},
  };
}

function modelEntry(source: string, score: number, useful: boolean, notes: string[]): any {
  const mean = clamp(score);
  const variance = clamp(0.18 + Math.abs(0.5 - mean) * 0.6);
  return {
    mean,
    variance,
    sampleSize: 1,
    successes: useful ? 1 : 0,
    failures: useful ? 0 : 1,
    lastObservedAt: Date.now(),
    notes,
    epistemicClass: source === 'github' || source === 'web' ? 'primary' : source === 'scholar' ? 'expert' : 'unknown',
    representation: [mean, 1 - variance, useful ? 1 : 0, notes.length ? 0.8 : 0.4],
    corroboration: { [source]: mean },
    classPosterior: { primary: mean, expert: mean * 0.92, institutional: mean * 0.88, community: mean * 0.9, unknown: mean * 0.8 },
  };
}

function safeDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www./, ''); } catch { return ''; }
}

function sourceFromReliability(reliability?: Record<string, SearchSourceReliability>, source?: SearchSource | string): number {
  if (!source) return 0.56;
  return clamp(reliability?.[String(source)]?.score ?? 0.56);
}

function sourceHintWeight(intent: SearchIntent, source: SearchSource | string): number {
  const prior = intent.sourcePriors.find((entry) => entry.source === source);
  return clamp(prior?.weight ?? (intent.sourceHints.includes(source as SearchSource) ? 0.74 : 0.5));
}

function trustBreakdown(intent: SearchIntent, result: SearchResult, reliabilityScore: number, corroborationScore: number, decision?: PolicyDecision): TrustedEvidence['trustBreakdown'] {
  const trustSignal = clamp(result.trust ?? result.score ?? 0.5);
  const freshness = clamp(result.freshness ?? (result.publishedAt ? 0.72 : 0.48));
  const evidenceQuality = clamp(0.48 + Math.min(0.24, (result.claims?.length ?? 0) * 0.06) + Math.min(0.18, result.snippet.length / 800));
  const provenance = clamp(0.45 + sourceHintWeight(intent, result.source) * 0.25 + reliabilityScore * 0.3);
  const recency = freshness;
  const corroboration = clamp(0.3 + corroborationScore * 0.5 + (decision?.requireCorroboration ? 0.1 : 0));
  const domainReliability = clamp(reliabilityScore);
  const expertise = clamp(result.source === 'scholar' || result.source === 'github' ? 0.78 : result.source === 'memory' ? 0.54 : 0.66);
  const independence = clamp(0.45 + (new Set((result.claims ?? []).map((claim) => stableHash(claim).slice(0, 4))).size / Math.max(1, (result.claims ?? []).length || 1)) * 0.25);
  const uncertainty = clamp(1 - (trustSignal * 0.58 + provenance * 0.2 + corroboration * 0.12 + recency * 0.1));
  return { evidenceQuality, provenance, recency, corroboration, domainReliability, expertise, independence, uncertainty };
}

function epistemicClassFor(result: SearchResult): 'primary' | 'expert' | 'institutional' | 'community' | 'unknown' {
  const source = String(result.source);
  if (source === 'github' || /(api|docs|source|spec|release notes)/i.test(result.snippet)) return 'primary';
  if (source === 'scholar' || /(study|paper|research|analysis|citation)/i.test(result.snippet)) return 'expert';
  if (source === 'calendar' || source === 'email') return 'institutional';
  if (source === 'memory' || source === 'integration') return 'community';
  return 'unknown';
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const current = (model ?? baseModel()) as EpistemicTrustModel;
  const source = String(outcome.source ?? 'web');
  const domain = outcome.resultDomains?.[0] ?? source;
  const useful = outcome.useful ?? outcome.score >= 0.7;
  const notes = outcome.notes ?? [];
  const next: EpistemicTrustModel = {
    ...current,
    sourceMemory: { ...current.sourceMemory },
    domainMemory: { ...current.domainMemory },
    corroborationGraph: { ...current.corroborationGraph },
    classPriors: { ...current.classPriors },
  };
  next.sourceMemory[source] = modelEntry(source, outcome.score, useful, notes);
  next.domainMemory[domain] = modelEntry(domain, clamp(outcome.score * 0.96 + (outcome.resultDomains?.length ?? 0) * 0.02), useful, notes);
  const sourceGraph = next.corroborationGraph[source] ?? {};
  sourceGraph[domain] = clamp((sourceGraph[domain] ?? 0.2) * 0.7 + outcome.score * 0.3);
  next.corroborationGraph[source] = sourceGraph;
  next.calibration = clamp(next.calibration * 0.9 + outcome.score * 0.1 + (useful ? 0.03 : -0.02));
  return next;
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability?: Record<string, SearchSourceReliability>, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  const sourceCounts = results.reduce<Record<string, number>>((counts, result) => {
    const key = String(result.source);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const resultsByDomain = results.reduce<Record<string, SearchResult[]>>((map, result) => {
    const domain = safeDomain(result.url) || String(result.source);
    (map[domain] ??= []).push(result);
    return map;
  }, {});
  const activeDecision = decision ?? { requireCorroboration: false, preferProviderNlu: false, sourceBoosts: {}, matchedRules: [] };
  const trustworthy = results.map((result) => {
    const source = String(result.source);
    const domain = safeDomain(result.url) || source;
    const sourceReliability = sourceFromReliability(reliability, source);
    const domainReliability = sourceFromReliability(reliability, domain);
    const corroborationScore = clamp((resultsByDomain[domain]?.length ?? 1) / Math.max(1, results.length));
    const breakdown = trustBreakdown(intent, result, Math.max(sourceReliability, domainReliability), corroborationScore, activeDecision);
    const sourceBoost = activeDecision.sourceBoosts[source] ?? 1;
    const trustScore = clamp(Math.max(0.24, (result.trust ?? result.score ?? 0.5) * 0.24 + breakdown.evidenceQuality * 0.14 + breakdown.provenance * 0.18 + breakdown.recency * 0.12 + breakdown.corroboration * 0.12 + breakdown.domainReliability * 0.1 + breakdown.expertise * 0.08 + breakdown.independence * 0.04 + (policy?.reasoningArchitecture?.primaryReasoner === 'hybrid' ? 0.03 : 0)) * sourceBoost);
    return {
      ...result,
      trustScore,
      trustBreakdown: breakdown,
      reliability: {
        mean: clamp((reliability?.[source]?.score ?? trustScore) * 0.7 + trustScore * 0.3),
        variance: clamp(1 - trustScore),
        sampleSize: sourceCounts[source] ?? 1,
        failureModes: trustScore < 0.5 ? ['low-evidence-confidence'] : [],
        epistemicClass: epistemicClassFor(result),
      },
      provenance: { domain, source, official: /github.com|docs|support|help/i.test(domain), primary: result.source === 'github' || result.source === 'scholar' },
    };
  });
  return trustworthy.sort((left, right) => right.trustScore - left.trustScore);
}

export function buildSourceRanking(intent: SearchIntent, reliability?: Record<string, SearchSourceReliability>, rules?: SearchPolicyRule[], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const seen = new Set<string>();
  const sources = uniq([
    ...intent.sourceHints,
    ...Object.keys(reliability ?? {}),
    ...(decision ? Object.keys(decision.sourceBoosts) : []),
  ].filter((source): source is SearchSource | string => Boolean(source)));
  const ranked = sources.map((source) => {
    const key = String(source);
    if (seen.has(key)) return null;
    seen.add(key);
    const prior = intent.sourcePriors.find((entry) => entry.source === source);
    const reliabilityScore = clamp(reliability?.[key]?.score ?? prior?.weight ?? 0.5);
    const boost = clamp(decision?.sourceBoosts[key] ?? 1);
    const ruleBoost = (rules ?? []).some((rule) => rule.enabled && rule.sourceWeights?.[source as SearchSource]) ? 1.06 : 1;
    const score = clamp((0.28 + reliabilityScore * 0.42 + (prior?.weight ?? 0.5) * 0.2) * boost * ruleBoost);
    const reason = (prior ? 'intent-prior' : 'observed-source') + ':' + reliabilityScore.toFixed(2);
    return { source, score, reason };
  }).filter((entry): entry is { source: SearchSource | string; score: number; reason: string } => Boolean(entry));
  if (!ranked.length) return [{ source: intent.sourceHints[0] ?? 'web', score: 0.56, reason: 'fallback-source' }];
  return ranked.sort((left, right) => right.score - left.score);
}
