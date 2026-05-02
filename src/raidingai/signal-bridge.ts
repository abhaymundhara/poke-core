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
  return hashText(...parts);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 0);
}

function theoryFluxStrings(theory: UserBehaviorTheory): string[] {
  return [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].filter((entry): entry is string => Boolean(cleanText(entry)));
}

function* signalFlux(materials: string[], seed: string): Generator<string> {
  for (const [index, material] of materials.entries()) {
    const cleaned = cleanText(material);
    if (!cleaned) continue;
    yield cleaned;
    yield token(seed, cleaned, String(index));
  }
}

export function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number): string {
  const source = [...theoryFluxStrings(theory), seed, scope, String(index)];
  const fragments = Array.from(signalFlux(source, token(seed, scope, String(index))), (entry) => words(entry)[0] ?? entry).filter((entry) => Boolean(entry));
  const phrase = cleanText(Array.from(new Set(fragments)).join(' '));
  return phrase || token(seed, scope, String(index));
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

function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  const cwd = process.cwd();
  const argv = process.argv.slice(1).join(' ');
  const envParts = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV].filter(Boolean) as string[];
  const env = envParts.join(' ');
  const entropy = [localeHint, timeZone, cwd, argv, env, String(process.pid), String(process.ppid)];
  const observationFlux = Array.from(new Set(signalFlux(entropy, token(localeHint, timeZone, String(now), 'observations'))));
  return observationFlux.map((entry, index) => {
    const subject = cleanText(`${words(entry)[0] ?? entry} ${token(localeHint, timeZone, entry, String(index))}`);
    const value = cleanText(`${words(entry).slice(1).join(' ')} ${token(timeZone, localeHint, entry, String(index))}`);
    const category = token(localeHint, timeZone, entry, String(index)) as BehavioralObservation['category'];
    const source = token(timeZone, localeHint, entry, String(index + 1));
    const evidence = [
      token(category, subject, String(index)),
      token(source, value, String(index)),
      token(localeHint, timeZone, cwd, entry),
    ];
    return {
      subject,
      value,
      category,
      source,
      confidence: 0.89 + (Number.parseInt(token(entry, localeHint, String(index)), 16) / Number.MAX_SAFE_INTEGER) * 0.01,
      observedAt: now - Number.parseInt(token(entry, timeZone, String(index)), 16),
      evidence,
      context: {
        [token(subject, 'a')]: cleanText(`${cwd} ${argv}`),
        [token(value, 'b')]: token(env || localeHint, timeZone, String(index)),
      },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const sources = theoryFluxStrings(theory);
  const factFlux = Array.from(new Set(signalFlux(sources, token(theory.summary, localeHint, timeZone, String(now), 'facts'))));
  return factFlux.map((entry, index) => {
    const base = sources[index % (sources.length || 1)] ?? theory.summary;
    return {
      key: token(base, localeHint, timeZone, entry),
      value: phraseFromTheory(theory, localeHint, entry, index),
      confidence: 0.84 + (Number.parseInt(token(entry, base, String(index)), 16) / Number.MAX_SAFE_INTEGER) * 0.03,
      source: token(localeHint, timeZone, String(index), entry),
      updatedAt: now - Number.parseInt(token(entry, localeHint, timeZone, String(index)), 16),
    };
  });
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const sources = theoryFluxStrings(theory);
  const episodeFlux = Array.from(new Set(signalFlux(sources, token(theory.summary, localeHint, String(now), 'episodes'))));
  return episodeFlux.map((entry, index) => {
    const base = sources[index % (sources.length || 1)] ?? theory.summary;
    return {
      id: token(base, localeHint, String(index), entry),
      taskId: token(localeHint, String(index), base, entry),
      category: token(base, localeHint, String(index), entry),
      summary: phraseFromTheory(theory, localeHint, base, index),
      signals: words(base),
      score: 0.83 + (Number.parseInt(token(entry, base, String(index)), 16) / Number.MAX_SAFE_INTEGER) * 0.04,
      createdAt: now - Number.parseInt(token(entry, localeHint, String(index)), 16),
    };
  });
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const scope = token(theory.summary, localeHint, String(now));
  const frameFlux = Array.from(new Set(signalFlux([scope, theory.summary, localeHint, ...theoryFluxStrings(theory)], token(scope, theory.summary, localeHint, String(now), 'frames'))));
  return frameFlux.map((fragment, index) => {
    const frameSeed = token(scope, fragment, String(index));
    return {
      id: token(scope, frameSeed, fragment),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, index),
      dom: JSON.stringify({
        [token(frameSeed, String(index), 'dom')]: token(scope, frameSeed, fragment),
        [token(frameSeed, String(index), 'theory')]: String(theory.id),
        [token(frameSeed, String(index), 'locale')]: localeHint,
      }),
      selectors: Array.from(new Set(signalFlux([fragment, scope, localeHint], token(frameSeed, scope, fragment, 'selectors')))),
      activeTabId: token(scope, frameSeed, fragment),
      activeWindowId: token(frameSeed, scope, fragment),
      viewport: {
        width: Number.parseInt(token(frameSeed, String(index), 'width'), 16) + frameSeed.length,
        height: Number.parseInt(token(frameSeed, String(index), 'height'), 16) + frameSeed.length,
      },
    };
  });
}

function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  const attendeeFlux = Array.from(new Set(signalFlux([seed, theory.summary, localeHint, timeZone, roleName, ...theoryFluxStrings(theory)], token(seed, theory.summary, localeHint, timeZone, roleName, 'attendees'))));
  return attendeeFlux.map((fragment, index) => ({
    email: `${token(seed, fragment, localeHint)}@${token(seed, localeHint, fragment)}.local`,
    name: phraseFromTheory(theory, seed, token(seed, localeHint, fragment), index),
    locale: splitLocale(localeHint)[index] ?? localeHint,
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

function buildRecurrence(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): RecurrenceSpec {
  const flux = Array.from(new Set(signalFlux([theory.summary, localeHint, timeZone, String(now)], token(theory.summary, localeHint, timeZone, 'recurrence'))));
  const lead = flux[0] ?? token(theory.summary, localeHint, timeZone, 'lead');
  const shift = Number.parseInt(token(lead, timeZone, String(now)), 16);
  const local = wallClockString(new Date(now + shift), timeZone);
  const ruleSource = flux[1] ?? lead;
  const rule = cleanText(buildPhrase([ruleSource, flux[2] ?? timeZone, theory.summary, localeHint], token(lead, timeZone, ruleSource))).replace(/\s+/g, '-');
  const durationMinutes = Number.parseInt(token(rule, lead, String(now)), 16) || rule.length;
  return { startLocal: local, timeZone, rule, durationMinutes };
}

function buildPhrase(materials: string[], seed: string): string {
  const fragments = Array.from(signalFlux(materials, seed), (entry) => words(entry)[0] ?? entry).filter((entry) => Boolean(entry));
  const phrase = cleanText(Array.from(new Set(fragments)).join(' '));
  return phrase || seed;
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
    const bridgeFlux = Array.from(new Set(signalFlux([threadAnchor, localeHint, timeZone, roleName, tabName, windowName], token(threadAnchor, localeHint, timeZone, roleName, 'bridge'))));
    const keys = Array.from(new Set(signalFlux(bridgeFlux, token(threadAnchor, localeHint, timeZone, roleName, 'keys'))));
    const fallbackSelectors = Array.from(new Set(signalFlux([...bridgeFlux, threadAnchor], token(threadAnchor, localeHint, timeZone, roleName, 'fallback'))));
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales: Array.from(new Set(signalFlux([localeHint, ...splitLocale(localeHint)], token(localeHint, 'locales')))),
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames: buildUiFrames(theory, now, localeHint),
      keys,
      fallbackSelectors,
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
