import { createHash, randomUUID } from 'node:crypto';
import { buildBehavioralModel } from '../memory/behavioral-theory';
import { BehavioralLearningLayer, type BehavioralObservation, type BehavioralPattern, type LearnedBehaviorFact } from '../memory/behavioral-learning';
import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
type VisionFrame = { id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } };
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';

export type RaidingAiScenario = {
  seed: string;
  now: number;
  label: string;
  taskHint: string;
  theory: UserBehaviorTheory;
  computerUse: { frames: VisionFrame[]; keys: string[]; fallbackSelectors: string[] };
  deepPrimitives: {
    threadA: ThreadIdentityInput;
    threadB: ThreadIdentityInput;
    timezone: {
      local: string;
      timeZone: string;
      expectedUtc: string;
    };
    attendees: Attendee[];
    recurrence: RecurrenceSpec;
  };
  memory: { facts: MemoryFact[]; episodes: EpisodicMemoryItem[] };
  traces: Array<{
    id: string;
    kind: string;
    description: string;
    frames?: VisionFrame[];
    fallbackSelectors?: string[];
    threadInputs?: ThreadIdentityInput[];
    workingFacts?: MemoryFact[];
    episodicItems?: EpisodicMemoryItem[];
    objective?: string;
    expected: Record<string, boolean | number | string>;
  }>;
};

type Rng = () => number;

function hashText(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function seedFromInput(input?: { seed?: string; taskHint?: string; now?: number }): string {
  return hashText(String(input?.seed ?? ''), String(input?.taskHint ?? ''), String(input?.now ?? Date.now()), randomUUID()).slice(0, 24);
}

function createRng(seed: string): Rng {
  let state = parseInt(seed.slice(0, 8), 16) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(seed: string, scope: string, index = 0): string {
  return hashText(seed, scope, String(index)).slice(0, 10);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 2);
}

function pickFromSeed<T>(seed: string, scope: string, values: readonly T[]): T {
  const index = values.length === 0 ? 0 : parseInt(token(seed, scope).slice(0, 2), 16) % values.length;
  return values[index] ?? values[0];
}

function phraseFromText(text: string, seed: string, index: number): string {
  const tokens = words(text);
  const extra = token(seed, 'phrase', index).match(/.{1,4}/g) ?? [];
  return cleanText([...tokens.slice(0, 5), ...extra.slice(0, 2)].join(' '));
}

function theoryWords(theory: UserBehaviorTheory): string[] {
  return [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].flatMap(words);
}

function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number, min = 4, max = 7): string {
  const pool = theoryWords(theory);
  if (pool.length === 0) return cleanText([token(seed, scope, index), token(seed, scope, index + 1)].join(' '));
  const count = Math.max(min, Math.min(max, 3 + (parseInt(token(seed, scope, index).slice(0, 2), 16) % (max - min + 1))));
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = pool[(parseInt(token(seed, scope, index + i).slice(0, 2), 16) + i) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, index).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  return cleanText([...parts, ...hashed].join(' '));
}

function buildBootstrapObservations(seed: string, rng: Rng): BehavioralObservation[] {
  return Array.from({ length: 6 }, (_, index) => {
    const subject = token(seed, 'subject', index);
    const value = cleanText([phraseFromText(subject, seed, index), token(seed, 'value', index + 1)].join(' '));
    return {
      subject,
      value,
      category: token(seed, 'category', index),
      source: token(seed, 'source', index),
      confidence: Number((0.72 + rng() * 0.23).toFixed(3)),
      observedAt: Date.now() - (index + 1) * 17_000,
      evidence: [subject, value, token(seed, 'evidence', index)],
      context: { seed, index },
    };
  });
}

function buildBootstrapFacts(observations: BehavioralObservation[], seed: string, now: number): LearnedBehaviorFact[] {
  return observations.map((observation, index) => ({
    key: hashText(seed, observation.subject, observation.category, String(index)).slice(0, 20),
    value: `${observation.subject} ${observation.value}`.trim(),
    confidence: observation.confidence,
    source: observation.source,
    updatedAt: now - index * 11_000,
    category: observation.category,
    evidenceCount: observation.evidence?.length ?? 0,
    firstObservedAt: observation.observedAt - 42_000,
    lastObservedAt: observation.observedAt,
    sources: [observation.source],
    rationale: phraseFromText(observation.value, seed, index),
  }));
}

function buildBootstrapPatterns(observations: BehavioralObservation[]): BehavioralPattern[] {
  return observations.map((observation, index) => ({
    key: hashText(observation.subject, observation.value, String(index)).slice(0, 24),
    category: observation.category,
    subject: observation.subject,
    value: observation.value,
    evidenceCount: observation.evidence?.length ?? 0,
    sourceCount: 1,
    confidence: observation.confidence,
    firstObservedAt: observation.observedAt - 42_000,
    lastObservedAt: observation.observedAt,
    sources: [observation.source],
    examples: observation.evidence?.slice(0, 3) ?? [],
    contradictionScore: Number((0.04 + (index % 3) * 0.03).toFixed(3)),
  }));
}

function buildTheory(seed: string, now: number, rng: Rng): UserBehaviorTheory {
  const observations = buildBootstrapObservations(seed, rng);
  const facts = buildBootstrapFacts(observations, seed, now);
  const patterns = buildBootstrapPatterns(observations);
  const bootstrap = buildBehavioralModel({ now, observations, facts, patterns, priorTheory: null });
  const learning = new BehavioralLearningLayer({ storagePath: `.poke-core/generated/${seed}/behavioral-state.json` });
  const learned = learning.learn({ now, workingFacts: facts, episodicItems: synthesizeEpisodesFromTheory(bootstrap.theory, seed, now), sourceDocuments: [] });
  return learned.theory ?? bootstrap.theory;
}

function synthesizeEpisodesFromTheory(theory: UserBehaviorTheory, seed: string, now: number): EpisodicMemoryItem[] {
  const source = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return source.slice(0, 3).map((text, index) => ({
    id: hashText(seed, text, String(index)).slice(0, 18),
    taskId: hashText(seed, String(index), 'task').slice(0, 18),
    category: token(seed, String(index), index),
    summary: phraseFromText(text, seed, index),
    signals: words(text).slice(0, 5),
    score: Number((0.78 + index * 0.04).toFixed(3)),
    createdAt: now - index * 19_000,
  }));
}

function buildParticipants(seed: string, theory: UserBehaviorTheory): ThreadIdentityInput['participants'] {
  const pools = theoryWords(theory);
  const derived = pools.slice(0, 3).map((word, index) => ({
    email: `${word.replace(/[^a-z0-9]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '')}.${index}.${hashText(seed, String(index), 'email').slice(0, 8)}@${hashText(seed, String(index), 'domain').slice(0, 10)}.local`,
    name: cleanText(`${word} ${token(seed, String(index), index)}`),
  }));
  return derived.length > 0 ? derived : [{ email: `${token(seed, '0', 0)}@${hashText(seed, '0', 'domain').slice(0, 10)}.local`, name: token(seed, '0', 0) }];
}

function buildThreadIdentity(theory: UserBehaviorTheory, seed: string, scope: string, index: number, participants: ThreadIdentityInput['participants'], rootMessageId: string): ThreadIdentityInput {
  const subject = phraseFromTheory(theory, seed, `${scope}-subject`, index);
  return {
    subject,
    participants,
    messageId: hashText(seed, scope, String(index), 'message').slice(0, 32),
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
    provider: hashText(seed, 'provider').slice(0, 8),
    mailbox: hashText(seed, 'mailbox').slice(0, 8),
  };
}

function buildUiFrames(theory: UserBehaviorTheory, seed: string): VisionFrame[] {
  const stableSelectors = [token(seed, '0', 0), token(seed, '1', 1)];
  const driftSelectors = [token(seed, '2', 2), token(seed, '3', 3)];
  return [0, 1, 2].map((index) => {
    const over = index === 1;
    const selectors = over ? driftSelectors : stableSelectors;
    const scope = token(seed, String(index), index);
    const a = phraseFromTheory(theory, seed, scope, index);
    const b = phraseFromTheory(theory, seed, token(seed, scope, 1), index + 1);
    const c = phraseFromTheory(theory, seed, token(seed, scope, 2), index + 2);
    const dom = JSON.stringify({ a, b, c, d: over ? token(seed, scope, 3) : token(seed, scope, 4), e: selectors, f: token(seed, scope, 5) });
    return {
      id: hashText(seed, scope).slice(0, 20),
      ocr: cleanText([a, b, c, theory.summary, ...theory.persistentGoals.map((goal) => goal.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].join(' ')),
      dom,
      selectors,
      activeTabId: hashText(seed, 'tab', scope).slice(0, 18),
      activeWindowId: hashText(seed, 'window', scope).slice(0, 18),
      viewport: { width: 1280, height: over ? 790 : 816 },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, seed: string, now: number): MemoryFact[] {
  return theory.latentAxes.slice(0, 6).map((axis, index) => ({
    key: hashText(seed, 'fact', axis.axis, String(index)).slice(0, 20),
    value: cleanText(`${axis.axis} ${axis.direction} ${theory.persistentGoals[index % Math.max(1, theory.persistentGoals.length)]?.goal ?? theory.summary}`),
    confidence: Number(Math.min(0.99, 0.7 + axis.confidence * 0.2).toFixed(3)),
    source: hashText(seed, 'source', String(index)).slice(0, 12),
    updatedAt: now - index * 17_000,
  }));
}

function buildEpisodes(theory: UserBehaviorTheory, seed: string, now: number): EpisodicMemoryItem[] {
  return [...theory.persistentGoals, ...theory.crossContextGeneralizations].slice(0, 3).map((entry, index) => ({
    id: hashText(seed, entry.goal ?? entry.generalization, String(index)).slice(0, 18),
    taskId: hashText(seed, String(index), 'task').slice(0, 18),
    category: token(seed, String(index), index),
    summary: cleanText(`${index === 0 ? entry.goal : entry.generalization} ${phraseFromText(entry.goal ?? entry.generalization, seed, index)}`),
    signals: words(entry.goal ?? entry.generalization).slice(0, 5),
    score: Number((0.8 + index * 0.05).toFixed(3)),
    createdAt: now - index * 23_000,
  }));
}

function parseOffsetMinutes(label: string): number {
  const normalized = label.replace(/^utc/i, 'GMT').trim();
  if (normalized === 'GMT' || normalized === 'UTC') return 0;
  const match = normalized.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes);
}

function timePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    offsetMinutes: parseOffsetMinutes(get('timeZoneName')),
  };
}

function normalizeWallTimeLocal(localIso: string, timeZone: string): string {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) throw new Error('invalid local datetime: ' + localIso);
  const target = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? '0') };
  let adjusted = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  for (let i = 0; i < 4; i += 1) {
    const offsetMinutes = timePartsInZone(new Date(adjusted), timeZone).offsetMinutes;
    const next = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second) - offsetMinutes * 60_000;
    if (Math.abs(next - adjusted) < 1_000) {
      adjusted = next;
      break;
    }
    adjusted = next;
  }
  return new Date(adjusted).toISOString();
}

function pickTimeZone(seed: string): string {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return pickFromSeed(seed, 'time-zone', supported as readonly string[]);
}

function buildTimezone(seed: string): { local: string; timeZone: string; expectedUtc: string } {
  const hour = 8 + (parseInt(token(seed, 'tz-hour').slice(0, 2), 16) % 3);
  const minute = [0, 15, 30, 45][parseInt(token(seed, 'tz-minute').slice(0, 2), 16) % 4];
  const local = `2026-03-08T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const timeZone = pickTimeZone(seed);
  return { local, timeZone, expectedUtc: normalizeWallTimeLocal(local, timeZone) };
}

function buildRecurrence(seed: string): RecurrenceSpec {
  const day = ['MO', 'TU', 'WE', 'TH', 'FR'][parseInt(token(seed, 'day').slice(0, 2), 16) % 5];
  const hour = 8 + (parseInt(token(seed, 'hour').slice(0, 2), 16) % 4);
  return { startLocal: `2026-03-09T${String(hour).padStart(2, '0')}:00:00`, timeZone: pickTimeZone(seed), rule: `FREQ=WEEKLY;COUNT=3;BYDAY=${day}`, durationMinutes: 30 + (parseInt(token(seed, 'duration').slice(0, 2), 16) % 30) };
}

function buildTaskHint(theory: UserBehaviorTheory, seed: string): string {
  return cleanText(phraseFromText(`${theory.summary} ${theory.persistentGoals.map((goal) => goal.goal).join(' ')} ${theory.crossContextGeneralizations.map((entry) => entry.generalization).join(' ')}`, seed, 0));
}

function buildLabel(seed: string, taskHint: string, theory: UserBehaviorTheory): string {
  return hashText(seed, taskHint, theory.summary, token(seed, taskHint, 0)).slice(0, 24);
}

function buildLearningLayer(seed: string): BehavioralLearningLayer {
  return new BehavioralLearningLayer({ storagePath: `.poke-core/generated/${seed}/behavioral-state.json` });
}

export function buildRaidingAiScenario(input: { seed?: string; taskHint?: string; now?: number } = {}): RaidingAiScenario {
  const seed = seedFromInput(input);
  const rng = createRng(seed);
  const now = input.now ?? Date.now();
  const initialObservations = buildBootstrapObservations(seed, rng);
  const initialLearnedFacts = buildBootstrapFacts(initialObservations, seed, now);
  const initialFacts = initialLearnedFacts.map(({ category, evidenceCount, firstObservedAt, lastObservedAt, sources, rationale, ...fact }) => ({ ...fact }));
  const initialPatterns = buildBootstrapPatterns(initialObservations);
  const bootstrap = buildBehavioralModel({ now, observations: initialObservations, facts: initialLearnedFacts, patterns: initialPatterns, priorTheory: null });
  const learning = buildLearningLayer(seed);
  const probeEpisodes = synthesizeEpisodesFromTheory(bootstrap.theory, seed, now);
  learning.observeFacts(initialFacts);
  learning.observeEpisodes(probeEpisodes);
  const snapshot = learning.snapshot();
  const theory = snapshot.theory ?? bootstrap.theory;
  const taskHint = cleanText(input.taskHint?.trim() || buildTaskHint(theory, seed));
  const label = buildLabel(seed, taskHint, theory);
  const frames = buildUiFrames(theory, seed);
  const participants = buildParticipants(seed, theory);
  const threadRoot = hashText(seed, String(now), 'root');
  const threadA = buildThreadIdentity(theory, seed, 'thread-a', 0, participants, threadRoot);
  const threadB = buildThreadIdentity(theory, seed, 'thread-b', 1, participants, threadRoot);
  threadB.references = [threadRoot, threadA.messageId].filter(Boolean) as string[];
  threadB.inReplyTo = threadA.messageId;
  const facts = buildMemoryFacts(theory, seed, now);
  const episodes = buildEpisodes(theory, seed, now);
  const recurrence = buildRecurrence(seed);
  const timezone = buildTimezone(seed);
  const attendees = participants.map((participant, index) => ({
    email: participant.email,
    name: participant.name,
    timezone: index === 0 ? timezone.timeZone : pickTimeZone(`${seed}:${index}`),
    locale: pickFromSeed(seed, `locale-${index}`, ['en-GB', 'en-US'] as const),
    role: 'required' as const,
  }));

  return {
    seed,
    now,
    label,
    taskHint,
    theory,
    computerUse: {
      frames,
      keys: [hashText(seed, 'key-0').slice(0, 4), hashText(seed, 'key-1').slice(0, 4), hashText(seed, 'key-2').slice(0, 4)],
      fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
    },
    deepPrimitives: { threadA, threadB, timezone, attendees, recurrence },
    memory: { facts, episodes },
    traces: [
      {
        id: hashText(seed, String(now), '0').slice(0, 18),
        kind: hashText(seed, theory.summary, '0').slice(0, 24),
        description: cleanText(`${taskHint} ${phraseFromText(theory.summary, seed, 1)}`),
        frames,
        fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
        expected: { driftRecoveries: 1, frameCount: 3, contextRich: true },
      },
      {
        id: hashText(seed, String(now), '1').slice(0, 18),
        kind: hashText(seed, theory.summary, '1').slice(0, 24),
        description: cleanText(`${taskHint} ${phraseFromText(theory.crossContextGeneralizations[0]?.generalization ?? theory.summary, seed, 2)}`),
        threadInputs: [threadA, threadB],
        expected: { distinctThreads: true, headerAnchored: true },
      },
      {
        id: hashText(seed, String(now), '2').slice(0, 18),
        kind: hashText(seed, theory.summary, '2').slice(0, 24),
        description: cleanText(`${taskHint} ${phraseFromText(theory.persistentGoals[0]?.goal ?? theory.summary, seed, 3)}`),
        workingFacts: facts,
        episodicItems: episodes,
        expected: { factsPersisted: true, episodesPersisted: true, theoryAligned: true },
      },
      {
        id: hashText(seed, String(now), '3').slice(0, 18),
        kind: hashText(seed, theory.summary, '3').slice(0, 24),
        description: cleanText(`${taskHint} ${phraseFromText(theory.summary, seed, 4)}`),
        objective: cleanText(`${phraseFromText(theory.summary, seed, 5)} ${phraseFromText(theory.persistentGoals[0]?.goal ?? theory.summary, seed, 6)} ${phraseFromText(theory.crossContextGeneralizations[0]?.generalization ?? theory.summary, seed, 7)}`),
        expected: { recoveryAware: true, multiStep: true },
      },
    ],
  };
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = buildRaidingAiScenario();
