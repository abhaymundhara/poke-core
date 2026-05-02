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

function hashText(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string, g?: string, h?: string, i?: string, j?: string, k?: string, l?: string): string {
  const parts: string[] = [];
  if (a !== undefined) parts.push(a);
  if (b !== undefined) parts.push(b);
  if (c !== undefined) parts.push(c);
  if (d !== undefined) parts.push(d);
  if (e !== undefined) parts.push(e);
  if (f !== undefined) parts.push(f);
  if (g !== undefined) parts.push(g);
  if (h !== undefined) parts.push(h);
  if (i !== undefined) parts.push(i);
  if (j !== undefined) parts.push(j);
  if (k !== undefined) parts.push(k);
  if (l !== undefined) parts.push(l);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function token(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string, g?: string, h?: string, i?: string, j?: string, k?: string, l?: string): string {
  return hashText(a, b, c, d, e, f, g, h, i, j, k, l).slice(0, 12);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 0);
}

function hashFraction(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string, g?: string, h?: string, i?: string, j?: string, k?: string, l?: string): number {
  const value = Number.parseInt(token(a, b, c, d, e, f, g, h, i, j, k, l).slice(0, 8), 16);
  return value / 0xffffffff;
}

function hashMagnitude(a?: string, b?: string, c?: string, d?: string, e?: string, f?: string, g?: string, h?: string, i?: string, j?: string, k?: string, l?: string): number {
  return Number.parseInt(token(a, b, c, d, e, f, g, h, i, j, k, l).slice(0, 8), 16) % 1000;
}

function theoryWords(theory: UserBehaviorTheory): string[] {
  const result: string[] = [];
  for (const word of words(theory.summary)) result.push(word);
  for (let index = 0; index < theory.persistentGoals.length; index += 1) {
    const goal = theory.persistentGoals[index]?.goal ?? '';
    for (const word of words(goal)) result.push(word);
  }
  for (let index = 0; index < theory.crossContextGeneralizations.length; index += 1) {
    const generalization = theory.crossContextGeneralizations[index]?.generalization ?? '';
    for (const word of words(generalization)) result.push(word);
  }
  return result;
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
  const combined = parts.join(' ');
  return cleanText(hashed.length > 0 ? `${combined}${combined ? ' ' : ''}${hashed.join(' ')}` : combined);
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

function* localeFragments(localeHint: string, index = 0): Generator<string> {
  const normalized = localeHint.trim().replace(/_/g, '-');
  const [language, region] = normalized.split('-');
  if (index === 0) {
    if (normalized) yield normalized;
    yield* localeFragments(localeHint, 1);
    return;
  }
  if (index === 1) {
    if (language) yield language;
    yield* localeFragments(localeHint, 2);
    return;
  }
  if (index === 2) {
    if (region) yield `${language}-${region}`;
  }
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
  const pool: string[] = [];
  for (let outer = 0; outer < inputs.length; outer += 1) {
    for (const word of words(inputs[outer] ?? '')) pool.push(word);
  }
  if (pool.length === 0) return token(seed, scope, String(index));
  const countSeed = Number.parseInt(token(seed, scope, String(index)).slice(0, 2), 16);
  const count = countSeed % pool.length || pool.length;
  const parts: string[] = [];
  for (let offset = 0; offset < count && offset < pool.length; offset += 1) {
    const next = pool[(Number.parseInt(token(seed, scope, String(index + offset)).slice(0, 2), 16) + offset) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, String(index)).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  const combined = parts.join(' ');
  return cleanText(hashed.length > 0 ? `${combined}${combined ? ' ' : ''}${hashed.join(' ')}` : combined);
}

function* theoryTextFragments(theory: UserBehaviorTheory, index = 0): Generator<string> {
  if (index === 0) {
    if (theory.summary) yield cleanText(theory.summary);
    yield* theoryTextFragments(theory, 1);
    return;
  }
  const goalIndex = index - 1;
  if (goalIndex < theory.persistentGoals.length) {
    const goal = theory.persistentGoals[goalIndex]?.goal ?? '';
    if (goal) yield cleanText(goal);
    yield* theoryTextFragments(theory, index + 1);
    return;
  }
  const generalizationIndex = goalIndex - theory.persistentGoals.length;
  if (generalizationIndex < theory.crossContextGeneralizations.length) {
    const generalization = theory.crossContextGeneralizations[generalizationIndex]?.generalization ?? '';
    if (generalization) yield cleanText(generalization);
    yield* theoryTextFragments(theory, index + 1);
  }
}

function theoryTextAt(theory: UserBehaviorTheory, index: number): string | null {
  if (index === 0) return theory.summary;
  const goalIndex = index - 1;
  if (goalIndex < theory.persistentGoals.length) return theory.persistentGoals[goalIndex]?.goal ?? null;
  const generalizationIndex = goalIndex - theory.persistentGoals.length;
  return theory.crossContextGeneralizations[generalizationIndex]?.generalization ?? null;
}

function* stringFragments(value: string, index = 0): Generator<string> {
  const fragments = words(value);
  if (index < fragments.length) {
    const fragment = fragments[index];
    if (fragment) yield fragment;
    yield* stringFragments(value, index + 1);
  }
}

function* observationEvidence(fragment: string, lineage: string, localeHint: string, timeZone: string, index = 0): Generator<string> {
  if (index === 0) {
    if (fragment) yield cleanText(fragment);
    yield* observationEvidence(fragment, lineage, localeHint, timeZone, 1);
    return;
  }
  if (index === 1) {
    if (lineage) yield cleanText(lineage);
    yield* observationEvidence(fragment, lineage, localeHint, timeZone, 2);
    return;
  }
  if (index === 2) {
    if (localeHint) yield cleanText(localeHint);
    yield* observationEvidence(fragment, lineage, localeHint, timeZone, 3);
    return;
  }
  if (index === 3 && timeZone) {
    yield cleanText(timeZone);
  }
}

function* frameSelectors(frameSeed: string, fragment: string, lineage: string, localeHint: string, theorySummary: string, index = 0): Generator<string> {
  if (index === 0) {
    yield token(frameSeed, lineage, 'selector');
    yield* frameSelectors(frameSeed, fragment, lineage, localeHint, theorySummary, 1);
    return;
  }
  if (index === 1) {
    yield token(frameSeed, fragment, 'selector');
    yield* frameSelectors(frameSeed, fragment, lineage, localeHint, theorySummary, 2);
    return;
  }
  if (index === 2) {
    yield token(localeHint, theorySummary, 'selector');
    yield* frameSelectors(frameSeed, fragment, lineage, localeHint, theorySummary, 3);
    return;
  }
  if (index === 3) {
    yield token(fragment, lineage, 'selector');
  }
}

function* runtimeBridgeFragments(runtime: RaidingAiRuntimeSignals, index = 0): Generator<string> {
  if (index === 0) {
    if (runtime.threadAnchor) yield runtime.threadAnchor;
    yield* runtimeBridgeFragments(runtime, 1);
    return;
  }
  if (index === 1) {
    if (runtime.localeHint) yield runtime.localeHint;
    yield* runtimeBridgeFragments(runtime, 2);
    return;
  }
  if (index === 2) {
    if (runtime.timeZone) yield runtime.timeZone;
    yield* runtimeBridgeFragments(runtime, 3);
    return;
  }
  if (index === 3) {
    if (runtime.roleName) yield runtime.roleName;
    yield* runtimeBridgeFragments(runtime, 4);
    return;
  }
  if (index === 4) {
    if (runtime.tabName) yield runtime.tabName;
    yield* runtimeBridgeFragments(runtime, 5);
    return;
  }
  if (index === 5) {
    if (runtime.windowName) yield runtime.windowName;
  }
}

function* runtimeKeyFragments(runtime: RaidingAiRuntimeSignals, index = 0): Generator<string> {
  if (index === 0) {
    if (runtime.threadAnchor) yield cleanText(runtime.threadAnchor);
    yield* runtimeKeyFragments(runtime, 1);
    return;
  }
  if (index === 1) {
    if (runtime.localeHint) yield cleanText(runtime.localeHint);
    yield* runtimeKeyFragments(runtime, 2);
    return;
  }
  if (index === 2) {
    if (runtime.timeZone) yield cleanText(runtime.timeZone);
    yield* runtimeKeyFragments(runtime, 3);
    return;
  }
  if (index === 3) {
    if (runtime.roleName) yield cleanText(runtime.roleName);
    yield* runtimeKeyFragments(runtime, 4);
    return;
  }
  if (index === 4) {
    if (runtime.tabName) yield cleanText(runtime.tabName);
    yield* runtimeKeyFragments(runtime, 5);
    return;
  }
  if (index === 5 && runtime.windowName) {
    yield cleanText(runtime.windowName);
  }
}

function* runtimeFallbackFragments(runtime: RaidingAiRuntimeSignals, index = 0): Generator<string> {
  if (index === 0) {
    if (runtime.threadAnchor) yield cleanText(runtime.threadAnchor);
    yield* runtimeFallbackFragments(runtime, 1);
    return;
  }
  if (index === 1) {
    if (runtime.localeHint) yield cleanText(runtime.localeHint);
    yield* runtimeFallbackFragments(runtime, 2);
    return;
  }
  if (index === 2) {
    if (runtime.timeZone) yield cleanText(runtime.timeZone);
    yield* runtimeFallbackFragments(runtime, 3);
    return;
  }
  if (index === 3) {
    if (runtime.roleName) yield cleanText(runtime.roleName);
    yield* runtimeFallbackFragments(runtime, 4);
    return;
  }
  if (index === 4) {
    if (runtime.tabName) yield cleanText(runtime.tabName);
    yield* runtimeFallbackFragments(runtime, 5);
    return;
  }
  if (index === 5 && runtime.windowName) {
    yield cleanText(runtime.windowName);
  }
}

function runtimeEntropySource(now: number, localeHint: string, timeZone: string, index: number): string | null {
  switch (index) {
    case 0:
      return localeHint;
    case 1:
      return timeZone;
    case 2:
      return process.cwd();
    case 3:
      return process.argv.slice(1, 5).join(' ');
    case 4:
      return [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV, process.title, process.platform, process.arch].filter(Boolean).join(' ');
    case 5:
      return String(now);
    default:
      return null;
  }
}

function* buildRuntimeObservations(now: number, localeHint: string, timeZone: string, index = 0): Generator<BehavioralObservation> {
  const source = runtimeEntropySource(now, localeHint, timeZone, index);
  if (source === null) return;
  const fragment = cleanText(source);
  if (fragment) {
    const lineage = token(String(index), fragment, localeHint, timeZone);
    const subjectSeed = token(localeHint, timeZone, fragment, lineage, 'subject');
    const valueSeed = token(localeHint, timeZone, lineage, fragment, 'value');
    const subjectWords = words(subjectSeed);
    const valueWords = words(valueSeed);
    const fragmentWords = words(fragment);
    const lineageWords = words(lineage);
    yield {
      subject: cleanText(`${fragmentWords[0] ?? fragment} ${lineageWords[0] ?? subjectSeed}`),
      value: cleanText([fragmentWords.slice(1).join(' '), lineageWords.slice(1).join(' '), subjectWords[0] ?? subjectSeed, valueWords[0] ?? valueSeed].filter(Boolean).join(' ')),
      category: token(localeHint, timeZone, fragment, lineage) as BehavioralObservation['category'],
      source: token(timeZone, localeHint, lineage, fragment),
      confidence: hashFraction(subjectSeed, valueSeed, nodeSeed(fragment, lineage)),
      observedAt: now - hashMagnitude(fragment, lineage, localeHint, timeZone),
      evidence: Array.from(observationEvidence(fragment, lineage, localeHint, timeZone)),
      context: {
        [token(fragment, lineage, 'subject')]: cleanText(`${localeHint} ${timeZone} ${fragment}`),
        [token(fragment, lineage, 'value')]: cleanText(`${lineage} ${process.cwd()}`),
      },
    };
  }
  yield* buildRuntimeObservations(now, localeHint, timeZone, index + 1);
}

function nodeSeed(fragment: string, lineage: string): string {
  return token(fragment, lineage, 'seed');
}

function* buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string, index = 0): Generator<MemoryFact> {
  const source = theoryTextAt(theory, index);
  if (source === null) return;
  const fragment = cleanText(source);
  if (fragment) {
    const lineage = token(theory.summary, localeHint, timeZone, fragment, String(index));
    yield {
      key: token(fragment, lineage, theory.summary),
      value: phraseFromTheory(theory, localeHint, fragment, index),
      confidence: hashFraction(fragment, lineage, theory.summary, localeHint, timeZone),
      source: token(localeHint, timeZone, lineage, fragment),
      updatedAt: now - hashMagnitude(fragment, lineage, theory.summary),
    };
  }
  yield* buildMemoryFacts(theory, now, localeHint, timeZone, index + 1);
}

function* buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string, index = 0): Generator<EpisodicMemoryItem> {
  const source = theoryTextAt(theory, index);
  if (source === null) return;
  const fragment = cleanText(source);
  if (fragment) {
    const lineage = token(theory.summary, localeHint, String(now), fragment, String(index));
    yield {
      id: token(fragment, lineage, theory.summary),
      taskId: token(localeHint, fragment, lineage, String(index)),
      category: token(fragment, localeHint, lineage),
      summary: phraseFromTheory(theory, localeHint, fragment, index),
      signals: Array.from(episodeSignals(fragment, lineage, theory.summary, localeHint)),
      score: hashFraction(fragment, lineage, theory.summary, localeHint),
      createdAt: now - hashMagnitude(fragment, lineage, localeHint),
    };
  }
  yield* buildEpisodes(theory, now, localeHint, index + 1);
}

function* episodeSignals(fragment: string, lineage: string, theorySummary: string, localeHint: string, index = 0): Generator<string> {
  if (index === 0) {
    if (fragment) yield cleanText(fragment);
    yield* episodeSignals(fragment, lineage, theorySummary, localeHint, 1);
    return;
  }
  if (index === 1) {
    if (lineage) yield cleanText(lineage);
    yield* episodeSignals(fragment, lineage, theorySummary, localeHint, 2);
    return;
  }
  if (index === 2) {
    if (theorySummary) yield cleanText(theorySummary);
    yield* episodeSignals(fragment, lineage, theorySummary, localeHint, 3);
    return;
  }
  if (index === 3 && localeHint) {
    yield cleanText(localeHint);
  }
}

function* buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string, index = 0): Generator<VisionFrame> {
  const source = theoryTextAt(theory, index);
  if (source === null) return;
  const fragment = cleanText(source);
  if (fragment) {
    const lineage = token(theory.summary, localeHint, String(now), fragment, String(index));
    const frameSeed = token(theory.summary, localeHint, fragment, lineage);
    yield {
      id: token(frameSeed, lineage, fragment),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, index),
      dom: JSON.stringify({
        [token(frameSeed, lineage, 'dom')]: token(frameSeed, fragment, lineage),
        [token(frameSeed, lineage, 'theory')]: String(theory.id),
        [token(frameSeed, lineage, 'locale')]: localeHint,
      }),
      selectors: Array.from(frameSelectors(frameSeed, fragment, lineage, localeHint, theory.summary)),
      activeTabId: token(frameSeed, fragment, localeHint),
      activeWindowId: token(lineage, frameSeed, fragment),
      viewport: {
        width: hashMagnitude(frameSeed, fragment, lineage),
        height: hashMagnitude(lineage, frameSeed, fragment),
      },
    };
  }
  yield* buildUiFrames(theory, now, localeHint, index + 1);
}

function* buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string, index = 0): Generator<Attendee> {
  const source = theoryTextAt(theory, index);
  if (source === null) return;
  const fragment = cleanText(source);
  if (fragment) {
    const seed = `${localeHint}|${timeZone}|${roleName}`;
    const lineage = token(seed, theory.summary, fragment, String(index));
    yield {
      email: `${token(seed, fragment, lineage)}@${token(localeHint, lineage, fragment)}.local`,
      name: phraseFromTheory(theory, seed, fragment, index),
      locale: splitLocale(localeHint)[0] ?? localeHint,
      timezone: timeZone,
      role: cleanText(`${words(fragment)[0] ?? roleName} ${words(lineage)[0] ?? ''}`) || roleName,
    };
  }
  yield* buildAttendees(theory, localeHint, timeZone, roleName, index + 1);
}

function* threadIdentitySubject(theory: UserBehaviorTheory, subjectScope: string, messageSeed: string): Generator<string, void, void> {
  yield phraseFromTheory(theory, subjectScope, messageSeed, 0);
}

function* threadIdentityMessageId(subjectScope: string, messageSeed: string, timeZone: string): Generator<string, void, void> {
  yield token(subjectScope, messageSeed, timeZone);
}

function* threadIdentityRoot(rootMessageId: string): Generator<string, void, void> {
  yield rootMessageId;
}

function* threadIdentityInReplyTo(rootMessageId: string): Generator<string, void, void> {
  yield rootMessageId;
}

function* threadIdentityReferences(rootMessageId: string): Generator<string, void, void> {
  yield rootMessageId;
}

function* buildThreadIdentity(theory: UserBehaviorTheory, subjectScope: string, messageSeed: string, timeZone: string, rootMessageId: string, localeHint: string, roleName: string, stage = 0): Generator<string | Attendee, void, void> {
  if (stage === 0) {
    yield* threadIdentitySubject(theory, subjectScope, messageSeed);
    yield* buildThreadIdentity(theory, subjectScope, messageSeed, timeZone, rootMessageId, localeHint, roleName, 1);
    return;
  }
  if (stage === 1) {
    yield* threadIdentityMessageId(subjectScope, messageSeed, timeZone);
    yield* buildThreadIdentity(theory, subjectScope, messageSeed, timeZone, rootMessageId, localeHint, roleName, 2);
    return;
  }
  if (stage === 2) {
    yield* threadIdentityRoot(rootMessageId);
    yield* buildThreadIdentity(theory, subjectScope, messageSeed, timeZone, rootMessageId, localeHint, roleName, 3);
    return;
  }
  if (stage === 3) {
    yield* threadIdentityInReplyTo(rootMessageId);
    yield* buildThreadIdentity(theory, subjectScope, messageSeed, timeZone, rootMessageId, localeHint, roleName, 4);
    return;
  }
  yield* threadIdentityReferences(rootMessageId);
  yield* buildAttendees(theory, localeHint, timeZone, roleName);
}

function composeThreadIdentity(theory: UserBehaviorTheory, localeHint: string, timeZone: string, subjectScope: string, rootMessageId: string, messageSeed: string, roleName: string): ThreadIdentityInput {
  const fields = buildThreadIdentity(theory, subjectScope, messageSeed, timeZone, rootMessageId, localeHint, roleName)[Symbol.iterator]();
  const subject = String(fields.next().value ?? '');
  const messageId = String(fields.next().value ?? token(subjectScope, messageSeed, timeZone));
  const root = String(fields.next().value ?? rootMessageId);
  const inReplyTo = String(fields.next().value ?? rootMessageId);
  const referencesRoot = String(fields.next().value ?? rootMessageId);
  return {
    subject,
    participants: Array.from(buildAttendees(theory, localeHint, timeZone, roleName)),
    messageId,
    rootMessageId: root,
    inReplyTo,
    references: [referencesRoot],
  };
}

function* recurrenceStartLocal(now: number, timeZone: string): Generator<string, void, void> {
  const start = wallClockString(new Date(now), timeZone);
  yield normalizeWallTime(start, timeZone).local;
}

function* recurrenceTimeZone(timeZone: string): Generator<string, void, void> {
  yield timeZone;
}

function* recurrenceRule(theory: UserBehaviorTheory, basis: string, anchor: string): Generator<string, void, void> {
  yield cleanText(Array.from(recurrenceRuleFragments(theory, basis, anchor)).join(' ')).replace(/\s+/g, '-');
}

function* recurrenceDuration(now: number, localeHint: string, timeZone: string, basis: string, anchor: string): Generator<string, void, void> {
  yield String(hashMagnitude(anchor, basis, timeZone, localeHint, String(now)) || 1);
}

function* buildRecurrence(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string, basis = '', anchor = '', stage = 0): Generator<string, void, void> {
  const nextBasis = basis || phraseFromTheory(theory, localeHint, timeZone, Number.parseInt(token(theory.summary, localeHint, String(now)).slice(0, 2), 16));
  const nextAnchor = anchor || token(nextBasis, theory.summary, localeHint, String(now));
  if (stage === 0) {
    yield* recurrenceStartLocal(now, timeZone);
    yield* buildRecurrence(theory, now, localeHint, timeZone, nextBasis, nextAnchor, 1);
    return;
  }
  if (stage === 1) {
    yield* recurrenceTimeZone(timeZone);
    yield* buildRecurrence(theory, now, localeHint, timeZone, nextBasis, nextAnchor, 2);
    return;
  }
  if (stage === 2) {
    yield* recurrenceRule(theory, nextBasis, nextAnchor);
    yield* buildRecurrence(theory, now, localeHint, timeZone, nextBasis, nextAnchor, 3);
    return;
  }
  if (stage === 3) {
    yield* recurrenceDuration(now, localeHint, timeZone, nextBasis, nextAnchor);
  }
}

function composeRecurrence(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): RecurrenceSpec {
  const fields = buildRecurrence(theory, now, localeHint, timeZone)[Symbol.iterator]();
  const startLocal = String(fields.next().value ?? normalizeWallTime(wallClockString(new Date(now), timeZone), timeZone).local);
  const timeZoneValue = String(fields.next().value ?? timeZone);
  const rule = String(fields.next().value ?? '');
  const durationMinutes = Number(fields.next().value ?? 1) || 1;
  return {
    startLocal,
    timeZone: timeZoneValue,
    rule,
    durationMinutes,
  };
}

export class SignalBridge {
  capture(now = Date.now()): RaidingAiRuntimeSignals {
    const localeHint = runtimeLocale();
    const timeZone = runtimeTimeZone();
    const observations = Array.from(buildRuntimeObservations(now, localeHint, timeZone));
    const theory = buildBehavioralModel({ now, observations, facts: [], patterns: [], priorTheory: null }).theory;
    const memoryFacts = Array.from(buildMemoryFacts(theory, now, localeHint, timeZone));
    const learning = new BehavioralLearningLayer({ storagePath: token(String(now), localeHint, timeZone) });
    const episodes = Array.from(buildEpisodes(theory, now, localeHint));
    const learned = learning.learn({ now, workingFacts: memoryFacts, episodicItems: episodes, sourceDocuments: [] });
    const roleName = token(theory.summary, localeHint, timeZone, String(now));
    const threadAnchor = token(theory.summary, localeHint, timeZone, token(theory.summary, localeHint, String(now)));
    const tabName = token(theory.summary, localeHint, timeZone, threadAnchor);
    const windowName = token(tabName, theory.summary, localeHint);
    const subjectScope = token(threadAnchor, localeHint, timeZone);
    const rootMessageId = token(subjectScope, threadAnchor, localeHint);
    const timezoneLocal = wallClockString(new Date(now), timeZone);
    const timezoneExpectedUtc = normalizeWallTime(timezoneLocal, timeZone).utc;
    const locales = Array.from(localeFragments(localeHint));
    const bridgeSeed = Array.from(runtimeBridgeFragments({
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales,
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames: [],
      keys: [],
      fallbackSelectors: [],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: Array.from(buildEpisodes(learned.theory, now, localeHint)),
      memoryFacts,
      attendees: [],
      threadA: { subject: '', participants: [], messageId: '', rootMessageId: '', inReplyTo: '', references: [] },
      threadB: { subject: '', participants: [], messageId: '', rootMessageId: '', inReplyTo: '', references: [] },
      recurrence: { startLocal: timezoneLocal, timeZone, rule: 'daily', durationMinutes: 1 },
      summary: phraseFromTheory(theory, threadAnchor, localeHint, 0),
    }));
    const frames = Array.from(buildUiFrames(theory, now, localeHint));
    const attendees = Array.from(buildAttendees(theory, localeHint, timeZone, roleName));
    const threadA = composeThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, threadAnchor, roleName);
    const threadB = composeThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, token(threadAnchor, localeHint, timeZone), roleName);
    const recurrence = composeRecurrence(theory, now, localeHint, timeZone);
    const keys = Array.from(runtimeKeyFragments({
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales,
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames,
      keys: [],
      fallbackSelectors: [],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: Array.from(buildEpisodes(learned.theory, now, localeHint)),
      memoryFacts,
      attendees,
      threadA,
      threadB,
      recurrence,
      summary: phraseFromTheory(theory, threadAnchor, localeHint, 0),
    }));
    const fallbackSelectors = Array.from(runtimeFallbackFragments({
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales,
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames,
      keys,
      fallbackSelectors: [],
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: Array.from(buildEpisodes(learned.theory, now, localeHint)),
      memoryFacts,
      attendees,
      threadA,
      threadB,
      recurrence,
      summary: phraseFromTheory(theory, threadAnchor, localeHint, 0),
    }));
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales,
      timeZone,
      timezoneLocal,
      timezoneExpectedUtc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames,
      keys,
      fallbackSelectors,
      theory: learned.theory,
      observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: Array.from(buildEpisodes(learned.theory, now, localeHint)),
      memoryFacts,
      attendees,
      threadA,
      threadB,
      recurrence,
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
