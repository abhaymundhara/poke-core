import type { PolicyDecision, SearchIntent, SearchOutcome, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { average, clamp, hostname, stableHash, words } from './utils.ts';

const OFFICIAL_DOMAINS = [/\.gov$/i, /\.edu$/i, /github\.com$/i, /docs\./i, /developer\./i, /openai\.com$/i];
const LOW_QUALITY_DOMAINS = [/medium\.com$/i, /substack\.com$/i, /quora\.com$/i, /reddit\.com$/i];
const VECTOR_DIMENSIONS = 16;

function officialDomain(domain: string): boolean {
  return OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain));
}

function lowQualityDomain(domain: string): boolean {
  return LOW_QUALITY_DOMAINS.some((pattern) => pattern.test(domain));
}

function epistemicClassFor(source: SearchSource | string, domain: string): TrustedEvidence['reliability']['epistemicClass'] {
  if (source === 'scholar' || /\.edu$/i.test(domain) || officialDomain(domain)) return 'expert';
  if (source === 'github' || source === 'integration' || source === 'email' || source === 'calendar') return 'institutional';
  if (source === 'web' || source === 'realtime-web') return 'community';
  return 'unknown';
}

function vectorize(text: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vector = new Array(dimensions).fill(0);
  const normalized = text.toLowerCase().trim();
  const tokens = words(normalized);
  if (tokens.length === 0) return vector;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const seed = `${token}:${tokenIndex % 7}:${dimensions}`;
    const hash = stableHash(seed);
    for (let i = 0; i < hash.length; i += 2) {
      const slice = hash.slice(i, i + 2);
      if (!slice) continue;
      const bucket = Number.parseInt(slice, 16) % dimensions;
      const weight = ((tokenIndex % 5) + 1) / (tokens.length + 2);
      vector[bucket] += weight;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function blendVector(left: number[], right: number[], leftWeight = 0.5): number[] {
  const vector = left.map((value, index) => value * leftWeight + (right[index] ?? 0) * (1 - leftWeight));
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = (Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1) * (Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1);
  if (denominator === 0) return 0;
  const numerator = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  return clamp((numerator / denominator + 1) / 2);
}

function domainKey(value: string): string {
  return value || 'unknown-domain';
}

function ensureTrustEntry(bucket: Record<string, any>, key: string, epistemicClass: TrustedEvidence['reliability']['epistemicClass']) {
  const existing = bucket[key];
  if (existing) return existing;
  const entry = {
    mean: 0.5,
    variance: 0.12,
    evidenceCount: 0,
    successes: 0,
    failures: 0,
    lastObservedAt: null,
    notes: [],
    epistemicClass,
    representation: vectorize(key),
    corroboration: {},
    classPosterior: { primary: 0.25, expert: 0.25, institutional: 0.25, community: 0.2, unknown: 0.05 },
  };
  bucket[key] = entry;
  return entry;
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return {
    version: 1,
    calibration: 0.68,
    classPriors: { primary: 0.88, expert: 0.82, institutional: 0.76, community: 0.6, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: vectorize('primary authorative origin'),
      expert: vectorize('expert analysis evidence'),
      institutional: vectorize('institutional operational record'),
      community: vectorize('community corroboration discussion'),
      unknown: vectorize('unknown low confidence'),
    },
    corroborationGraph: {},
  };
}

function outcomeVector(outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): number[] {
  const components = [
    String(outcome.source),
    ...(outcome.resultDomains ?? []),
    ...(outcome.notes ?? []),
    String(outcome.score),
    outcome.useful ? 'useful' : 'not-useful',
  ].join(' | ');
  return vectorize(components);
}

function updateEntry(entry: ReturnType<typeof ensureTrustEntry>, evidenceVector: number, useful: boolean, score: number, domain: string, correlatedDomains: string[], notes: string[]): void {
  entry.evidenceCount += 1;
  entry.successes += useful ? 1 : 0;
  entry.failures += useful ? 0 : 1;
  entry.lastObservedAt = Date.now();
  const target = useful ? Math.max(score, 0.68) : Math.min(score, 0.32);
  entry.mean = clamp(entry.mean * 0.72 + target * 0.28);
  entry.variance = clamp(entry.variance * 0.78 + Math.abs(entry.mean - target) * 0.12, 0.02, 0.5);
  entry.representation = blendVector(entry.representation, evidenceVector, 0.68);
  entry.corroboration[domain] = clamp((entry.corroboration[domain] ?? 0.2) * 0.72 + (useful ? 0.26 : -0.12) + score * 0.08, 0, 1);
  entry.classPosterior[entry.epistemicClass] = clamp((entry.classPosterior[entry.epistemicClass] ?? 0.2) * 0.75 + (useful ? 0.18 : 0.06), 0, 1);
  for (const correlatedDomain of correlatedDomains) {
    entry.corroboration[correlatedDomain] = clamp((entry.corroboration[correlatedDomain] ?? 0.15) * 0.8 + (useful ? 0.14 : -0.08), 0, 1);
  }
  if (notes.length > 0) entry.notes.push(...notes);
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const next = model ?? initialEpistemicTrustModel();
  const useful = outcome.useful ?? outcome.score >= 0.7;
  const domains = (outcome.resultDomains ?? []).filter(Boolean).map(domainKey);
  const sourceKey = String(outcome.source);
  const sourceEntry = ensureTrustEntry(next.sourceMemory, sourceKey, epistemicClassFor(outcome.source, domains[0] ?? ''));
  const evidenceVector = outcomeVector(outcome);
  updateEntry(sourceEntry, evidenceVector, useful, outcome.score, sourceKey, domains, outcome.notes ?? []);

  for (const domain of domains.length > 0 ? domains : [sourceKey]) {
    const domainEntry = ensureTrustEntry(next.domainMemory, domain, epistemicClassFor(outcome.source, domain));
    updateEntry(domainEntry, evidenceVector, useful, outcome.score, domain, domains.filter((value) => value !== domain), outcome.notes ?? []);
  }

  for (let i = 0; i < domains.length; i += 1) {
    const left = domains[i];
    for (let j = i + 1; j < domains.length; j += 1) {
      const right = domains[j];
      next.corroborationGraph[left] ??= {};
      next.corroborationGraph[right] ??= {};
      next.corroborationGraph[left][right] = clamp((next.corroborationGraph[left][right] ?? 0.1) * 0.8 + (useful ? 0.18 : -0.06) + outcome.score * 0.06, 0, 1);
      next.corroborationGraph[right][left] = clamp((next.corroborationGraph[right][left] ?? 0.1) * 0.8 + (useful ? 0.18 : -0.06) + outcome.score * 0.06, 0, 1);
    }
  }

  const classKey = epistemicClassFor(outcome.source, domains[0] ?? sourceKey);
  next.knowledgeClassRepresentations[classKey] = blendVector(next.knowledgeClassRepresentations[classKey] ?? vectorize(classKey), evidenceVector, 0.62);
  next.calibration = clamp(next.calibration * 0.84 + (useful ? 0.18 : 0.08) + outcome.score * 0.06);
  return next;
}

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

function expertiseScore(result: SearchResult, domain: string): number {
  const text = `${result.author ?? ''} ${result.title} ${result.snippet}`;
  if (result.source === 'scholar' || /\.edu$/i.test(domain) || /\b(doi|journal|study|researcher|professor|lab)\b/i.test(text)) return 0.86;
  if (result.source === 'github' || /\b(maintainer|release|commit|repository|docs)\b/i.test(text)) return 0.82;
  if (OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain))) return 0.78;
  return 0.52;
}

function independenceScore(result: SearchResult, all: SearchResult[]): number {
  const domains = new Set(all.map((entry) => hostname(entry.url)).filter(Boolean));
  const sameDomainCount = all.filter((entry) => hostname(entry.url) === hostname(result.url)).length;
  return clamp(0.45 + Math.min(0.28, domains.size * 0.05) - Math.max(0, sameDomainCount - 1) * 0.08);
}

function reliabilityDistribution(result: SearchResult, breakdown: TrustScoreBreakdown, reliability: Record<string, SearchSourceReliability>) {
  const domain = hostname(result.url);
  const record = reliability[result.source] ?? reliability[domain];
  const sampleSize = Math.max(1, record?.uses ?? 1);
  const failures = record?.failures ?? 0;
  const successes = record?.successes ?? 0;
  const mean = clamp((breakdown.provenance + breakdown.domainReliability + breakdown.expertise + breakdown.independence) / 4);
  const variance = clamp((mean * (1 - mean)) / (sampleSize + 2) + failures / Math.max(4, successes + failures + 4) * 0.08);
  const failureModes = [
    ...(breakdown.recency < 0.35 ? ['stale'] : []),
    ...(breakdown.independence < 0.45 ? ['not-independent'] : []),
    ...(breakdown.evidenceQuality < 0.45 ? ['thin-evidence'] : []),
    ...(LOW_QUALITY_DOMAINS.some((pattern) => pattern.test(domain)) ? ['low-accountability-platform'] : []),
  ];
  const epistemicClass = result.source === 'scholar' ? 'expert' : result.source === 'github' || OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain)) ? 'primary' : result.source === 'email' || result.source === 'calendar' || result.source === 'integration' ? 'institutional' : result.source === 'web' ? 'community' : 'unknown';
  return { mean, variance, sampleSize, failureModes, epistemicClass } as const;
}

function learnedEpistemicPrior(policy: SearchPolicyState | undefined, result: SearchResult, breakdown: TrustScoreBreakdown, epistemicClass: ReturnType<typeof reliabilityDistribution>['epistemicClass']): number {
  const domain = hostname(result.url);
  const model = policy?.epistemicModel;
  if (!model) return clamp((breakdown.provenance + breakdown.domainReliability + breakdown.expertise + breakdown.independence) / 4);
  const sourceEntry = model.sourceMemory[String(result.source)];
  const domainEntry = model.domainMemory[domain];
  const classPrior = model.classPriors[epistemicClass] ?? model.classPriors.unknown ?? 0.5;
  const classRepresentation = model.knowledgeClassRepresentations[epistemicClass] ?? vectorize(String(epistemicClass));
  const sourceVector = sourceEntry?.representation ?? vectorize(String(result.source));
  const domainVector = domainEntry?.representation ?? vectorize(domain);
  return clamp(
    (sourceEntry?.mean ?? breakdown.domainReliability) * 0.24 +
    (domainEntry?.mean ?? breakdown.provenance) * 0.2 +
    classPrior * 0.18 +
    cosineSimilarity(sourceVector, classRepresentation) * 0.16 +
    cosineSimilarity(domainVector, classRepresentation) * 0.14 +
    model.calibration * 0.08,
  );
}

function corroborationScore(result: SearchResult, all: SearchResult[], policy?: SearchPolicyState): number {
  const resultVector = vectorize(`${result.title} ${result.snippet} ${(result.claims ?? []).join(' ')}`);
  const overlapScores = all.filter((other) => other !== result).map((other) => {
    const otherVector = vectorize(`${other.title} ${other.snippet} ${(other.claims ?? []).join(' ')}`);
    return cosineSimilarity(resultVector, otherVector);
  });
  const graph = policy?.epistemicModel?.corroborationGraph ?? {};
  const domain = hostname(result.url);
  const corroboratedDomains = Object.values(graph[domain] ?? {}).filter((value) => value > 0.35).length;
  return clamp(0.42 + average(overlapScores) * 0.36 + Math.min(0.18, corroboratedDomains * 0.04) + (new Set(all.map((entry) => hostname(entry.url))).size > 1 ? 0.08 : 0));
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  return results.map((result) => {
    const domain = hostname(result.url);
    const official = OFFICIAL_DOMAINS.some((pattern) => pattern.test(domain));
    const primary = official || result.source === 'github' || result.source === 'scholar';
    const partial = {
      evidenceQuality: evidenceQuality(intent, result),
      provenance: provenanceScore(domain, result.source),
      recency: recencyScore(intent, result),
      corroboration: corroborationScore(result, results, policy),
      domainReliability: reliability[result.source]?.score ?? reliability[domain]?.score ?? result.trust ?? 0.62,
      expertise: expertiseScore(result, domain),
      independence: independenceScore(result, results),
    };
    const reliabilityShape = reliabilityDistribution(result, { ...partial, uncertainty: 0 }, reliability);
    const breakdown: TrustScoreBreakdown = {
      ...partial,
      uncertainty: reliabilityShape.variance,
    };
    const learnedPrior = learnedEpistemicPrior(policy, result, breakdown, reliabilityShape.epistemicClass);
    const trustScore = clamp(
      breakdown.evidenceQuality * 0.15 +
      breakdown.provenance * 0.12 +
      breakdown.recency * 0.08 +
      breakdown.corroboration * 0.16 +
      breakdown.domainReliability * 0.08 +
      breakdown.expertise * 0.1 +
      breakdown.independence * 0.06 +
      learnedPrior * 0.22 -
      breakdown.uncertainty * 0.05,
    );
    return { ...result, trustScore, trustBreakdown: breakdown, trust: trustScore, reliability: reliabilityShape, provenance: { domain, source: result.source, official, primary } };
  }).filter((result) => result.trustScore >= (decision?.minTrustScore ?? 0)).sort((left, right) => right.trustScore - left.trustScore);
}

function ruleBoostFor(source: SearchSource | string, intent: SearchIntent, rules: SearchPolicyRule[], decision?: PolicyDecision): number {
  if (decision) return decision.sourceBoosts[source] ?? 0;
  return rules.filter((rule) => rule.enabled).reduce((boost, rule) => {
    const sourceMatch = !rule.when?.sources || rule.when.sources.includes(source);
    const focusMatch = !rule.when?.focus || rule.when.focus.includes(intent.focus);
    const freshnessMatch = !rule.when?.freshness || rule.when.freshness.includes(intent.freshness);
    if (!sourceMatch || !focusMatch || !freshnessMatch) return boost;
    return boost + (rule.actions ?? []).filter((action) => action.type === 'boost-source' && action.value === source).reduce((sum, action) => sum + action.weight, 0);
  }, 0);
}

export function sourceScoreFor(source: SearchSource | string, intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): number {
  const base = reliability[source]?.score ?? 0.6;
  const prior = intent.sourcePriors.find((entry) => entry.source === source)?.weight ?? 0;
  const freshnessBonus = source === 'realtime-web' && intent.freshness === 'live' ? 0.16 : 0;
  const trustBonus = (source === 'scholar' || source === 'github') && intent.trustMode === 'official-first' ? 0.12 : 0;
  return clamp(base * 0.68 + prior * 0.24 + freshnessBonus + trustBonus + ruleBoostFor(source, intent, rules, decision));
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[] = [], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const candidates = [...new Set([...intent.sourcePriors.map((prior) => prior.source), ...intent.sourceHints, 'web', 'realtime-web', 'github', 'scholar', 'memory'])];
  return candidates.map((source) => ({
    source,
    score: sourceScoreFor(source, intent, reliability, rules, decision),
    reason: [
      intent.sourcePriors.find((prior) => prior.source === source)?.reason ?? (source === 'realtime-web' ? 'freshness coverage' : source === 'scholar' ? 'citation coverage' : 'general coverage'),
      ruleBoostFor(source, intent, rules, decision) > 0 ? 'policy-rule-boost' : '',
    ].filter(Boolean).join('+'),
  })).sort((left, right) => right.score - left.score);
}
