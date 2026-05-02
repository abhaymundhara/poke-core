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

function* generativeFlux(materials: Iterable<string>, seed: string): Generator<FluxNode> {
  const queue: FluxNode[] = Array.from(materials, (material, index) => ({
    fragment: cleanText(material),
    lineage: token(seed, String(index), material),
    depth: 0,
  })).filter((entry) => Boolean(entry.fragment));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || !node.fragment || seen.has(node.fragment)) continue;
    seen.add(node.fragment);
    yield node;
    const branchSeed = token(seed, node.fragment, node.lineage, String(seen.size));
    const branch = Array.from(signalFlux([node.fragment, node.lineage, ...words(node.fragment)], branchSeed));
    for (const [index, fragment] of branch.entries()) {
      const next = cleanText(fragment);
      if (!next || seen.has(next)) continue;
      queue.push({
        fragment: next,
        lineage: token(node.lineage, next, String(index)),
        depth: node.depth + 1,
      });
    }
  }
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
  const observationFlux = generativeFlux(entropy, token(localeHint, timeZone, String(now), 'observations'));
  return Array.from(observationFlux, (node) => {
    const subjectSeed = token(localeHint, timeZone, node.fragment, node.lineage, 'subject');
    const valueSeed = token(localeHint, timeZone, node.lineage, node.fragment, 'value');
    const subject = cleanText(`${words(node.fragment)[0] ?? node.fragment} ${words(node.lineage)[0] ?? subjectSeed}`);
    const value = cleanText([
      ...words(node.fragment).slice(1),
      ...words(node.lineage).slice(1),
      words(subjectSeed)[0] ?? subjectSeed,
      words(valueSeed)[0] ?? valueSeed,
    ].join(' '));
    const weight = node.fragment.length + node.lineage.length;
    return {
      subject,
      value,
      category: token(localeHint, timeZone, node.fragment, node.lineage) as BehavioralObservation['category'],
      source: token(timeZone, localeHint, node.lineage, node.fragment),
      confidence: weight / ((weight + localeHint.length + timeZone.length + 1) || 1),
      observedAt: now - (node.depth + weight),
      evidence: Array.from(generativeFlux([node.fragment, node.lineage, localeHint, timeZone], token(subjectSeed, valueSeed, node.lineage)), (support) => support.fragment),
      context: {
        [token(subject, node.lineage)]: cleanText(`${localeHint} ${timeZone} ${node.fragment}`),
        [token(value, node.fragment)]: cleanText(`${node.lineage} ${process.cwd()}`),
      },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, now: number, localeHint: string, timeZone: string): MemoryFact[] {
  const factFlux = generativeFlux(theoryFluxStrings(theory), token(theory.summary, localeHint, timeZone, String(now), 'facts'));
  return Array.from(factFlux, (node) => {
    const support = phraseFromTheory(theory, localeHint, node.fragment, node.depth);
    const weight = node.fragment.length + node.lineage.length;
    return {
      key: token(node.fragment, node.lineage, theory.summary),
      value: support,
      confidence: weight / ((weight + theory.summary.length + localeHint.length + timeZone.length + 1) || 1),
      source: token(localeHint, timeZone, node.lineage, node.fragment),
      updatedAt: now - (node.depth + weight),
    };
  });
}

function buildEpisodes(theory: UserBehaviorTheory, now: number, localeHint: string): EpisodicMemoryItem[] {
  const episodeFlux = generativeFlux(theoryFluxStrings(theory), token(theory.summary, localeHint, String(now), 'episodes'));
  return Array.from(episodeFlux, (node) => {
    const signals = Array.from(generativeFlux([node.fragment, node.lineage, theory.summary, localeHint], token(node.fragment, node.lineage, 'signals')), (support) => support.fragment);
    const weight = node.fragment.length + node.lineage.length;
    return {
      id: token(node.fragment, node.lineage, theory.summary),
      taskId: token(localeHint, node.fragment, node.lineage, String(node.depth)),
      category: token(node.fragment, localeHint, node.lineage),
      summary: phraseFromTheory(theory, localeHint, node.fragment, node.depth),
      signals,
      score: weight / ((weight + theory.summary.length + localeHint.length + 1) || 1),
      createdAt: now - (node.depth + weight),
    };
  });
}

function buildUiFrames(theory: UserBehaviorTheory, now: number, localeHint: string): VisionFrame[] {
  const frameFlux = generativeFlux([theory.summary, localeHint, ...theoryFluxStrings(theory)], token(theory.summary, localeHint, String(now), 'frames'));
  return Array.from(frameFlux, (node) => {
    const frameSeed = token(theory.summary, localeHint, node.fragment, node.lineage);
    const selectorFlux = Array.from(generativeFlux([node.fragment, node.lineage, localeHint, theory.summary], token(frameSeed, 'selectors')), (selectorNode) => selectorNode.fragment);
    return {
      id: token(frameSeed, node.lineage, node.fragment),
      ocr: phraseFromTheory(theory, frameSeed, localeHint, node.depth),
      dom: JSON.stringify({
        [token(frameSeed, node.lineage, 'dom')]: token(frameSeed, node.fragment, node.lineage),
        [token(frameSeed, node.lineage, 'theory')]: String(theory.id),
        [token(frameSeed, node.lineage, 'locale')]: localeHint,
      }),
      selectors: selectorFlux,
      activeTabId: token(frameSeed, node.fragment, localeHint),
      activeWindowId: token(node.lineage, frameSeed, node.fragment),
      viewport: {
        width: node.fragment.length + node.lineage.length,
        height: words(node.fragment).join('').length + words(node.lineage).join('').length + node.depth,
      },
    };
  });
}

function buildAttendees(theory: UserBehaviorTheory, localeHint: string, timeZone: string, roleName: string): Attendee[] {
  const seed = `${localeHint}|${timeZone}|${roleName}`;
  const attendeeFlux = generativeFlux([seed, theory.summary, localeHint, timeZone, roleName, ...theoryFluxStrings(theory)], token(seed, theory.summary, localeHint, timeZone, roleName, 'attendees'));
  return Array.from(attendeeFlux, (node) => ({
    email: `${token(seed, node.fragment, node.lineage, String(node.depth))}@${token(localeHint, node.lineage, node.fragment)}.local`,
    name: phraseFromTheory(theory, seed, node.fragment, node.depth),
    locale: splitLocale(localeHint)[node.depth] ?? localeHint,
    timezone: timeZone,
    role: cleanText(`${words(node.fragment)[0] ?? roleName} ${words(node.lineage)[0] ?? ''}`) || roleName,
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
  const recurrenceFlux = Array.from(generativeFlux([theory.summary, localeHint, timeZone, String(now)], token(theory.summary, localeHint, timeZone, 'recurrence')));
  const anchor = recurrenceFlux[0]?.fragment ?? token(theory.summary, localeHint, timeZone, 'anchor');
  const local = wallClockString(new Date(now + anchor.length + (recurrenceFlux[0]?.lineage.length ?? 0)), timeZone);
  const rule = cleanText(Array.from(recurrenceFlux, (node) => phraseFromTheory(theory, node.lineage, node.fragment, node.depth)).join(' ')).replace(/\s+/g, '-');
  const durationMinutes = recurrenceFlux.reduce((total, node) => total + node.fragment.length + node.lineage.length + node.depth, 0) || rule.length || anchor.length;
  return { startLocal: local, timeZone, rule, durationMinutes };
}

function buildPhrase(materials: string[], seed: string): string {
  const fragments = Array.from(generativeFlux(materials, seed), (node) => words(node.fragment)[0] ?? node.fragment).filter((entry) => Boolean(entry));
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

