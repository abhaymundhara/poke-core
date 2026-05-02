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
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function token(...parts: string[]): string {
  return hashText(...parts).slice(0, 12);
}

function canonicalLocale(value: string): string {
  return value.trim().replace(/_/g, '-');
}

function runtimeLocale(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().locale || '';
  const envLocale = process.env.LANG?.split('.')[0] ?? '';
  return canonicalLocale(resolved || envLocale || String(new Intl.NumberFormat().resolvedOptions().locale || ''));
}

function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}

function splitLocale(value: string): string[] {
  const [language, region] = canonicalLocale(value).split('-');
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

function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  const cwd = process.cwd();
  const argv = process.argv.slice(1, 5).join(' ');
  const env = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV].filter(Boolean).join(' ');
  return [
    { subject: token(localeHint, timeZone), value: `${localeHint} ${splitLocale(localeHint).join(' ')}`.trim(), category: 'signal', source: 'system', confidence: 0.94, observedAt: now, evidence: [localeHint, ...splitLocale(localeHint)], context: { localeHint, timeZone } },
    { subject: token(timeZone, String(now)), value: `${timeZone} current session clock`.trim(), category: 'schedule', source: 'system', confidence: 0.92, observedAt: now, evidence: [timeZone, 'clock', 'session'], context: { timeZone } },
    { subject: token(String(process.pid), String(process.ppid), cwd), value: `${process.pid} ${process.ppid} ${cwd} ${argv}`.trim(), category: 'signal', source: 'system', confidence: 0.91, observedAt: now, evidence: [String(process.pid), String(process.ppid), cwd, argv], context: { cwd, argv } },
    { subject: token(env || 'env', localeHint, timeZone), value: `${env} concise professional structured channel relationship`.trim(), category: 'collaboration', source: 'browser', confidence: 0.93, observedAt: now, evidence: ['concise', 'professional', 'structured', 'channel', 'relationship'], context: { env } },
    { subject: token(new Date(now).toISOString(), 'feedback'), value: `${new Date(now).toISOString()} quick follow-up today`.trim(), category: 'tone', source: 'email', confidence: 0.9, observedAt: now, evidence: ['quick', 'follow-up', 'today'], context: { now } },
    { subject: token(cwd, 'structure'), value: `${cwd.split('/').slice(-2).join(' ')} bullet numbered step`.trim(), category: 'signal', source: 'memory', confidence: 0.9, observedAt: now, evidence: ['bullet', 'numbered', 'step'], context: { cwd } },
  ];
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return Array.from({ length: Math.max(5, pools.length || 0) }, (_, index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return { key: token(base, localeHint, timeZone, String(index)), value: `${base} ${localeHint} ${timeZone}`.trim(), confidence: Number((0.84 + (index % 3) * 0.03).toFixed(3)), source: 'system', updatedAt: now - index * 17_000 };
  });
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const pools = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return Array.from({ length: 4 }, (_, index) => {
    const base = pools[index % (pools.length || 1)] ?? theory.summary;
    return { id: token(base, localeHint, String(index)), taskId: token(localeHint, String(index), base), category: token(base, String(index + 1), localeHint), summary: `${base} ${localeHint}`.trim(), signals: base.split(/\s+/).slice(0, 5), score: Number((0.83 + (index % 2) * 0.04).toFixed(3)), createdAt: now - index * 23_000 };
  });
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const scope = token(theory.summary, localeHint, String(now));
  return [0, 1, 2].map((index) => {
    const fragment = token(scope, String(index));
    return {
      id: token(scope, String(index), localeHint),
      ocr: `${theory.summary} ${localeHint} ${fragment}`.trim(),
      dom: JSON.stringify({ scope: fragment, theory: theory.id.slice(0, 10), localeHint }),
      selectors: [token(fragment, String(index), '0'), token(fragment, String(index), '1')],
      activeTabId: token(scope, String(index), String(index + 11)),
      activeWindowId: token(scope, String(index), String(index + 23)),
      viewport: { width: 1280, height: index === 1 ? 790 : 816 },
    };
  });
}

function buildAttendees(localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  return [
    { email: `${token(seed, '0')}@${token(seed, '1')}`, name: token(seed, '2'), locale: localeHint, timezone: timeZone, role: roleName },
    { email: `${token(seed, '3')}@${token(seed, '4')}`, name: token(seed, '5'), locale: splitLocale(localeHint)[0] ?? localeHint, timezone: timeZone, role: roleName },
    { email: `${token(seed, '6')}@${token(seed, '7')}`, name: token(seed, '8'), timezone: timeZone, role: roleName },
  ];
}

function buildThreadIdentity(localeHint: string, timeZone: string, subjectSeed: string, rootMessageId: string, messageSeed: string, roleName: string): ThreadIdentityInput {
  const participants = buildAttendees(localeHint, timeZone, roleName).map((attendee) => ({ email: attendee.email, name: attendee.name, locale: attendee.locale, timezone: attendee.timezone, role: attendee.role }));
  return {
    subject: subjectSeed,
    participants,
    messageId: token(subjectSeed, messageSeed, timeZone),
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
    provider: token(localeHint, timeZone, subjectSeed, 'p'),
    mailbox: token(localeHint, timeZone, subjectSeed, 'm'),
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
    const subjectSeed = `${theory.summary} ${localeHint} ${timeZone}`.trim();
    const rootMessageId = token(subjectSeed, 'root', threadAnchor);
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
      fallbackSelectors: [token(threadAnchor, '0', 'selector'), token(threadAnchor, '1', 'selector')],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: buildEpisodes(learned.theory, now, localeHint),
      memoryFacts,
      attendees: buildAttendees(localeHint, timeZone, roleName),
      threadA: buildThreadIdentity(localeHint, timeZone, `Re: ${subjectSeed}`, rootMessageId, threadAnchor, roleName),
      threadB: buildThreadIdentity(localeHint, timeZone, `Re: ${subjectSeed}`, rootMessageId, token(threadAnchor, 'b'), roleName),
      recurrence: buildRecurrence(now, timeZone),
      summary: `${theory.summary} ${localeHint} ${timeZone}`.trim(),
    };
  }

  buildTrace(now = Date.now()): RaidingAiTrace {
    const runtime = this.capture(now);
    const captureId = token(runtime.threadAnchor, runtime.summary, runtime.capturedAt);
    return {
      captureId,
      capturedAt: runtime.capturedAt,
      taskHint: `${runtime.theory.summary} ${runtime.localeHint}`.trim(),
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
