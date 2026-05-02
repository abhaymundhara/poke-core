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
  const pool = theoryWords(theory);
  if (pool.length === 0) return token(seed, scope, String(index));
  const countSeed = Number.parseInt(token(seed, scope, String(index)).slice(0, 2), 16);
  const count = countSeed % pool.length || pool.length;
  const parts: string[] = [];
  for (let offset = 0; offset < count && offset < pool.length; offset += 1) {
    const next = pool[(Number.parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length];
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

function entropyPhrase(seed: string, scope: string, index: number, inputs: string[]): string {
  const pool = inputs.flatMap(words).filter(Boolean);
  if (pool.length === 0) return token(seed, scope, String(index));
  const countSeed = Number.parseInt(token(seed, scope, String(index)).slice(0, 2), 16);
  const count = countSeed % pool.length || pool.length;
  const parts: string[] = [];
  for (let offset = 0; offset < count && offset < pool.length; offset += 1) {
    const next = pool[(Number.parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, String(index)).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  return cleanText([...parts, ...hashed].join(' '));
}

function drainFlux<T>(iterator: Iterator<T>, acc: T[] = []): T[] {
  const next = iterator.next();
  if (next.done) return acc;
  acc.push(next.value);
  return drainFlux(iterator, acc);
}

function collectFlux<T>(iterable: Iterable<T>): T[] {
  return drainFlux(iterable[Symbol.iterator]());
}

function collectUniqueStrings(iterable: Iterable<string>): string[] {
  const values: string[] = [];
  const step = (iterator: Iterator<string>): string[] => {
    const next = iterator.next();
    if (next.done) return values;
    if (next.value && !values.includes(next.value)) values.push(next.value);
    return step(iterator);
  };
  return step(iterable[Symbol.iterator]());
}

function collectFluxMap<T, R>(iterable: Iterable<T>, map: (value: T) => R): R[] {
  const values: R[] = [];
  const step = (iterator: Iterator<T>): R[] => {
    const next = iterator.next();
    if (next.done) return values;
    values.push(map(next.value));
    return step(iterator);
  };
  return step(iterable[Symbol.iterator]());
}
function* runtimeObservationFlux(now: number, localeHint: string, timeZone: string): Generator<BehavioralObservation> {
  const entropy = [
    localeHint,
    timeZone,
    process.cwd(),
    process.argv.slice(1, 5).join(' '),
    [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV, process.title, process.platform, process.arch].filter(Boolean).join(' '),
    String(now),
  ];
  for (const node of theoryFlux(entropy, token(localeHint, timeZone, String(now), 'observations'))) {
    const subjectSeed = token(localeHint, timeZone, node.fragment, node.lineage, 'subject');
    const valueSeed = token(localeHint, timeZone, node.lineage, node.fragment, 'value');
    yield {
      subject: cleanText(`${words(node.fragment)[0] ?? node.fragment} ${words(node.lineage)[0] ?? subjectSeed}`),
      value: cleanText([
        ...words(node.fragment).slice(1),
        ...words(node.lineage).slice(1),
        words(subjectSeed)[0] ?? subjectSeed,
        words(valueSeed)[0] ?? valueSeed,
      ].join(' ')),
      category: token(localeHint, timeZone, node.fragment, node.lineage) as BehavioralObservation['category'],
      source: token(timeZone, localeHint, node.lineage, node.fragment),
      confidence: hashFraction(subjectSeed, valueSeed, node.lineage),
      observedAt: now - hashMagnitude(node.fragment, node.lineage, localeHint, timeZone),
      evidence: collectFluxMap(theoryFlux([node.fragment, node.lineage, localeHint, timeZone], token(subjectSeed, valueSeed, node.lineage)), (support) => support.fragment),
      context: {
        [token(node.fragment, node.lineage, 'subject')]: cleanText(`${localeHint} ${timeZone} ${node.fragment}`),
        [token(node.fragment, node.lineage, 'value')]: cleanText(`${node.lineage} ${process.cwd()}`),
      },
    };
  }
}

function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  return collectFlux(runtimeObservationFlux(now, localeHint, timeZone));
}

function* memoryFactFlux(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): Generator<MemoryFact> {
  const seed = token(theory.summary, localeHint, timeZone, String(now), 'facts');
  for (const node of theoryFlux(theoryFluxStrings(theory), seed)) {
    yield {
      key: token(node.fragment, node.lineage, theory.summary),
      value: phraseFromTheory(theory, localeHint, node.fragment, node.depth),
      confidence: hashFraction(node.fragment, node.lineage, theory.summary, localeHint, timeZone),
      source: token(localeHint, timeZone, node.lineage, node.fragment),
      updatedAt: now - hashMagnitude(node.fragment, node.lineage, theory.summary),
    };
  }
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  return collectFlux(memoryFactFlux(theory, now, localeHint, timeZone));
}

function* episodeFlux(theory: UserBehaviorTheory, now: number, localeHint: string): Generator<EpisodicMemoryItem> {
  for (const node of theoryFlux(theoryFluxStrings(theory), token(theory.summary, localeHint, String(now), 'episodes'))) {
    yield {
      id: token(node.fragment, node.lineage, theory.summary),
      taskId: token(localeHint, node.fragment, node.lineage, String(node.depth)),
      category: token(node.fragment, localeHint, node.lineage),
      summary: phraseFromTheory(theory, localeHint, node.fragment, node.depth),
      signals: collectFluxMap(theoryFlux([node.fragment, node.lineage, theory.summary, localeHint], token(node.fragment, node.lineage, 'signals')), (support) => support.fragment),
      score: hashFraction(node.fragment, node.lineage, theory.summary, localeHint),
      createdAt: now - hashMagnitude(node.fragment, node.lineage, localeHint),
    };
  }
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  return collectFlux(episodeFlux(theory, now, localeHint));
}

function* uiFrameFlux(theory: UserBehaviorTheory, now: number, localeHint: string): Generator<VisionFrame> {
  for (const node of theoryFlux([theory.summary, localeHint, ...theoryFluxStrings(theory)], token(theory.summary, localeHint, String(now), 'frames'))) {
    const frameSeed = token(theory.summary, localeHint, node.fragment, node.lineage);
    yield {
      id: token(frameSeed, node.lineage, node.fragment),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, node.depth),
      dom: JSON.stringify({
        [token(frameSeed, node.lineage, 'dom')]: token(frameSeed, node.fragment, node.lineage),
        [token(frameSeed, node.lineage, 'theory')]: String(theory.id),
        [token(frameSeed, node.lineage, 'locale')]: localeHint,
      }),
      selectors: collectFluxMap(theoryFlux([node.fragment, node.lineage, localeHint, theory.summary], token(frameSeed, 'selectors')), (selectorNode) => selectorNode.fragment),
      activeTabId: token(frameSeed, node.fragment, localeHint),
      activeWindowId: token(node.lineage, frameSeed, node.fragment),
      viewport: {
        width: hashMagnitude(frameSeed, node.fragment, node.lineage),
        height: hashMagnitude(node.lineage, frameSeed, node.fragment),
      },
    };
  }
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  return collectFlux(uiFrameFlux(theory, now, localeHint));
}

function* attendeeFlux(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Generator<Attendee> {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  for (const node of theoryFlux([seed, theory.summary, localeHint, timeZone, roleName, ...theoryFluxStrings(theory)], token(seed, theory.summary, localeHint, timeZone, roleName, 'attendees'))) {
    yield {
      email: `${token(seed, node.fragment, node.lineage)}@${token(localeHint, node.lineage, node.fragment)}.local`,
      name: phraseFromTheory(theory, seed, node.fragment, node.depth),
      locale: splitLocale(localeHint)[0] ?? localeHint,
      timezone: timeZone,
      role: cleanText(`${words(node.fragment)[0] ?? roleName} ${words(node.lineage)[0] ?? ''}`) || roleName,
    };
  }
}

function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  return collectFlux(attendeeFlux(theory, localeHint, timeZone, roleName));
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

function* recurrenceFlux(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): Generator<RecurrenceSpec> {
  const basis = phraseFromTheory(theory, localeHint, timeZone, Number.parseInt(token(theory.summary, localeHint, String(now)).slice(0, 2), 16));
  const anchor = token(basis, theory.summary, localeHint, String(now));
  const start = wallClockString(new Date(now), timeZone);
  const local = normalizeWallTime(start, timeZone).local;
  yield {
    startLocal: local,
    timeZone,
    rule: cleanText(collectFluxMap(theoryFlux([basis, localeHint, timeZone, String(now)], token(anchor, 'recurrence')), (node) => phraseFromTheory(theory, node.lineage, node.fragment, node.depth)).join(' ')).replace(/\s+/g, '-'),
    durationMinutes: hashMagnitude(anchor, basis, timeZone, localeHint, String(now)) || 1,
  };
}

function buildRecurrence(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): RecurrenceSpec {
  return collectFlux(recurrenceFlux(theory, now, localeHint, timeZone))[0];
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
    const threadAnchor = token(theory.summary, localeHint, timeZone, token(theory.summary, localeHint, String(now)));
    const tabName = token(theory.summary, localeHint, timeZone, threadAnchor);
    const windowName = token(tabName, theory.summary, localeHint);
    const subjectScope = token(threadAnchor, localeHint, timeZone);
    const rootMessageId = token(subjectScope, threadAnchor, localeHint);
    const timezoneLocal = wallClockString(new Date(now), timeZone);
    const timezoneExpectedUtc = normalizeWallTime(timezoneLocal, timeZone).utc;
    const localeStream = collectUniqueStrings(collectFluxMap(theoryFlux([localeHint, ...splitLocale(localeHint)], token(localeHint, 'locales')), (node) => node.fragment));
    const bridgeStream = collectUniqueStrings(collectFluxMap(theoryFlux([threadAnchor, localeHint, timeZone, roleName, tabName, windowName], token(threadAnchor, localeHint, timeZone, roleName, 'bridge')), (node) => node.fragment));
    const keyStream = collectUniqueStrings(collectFluxMap(theoryFlux(bridgeStream, token(threadAnchor, localeHint, timeZone, roleName, 'keys')), (node) => node.fragment));
    const fallbackStream = collectUniqueStrings(collectFluxMap(theoryFlux([threadAnchor, ...bridgeStream], token(threadAnchor, localeHint, timeZone, roleName, 'fallback')), (node) => node.fragment));
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales: localeStream,
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames: buildUiFrames(theory, now, localeHint),
      keys: keyStream,
      fallbackSelectors: fallbackStream,
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
