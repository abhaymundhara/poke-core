import type { PolicyDecision, SearchIntent, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { average, clamp, hostname, normalize, uniq } from './utils.ts';

function sourceKey(source: SearchSource | string): string {
  return normalize(String(source)) || String(source);
}

function domainKey(result: SearchResult): string {
  try {
    return hostname(result.url);
  } catch {
    return '';
  }
}

function claimText(result: SearchResult): string {
  return [result.title, result.snippet, ...(result.claims ?? [])].join(' ');
}

function makeEntry(epistemicClass: TrustedEvidence['reliability']['epistemicClass'] = 'unknown') {
  return {
    mean: 0.5,
    variance: 0.2,
    evidenceCount: 0,
    successes: 0,
    failures: 0,
    lastObservedAt: null as number | null,
    notes: [] as string[],
    epistemicClass,
    representation: [0.2, 0.2, 0.2, 0.2, 0.2],
    corroboration: {} as Record<string, number>,
    classPosterior: { primary: 0.2, expert: 0.2, institutional: 0.2, community: 0.2, unknown: 0.2 },
  };
}

function epistemicClassFromMean(mean: number): TrustedEvidence['reliability']['epistemicClass'] {
  if (mean >= 0.82) return 'primary';
  if (mean >= 0.7) return 'expert';
  if (mean >= 0.58) return 'institutional';
  if (mean >= 0.48) return 'community';
  return 'unknown';
}

function ensureModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined): NonNullable<SearchPolicyState['epistemicModel']> {
  const next = model ?? {
    version: 1,
    calibration: 0.5,
    classPriors: { primary: 0.5, expert: 0.5, institutional: 0.5, community: 0.5, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: [1, 0, 0, 0, 0],
      expert: [0, 1, 0, 0, 0],
      institutional: [0, 0, 1, 0, 0],
      community: [0, 0, 0, 1, 0],
      unknown: [0, 0, 0, 0, 1],
    },
    corroborationGraph: {},
  };
  next.sourceMemory ??= {};
  next.domainMemory ??= {};
  next.corroborationGraph ??= {};
  next.knowledgeClassRepresentations ??= {
    primary: [1, 0, 0, 0, 0],
    expert: [0, 1, 0, 0, 0],
    institutional: [0, 0, 1, 0, 0],
    community: [0, 0, 0, 1, 0],
    unknown: [0, 0, 0, 0, 1],
  };
  return next;
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return ensureModel(undefined);
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const next = ensureModel(model);
  const useful = outcome.useful ?? outcome.score >= 0.7;
  const source = sourceKey(outcome.source);
  const domains = uniq((outcome.resultDomains ?? []).filter(Boolean).map((value) => normalize(value)));
  const domain = domains[0] ?? source;
  const sourceEntry = next.sourceMemory[source] ?? (next.sourceMemory[source] = makeEntry());
  const domainEntry = next.domainMemory[domain] ?? (next.domainMemory[domain] = makeEntry());
  const target = clamp(useful ? Math.max(outcome.score, 0.56) : Math.min(outcome.score, 0.44));
  const learningRate = clamp(0.12 + Math.min(0.1, sourceEntry.evidenceCount * 0.004), 0.08, 0.2);

  for (const entry of [sourceEntry, domainEntry]) {
    entry.evidenceCount += 1;
    entry.successes += useful ? 1 : 0;
    entry.failures += useful ? 0 : 1;
    entry.lastObservedAt = Date.now();
    entry.mean = clamp(entry.mean * (1 - learningRate) + target * learningRate);
    entry.variance = clamp(entry.variance * 0.84 + Math.abs(entry.mean - target) * 0.16, 0.01, 0.5);
    entry.representation = entry.representation.map((value, index) => value * 0.86 + (index === 0 ? target : 0.03));
    const magnitude = Math.sqrt(entry.representation.reduce((sum, value) => sum + value * value, 0)) || 1;
    entry.representation = entry.representation.map((value) => value / magnitude);
  }

  const sourceClass = epistemicClassFromMean(sourceEntry.mean);
  next.knowledgeClassRepresentations[sourceClass] = next.knowledgeClassRepresentations[sourceClass].map((value, index) => value * 0.86 + (index === 0 ? target : 0.02));
  const classMagnitude = Math.sqrt(next.knowledgeClassRepresentations[sourceClass].reduce((sum, value) => sum + value * value, 0)) || 1;
  next.knowledgeClassRepresentations[sourceClass] = next.knowledgeClassRepresentations[sourceClass].map((value) => value / classMagnitude);

  next.calibration = clamp(next.calibration * 0.86 + average([sourceEntry.mean, domainEntry.mean]) * 0.14);
  next.corroborationGraph[domain] ??= {};
  for (const peer of domains.slice(1)) {
    next.corroborationGraph[peer] ??= {};
    const current = next.corroborationGraph[domain][peer] ?? 0.2;
    const updated = clamp(current * 0.84 + (useful ? 0.08 : -0.04) + next.calibration * 0.04);
    next.corroborationGraph[domain][peer] = updated;
    next.corroborationGraph[peer][domain] = updated;
  }

  if (outcome.notes?.length) {
    sourceEntry.notes.push(...outcome.notes.map((note) => `outcome:${note}`));
    domainEntry.notes.push(...outcome.notes.map((note) => `outcome:${note}`));
  }

  return next;
}

function learnedMemoryScore(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, result: SearchResult) {
  const next = ensureModel(model);
  const domain = domainKey(result);
  const sourceEntry = next.sourceMemory[sourceKey(result.source)];
  const domainEntry = next.domainMemory[domain];
  const sampleSize = Math.max(sourceEntry?.evidenceCount ?? 0, domainEntry?.evidenceCount ?? 0, 1);
  const failures = (sourceEntry?.failures ?? 0) + (domainEntry?.failures ?? 0);
  const successes = (sourceEntry?.successes ?? 0) + (domainEntry?.successes ?? 0);
  const corroboration = average([sourceEntry?.corroboration[domain] ?? 0.5, domainEntry?.corroboration[sourceKey(result.source)] ?? 0.5]);
  const mean = clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, next.calibration ?? 0.5, corroboration]));
  const variance = clamp(average([sourceEntry?.variance ?? 0.2, domainEntry?.variance ?? 0.2]) + failures / Math.max(4, successes + failures + 4) * 0.05, 0.01, 0.5);
  return { mean, variance, sampleSize, failures, successes, corroboration, epistemicClass: epistemicClassFromMean(mean) } as const;
}

function trustBreakdown(intent: SearchIntent, result: SearchResult, policy?: SearchPolicyState): Omit<TrustScoreBreakdown, 'uncertainty'> {
  const model = ensureModel(policy?.epistemicModel);
  const domain = domainKey(result);
  const sourceEntry = model.sourceMemory[sourceKey(result.source)];
  const domainEntry = model.domainMemory[domain];
  const text = claimText(result).toLowerCase();
  const lexicalBreadth = clamp(new Set(text.split(/[^a-z0-9]+/g).filter((token) => token.length > 3)).size / 16);
  const evidenceQuality = clamp(lexicalBreadth * 0.24 + (result.claims?.length ?? 0) * 0.08 + (text.length > 120 ? 0.12 : 0) + (result.snippet.length > 80 ? 0.1 : 0));
  const provenance = clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, model.calibration ?? 0.5]));
  const recency = typeof result.freshness === 'number' ? clamp(result.freshness) : 0.5;
  const corroboration = average([sourceEntry?.corroboration[domain] ?? 0.5, domainEntry?.corroboration[sourceKey(result.source)] ?? 0.5]);
  const domainReliability = clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, corroboration]));
  const expertise = clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, intent.trustMode === 'official-first' ? 0.7 : 0.55]));
  const independence = clamp(0.45 + Math.min(0.35, new Set([sourceKey(result.source), domain]).size * 0.05));
  return { evidenceQuality, provenance, recency, corroboration, domainReliability, expertise, independence };
}

function reliabilityShape(result: SearchResult, breakdown: TrustScoreBreakdown, reliability: Record<string, SearchSourceReliability>, policy?: SearchPolicyState) {
  const model = ensureModel(policy?.epistemicModel);
  const domain = domainKey(result);
  const sourceEntry = model.sourceMemory[sourceKey(result.source)];
  const domainEntry = model.domainMemory[domain];
  const sampleSize = Math.max(reliability[result.source]?.uses ?? 0, reliability[domain]?.uses ?? 0, sourceEntry?.evidenceCount ?? 0, domainEntry?.evidenceCount ?? 0, 1);
  const failures = (reliability[result.source]?.failures ?? 0) + (reliability[domain]?.failures ?? 0) + (sourceEntry?.failures ?? 0) + (domainEntry?.failures ?? 0);
  const successes = (reliability[result.source]?.successes ?? 0) + (reliability[domain]?.successes ?? 0) + (sourceEntry?.successes ?? 0) + (domainEntry?.successes ?? 0);
  const mean = clamp(average([sourceEntry?.mean ?? reliability[result.source]?.score ?? 0.5, domainEntry?.mean ?? reliability[domain]?.score ?? 0.5, breakdown.corroboration, breakdown.domainReliability]));
  const variance = clamp(average([sourceEntry?.variance ?? 0.2, domainEntry?.variance ?? 0.2]) + failures / Math.max(4, successes + failures + 4) * 0.06, 0.01, 0.5);
  const failureModes = [
    ...(breakdown.corroboration < 0.4 ? ['low-corroboration'] : []),
    ...(breakdown.evidenceQuality < 0.4 ? ['thin-evidence'] : []),
    ...(variance > 0.24 ? ['high-uncertainty'] : []),
    ...(sourceEntry?.variance && sourceEntry.variance > 0.24 ? ['volatile-source-memory'] : []),
  ];
  return { mean, variance, sampleSize, failureModes, epistemicClass: epistemicClassFromMean(mean) } as const;
}

function learnedPrior(policy: SearchPolicyState | undefined, result: SearchResult, breakdown: TrustScoreBreakdown): number {
  const model = ensureModel(policy?.epistemicModel);
  const domain = domainKey(result);
  const sourceEntry = model.sourceMemory[sourceKey(result.source)];
  const domainEntry = model.domainMemory[domain];
  const sourceWeight = sourceEntry ? sourceEntry.mean * (1 - sourceEntry.variance * 0.5) : breakdown.domainReliability;
  const domainWeight = domainEntry ? domainEntry.mean * (1 - domainEntry.variance * 0.5) : breakdown.provenance;
  const corroborationWeight = breakdown.corroboration * 0.4 + (sourceEntry?.corroboration[domain] ?? 0.5) * 0.15 + (domainEntry?.corroboration[sourceKey(result.source)] ?? 0.5) * 0.15;
  return clamp(average([sourceWeight, domainWeight, corroborationWeight, model.calibration ?? 0.5]));
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  return results.map((result) => {
    const domain = domainKey(result);
    const breakdownBase = trustBreakdown(intent, result, policy);
    const reliabilityState = reliabilityShape(result, { ...breakdownBase, uncertainty: 0 }, reliability, policy);
    const breakdown: TrustScoreBreakdown = { ...breakdownBase, uncertainty: reliabilityState.variance };
    const learned = learnedPrior(policy, result, breakdown);
    const trustScore = clamp(learned * 0.34 + breakdown.evidenceQuality * 0.18 + breakdown.provenance * 0.14 + breakdown.corroboration * 0.14 + breakdown.domainReliability * 0.08 + breakdown.expertise * 0.08 + breakdown.independence * 0.04 + breakdown.recency * 0.02 - breakdown.uncertainty * 0.06);
    const model = ensureModel(policy?.epistemicModel);
    const sourceEntry = model.sourceMemory[sourceKey(result.source)];
    const domainEntry = model.domainMemory[domain];
    return {
      ...result,
      trustScore,
      trustBreakdown: breakdown,
      reliability: {
        mean: reliabilityState.mean,
        variance: reliabilityState.variance,
        sampleSize: reliabilityState.sampleSize,
        failureModes: [...reliabilityState.failureModes, ...(decision?.requireCorroboration ? ['corroboration-required'] : [])],
        epistemicClass: reliabilityState.epistemicClass,
      },
      provenance: {
        domain,
        sourceMemory: sourceEntry?.notes ?? [],
        domainMemory: domainEntry?.notes ?? [],
      },
    } as TrustedEvidence;
  });
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const entries = new Map<string, { source: SearchSource | string; score: number; reason: string }>();
  for (const [source, state] of Object.entries(reliability)) {
    const boost = decision?.sourceBoosts?.[source] ?? 0;
    const ruleWeight = rules.filter((rule) => rule.enabled && (rule.when?.sources?.includes(source) ?? false)).reduce((sum, rule) => sum + (rule.sourceWeights?.[source as SearchSource] ?? 0), 0);
    const score = clamp((state.score ?? 0.5) * 0.7 + (state.uses ?? 0) * 0.02 - (state.failures ?? 0) * 0.03 + boost + ruleWeight * 0.04);
    entries.set(source, { source, score, reason: `reliability=${score.toFixed(2)}` });
  }
  for (const source of intent.sourceHints) {
    if (!entries.has(source)) entries.set(source, { source, score: 0.5 + (decision?.sourceBoosts?.[source] ?? 0), reason: 'intent-source-hint' });
  }
  return [...entries.values()].sort((left, right) => right.score - left.score);
}
