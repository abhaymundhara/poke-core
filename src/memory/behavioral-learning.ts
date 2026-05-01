import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildBehavioralModel, type BehaviorForecast, type BehaviorPolicy, type UserBehaviorTheory } from './behavioral-theory';
import type { ChunkRecord, MemoryDocument } from '../rag/types';
import type { EpisodicMemoryItem } from './episodic-memory';
import type { MemoryFact } from './working-memory';

export type BehavioralCategory = 'preference' | 'habit' | 'relationship' | 'channel' | 'tone' | 'schedule' | 'collaboration' | 'correction' | 'signal';

export type BehavioralObservation = {
  subject: string;
  value: string;
  category: BehavioralCategory;
  source: string;
  confidence: number;
  observedAt: number;
  evidence?: string[];
  context?: Record<string, unknown>;
};

export type LearnedBehaviorFact = MemoryFact & {
  category: BehavioralCategory;
  evidenceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  sources: string[];
  rationale: string;
};

export type BehavioralPattern = {
  key: string;
  category: BehavioralCategory;
  subject: string;
  value: string;
  evidenceCount: number;
  sourceCount: number;
  confidence: number;
  firstObservedAt: number;
  lastObservedAt: number;
  sources: string[];
  examples: string[];
  contradictionScore: number;
};

export type BehavioralLearningInput = {
  now?: number;
  clock?: { now(): number };
  storagePath?: string;
  workingFacts: MemoryFact[];
  episodicItems: EpisodicMemoryItem[];
  sourceDocuments?: MemoryDocument[];
};

export type BehavioralLearningResult = {
  observations: BehavioralObservation[];
  promotedFacts: LearnedBehaviorFact[];
  semanticDocuments: MemoryDocument[];
  semanticChunks: ChunkRecord[];
  patterns: BehavioralPattern[];
  theory: UserBehaviorTheory;
  policies: BehaviorPolicy[];
  forecasts: BehaviorForecast[];
  nextBestActions: string[];
  summary: string;
};

type ObservationBucket = {
  category: BehavioralCategory;
  subject: string;
  value: string;
  sources: Set<string>;
  evidence: Set<string>;
  firstObservedAt: number;
  lastObservedAt: number;
  confidenceSum: number;
  confidenceCount: number;
  examples: string[];
};

type SubjectBucket = {
  category: BehavioralCategory;
  subject: string;
  values: Map<string, ObservationBucket>;
};

type BehavioralModelSnapshot = {
  observations: BehavioralObservation[];
  learnedFacts: LearnedBehaviorFact[];
  lastPatterns: BehavioralPattern[];
  theory: UserBehaviorTheory | null;
  policies: BehaviorPolicy[];
  forecasts: BehaviorForecast[];
  sessionCount: number;
};

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'via', 'from', 'use', 'keep', 'make', 'do', 'be', 'is', 'are', 'was', 'were']);
const GENERIC_SUBJECTS = new Set(['', 'tone', 'style', 'channel', 'preferred', 'preference', 'timing', 'time', 'schedule', 'relationship', 'relation', 'habit']);
const TONE_WORDS = new Set(['brief', 'concise', 'professional', 'formal', 'casual', 'direct', 'polite', 'friendly', 'patient', 'respectful', 'short', 'clear']);
const CHANNEL_WORDS = new Set(['email', 'whatsapp', 'discord', 'calendar', 'browser', 'phone', 'call', 'chat', 'text', 'message']);
const SCHEDULE_WORDS = new Set(['morning', 'afternoon', 'evening', 'night', 'late', 'asap', 'soon', 'follow-up', 'daily', 'weekly', 'monthly', 'weekday', 'weekend']);
const RELATIONSHIP_WORDS = new Set(['bt group', 'manager', 'line manager', 'colleague', 'contact', 'partner', 'client', 'mentor', 'flatmate', 'friend', 'family', 'student']);
const CATEGORY_ALIASES: Record<string, BehavioralCategory> = {
  tone: 'tone',
  style: 'tone',
  channel: 'channel',
  timing: 'schedule',
  schedule: 'schedule',
  time: 'schedule',
  habit: 'habit',
  preference: 'preference',
  prefs: 'preference',
  relationship: 'relationship',
  relation: 'relationship',
  collaboration: 'collaboration',
  collaborator: 'collaboration',
  correction: 'correction',
  signal: 'signal',
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9@._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function canonicalPhrase(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, '')
    .replace(/[^a-z0-9@._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return canonicalPhrase(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9@._-]/g, ''))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function selectBestValue(values: ObservationBucket[]): ObservationBucket {
  return [...values].sort((left, right) => {
    const leftScore = left.evidence.size * 2 + left.sources.size + left.confidenceSum;
    const rightScore = right.evidence.size * 2 + right.sources.size + right.confidenceSum;
    return rightScore - leftScore || right.lastObservedAt - left.lastObservedAt;
  })[0];
}

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 18)}`;
}

function inferCategoryFromKey(key: string, fallback: BehavioralCategory): BehavioralCategory {
  const prefix = key.split(':', 1)[0].toLowerCase();
  return CATEGORY_ALIASES[prefix] ?? fallback;
}

function inferSubjectFromKey(key: string, category: BehavioralCategory): string {
  const cleaned = key.includes(':') ? key.split(':').slice(1).join(':') : key;
  const candidate = canonicalPhrase(cleaned || category);
  if (category === 'preference') return candidate || category;
  return GENERIC_SUBJECTS.has(candidate) ? category : candidate;
}

function extractLexiconPhrase(text: string, lexicon: Set<string>): string | null {
  const tokens = canonicalPhrase(text).split(/\s+/).filter(Boolean);
  const picks = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!lexicon.has(tokens[i])) continue;
    for (let j = Math.max(0, i - 3); j <= i; j += 1) {
      const token = tokens[j];
      if (STOPWORDS.has(token) || token === 'tone' || token === 'style' || token === 'channel') continue;
      if (lexicon.has(token)) picks.add(token);
    }
  }
  return picks.size > 0 ? [...picks].join(' ') : null;
}

function splitEvidence(text: string): string[] {
  return tokenize(text).filter((token) => token.length > 2);
}

function guessBehavioralObservationsFromFact(fact: MemoryFact): BehavioralObservation[] {
  const category = inferCategoryFromKey(fact.key, 'signal');
  const subject = inferSubjectFromKey(fact.key, category);
  const evidence = splitEvidence(`${fact.key} ${fact.value}`);
  const observations: BehavioralObservation[] = [{
    subject,
    value: canonicalPhrase(fact.value),
    category,
    source: fact.source,
    confidence: Math.min(1, Math.max(0.1, fact.confidence)),
    observedAt: fact.updatedAt,
    evidence,
    context: { key: fact.key },
  }];

  if (category === 'preference' && /tone|style|channel|timing|schedule/.test(subject)) {
    observations.push({
      subject: subject.replace(/^preference[:\-]*/, ''),
      value: canonicalPhrase(fact.value),
      category: subject.includes('tone') ? 'tone' : subject.includes('channel') ? 'channel' : subject.includes('schedule') || subject.includes('timing') ? 'schedule' : 'preference',
      source: fact.source,
      confidence: Math.min(1, fact.confidence + 0.05),
      observedAt: fact.updatedAt,
      evidence,
      context: { key: fact.key, derived: true },
    });
  }

  return observations;
}

function inferBehavioralObservationsFromEpisode(item: EpisodicMemoryItem): BehavioralObservation[] {
  const text = canonicalPhrase(`${item.summary} ${item.signals.join(' ')}`);
  const observations: BehavioralObservation[] = [];
  const evidence = splitEvidence(text);
  const confidence = Math.min(1, Math.max(0.2, item.score));

  const make = (subject: string, value: string, category: BehavioralCategory, source = `episode:${item.taskId}`): BehavioralObservation => ({
    subject,
    value,
    category,
    source,
    confidence,
    observedAt: item.createdAt,
    evidence,
    context: { itemId: item.id, category: item.category, taskId: item.taskId },
  });

  const toneValue = extractLexiconPhrase(text, TONE_WORDS);
  if (toneValue) observations.push(make('tone', toneValue, 'tone'));

  const channelValue = extractLexiconPhrase(text, CHANNEL_WORDS);
  if (channelValue) observations.push(make('channel', channelValue, 'channel'));

  const scheduleValue = extractLexiconPhrase(text, SCHEDULE_WORDS);
  if (scheduleValue) observations.push(make('schedule', scheduleValue, 'schedule'));

  const relationshipValue = extractLexiconPhrase(text, RELATIONSHIP_WORDS);
  if (relationshipValue) observations.push(make('relationship', relationshipValue, 'relationship'));

  const preferenceMatch = text.match(/\b(prefers?|prefer|likes?|usually|tends to|often|avoid|should|best)\b[^.]{0,80}/g);
  if (observations.length === 0 && preferenceMatch?.length) observations.push(make('preference', canonicalPhrase(preferenceMatch.join(' ')), 'preference'));

  if (observations.length === 0) observations.push(make(item.category, item.summary, item.category === 'preference' ? 'preference' : 'signal'));

  return observations;
}

function bucketObservation(subjectBuckets: Map<string, SubjectBucket>, observation: BehavioralObservation): void {
  const subjectKey = [observation.category, normalizeKey(observation.subject)].join('|');
  const bucket = subjectBuckets.get(subjectKey) ?? { category: observation.category, subject: canonicalPhrase(observation.subject), values: new Map() };
  const valueKey = normalizeKey(observation.value);
  const entry = bucket.values.get(valueKey) ?? {
    category: observation.category,
    subject: canonicalPhrase(observation.subject),
    value: canonicalPhrase(observation.value),
    sources: new Set<string>(),
    evidence: new Set<string>(),
    firstObservedAt: observation.observedAt,
    lastObservedAt: observation.observedAt,
    confidenceSum: 0,
    confidenceCount: 0,
    examples: [],
  };

  entry.sources.add(observation.source);
  for (const item of observation.evidence ?? []) entry.evidence.add(item);
  entry.firstObservedAt = Math.min(entry.firstObservedAt, observation.observedAt);
  entry.lastObservedAt = Math.max(entry.lastObservedAt, observation.observedAt);
  entry.confidenceSum += observation.confidence;
  entry.confidenceCount += 1;
  if (observation.value && entry.examples.length < 5) entry.examples.push(observation.value);
  bucket.values.set(valueKey, entry);
  subjectBuckets.set(subjectKey, bucket);
}

function buildPromotedFact(subject: string, category: BehavioralCategory, value: string, bucket: ObservationBucket, now: number): LearnedBehaviorFact {
  const evidenceCount = bucket.evidence.size;
  const sourceCount = bucket.sources.size;
  const meanConfidence = bucket.confidenceSum / Math.max(1, bucket.confidenceCount);
  const recencyHours = Math.max(0, (now - bucket.lastObservedAt) / 3_600_000);
  const recencyBoost = Math.exp(-recencyHours / 72);
  const supportBoost = Math.min(1, evidenceCount / 3) * 0.35 + Math.min(1, sourceCount / 2) * 0.2 + meanConfidence * 0.3 + recencyBoost * 0.15;
  const confidence = Number(Math.min(1, supportBoost + 0.05).toFixed(3));
  const rationale = `learned from ${evidenceCount} evidence items across ${sourceCount} source${sourceCount === 1 ? '' : 's'} with recency-adjusted confidence`;
  const key = category === 'preference' || category === 'tone' || category === 'channel' || category === 'schedule'
    ? `preference:${category === 'preference' ? subject : category}`
    : `user-model:${category}:${subject}`;
  return {
    key,
    value,
    confidence,
    source: 'behavioral-learning',
    updatedAt: now,
    category,
    evidenceCount,
    firstObservedAt: bucket.firstObservedAt,
    lastObservedAt: bucket.lastObservedAt,
    sources: [...bucket.sources],
    rationale,
  };
}

function scorePattern(bucket: ObservationBucket, subjectBucket: SubjectBucket, now: number): number {
  const evidenceCount = bucket.evidence.size;
  const sourceCount = bucket.sources.size;
  const meanConfidence = bucket.confidenceSum / Math.max(1, bucket.confidenceCount);
  const distinctValues = subjectBucket.values.size;
  const recencyHours = Math.max(0, (now - bucket.lastObservedAt) / 3_600_000);
  const recencyBoost = Math.exp(-recencyHours / 72);
  const contradictionPenalty = distinctValues > 1 ? Math.max(0.2, 1 - (distinctValues - 1) * 0.18) : 1;
  const densityBoost = Math.min(1, bucket.evidence.size / 2) * 0.2 + Math.min(1, bucket.confidenceCount / 3) * 0.2;
  return Number(Math.min(1, (meanConfidence * 0.35 + recencyBoost * 0.2 + densityBoost + Math.min(1, sourceCount / 2) * 0.15 + Math.min(1, evidenceCount / 4) * 0.1) * contradictionPenalty).toFixed(3));
}

function serializeSnapshot(snapshot: BehavioralModelSnapshot): string {
  return JSON.stringify(snapshot);
}

function deserializeSnapshot(payload: string): BehavioralModelSnapshot | null {
  try {
    const parsed = JSON.parse(payload) as BehavioralModelSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      observations: Array.isArray(parsed.observations) ? parsed.observations as BehavioralObservation[] : [],
      learnedFacts: Array.isArray(parsed.learnedFacts) ? parsed.learnedFacts as LearnedBehaviorFact[] : [],
      lastPatterns: Array.isArray(parsed.lastPatterns) ? parsed.lastPatterns as BehavioralPattern[] : [],
      theory: parsed.theory ?? null,
      policies: Array.isArray(parsed.policies) ? parsed.policies as BehaviorPolicy[] : [],
      forecasts: Array.isArray(parsed.forecasts) ? parsed.forecasts as BehaviorForecast[] : [],
      sessionCount: typeof parsed.sessionCount === 'number' ? parsed.sessionCount : 0,
    };
  } catch {
    return null;
  }
}

export class BehavioralLearningLayer {
  private readonly snapshotPath: string;
  private readonly observations: BehavioralObservation[] = [];
  private readonly learnedFacts = new Map<string, LearnedBehaviorFact>();
  private lastPatterns: BehavioralPattern[] = [];
  private lastTheory: UserBehaviorTheory | null = null;
  private lastPolicies: BehaviorPolicy[] = [];
  private lastForecasts: BehaviorForecast[] = [];
  private sessionCount = 0;

  constructor(options: { storagePath?: string } = {}) {
    const defaultPath = resolve(process.cwd(), '.poke-core', 'behavioral-state.json');
    this.snapshotPath = resolve(options.storagePath ?? defaultPath);
    this.restore();
  }

  private restore(): void {
    if (!existsSync(this.snapshotPath)) return;
    const snapshot = deserializeSnapshot(readFileSync(this.snapshotPath, 'utf8'));
    if (!snapshot) return;
    this.observations.push(...snapshot.observations);
    for (const fact of snapshot.learnedFacts) this.learnedFacts.set(fact.key, fact);
    this.lastPatterns = snapshot.lastPatterns;
    this.lastTheory = snapshot.theory;
    this.lastPolicies = snapshot.policies;
    this.lastForecasts = snapshot.forecasts;
    this.sessionCount = snapshot.sessionCount;
  }

  private persist(): void {
    const snapshot: BehavioralModelSnapshot = {
      observations: this.observations,
      learnedFacts: [...this.learnedFacts.values()],
      lastPatterns: this.lastPatterns,
      theory: this.lastTheory,
      policies: this.lastPolicies,
      forecasts: this.lastForecasts,
      sessionCount: this.sessionCount,
    };
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    writeFileSync(this.snapshotPath, serializeSnapshot(snapshot), 'utf8');
  }

  observe(observation: BehavioralObservation): BehavioralObservation {
    const normalized: BehavioralObservation = {
      ...observation,
      subject: canonicalPhrase(observation.subject),
      value: canonicalPhrase(observation.value),
      source: canonicalPhrase(observation.source),
      confidence: Math.min(1, Math.max(0, observation.confidence)),
      evidence: [...new Set((observation.evidence ?? []).map((item) => canonicalPhrase(item)).filter(Boolean))],
    };
    this.observations.push(normalized);
    return normalized;
  }

  observeFacts(facts: MemoryFact[]): BehavioralObservation[] {
    return facts.flatMap((fact) => guessBehavioralObservationsFromFact(fact).map((observation) => this.observe(observation)));
  }

  observeEpisodes(items: EpisodicMemoryItem[]): BehavioralObservation[] {
    return items.flatMap((item) => inferBehavioralObservationsFromEpisode(item).map((observation) => this.observe(observation)));
  }

  learn(input: BehavioralLearningInput): BehavioralLearningResult {
    const now = input.now ?? input.clock?.now() ?? Date.now();
    this.sessionCount += 1;
    const observations = [
      ...this.observeFacts(input.workingFacts),
      ...this.observeEpisodes(input.episodicItems),
    ];

    for (const doc of input.sourceDocuments ?? []) {
      const sourceObservation: BehavioralObservation = {
        subject: canonicalPhrase(doc.title || doc.id),
        value: canonicalPhrase(doc.body.slice(0, 240)),
        category: doc.tags.includes('preference') ? 'preference' : 'signal',
        source: doc.source,
        confidence: Math.min(1, doc.importance ?? 0.6),
        observedAt: doc.updatedAt,
        evidence: splitEvidence(`${doc.title} ${doc.body}`),
        context: { documentId: doc.id, threadId: doc.threadId, relationshipId: doc.relationshipId },
      };
      observations.push(this.observe(sourceObservation));
    }

    const grouped = new Map<string, SubjectBucket>();
    for (const observation of this.observations) bucketObservation(grouped, observation);

    const patterns: BehavioralPattern[] = [];
    for (const subjectBucket of grouped.values()) {
      const best = selectBestValue([...subjectBucket.values.values()]);
      const score = scorePattern(best, subjectBucket, now);
      patterns.push({
        key: stableId('behavior', [subjectBucket.category, subjectBucket.subject, best.value]),
        category: subjectBucket.category,
        subject: subjectBucket.subject,
        value: best.value,
        evidenceCount: best.evidence.size,
        sourceCount: best.sources.size,
        confidence: score,
        firstObservedAt: best.firstObservedAt,
        lastObservedAt: best.lastObservedAt,
        sources: [...best.sources],
        examples: best.examples,
        contradictionScore: Number(Math.min(1, Math.max(0, (subjectBucket.values.size - 1) / Math.max(1, subjectBucket.values.size))).toFixed(3)),
      });
    }
    this.lastPatterns = patterns;

    for (const subjectBucket of grouped.values()) {
      const best = selectBestValue([...subjectBucket.values.values()]);
      const score = scorePattern(best, subjectBucket, now);
      if (score < 0.55 && best.evidence.size < 2 && best.sources.size < 2) continue;
      const fact = buildPromotedFact(subjectBucket.subject, subjectBucket.category, best.value, best, now);
      const current = this.learnedFacts.get(fact.key);
      if (!current || current.confidence <= fact.confidence || current.lastObservedAt <= fact.lastObservedAt) {
        this.learnedFacts.set(fact.key, fact);
      }
    }

    const retained = [...this.learnedFacts.values()].sort((left, right) => right.confidence - left.confidence || right.lastObservedAt - left.lastObservedAt);
    const theoryBundle = buildBehavioralModel({
      now,
      observations: this.observations,
      facts: retained,
      patterns,
      episodes: input.episodicItems,
      sourceDocuments: input.sourceDocuments,
      priorTheory: this.lastTheory,
    });
    this.lastTheory = { ...theoryBundle.theory, sessionCount: Math.max(theoryBundle.theory.sessionCount, this.sessionCount) };
    this.lastPolicies = theoryBundle.policies;
    this.lastForecasts = theoryBundle.forecasts;

    const semanticDocuments: MemoryDocument[] = retained.map((fact) => ({
      id: stableId('user-model', [fact.key, fact.value]),
      source: 'behavioral-learning',
      title: `user model / ${fact.key}`,
      body: [
        `value: ${fact.value}`,
        `confidence: ${fact.confidence.toFixed(3)}`,
        `evidence-count: ${fact.evidenceCount}`,
        `sources: ${fact.sources.join(', ')}`,
        `rationale: ${fact.rationale}`,
      ].join('\n'),
      createdAt: fact.firstObservedAt,
      updatedAt: now,
      tags: ['semantic', 'behavioral', fact.category, 'user-model'],
      metadata: {
        category: fact.category,
        evidenceCount: fact.evidenceCount,
        sources: fact.sources,
        rationale: fact.rationale,
        confidence: fact.confidence,
      },
      relationshipId: fact.key.startsWith('preference:') ? 'preference' : undefined,
      importance: fact.confidence,
    }));

    const semanticChunks: ChunkRecord[] = semanticDocuments.flatMap((doc) => {
      const chunks = doc.body.split(/\n+/).filter(Boolean);
      return chunks.map((text, position) => ({
        chunkId: stableId('chunk', [doc.id, String(position)]),
        documentId: doc.id,
        position,
        text,
        tokenCount: text.split(/\s+/).filter(Boolean).length,
        termVector: tokenize(text).reduce<Record<string, number>>((acc, token) => { acc[token] = (acc[token] ?? 0) + 1; return acc; }, {}),
        embedding: [],
        salience: Number(doc.importance?.toFixed(3) ?? '0.500'),
        recencyScore: Number(Math.exp(-Math.max(0, (now - doc.updatedAt) / 3_600_000) / 72).toFixed(3)),
        lifecycle: doc.tags.includes('preference') ? 'preference' : doc.tags.includes('behavioral') ? 'reference' : 'unknown',
        source: doc.source,
      }));
    });

    this.persist();
    const summary = `${retained.length} behavioral facts promoted from ${this.observations.length} observations across ${grouped.size} learned patterns; ${theoryBundle.summary}`;
    return {
      observations,
      promotedFacts: retained,
      semanticDocuments,
      semanticChunks,
      patterns,
      theory: this.lastTheory,
      policies: this.lastPolicies,
      forecasts: this.lastForecasts,
      nextBestActions: theoryBundle.nextBestActions,
      summary,
    };
  }

  evaluate(context: Record<string, unknown>): { policies: BehaviorPolicy[]; nextBestActions: string[]; forecasts: BehaviorForecast[] } {
    const policies = evaluateBehaviorPolicies(context, this.lastPolicies);
    const nextBestActions = policies.map((policy) => policy.action.value);
    return { policies, nextBestActions, forecasts: this.lastForecasts };
  }

  snapshot(): { observations: BehavioralObservation[]; promotedFacts: LearnedBehaviorFact[]; patterns: BehavioralPattern[]; theory: UserBehaviorTheory | null; policies: BehaviorPolicy[]; forecasts: BehaviorForecast[]; sessionCount: number } {
    return {
      observations: [...this.observations],
      promotedFacts: [...this.learnedFacts.values()],
      patterns: [...this.lastPatterns],
      theory: this.lastTheory,
      policies: [...this.lastPolicies],
      forecasts: [...this.lastForecasts],
      sessionCount: this.sessionCount,
    };
  }
}
