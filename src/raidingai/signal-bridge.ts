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
  for (const material of materials) {
    const cleaned = cleanText(material);
    if (!cleaned) continue;
    yield cleaned;
    yield token(seed, cleaned);
  }
}

export function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number): string {
  const source = [...theoryFluxStrings(theory), seed, scope, String(index)];
  return buildPhrase(source, token(seed, scope, String(index)));
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

type FluxNode = {
  fragment: string;
  lineage: string;
  depth: number;
};

function* theoryFlux(materials: Iterable<string>, seed: string): Generator<FluxNode> {
  for (const material of materials) {
    const fragment = cleanText(material);
    if (!fragment) continue;
    const lineage = token(seed, fragment);
    yield { fragment, lineage, depth: 0 };
    for (const branch of signalFlux([fragment, ...words(fragment)], lineage)) {
      const branchFragment = cleanText(branch);
      if (!branchFragment) continue;
      const branchLineage = token(lineage, branchFragment);
      yield { fragment: branchFragment, lineage: branchLineage, depth: 1 };
      for (const echo of signalFlux(words(branchFragment), branchLineage)) {
        const echoFragment = cleanText(echo);
        if (!echoFragment) continue;
        yield { fragment: echoFragment, lineage: token(branchLineage, echoFragment), depth: 2 };
      }
    }
  }
}

function hashMagnitude(...parts: string[]): number {
  return Number.parseInt(hashText(...parts).slice(0, 12), 16);
}

function hashFraction(...parts: string[]): number {
  return hashMagnitude(...parts) / 281474976710655;
}

function pushUnique(values: string[], value: string): void {
  if (!value) return;
  for (const entry of values) {
    if (entry === value) return;
  }
  values.push(value);
}

function collectFragments(nodes: Iterable<FluxNode>): string[] {
  const fragments: string[] = [];
  for (const node of nodes) {
    pushUnique(fragments, node.fragment);
  }
  return fragments;
}

function buildRuntimeObservations(now: number, localeHint: string, timeZone: string): BehavioralObservation[] {
  const entropy = [
    localeHint,
    timeZone,
    process.cwd(),
    process.argv.slice(1).join(' '),
    [process.env.CI, process.env.GITHUB_ACTIONS, process.env.NODE_ENV, process.title, process.platform, process.arch].filter(Boolean).join(' '),
    String(now),
  ];
  const observations: BehavioralObservation[] = [];
  for (const node of theoryFlux(entropy, token(localeHint, timeZone, String(now), 'observations'))) {
    const subjectSeed = token(localeHint, timeZone, node.fragment, node.lineage, 'subject');
    const valueSeed = token(localeHint, timeZone, node.lineage, node.fragment, 'value');
    const evidence = collectFragments(theoryFlux([node.fragment, node.lineage, localeHint, timeZone], token(subjectSeed, valueSeed, node.lineage)));
    const subject = cleanText(`${words(node.fragment)[0] ?? node.fragment} ${words(node.lineage)[0] ?? subjectSeed}`);
    const value = cleanText([
      ...words(node.fragment).slice(1),
      ...words(node.lineage).slice(1),
      words(subjectSeed)[0] ?? subjectSeed,
      words(valueSeed)[0] ?? valueSeed,
    ].join(' '));
    observations.push({
      subject,
      value,
      category: token(localeHint, timeZone, node.fragment, node.lineage) as BehavioralObservation['category'],
      source: token(timeZone, localeHint, node.lineage, node.fragment),
      confidence: hashFraction(subjectSeed, valueSeed, node.lineage),
      observedAt: now - hashMagnitude(node.fragment, node.lineage, localeHint, timeZone),
      evidence,
      context: {
        [token(subject, node.lineage)]: cleanText(`${localeHint} ${timeZone} ${node.fragment}`),
        [token(value, node.fragment)]: cleanText(`${node.lineage} ${process.cwd()}`),
      },
    });
  }
  return observations;
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  for (const node of theoryFlux(theoryFluxStrings(theory), token(theory.summary, localeHint, timeZone, String(now), 'facts'))) {
    facts.push({
      key: token(node.fragment, node.lineage, theory.summary),
      value: phraseFromTheory(theory, localeHint, node.fragment, node.depth),
      confidence: hashFraction(node.fragment, node.lineage, theory.summary, localeHint, timeZone),
      source: token(localeHint, timeZone, node.lineage, node.fragment),
      updatedAt: now - hashMagnitude(node.fragment, node.lineage, theory.summary),
    });
  }
  return facts;
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const episodes: EpisodicMemoryItem[] = [];
  for (const node of theoryFlux(theoryFluxStrings(theory), token(theory.summary, localeHint, String(now), 'episodes'))) {
    const signals = collectFragments(theoryFlux([node.fragment, node.lineage, theory.summary, localeHint], token(node.fragment, node.lineage, 'signals')));
    episodes.push({
      id: token(node.fragment, node.lineage, theory.summary),
      taskId: token(localeHint, node.fragment, node.lineage, String(node.depth)),
      category: token(node.fragment, localeHint, node.lineage),
      summary: phraseFromTheory(theory, localeHint, node.fragment, node.depth),
      signals,
      score: hashFraction(node.fragment, node.lineage, theory.summary, localeHint),
      createdAt: now - hashMagnitude(node.fragment, node.lineage, localeHint),
    });
  }
  return episodes;
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const frames: VisionFrame[] = [];
  for (const node of theoryFlux([theory.summary, localeHint, ...theoryFluxStrings(theory)], token(theory.summary, localeHint, String(now), 'frames'))) {
    const frameSeed = token(theory.summary, localeHint, node.fragment, node.lineage);
    const selectors = collectFragments(theoryFlux([node.fragment, node.lineage, localeHint, theory.summary], token(frameSeed, 'selectors')));
    frames.push({
      id: token(frameSeed, node.lineage, node.fragment),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, node.depth),
      dom: JSON.stringify({
        [token(frameSeed, node.lineage, 'dom')]: token(frameSeed, node.fragment, node.lineage),
        [token(frameSeed, node.lineage, 'theory')]: String(theory.id),
        [token(frameSeed, node.lineage, 'locale')]: localeHint,
      }),
      selectors,
      activeTabId: token(frameSeed, node.fragment, localeHint),
      activeWindowId: token(node.lineage, frameSeed, node.fragment),
      viewport: {
        width: hashMagnitude(frameSeed, node.fragment, node.lineage),
        height: hashMagnitude(node.lineage, frameSeed, node.fragment),
      },
    });
  }
  return frames;
}

function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  const attendees: Attendee[] = [];
  for (const node of theoryFlux([seed, theory.summary, localeHint, timeZone, roleName, ...theoryFluxStrings(theory)], token(seed, theory.summary, localeHint, timeZone, roleName, 'attendees'))) {
    attendees.push({
      email: `${token(seed, node.fragment, node.lineage)}@${token(localeHint, node.lineage, node.fragment)}.local`,
      name: phraseFromTheory(theory, seed, node.fragment, node.depth),
      locale: splitLocale(localeHint)[0] ?? localeHint,
      timezone: timeZone,
      role: cleanText(`${words(node.fragment)[0] ?? roleName} ${words(node.lineage)[0] ?? ''}`) || roleName,
    });
  }
  return attendees;
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
  const fragments: string[] = [];
  for (const node of theoryFlux([theory.summary, localeHint, timeZone, String(now)], token(theory.summary, localeHint, timeZone, 'recurrence'))) {
    pushUnique(fragments, phraseFromTheory(theory, node.lineage, node.fragment, node.depth));
  }
  return {
    startLocal: wallClockString(new Date(now), timeZone),
    timeZone,
    rule: cleanText(fragments.join(' ')).replace(/\s+/g, '-'),
    durationMinutes: hashMagnitude(theory.summary, localeHint, timeZone, String(now)) || 1,
  };
}

function buildPhrase(materials: Iterable<string>, seed: string): string {
  const fragments: string[] = [];
  for (const node of theoryFlux(materials, seed)) {
    pushUnique(fragments, words(node.fragment)[0] ?? node.fragment);
  }
  return cleanText(fragments.join(' ')) || seed;
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
    const tabName = token(theory.summary, localeHint, timeZone, threadAnchor);
    const windowName = token(tabName, theory.summary, localeHint);
    const threadAnchor = token(theory.summary, localeHint, timeZone, token(theory.summary, localeHint, String(now)));
    const subjectScope = token(threadAnchor, localeHint, timeZone);
    const rootMessageId = token(subjectScope, threadAnchor, localeHint);
    const timezoneLocal = wallClockString(new Date(now), timeZone);
    const timezoneExpectedUtc = normalizeWallTime(timezoneLocal, timeZone).utc;
    const bridgeFragments: string[] = [];
    for (const node of theoryFlux([threadAnchor, localeHint, timeZone, roleName, tabName, windowName], token(threadAnchor, localeHint, timeZone, roleName, 'bridge'))) {
      pushUnique(bridgeFragments, node.fragment);
    }
    const keys: string[] = [];
    for (const fragment of bridgeFragments) {
      for (const keyNode of theoryFlux([fragment], token(threadAnchor, localeHint, timeZone, roleName, fragment, 'keys'))) {
        pushUnique(keys, keyNode.fragment);
      }
    }
    const fallbackSelectors: string[] = [];
    for (const fragment of bridgeFragments) {
      for (const selectorNode of theoryFlux([fragment, threadAnchor], token(threadAnchor, localeHint, timeZone, roleName, fragment, 'fallback'))) {
        pushUnique(fallbackSelectors, selectorNode.fragment);
      }
    }
    const locales: string[] = [];
    pushUnique(locales, localeHint);
    for (const locale of splitLocale(localeHint)) {
      pushUnique(locales, locale);
    }
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


