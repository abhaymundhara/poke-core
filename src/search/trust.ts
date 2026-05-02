import type { PolicyDecision, SearchIntent, SearchOutcome, SearchPolicyRule, SearchPolicyState, SearchResult, SearchSource, SearchSourceReliability, TrustedEvidence, TrustScoreBreakdown } from './types.ts';
import { average, clamp, hostname, normalize, stableHash, uniq, words } from './utils.ts';

function conceptTokens(text: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'need', 'want', 'please', 'help', 'find', 'search', 'what', 'who', 'when', 'where', 'how', 'why', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'by', 'a', 'an']);
  return uniq(words(text).filter((token) => !stop.has(token))).slice(0, 24);
}

function claimText(result: SearchResult): string {
  return [result.title, result.snippet, ...(result.claims ?? [])].join(' ');
}

function sourceKey(source: SearchSource | string): string {
  return normalize(String(source)) || String(source);
}

function resultSignature(result: SearchResult): string {
  return stableHash([hostname(result.url), result.source, result.title, ...(result.claims ?? []), result.snippet].join('|'));
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

function epistemicClassFor(source: SearchSource | string, domain: string): TrustedEvidence['reliability']['epistemicClass'] {
  const text = `${String(source)} ${domain}`.toLowerCase();
  if (/memory|email|calendar|filesystem|integration/.test(text)) return 'institutional';
  if (/scholar|paper|research|study|journal|citation|doi|arxiv/.test(text)) return 'expert';
  if (/github|repo|commit|issue|pr|docs|developer/.test(text)) return 'primary';
  if (source === 'memory') return 'community';
  return 'unknown';
}

function emptyEntry(epistemicClass: TrustedEvidence['reliability']['epistemicClass']) {
  return {
    mean: 0.5,
    variance: 0.16,
    evidenceCount: 0,
    successes: 0,
    failures: 0,
    lastObservedAt: null,
    notes: [],
    epistemicClass,
    representation: encodeEvidence(epistemicClass),
    corroboration: {},
    classPosterior: { primary: 0.2, expert: 0.2, institutional: 0.2, community: 0.2, unknown: 0.2 },
  };
}

function normalizeEntry(entry: ReturnType<typeof emptyEntry>, observedScore: number, useful: boolean, evidence: number[], signals: string[]): void {
  const target = clamp(useful ? Math.max(observedScore, 0.54) : Math.min(observedScore, 0.46));
  const learningRate = clamp(0.12 + Math.min(0.18, entry.evidenceCount * 0.01), 0.08, 0.28);
  entry.evidenceCount += 1;
  entry.successes += useful ? 1 : 0;
  entry.failures += useful ? 0 : 1;
  entry.lastObservedAt = Date.now();
  entry.mean = clamp(entry.mean * (1 - learningRate) + target * learningRate);
  entry.variance = clamp(entry.variance * 0.88 + Math.abs(entry.mean - target) * 0.12, 0.01, 0.5);
  entry.representation = entry.representation.map((value, index) => value * 0.82 + (evidence[index] ?? 0) * 0.18);
  const magnitude = Math.sqrt(entry.representation.reduce((sum, value) => sum + value * value, 0)) || 1;
  entry.representation = entry.representation.map((value) => value / magnitude);
  entry.classPosterior[entry.epistemicClass] = clamp((entry.classPosterior[entry.epistemicClass] ?? 0.2) * 0.84 + target * 0.16, 0, 1);
  for (const signal of signals) {
    entry.corroboration[signal] = clamp((entry.corroboration[signal] ?? 0.2) * 0.86 + (useful ? 0.12 : -0.08) + target * 0.04, 0, 1);
  }
}

export function initialEpistemicTrustModel(): NonNullable<SearchPolicyState['epistemicModel']> {
  return {
    version: 1,
    calibration: 0.62,
    classPriors: { primary: 0.7, expert: 0.72, institutional: 0.66, community: 0.56, unknown: 0.5 },
    sourceMemory: {},
    domainMemory: {},
    knowledgeClassRepresentations: {
      primary: encodeEvidence('primary first-party source'),
      expert: encodeEvidence('expert analysis provenance'),
      institutional: encodeEvidence('institutional operational record'),
      community: encodeEvidence('community discussion corroboration'),
      unknown: encodeEvidence('unknown evidence source'),
    },
    corroborationGraph: {},
  };
}

export function updateEpistemicTrustModel(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, outcome: { source: SearchSource | string; resultDomains?: string[]; useful?: boolean; score: number; notes?: string[] }): NonNullable<SearchPolicyState['epistemicModel']> {
  const next = model ?? initialEpistemicTrustModel();
  next.sourceMemory ??= {};
  next.domainMemory ??= {};
  next.knowledgeClassRepresentations ??= initialEpistemicTrustModel().knowledgeClassRepresentations;
  next.classPriors ??= { primary: 0.7, expert: 0.72, institutional: 0.66, community: 0.56, unknown: 0.5 };
  next.corroborationGraph ??= {};

  const useful = outcome.useful ?? outcome.score >= 0.68;
  const sourceKeyValue = sourceKey(outcome.source);
  const domains = uniq((outcome.resultDomains ?? []).filter(Boolean).map((value) => normalize(value)));
  const domainKey = domains[0] ?? sourceKeyValue;
  const sourceClass = epistemicClassFor(outcome.source, domainKey);
  const evidence = encodeEvidence([sourceKeyValue, domainKey, ...(outcome.resultDomains ?? []), ...(outcome.notes ?? []), String(outcome.score), useful ? 'useful' : 'not-useful'].join(' | '));
  const sourceEntry = next.sourceMemory[sourceKeyValue] ?? (next.sourceMemory[sourceKeyValue] = emptyEntry(sourceClass));
  const domainEntry = next.domainMemory[domainKey] ?? (next.domainMemory[domainKey] = emptyEntry(epistemicClassFor(outcome.source, domainKey)));
  const peerSignals = uniq([sourceKeyValue, domainKey, ...domains]);

  normalizeEntry(sourceEntry, outcome.score, useful, evidence, peerSignals);
  normalizeEntry(domainEntry, outcome.score, useful, evidence, peerSignals);

  const sourceSupport = sourceEntry.mean * (1 - sourceEntry.variance);
  const domainSupport = domainEntry.mean * (1 - domainEntry.variance);
  const calibrationSignal = clamp((sourceSupport + domainSupport) / 2);
  next.calibration = clamp(next.calibration * 0.82 + calibrationSignal * 0.18);

  next.knowledgeClassRepresentations[sourceClass] ??= encodeEvidence(sourceClass);
  next.knowledgeClassRepresentations[sourceClass] = next.knowledgeClassRepresentations[sourceClass].map((value, index) => value * 0.84 + evidence[index % evidence.length] * 0.16);
  const magnitude = Math.sqrt(next.knowledgeClassRepresentations[sourceClass].reduce((sum, value) => sum + value * value, 0)) || 1;
  next.knowledgeClassRepresentations[sourceClass] = next.knowledgeClassRepresentations[sourceClass].map((value) => value / magnitude);

  for (let i = 0; i < domains.length; i += 1) {
    const left = domains[i];
    next.corroborationGraph[left] ??= {};
    for (let j = i + 1; j < domains.length; j += 1) {
      const right = domains[j];
      next.corroborationGraph[right] ??= {};
      const similarity = cosineSimilarity(encodeEvidence(left), encodeEvidence(right));
      const current = next.corroborationGraph[left][right] ?? 0.2;
      const updated = clamp(current * 0.82 + similarity * 0.12 + (useful ? 0.06 : -0.04) + calibrationSignal * 0.04);
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

function recencyScore(intent: SearchIntent, result: SearchResult): number {
  if (typeof result.freshness === 'number') return clamp(result.freshness);
  if (!result.publishedAt) return intent.freshness === 'live' ? 0.58 : 0.64;
  const ageDays = Math.max(0, (Date.now() - Date.parse(result.publishedAt)) / 86_400_000);
  if (!Number.isFinite(ageDays)) return 0.5;
  if (intent.freshness === 'live') return clamp(1 - ageDays / 12);
  if (intent.freshness === 'recent') return clamp(1 - ageDays / 100);
  return clamp(0.7 + Math.min(365, ageDays) / 3650);
}

function evidenceQuality(intent: SearchIntent, result: SearchResult): number {
  const terms = conceptTokens(`${result.title} ${result.snippet} ${(result.claims ?? []).join(' ')}`);
  const overlap = intent.evidenceTerms.filter((term) => terms.includes(term.toLowerCase())).length;
  const evidenceDensity = (result.claims?.length ?? 0) > 0 ? 0.16 : 0;
  return clamp(0.34 + Math.min(0.32, overlap * 0.05) + evidenceDensity + Math.min(0.16, terms.length / 70));
}

function semanticSimilarity(intent: SearchIntent, result: SearchResult): number {
  const intentVector = encodeEvidence([intent.semanticQuery, ...intent.entities, ...intent.topics, ...intent.evidenceTerms].join(' | '));
  const resultVector = encodeEvidence(claimText(result));
  return cosineSimilarity(intentVector, resultVector);
}

function sourceMemoryScore(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, source: SearchSource | string, domain: string): number {
  const sourceEntry = model?.sourceMemory[sourceKey(source)];
  const domainEntry = model?.domainMemory[domain];
  const sourceMean = sourceEntry?.mean ?? 0.5;
  const domainMean = domainEntry?.mean ?? 0.5;
  const classPrior = model?.classPriors[sourceEntry?.epistemicClass ?? domainEntry?.epistemicClass ?? 'unknown'] ?? 0.5;
  return clamp(sourceMean * 0.44 + domainMean * 0.4 + classPrior * 0.16);
}

function expertiseScore(model: NonNullable<SearchPolicyState['epistemicModel']> | undefined, result: SearchResult, domain: string): number {
  const sourceClass = epistemicClassFor(result.source, domain);
  const classVector = model?.knowledgeClassRepresentations?.[sourceClass];
  const semanticVector = encodeEvidence(claimText(result));
  const similarity = classVector ? cosineSimilarity(classVector, semanticVector) : 0.5;
  return clamp((model?.classPriors[sourceClass] ?? 0.5) * 0.56 + similarity * 0.44);
}

function corroborationScore(result: SearchResult, all: SearchResult[], policy?: SearchPolicyState): number {
  const resultVec = encodeEvidence(claimText(result));
  const similarities = all.filter((other) => other !== result).map((other) => cosineSimilarity(resultVec, encodeEvidence(claimText(other))));
  const domain = hostname(result.url);
  const graph = policy?.epistemicModel?.corroborationGraph ?? {};
  const graphSupport = Object.values(graph[domain] ?? {}).length > 0 ? average(Object.values(graph[domain] ?? {})) : 0.5;
  const multiSourceBoost = new Set(all.map((entry) => hostname(entry.url))).size > 1 ? 0.08 : 0;
  return clamp(average(similarities.length > 0 ? similarities : [0.5]) * 0.52 + graphSupport * 0.36 + multiSourceBoost);
}

function independenceScore(results: SearchResult[], result: SearchResult): number {
  const domains = results.map((entry) => hostname(entry.url)).filter(Boolean);
  const uniqueDomains = new Set(domains);
  const sameDomainCount = domains.filter((domain) => domain === hostname(result.url)).length;
  return clamp(0.36 + Math.min(0.34, uniqueDomains.size * 0.05) - Math.max(0, sameDomainCount - 1) * 0.08);
}

function learnedPrior(policy: SearchPolicyState | undefined, result: SearchResult, breakdown: TrustScoreBreakdown): number {
  const model = policy?.epistemicModel;
  const domain = hostname(result.url);
  const sourceEntry = model?.sourceMemory[sourceKey(result.source)];
  const domainEntry = model?.domainMemory[domain];
  const sourceClass = sourceEntry?.epistemicClass ?? domainEntry?.epistemicClass ?? epistemicClassFor(result.source, domain);
  const sourceRepresentation = sourceEntry?.representation ?? encodeEvidence(String(result.source));
  const domainRepresentation = domainEntry?.representation ?? encodeEvidence(domain);
  const classRepresentation = model?.knowledgeClassRepresentations?.[sourceClass] ?? encodeEvidence(sourceClass);
  const semanticRepresentation = encodeEvidence(claimText(result));
  return clamp(
    (sourceEntry?.mean ?? breakdown.domainReliability) * 0.3 +
    (domainEntry?.mean ?? breakdown.provenance) * 0.22 +
    (model?.classPriors[sourceClass] ?? 0.5) * 0.12 +
    cosineSimilarity(sourceRepresentation, semanticRepresentation) * 0.12 +
    cosineSimilarity(domainRepresentation, semanticRepresentation) * 0.12 +
    cosineSimilarity(classRepresentation, semanticRepresentation) * 0.08 +
    (model?.calibration ?? 0.5) * 0.04,
  );
}

function reliabilityDistribution(result: SearchResult, breakdown: TrustScoreBreakdown, reliability: Record<string, SearchSourceReliability>, policy?: SearchPolicyState) {
  const domain = hostname(result.url);
  const record = reliability[result.source] ?? reliability[domain];
  const sourceEntry = policy?.epistemicModel?.sourceMemory[sourceKey(result.source)];
  const domainEntry = policy?.epistemicModel?.domainMemory[domain];
  const sampleSize = Math.max(record?.uses ?? 0, sourceEntry?.evidenceCount ?? 0, domainEntry?.evidenceCount ?? 0, 1);
  const failures = (record?.failures ?? 0) + (sourceEntry?.failures ?? 0) + (domainEntry?.failures ?? 0);
  const successes = (record?.successes ?? 0) + (sourceEntry?.successes ?? 0) + (domainEntry?.successes ?? 0);
  const mean = clamp(((sourceEntry?.mean ?? record?.score ?? 0.5) + (domainEntry?.mean ?? record?.score ?? 0.5) + breakdown.corroboration + breakdown.evidenceQuality) / 4);
  const variance = clamp(((sourceEntry?.variance ?? 0.16) + (domainEntry?.variance ?? 0.16)) / 2 + failures / Math.max(4, successes + failures + 4) * 0.06, 0.01, 0.5);
  const failureModes = [
    ...(breakdown.corroboration < 0.42 ? ['low-corroboration'] : []),
    ...(breakdown.evidenceQuality < 0.42 ? ['thin-evidence'] : []),
    ...(breakdown.domainReliability < 0.42 ? ['weak-domain-memory'] : []),
    ...(variance > 0.22 ? ['high-uncertainty'] : []),
  ];
  const epistemicClass = sourceEntry?.epistemicClass ?? domainEntry?.epistemicClass ?? epistemicClassFor(result.source, domain);
  return { mean, variance, sampleSize, failureModes, epistemicClass } as const;
}

export function scoreEvidenceTrust(intent: SearchIntent, results: SearchResult[], reliability: Record<string, SearchSourceReliability> = {}, decision?: PolicyDecision, policy?: SearchPolicyState): TrustedEvidence[] {
  const learnedContext = policy?.epistemicModel;
  return results.map((result) => {
    const domain = hostname(result.url);
    const sourceEntry = learnedContext?.sourceMemory[sourceKey(result.source)];
    const domainEntry = learnedContext?.domainMemory[domain];
    const sourceClass = sourceEntry?.epistemicClass ?? domainEntry?.epistemicClass ?? epistemicClassFor(result.source, domain);
    const semanticVector = encodeEvidence(claimText(result));
    const sourceVector = sourceEntry?.representation ?? encodeEvidence(String(result.source));
    const domainVector = domainEntry?.representation ?? encodeEvidence(domain);
    const classVector = learnedContext?.knowledgeClassRepresentations?.[sourceClass] ?? encodeEvidence(sourceClass);
    const learnedContextMean = clamp(average([sourceEntry?.mean ?? 0.5, domainEntry?.mean ?? 0.5, learnedContext?.calibration ?? 0.5]));
    const partial: Omit<TrustScoreBreakdown, 'uncertainty'> = {
      evidenceQuality: clamp(evidenceQuality(intent, result) * 0.56 + semanticSimilarity(intent, result) * 0.44),
      provenance: sourceMemoryScore(learnedContext, result.source, domain),
      recency: recencyScore(intent, result),
      corroboration: corroborationScore(result, results, policy),
      domainReliability: learnedContext?.domainMemory[domain]?.mean ?? reliability[result.source]?.score ?? reliability[domain]?.score ?? result.trust ?? learnedContextMean,
      expertise: clamp(expertiseScore(learnedContext, result, domain) * 0.5 + cosineSimilarity(classVector, semanticVector) * 0.5),
      independence: independenceScore(results, result),
    };
    const reliabilityShape = reliabilityDistribution(result, { ...partial, uncertainty: 0 }, reliability, policy);
    const breakdown: TrustScoreBreakdown = { ...partial, uncertainty: reliabilityShape.variance };
    const learned = learnedPrior(policy, result, breakdown);
    const semanticSupport = clamp(cosineSimilarity(sourceVector, semanticVector) * 0.36 + cosineSimilarity(domainVector, semanticVector) * 0.36 + cosineSimilarity(classVector, semanticVector) * 0.28);
    const trustScore = clamp(
      learned * 0.42 +
      semanticSupport * 0.18 +
      breakdown.corroboration * 0.14 +
      breakdown.provenance * 0.1 +
      breakdown.recency * 0.08 +
      breakdown.domainReliability * 0.06 +
      breakdown.expertise * 0.06 +
      breakdown.independence * 0.04 -
      breakdown.uncertainty * 0.08,
    );
    return { ...result, trustScore, trustBreakdown: breakdown, trust: trustScore, reliability: reliabilityShape, provenance: { domain, source: result.source, official: false, primary: result.source === 'scholar' || result.source === 'github' || /(^|\.)docs?\.|(^|\.)developer\./i.test(domain) || domain.endsWith('.gov') || domain.endsWith('.edu') } };
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
  const signal = sourceTokens.some((token) => intent.evidenceTerms.includes(token));
  return signal ? 0.08 : 0;
}

export function buildSourceRanking(intent: SearchIntent, reliability: Record<string, SearchSourceReliability>, rules: SearchPolicyRule[], decision?: PolicyDecision): Array<{ source: SearchSource | string; score: number; reason: string }> {
  const model = Object.values(reliability);
  const sources = uniq([
    ...intent.sourcePriors.map((prior) => prior.source),
    'web',
    'realtime-web',
    'scholar',
    'github',
    'memory',
    'email',
    'calendar',
    'filesystem',
    'integration',
  ] as Array<SearchSource | string>);
  return sources.map((source) => {
    const prior = intent.sourcePriors.find((entry) => entry.source === source)?.weight ?? 0.5;
    const memory = reliability[sourceKey(source)]?.score ?? 0.5;
    const learnedMean = model.length ? average(model.map((entry) => entry.score)) : 0.5;
    const rule = ruleBoostFor(source, intent, rules, decision);
    const semantic = semanticPriority(intent, source);
    const freshness = intent.freshness === 'live' && source === 'realtime-web' ? 0.14 : intent.freshness === 'recent' && source === 'web' ? 0.04 : 0;
    const score = clamp(prior * 0.28 + memory * 0.4 + learnedMean * 0.08 + semantic + freshness + rule * 0.12);
    return { source, score, reason: `learned-reliability=${memory.toFixed(2)} prior=${prior.toFixed(2)} rule=${rule.toFixed(2)} semantic=${semantic.toFixed(2)} evidence-model=${learnedMean.toFixed(2)}` };
  }).sort((left, right) => right.score - left.score);
}
