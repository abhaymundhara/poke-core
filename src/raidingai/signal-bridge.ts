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

export function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number): string {
  const pool = [...theoryWords(theory), token(seed, scope, String(index))];
  const countSeed = Number.parseInt(token(seed, scope, String(index)).slice(0, 2), 16);
  const parts = pool.slice(0, countSeed % pool.length + 1).map((entry, offset) => pool[(Number.parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length]);
  const hashed = chunkText(token(seed, scope, String(index)), 4).slice(0, 2);
  return cleanText(uniqueValues([...parts, ...hashed]).join(' '));
}

function chunkText(text: string, size: number, index = 0, acc: string[] = []): string[] {
  if (index >= text.length) return acc;
  acc.push(text.slice(index, index + size));
  return chunkText(text, size, index + size, acc);
}

function uniqueValues(values: string[], index = 0, acc: string[] = []): string[] {
  if (index >= values.length) return acc;
  const value = values[index];
  if (value && !acc.includes(value)) acc.push(value);
  return uniqueValues(values, index + 1, acc);
}

function buildSeries<T>(count: number, factory: (index: number) => T, index = 0, acc: T[] = []): T[] {
  if (index >= count) return acc;
  acc.push(factory(index));
  return buildSeries(count, factory, index + 1, acc);
}

function segmentSeeds(source: string, width: number, count: number, index = 0, acc: string[] = []): string[] {
  if (index >= count) return acc;
  acc.push(source.slice(index * width, index * width + width));
  return segmentSeeds(source, width, count, index + 1, acc);
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

function entropyPhrase(seed: string, scope: string, index: number, inputs: string[]): string {
  const pool = [...inputs.flatMap(words).filter(Boolean), token(seed, scope, String(index))];
  const countSeed = Number.parseInt(token(seed, scope, String(index)).slice(0, 2), 16);
  const parts = pool.slice(0, countSeed % pool.length + 1).map((entry, offset) => pool[(Number.parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length]);
  const hashed = chunkText(token(seed, scope, String(index)), 4).slice(0, 2);
  return cleanText(uniqueValues([...parts, ...hashed]).join(' '));
}
function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  const cwd = process.cwd();
  const argv = process.argv.slice(1, 5).reduce((acc, part, index) => acc + (index === 0 ? part : ` ${part}`), '');
  const envParts = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV].filter(Boolean) as string[];
  const env = envParts.reduce((acc, part, index) => acc + (index === 0 ? part : ` ${part}`), '');
  const entropy = [localeHint, timeZone, cwd, argv, env, String(process.pid), String(process.ppid)];
  const categorySeed = token(localeHint, timeZone, String(now), '0');
  const sourceSeed = token(localeHint, timeZone, String(now), '1');
  const observationCount = Number.parseInt(token(localeHint, timeZone, String(now), 'observations').slice(0, 2), 16) % Math.max(1, entropy.length) || entropy.length;
  return buildSeries(observationCount, (index) => {
    const categoryBand = token(categorySeed, localeHint).length || entropy.length;
    const category = token(categorySeed, String(index % categoryBand));
    const sourceBand = token(sourceSeed, timeZone).length || entropy.length;
    const source = token(sourceSeed, String(index % sourceBand));
    const subject = entropyPhrase(localeHint, timeZone, index, entropy);
    const value = entropyPhrase(timeZone, localeHint, index + 11, entropy);
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
      confidence: 0.89 + (index % 4) * 0.01,
      observedAt: now - index * Date.parse('1970-01-01T00:00:17Z'),
      evidence,
      context: {
        [token(subject, 'a')]: entropyPhrase(cwd, argv, index, entropy),
        [token(value, 'b')]: token(env || localeHint, timeZone, String(index)),
      },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return buildSeries(Math.max(5, pools.length || 0), (index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return {
      key: token(base, localeHint, timeZone, String(index)),
      value: phraseFromTheory(theory, localeHint, timeZone, index),
      confidence: 0.84 + (index % (pools.length || 1)) * 0.03,
      source: token(localeHint, timeZone, String(index), String(index + 97)),
      updatedAt: now - index * Date.parse('1970-01-01T00:00:17Z'),
    };
  });
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return buildSeries(4, (index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return {
      id: token(base, localeHint, String(index)),
      taskId: token(localeHint, String(index), base),
      category: token(base, localeHint, String(index)),
      summary: phraseFromTheory(theory, localeHint, base, index),
      signals: words(base).slice(0, 5),
      score: 0.83 + (index % 2) * 0.04,
      createdAt: now - index * 23_000,
    };
  });
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const scope = token(theory.summary, localeHint, String(now));
  const frameCount = Number.parseInt(token(scope, theory.summary, localeHint, 'frames').slice(0, 1), 16) % 3 + 2;
  const frameSeeds = segmentSeeds(scope, 4, frameCount);
  return buildSeries(frameSeeds.length, (index) => {
    const frameSeed = token(scope, fragment, String(index));
    return {
      id: token(scope, frameSeed, String(index)),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, index),
      dom: JSON.stringify({
        [token(frameSeed, String(index), 'dom')]: token(scope, frameSeed, fragment),
        [token(frameSeed, String(index), 'theory')]: theory.id.slice(0, 10),
        [token(frameSeed, String(index), 'locale')]: localeHint,
      }),
      selectors: [token(frameSeed, fragment, scope), token(frameSeed, scope, fragment)],
      activeTabId: token(scope, frameSeed, fragment),
      activeWindowId: token(frameSeed, scope, fragment),
      viewport: { width: Number.parseInt(token(frameSeed, String(index), 'width').slice(0, 4), 16) + frameSeed.length, height: Number.parseInt(token(frameSeed, String(index), 'height').slice(0, 4), 16) + frameSeed.length },
    };
  });
}
function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = [localeHint, timeZone, roleName].join('|');
  const attendeeCount = Number.parseInt(token(seed, theory.summary, 'attendees').slice(0, 1), 16) % 3 + 2;
  const attendeeSeeds = segmentSeeds(seed, 4, attendeeCount);
  return buildSeries(attendeeSeeds.length, (index) => {
    const fragment = attendeeSeeds[index] ?? seed.slice(index * 4, index * 4 + 4);
    return {
      email: token(seed, fragment, localeHint) + '@' + token(seed, localeHint, fragment) + '.local',
      name: phraseFromTheory(theory, seed, token(seed, localeHint, fragment), index),
      locale: index === 1 ? (splitLocale(localeHint)[0] ?? localeHint) : localeHint,
      timezone: timeZone,
    };
  });
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

function buildRecurrence(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): RecurrenceSpec {
  const base = phraseFromTheory(theory, localeHint, timeZone, Number.parseInt(token(theory.summary, localeHint, String(now)).slice(0, 2), 16));
  const basis = token(base, theory.summary, localeHint, String(now));
  const localDate = new Date(now);
  const daySeed = Number.parseInt(token(basis, timeZone, 'day').slice(0, 2), 16);
  localDate.setUTCDate(localDate.getUTCDate() + (daySeed % (base.length || timeZone.length)));
  const hour = String(Number.parseInt(token(basis, timeZone, 'hour').slice(0, 2), 16) % 24).padStart(2, '0');
  const minute = String(Number.parseInt(token(basis, timeZone, 'minute').slice(0, 2), 16) % 60).padStart(2, '0');
  const second = String(Number.parseInt(token(basis, timeZone, 'second').slice(0, 2), 16) % 60).padStart(2, '0');
  const local = `${localDate.getUTCFullYear()}-${String(localDate.getUTCMonth() + 1).padStart(2, '0')}-${String(localDate.getUTCDate()).padStart(2, '0')}T${hour}:${minute}:${second}`;
  const rule = phraseFromTheory(theory, basis, timeZone, Number.parseInt(token(basis, timeZone, 'rule').slice(0, 2), 16)).replace(/\s+/g, '-');
  const durationMinutes = Number.parseInt(token(rule, basis, String(now)).slice(0, 2), 16) || Number.parseInt(token(basis, rule, String(now)).slice(0, 2), 16) || base.length;
  return { startLocal: local, timeZone, rule, durationMinutes };
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
    const tabName = token(theory.summary, localeHint, timeZone, token(theory.summary, localeHint, String(now + 1)));
    const windowName = token(tabName, theory.summary, localeHint);
    const threadAnchor = token(theory.summary, localeHint, timeZone, token(theory.summary, localeHint, String(now)));
    const subjectScope = token(threadAnchor, localeHint, timeZone);
    const rootMessageId = token(subjectScope, threadAnchor, localeHint);
    const timezoneLocal = wallClockString(new Date(now), timeZone);
    const timezoneExpectedUtc = normalizeWallTime(timezoneLocal, timeZone).utc;
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales: uniqueValues([localeHint, ...splitLocale(localeHint)]).filter(Boolean),
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames: buildUiFrames(theory, now, localeHint),
      keys: [threadAnchor.slice(0, 4), threadAnchor.slice(4, 8), threadAnchor.slice(8, 12)].map((fragment, index) => token(threadAnchor, fragment, String(index))),
      fallbackSelectors: [token(threadAnchor, localeHint, String(now)), token(threadAnchor, timeZone, String(now))],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: buildEpisodes(learned.theory, now, localeHint),
      memoryFacts,
      attendees: buildAttendees(theory, localeHint, timeZone, roleName),
      threadA: buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, threadAnchor, roleName),
      threadB: buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, token(threadAnchor, localeHint, timeZone), roleName),
      recurrence: buildRecurrence(theory, now, localeHint, timeZone),
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
