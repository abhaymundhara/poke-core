import { createHash } from 'node:crypto';
import { buildBehavioralModel, type UserBehaviorTheory } from '../memory/behavioral-theory';
import { BehavioralLearningLayer, type BehavioralObservation, type BehavioralPattern, type LearnedBehaviorFact } from '../memory/behavioral-learning';
import { normalizeWallTime, type Attendee, type RecurrenceSpec, type ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';

type VisionFrame = { id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } };

export type RaidingAiRuntimeSignals = {
  now: number;
  capturedAt: string;
  localeHint: string;
  locales: string[];
  timeZone: string;
  timezoneLocal: string;
  timezoneExpectedUtc: string;
  tabName: string;
  windowName: string;
  roleName: string;
  threadAnchor: string;
  frames: VisionFrame[];
  keys: string[];
  fallbackSelectors: string[];
  theory: UserBehaviorTheory;
  observations: BehavioralObservation[];
  facts: LearnedBehaviorFact[];
  patterns: BehavioralPattern[];
  episodes: EpisodicMemoryItem[];
  memoryFacts: MemoryFact[];
  attendees: Attendee[];
  threadA: ThreadIdentityInput;
  threadB: ThreadIdentityInput;
  recurrence: RecurrenceSpec;
  summary: string;
};

export type RaidingAiTrace = {
  captureId: string;
  capturedAt: string;
  taskHint: string;
  summary: string;
  behavioral: {
    observations: BehavioralObservation[];
    facts: LearnedBehaviorFact[];
    patterns: BehavioralPattern[];
    episodes: EpisodicMemoryItem[];
  };
  computerUse: {
    frames: VisionFrame[];
    keys: string[];
    fallbackSelectors: string[];
  };
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
  signalBridge: {
    localeHint: string;
    locales: string[];
    tabName: string;
    windowName: string;
    roleName: string;
    threadAnchor: string;
  };
};

function hashText(...parts: string[]): string {
  return createHash('sha256').update(parts.reduce((acc, part, index) => acc + (index === 0 ? part : `|${part}`), '')).digest('hex');
}

function token(...parts: string[]): string {
  return hashText(...parts).slice(0, 12);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 0);
}

function theoryWords(theory: UserBehaviorTheory): string[] {
  return [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].flatMap(words);
}

export function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number, min = 4, max = 7): string {
  const pool = theoryWords(theory);
  if (pool.length === 0) return token(seed, scope, String(index));
  const count = Math.max(min, Math.min(max, 3 + (parseInt(token(seed, scope, String(index)).slice(0, 2), 16) % (max - min + 1))));
  const parts: string[] = [];
  for (let offset = 0; offset < count && offset < pool.length; offset += 1) {
    const next = pool[(parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, String(index)).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  return cleanText([...parts, ...hashed].join(' '));
}

function runtimeLocale(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().locale || '';
  const envLocale = process.env.LANG?.split('.')[0] ?? '';
  return resolved || envLocale || String(new Intl.NumberFormat().resolvedOptions().locale || '');
}

function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}

function splitLocale(value: string): string[] {
  const normalized = value.trim().replace(/_/g, '-');
  const [language, region] = normalized.split('-');
  return region ? [language, `${language}-${region}`] : [language].filter(Boolean);
}

function wallParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

function wallClockString(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year.toString().padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function entropyPhrase(seed: string, scope: string, index: number, inputs: string[], min = 3, max = 6): string {
  const pool = inputs.flatMap(words).filter(Boolean);
  if (pool.length === 0) return token(seed, scope, String(index));
  const count = Math.max(min, Math.min(max, 3 + (parseInt(token(seed, scope, String(index)).slice(0, 2), 16) % (max - min + 1))));
  const parts: string[] = [];
  for (let offset = 0; offset < count && offset < pool.length; offset += 1) {
    const next = pool[(parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, String(index)).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  return cleanText([...parts, ...hashed].join(' '));
}

function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  const cwd = process.cwd();
  const argv = process.argv.slice(1, 5).reduce((acc, part, index) => acc + (index === 0 ? part : ` ${part}`), '');
  const envParts = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV].filter(Boolean) as string[];
  const env = envParts.reduce((acc, part, index) => acc + (index === 0 ? part : ` ${part}`), '');
  const entropy = [localeHint, timeZone, cwd, argv, env, String(process.pid), String(process.ppid)];
  const categorySeed = token(localeHint, timeZone, String(now), '0');
  const sourceSeed = token(localeHint, timeZone, String(now), '1');
  return Array.from({ length: 6 }, (_, index) => {
    const category = token(categorySeed, String(index % 3));
    const source = token(sourceSeed, String(index % 3));
    const subject = entropyPhrase(localeHint, timeZone, index, entropy, 3, 5);
    const value = entropyPhrase(timeZone, localeHint, index + 11, entropy, 4, 6);
    const evidence = [
      token(category, subject, String(index)),
      token(source, value, String(index)),
      token(localeHint, timeZone, cwd, String(index)),
    ];
    return {
      subject,
      value,
      category: category as BehavioralObservation['category'],
      source,
      confidence: Number((0.89 + (index % 4) * 0.01).toFixed(3)),
      observedAt: now - index * 17_000,
      evidence,
      context: {
        [token(subject, 'a')]: entropyPhrase(cwd, argv, index, entropy, 2, 4),
        [token(value, 'b')]: token(env || localeHint, timeZone, String(index)),
      },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return Array.from({ length: Math.max(5, pools.length || 0) }, (_, index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return {
      key: token(base, localeHint, timeZone, String(index)),
      value: phraseFromTheory(theory, localeHint, timeZone, index),
      confidence: Number((0.84 + (index % 3) * 0.03).toFixed(3)),
      source: token(localeHint, timeZone, String(index), String(index + 97)),
      updatedAt: now - index * 17_000,
    };
  });
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return Array.from({ length: 4 }, (_, index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return {
      id: token(base, localeHint, String(index)),
      taskId: token(localeHint, String(index), base),
      category: token(base, String(index + 1), localeHint),
      summary: phraseFromTheory(theory, localeHint, base, index),
      signals: words(base).slice(0, 5),
      score: Number((0.83 + (index % 2) * 0.04).toFixed(3)),
      createdAt: now - index * 23_000,
    };
  });
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const scope = token(theory.summary, localeHint, String(now));
  return [0, 1, 2].map((index) => {
    const fragment = token(scope, String(index));
    const dom = JSON.stringify({
      [token(scope, String(index), '0')]: fragment,
      [token(scope, String(index), '1')]: theory.id.slice(0, 10),
      [token(scope, String(index), '2')]: localeHint,
    });
    return {
      id: token(scope, String(index), localeHint),
      ocr: phraseFromTheory(theory, scope, localeHint, index),
      dom,
      selectors: [token(fragment, String(index), String(index + 1)), token(fragment, String(index), String(index + 2))],
      activeTabId: token(scope, String(index), String(index + 11)),
      activeWindowId: token(scope, String(index), String(index + 23)),
      viewport: { width: 1280, height: index === 1 ? 790 : 816 },
    };
  });
}

function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  return [0, 1, 2].map((index) => ({
    email: `${token(seed, String(index), String(index + 1))}@${token(seed, String(index), String(index + 2))}.local`,
    name: phraseFromTheory(theory, seed, token(seed, String(index), String(index + 3)), index),
    locale: index === 1 ? (splitLocale(localeHint)[0] ?? localeHint) : localeHint,
    timezone: timeZone,
  }));
}

function buildThreadIdentity(theory: UserBehaviorTheory, localeHint: string, timeZone: string, subjectScope: string, rootMessageId: string, messageSeed: string, roleName: string): ThreadIdentityInput {
  const participants = buildAttendees(theory, localeHint, timeZone, roleName).map((attendee) => ({
    email: attendee.email,
    name: attendee.name,
    locale: attendee.locale,
    timezone: attendee.timezone,
    role: attendee.role,
  }));
  return {
    subject: phraseFromTheory(theory, subjectScope, messageSeed, 0),
    participants,
    messageId: token(subjectScope, messageSeed, timeZone),
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
  };
}

function buildRecurrence(now: number, timeZone: string): RecurrenceSpec {
  const start = new Date(now + 86_400_000);
  const weekday = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short' }).format(start).slice(0, 2).toUpperCase();
  const local = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}T09:00:00`;
  return { startLocal: local, timeZone, rule: `FREQ=WEEKLY;COUNT=3;BYDAY=${weekday}`, durationMinutes: 45 };
}

export class SignalBridge {
  capture(now = Date.now()): RaidingAiRuntimeSignals {
    const localeHint = runtimeLocale();
    const timeZone = runtimeTimeZone();
    const observations = buildRuntimeObservations(now, localeHint, timeZone);
    const theory = buildBehavioralModel({ now, observations, facts: [], patterns: [], priorTheory: null }).theory;
    const memoryFacts = buildMemoryFacts(theory, now, localeHint, timeZone);
    const learning = new BehavioralLearningLayer({ storagePath: token(String(now), localeHint, timeZone) });
    const learned = learning.learn({ now, workingFacts: memoryFacts, episodicItems: buildEpisodes(theory, now, localeHint), sourceDocuments: [] });
    const roleName = token(theory.summary, localeHint, timeZone, String(now));
    const tabName = token(theory.summary, localeHint, timeZone, String(now + 1));
    const windowName = token(theory.summary, localeHint, timeZone, String(now + 2));
    const threadAnchor = token(theory.summary, localeHint, timeZone, String(now + 3));
    const subjectScope = token(theory.summary, localeHint, timeZone, String(now + 4));
    const rootMessageId = token(subjectScope, threadAnchor, localeHint);
    const timezoneLocal = wallClockString(new Date(now), timeZone);
    const timezoneExpectedUtc = normalizeWallTime(timezoneLocal, timeZone).utc;
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales: Array.from(new Set([localeHint, ...splitLocale(localeHint)])).filter(Boolean),
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames: buildUiFrames(theory, now, localeHint),
      keys: [0, 1, 2].map((index) => token(threadAnchor, String(index), localeHint)),
      fallbackSelectors: [token(threadAnchor, String(0), String(1)), token(threadAnchor, String(2), String(3))],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: buildEpisodes(learned.theory, now, localeHint),
      memoryFacts,
      attendees: buildAttendees(theory, localeHint, timeZone, roleName),
      threadA: buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, threadAnchor, roleName),
      threadB: buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, token(threadAnchor, String(1)), roleName),
      recurrence: buildRecurrence(now, timeZone),
      summary: phraseFromTheory(theory, threadAnchor, localeHint, 0),
    };
  }

  buildTrace(now = Date.now()): RaidingAiTrace {
    const runtime = this.capture(now);
    const captureId = token(runtime.threadAnchor, runtime.summary, runtime.capturedAt);
    return {
      captureId,
      capturedAt: runtime.capturedAt,
      taskHint: phraseFromTheory(runtime.theory, runtime.threadAnchor, runtime.localeHint, 1),
      summary: runtime.summary,
      behavioral: { observations: runtime.observations, facts: runtime.facts, patterns: runtime.patterns, episodes: runtime.episodes },
      computerUse: { frames: runtime.frames, keys: runtime.keys, fallbackSelectors: runtime.fallbackSelectors },
      deepPrimitives: {
        threadA: runtime.threadA,
        threadB: runtime.threadB,
        timezone: { local: runtime.timezoneLocal, timeZone: runtime.timeZone, expectedUtc: runtime.timezoneExpectedUtc },
        attendees: runtime.attendees,
        recurrence: runtime.recurrence,
      },
      signalBridge: { localeHint: runtime.localeHint, locales: runtime.locales, tabName: runtime.tabName, windowName: runtime.windowName, roleName: runtime.roleName, threadAnchor: runtime.threadAnchor },
    };
  }
}

export function captureRaidingAiSignals(now = Date.now()): RaidingAiRuntimeSignals {
  return new SignalBridge().capture(now);
}

export function deriveRaidingAiTrace(now = Date.now()): RaidingAiTrace {
  return new SignalBridge().buildTrace(now);
}
