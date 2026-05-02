import type { PolicyDecision, SearchIntent, SearchOutcome, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { average, clamp, hostname, normalize, stableHash, uniq, words } from './utils.ts';

function sourceKey(source: SearchSource | string): string {
  return normalize(String(source)) || String(source);
}

function claimText(result: SearchResult): string {
  return [result.title, result.snippet, ...(result.claims ?? [])].join(' ');
}

function conceptTokens(text: string): string[] {
  return uniq(words(text)).filter((token) => token.length > 1).slice(0, 24);
}

function encodeEvidence(text: string, buckets = 12): number[] {
  const vector = new Array(buckets).fill(0);
  const tokens = conceptTokens(text);
  if (tokens.length === 0) return vector;
  for (const token of tokens) {
    const hash = stableHash(token);
    for (let i = 0; i < hash.length; i += 2) {
      const slice = hash.slice(i, i + 2);
      if (!slice) continue;
      vector[Number.parseInt(slice, 16) % buckets] += 1 / tokens.length;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = (Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1) * (Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1);
  if (denominator === 0) return 0;
  const numerator = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  return clamp((numerator / denominator + 1) / 2);
}

type LearnedTrustEntry = NonNullable<SearchPolicyState['epistemicModel']>['sourceMemory'][string];

function neutralEntry(source: SearchSource | string, epistemicClass: TrustedEvidence['reliability']['epistemicClass'] = 'unknown'): LearnedTrustEntry {
  return {
    mean: 0.5,
    variance: 0.18,
    evidenceCount: 0,
    successes: 0,
    failures: 0,
    lastObservedAt: null,
    notes: [],
    epistemicClass,
    representation: encodeEvidence(String(source)),
    corroboration: {},
    classPosterior: { primary: 0.2, expert: 0.2, institutional: 0.2, community: 0.2, unknown: 0.2 },
  };
}

function epistemicClassFromMemory(sourceEntry?: LearnedTrustEntry, domainEntry?: LearnedTrustEntry): TrustedEvidence['reliability']['epistemicClass'] {
  const mean = average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5]);
  if (mean >= 0.82) return 'primary';
  if (mean >= 0.7) return 'expert';
  if (mean >= 0.58) return 'institutional';
  if (mean >= 0.48) return 'community';
  return 'unknown';
}

function normalizeEntry(entry: LearnedTrustEntry, observedScore: number, useful: boolean, evidence: number[], corroborators: string[]): void {
  const target = clamp(useful ? Math.max(observedScore, 0.56) : Math.min(observedScore, 0.44));
  const learningRate = clamp(0.14 + Math.min(0.14, entry.evidenceCount * 0.006), 0.08, 0.24);
  entry.evidenceCount += 1;
  entry.successes += useful ? 1 : 0;
  entry.failures += useful ? 0 : 1;
  entry.lastObservedAt = Date.now();
  entry.mean = clamp(entry.mean * (1 - learningRate) + target * learningRate);
  entry.variance = clamp(entry.variance * 0.86 + Math.abs(entry.mean - target) * 0.14, 0.01, 0.5);
  entry.representation = entry.representation.map((value, index) => value * 0.82 + (evidence[index] ?? 0) * 0.18);
  const magnitude = Math.sqrt(entry.representation.reduce((sum, value) => sum + value * value, 0)) || 1;
  entry.representation = entry.representation.map((value) => value / magnitude);
  for (const corroborator of corroborators) {
    entry.corroboration[corroborator] = clamp((entry.corroboration[corroborator] ?? 0.2) * 0.84 + (useful ? 0.1 : -0.07) + target * 0.05, 0, 1);
  }
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return {
    version: 1,
    calibration: 0.5,
    classPriors: { primary: 0.5, expert: 0.5, institutional: 0.5, community: 0.5, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: encodeEvidence('primary'),
      expert: encodeEvidence('expert'),
      institutional: encodeEvidence('institutional'),
      community: encodeEvidence('community'),
      unknown: encodeEvidence('unknown'),
    },
    corroborationGraph: {},
  };
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const next = model ?? initialEpistemicTrustModel();
  next.sourceMemory ??= {};
  next.domainMemory ??= {};
  next.knowledgeClassRepresentations ??= initialEpistemicTrustModel().knowledgeClassRepresentations;
  next.corroborationGraph ??= {};

  const useful = outcome.useful ?? outcome.score >= 0.7;
  const sourceKeyValue = sourceKey(outcome.source);
  const domains = uniq((outcome.resultDomains ?? []).filter(Boolean).map((value) => normalize(value)));
  const domainKey = domains[0] ?? sourceKeyValue;
  const evidence = encodeEvidence([sourceKeyValue, domainKey, ...(domains.length ? domains : [domainKey]), String(outcome.score), useful ? 'useful' : 'not-useful', ...(outcome.notes ?? [])].join(' | '));
  const sourceClass = next.sourceMemory[sourceKeyValue]?.epistemicClass ?? 'unknown';
  const domainClass = next.domainMemory[domainKey]?.epistemicClass ?? 'unknown';
  const sourceEntry = next.sourceMemory[sourceKeyValue] ?? (next.sourceMemory[sourceKeyValue] = neutralEntry(sourceKeyValue, sourceClass));
  const domainEntry = next.domainMemory[domainKey] ?? (next.domainMemory[domainKey] = neutralEntry(domainKey, domainClass));
  const peerSignals = uniq([sourceKeyValue, domainKey, ...domains]);

  normalizeEntry(sourceEntry, outcome.score, useful, evidence, peerSignals);
  normalizeEntry(domainEntry, outcome.score, useful, evidence, peerSignals);

  const sourceSupport = sourceEntry.mean * (1 - sourceEntry.variance);
  const domainSupport = domainEntry.mean * (1 - domainEntry.variance);
  next.calibration = clamp(next.calibration * 0.84 + average([sourceSupport, domainSupport]) * 0.16);

  const sourceClassResolved = epistemicClassFromMemory(sourceEntry, domainEntry);
  next.knowledgeClassRepresentations[sourceClassResolved] ??= encodeEvidence(sourceClassResolved);
  next.knowledgeClassRepresentations[sourceClassResolved] = next.knowledgeClassRepresentations[sourceClassResolved].map((value, index) => value * 0.84 + evidence[index % evidence.length] * 0.16);
  const magnitude = Math.sqrt(next.knowledgeClassRepresentations[sourceClassResolved].reduce((sum, value) => sum + value * value, 0)) || 1;
  next.knowledgeClassRepresentations[sourceClassResolved] = next.knowledgeClassRepresentations[sourceClassResolved].map((value) => value / magnitude);

  for (let i = 0; i < domains.length; i += 1) {
    const left = domains[i];
    next.corroborationGraph[left] ??= {};
    for (let j = i + 1; j < domains.length; j += 1) {
      const right = domains[j];
      next.corroborationGraph[right] ??= {};
      const similarity = cosineSimilarity(encodeEvidence(left), encodeEvidence(right));
      const current = next.corroborationGraph[left][right] ?? 0.2;
      const updated = clamp(current * 0.82 + similarity * 0.12 + (useful ? 0.06 : -0.04) + next.calibration * 0.04);
      next.corroborationGraph[left][right] = updated;
      next.corroborationGraph[right][left] = updated;
    }
  }

  if (outcome.notes?.length) {
    sourceEntry.notes.push(...outcome.notes.map((note) => `outcome:${note}`));
    domainEntry.notes.push(...outcome.notes.map((note) => `outcome:${note}`));
  }

  return next;
}

function learnedMemoryScore(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, result: SearchResult): { mean: number; variance: number; sampleSize: number; failures: number; successes: number; corroboration: number; epistemicClass: TrustedEvidence['reliability']['epistemicClass'] } {
  const domain = hostname(result.url);
  const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
  const domainEntry = model?.domainMemory[domain];
  const sourceMean = sourceEntry?.mean ?? 0.5;
  const domainMean = domainEntry?.mean ?? 0.5;
  const corroborationSignals = Object.values(model?.corroborationGraph?.[domain] ?? {});
  const corroboration = corroborationSignals.length > 0 ? average(corroborationSignals) : 0.5;
  const sampleSize = Math.max(sourceEntry?.evidenceCount ?? 0, domainEntry?.evidenceCount ?? 0, 1);
  const failures = (sourceEntry?.failures ?? 0) + (domainEntry?.failures ?? 0);
  const successes = (sourceEntry?.successes ?? 0) + (domainEntry?.successes ?? 0);
  const mean = clamp(average([sourceMean, domainMean, model?.calibration ?? 0.5, corroboration]));
  const variance = clamp(average([sourceEntry?.variance ?? 0.18, domainEntry?.variance ?? 0.18]) + failures / Math.max(4, successes + failures + 4) * 0.05, 0.01, 0.5);
  const epistemicClass = epistemicClassFromMemory(sourceEntry, domainEntry);
  return { mean, variance, sampleSize, failures, successes, corroboration, epistemicClass };
}

function memorySimilarity(left: string, right: string): number {
  return cosineSimilarity(encodeEvidence(left), encodeEvidence(right));
}

function learnedEvidenceBreakdown(intent: SearchIntent, result: SearchResult, policy?: SearchPolicyState): Omit<TrustScoreBreakdown, 'uncertainty'> {
  const model = policy?.epistemicModel;
  const domain = hostname(result.url);
  const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
  const domainEntry = model?.domainMemory[domain];
  const resultMemory = claimText(result);
  const sourceMemory = sourceEntry?.representation ?? encodeEvidence(String(result.source));
  const domainMemory = domainEntry?.representation ?? encodeEvidence(domain);
  const intentMemory = encodeEvidence([intent.semanticQuery, ...intent.entities, ...intent.topics, ...intent.evidenceTerms].join(' | '));
  const learnedAlignment = average([
    memorySimilarity(resultMemory, intent.semanticQuery),
    memorySimilarity(resultMemory, sourceEntry ? sourceKey(result.source) : String(result.source)),
    memorySimilarity(resultMemory, domain),
    cosineSimilarity(sourceMemory, intentMemory),
    cosineSimilarity(domainMemory, intentMemory),
  ]);
  const corroborationGraph = model?.corroborationGraph?.[domain] ?? {};
  const corroboration = Object.values(corroborationGraph).length > 0 ? average(Object.values(corroborationGraph)) : 0.5;
  const evidenceDensity = clamp(((result.claims?.length ?? 0) + (result.snippet.length > 120 ? 1 : 0)) / 6);
  return {
    evidenceQuality: clamp(learnedAlignment * 0.44 + evidenceDensity * 0.32 + corroboration * 0.24),
    provenance: clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, model?.calibration ?? 0.5])),
    recency: typeof result.freshness === 'number' ? clamp(result.freshness) : 0.5,
    corroboration,
    domainReliability: clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, learnedAlignment])),
    expertise: clamp(average([sourceEntry?.mean ?? 0.5, memorySimilarity(sourceMemory.join(','), intent.semanticQuery)])),
    independence: clamp(0.45 + Math.min(0.35, new Set([sourceKey(result.source), domain]).size * 0.05)),
  };
}

function reliabilityDistribution(result: SearchResult, breakdown: TrustScoreBreakdown, reliability: Record<string, SearchSourceReliability>, policy?: SearchPolicyState) {
  const domain = hostname(result.url);
  const model = policy?.epistemicModel;
  const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
  const domainEntry = model?.domainMemory[domain];
  const sampleSize = Math.max(reliability[result.source]?.uses ?? 0, reliability[domain]?.uses ?? 0, sourceEntry?.evidenceCount ?? 0, domainEntry?.evidenceCount ?? 0, 1);
  const failures = (reliability[result.source]?.failures ?? 0) + (reliability[domain]?.failures ?? 0) + (sourceEntry?.failures ?? 0) + (domainEntry?.failures ?? 0);
  const successes = (reliability[result.source]?.successes ?? 0) + (reliability[domain]?.successes ?? 0) + (sourceEntry?.successes ?? 0) + (domainEntry?.successes ?? 0);
  const mean = clamp(average([sourceEntry?.mean ?? reliability[result.source]?.score ?? 0.5, domainEntry?.mean ?? reliability[domain]?.score ?? 0.5, breakdown.corroboration, breakdown.domainReliability]));
  const variance = clamp(average([sourceEntry?.variance ?? 0.18, domainEntry?.variance ?? 0.18]) + failures / Math.max(4, successes + failures + 4) * 0.06, 0.01, 0.5);
  const failureModes = [
    ...(breakdown.corroboration < 0.4 ? ['low-corroboration'] : []),
    ...(breakdown.evidenceQuality < 0.4 ? ['thin-evidence'] : []),
    ...(variance > 0.24 ? ['high-uncertainty'] : []),
    ...(sourceEntry?.variance && sourceEntry.variance > 0.24 ? ['volatile-source-memory'] : []),
  ];
  const epistemicClass = epistemicClassFromMemory(sourceEntry, domainEntry);
  return { mean, variance, sampleSize, failureModes, epistemicClass } as const;
}

function learnedPrior(policy: SearchPolicyState | undefined, result: SearchResult, breakdown: TrustScoreBreakdown): number {
  const model = policy?.epistemicModel;
  const domain = hostname(result.url);
  const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
  const domainEntry = model?.domainMemory[domain];
  const sourceWeight = sourceEntry ? sourceEntry.mean * (1 - sourceEntry.variance * 0.5) : breakdown.domainReliability;
  const domainWeight = domainEntry ? domainEntry.mean * (1 - domainEntry.variance * 0.5) : breakdown.provenance;
  const corroborationWeight = breakdown.corroboration * 0.4 + (model?.corroborationGraph?.[domain] ? average(Object.values(model.corroborationGraph[domain])) : 0.5) * 0.3;
  const calibration = model?.calibration ?? 0.5;
  return clamp(average([sourceWeight, domainWeight, corroborationWeight, calibration]));
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  return results.map((result) => {
    const domain = hostname(result.url);
    const breakdownBase = learnedEvidenceBreakdown(intent, result, policy);
    const reliabilityShape = reliabilityDistribution(result, { ...breakdownBase, uncertainty: 0 }, reliability, policy);
    const breakdown: TrustScoreBreakdown = { ...breakdownBase, uncertainty: reliabilityShape.variance };
    const learned = learnedPrior(policy, result, breakdown);
    const trustScore = clamp(learned * (1 - reliabilityShape.variance * 0.15));
    const model = policy?.epistemicModel;
    const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
    const domainEntry = model?.domainMemory[domain];
    return {
      ...result,
      trustScore,
      trustBreakdown: breakdown,
      trust: trustScore,
      reliability: reliabilityShape,
      provenance: {
        domain,
        source: result.source,
        official: (sourceEntry?.mean ?? 0.5) >= 0.7 || (domainEntry?.mean ?? 0.5) >= 0.7,
        primary: (sourceEntry?.mean ?? 0.5) >= 0.78 || (domainEntry?.mean ?? 0.5) >= 0.78,
      },
    };
  }).filter((result) => result.trustScore >= (decision?.minTrustScore ?? 0)).sort((left, right) => right.trustScore - left.trustScore);
}

function ruleBoostFor(source: SearchSource | string, intent: SearchIntent, rules: SearchPolicyRule[], decision?: PolicyDecision): number {
  if (decision) return decision.sourceBoosts[source] ?? 0;
  return rules.filter((rule) => rule.enabled).reduce((boost, rule) => {
    const sourceMatch = !rule.when?.sources || rule.when.sources.includes(source);
    const focusMatch = !rule.when?.focus || rule.when.focus.includes(intent.focus);
    const freshnessMatch = !rule.when?.freshness || rule.when.freshness.includes(intent.freshness);
    if (!sourceMatch || !focusMatch || !freshnessMatch) return boost;
    const sourceWeight = rule.sourceWeights?.[String(source) as SearchSource] ?? 1;
    return boost + (sourceWeight - 1) + (rule.minTrustScore ?? 0) * 0.04 + (rule.maxHopBudget ? 0.03 : 0);
  }, 0);
}

function semanticPriority(intent: SearchIntent, source: SearchSource | string): number {
  const sourceTokens = conceptTokens(`${source} ${intent.semanticQuery}`);
  return sourceTokens.some((token) => intent.evidenceTerms.includes(token)) ? 0.08 : 0;
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const candidates = uniq([...Object.keys(reliability), ...intent.sourcePriors.map((prior) => prior.source), ...intent.sourceHints]);
  return candidates.map((source) => {
    const prior = intent.sourcePriors.find((entry) => entry.source === source)?.weight ?? 0.5;
    const memory = reliability[sourceKey(source)]?.score ?? 0.5;
    const rule = ruleBoostFor(source, intent, rules, decision);
    const semantic = semanticPriority(intent, source);
    const freshness = intent.freshness === 'live' && source === 'realtime-web' ? 0.14 : intent.freshness === 'recent' && source === 'web' ? 0.04 : 0;
    const score = clamp(prior * 0.28 + memory * 0.48 + semantic + freshness + rule * 0.16);
    return { source, score, reason: `memory=${memory.toFixed(2)} prior=${prior.toFixed(2)} rule=${rule.toFixed(2)} semantic=${semantic.toFixed(2)}` };
  }).sort((left, right) => right.score - left.score);
}
