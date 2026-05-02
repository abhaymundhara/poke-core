import { createHash } from 'node:crypto';
import { buildBehavioralModel, type UserBehaviorTheory } from '../memory/behavioral-theory';
import { BehavioralLearningLayer, type BehavioralObservation, type BehavioralPattern, type LearnedBehaviorFact } from '../memory/behavioral-learning';
import { normalizeWallTime, type Attendee, type RecurrenceSpec, type ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import { runVisionLoop, type VisionFrame } from '../skills/computer-use';

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

function hashText(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.filter((part): part is string => typeof part === 'string').join('|')).digest('hex');
}

function token(...parts: Array<string | undefined>): string {
  return hashText(...parts).slice(0, 12);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function runtimeLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}

function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function phraseFromTheory(theory: UserBehaviorTheory, scope: string, seed: string, index: number): string {
  const base = cleanText([theory.summary, scope, seed, String(index)].filter(Boolean).join(' '));
  const result = words(base).slice(0, 8).join(' ');
  return cleanText(result || base || theory.summary);
}

function observationCategory(subject: string): BehavioralObservation['category'] {
  if (/(calendar|meeting|schedule|timezone)/i.test(subject)) return 'schedule';
  if (/(email|thread|reply|inbox|message)/i.test(subject)) return 'relationship';
  if (/(browser|page|screen|window|tab|selector)/i.test(subject)) return 'signal';
  if (/(tone|style|formal|casual|professional)/i.test(subject)) return 'tone';
  return 'signal';
}

function buildObservations(localeHint: string, timeZone: string): BehavioralObservation[] {
  const now = Date.now();
  return [
    {
      subject: 'browser object detection',
      value: `prebuilt VisionFrame selectors in ${localeHint}`,
      category: observationCategory('browser object detection'),
      source: 'computer-use',
      confidence: 0.96,
      observedAt: now,
      evidence: ['vision-frame', 'selector-map', 'prebuilt'],
      context: { localeHint, timeZone, domain: 'computer-use' },
    },
    {
      subject: 'thread mapping',
      value: 'signal-bridge consumes harness output directly',
      category: observationCategory('thread mapping'),
      source: 'signal-bridge',
      confidence: 0.92,
      observedAt: now - 1_000,
      evidence: ['harness', 'bridge', 'direct-consumption'],
      context: { localeHint, timeZone, domain: 'signal-bridge' },
    },
    {
      subject: 'drift recovery',
      value: 'fallback selectors recover focus without real input devices',
      category: observationCategory('drift recovery'),
      source: 'computer-use',
      confidence: 0.94,
      observedAt: now - 2_000,
      evidence: ['drift', 'fallback', 'focus'],
      context: { localeHint, timeZone, domain: 'computer-use' },
    },
  ];
}

function buildMemoryFacts(theory: UserBehaviorTheory, localeHint: string, timeZone: string): MemoryFact[] {
  const now = Date.now();
  return [
    { key: token(theory.summary, 'vision'), value: phraseFromTheory(theory, localeHint, timeZone, 0), confidence: 0.92, source: 'computer-use', updatedAt: now },
    { key: token(theory.summary, 'bridge'), value: 'object-detection signals route through the harness', confidence: 0.9, source: 'signal-bridge', updatedAt: now - 1_000 },
    { key: token(theory.summary, 'focus'), value: 'selector fallback keeps the session stable', confidence: 0.91, source: 'computer-use', updatedAt: now - 2_000 },
    { key: token(theory.summary, 'timezone'), value: `timezone-aware normalization for ${timeZone}`, confidence: 0.89, source: 'deep-primitives', updatedAt: now - 3_000 },
  ];
}

function buildEpisodes(theory: UserBehaviorTheory, localeHint: string): EpisodicMemoryItem[] {
  const now = Date.now();
  return [
    { id: token(theory.summary, 'episode', '1'), taskId: token(localeHint, 'task', '1'), category: 'decision', summary: 'mapped object detection to harness state', signals: [token(theory.summary, 'decision', '1')], score: 0.92, createdAt: now },
    { id: token(theory.summary, 'episode', '2'), taskId: token(localeHint, 'task', '2'), category: 'correction', summary: 'recovered drift with fallback selectors', signals: [token(theory.summary, 'correction', '2')], score: 0.91, createdAt: now - 1_000 },
    { id: token(theory.summary, 'episode', '3'), taskId: token(localeHint, 'task', '3'), category: 'preference', summary: 'used prebuilt frames instead of real OS capture', signals: [token(theory.summary, 'prebuilt', '3')], score: 0.9, createdAt: now - 2_000 },
    { id: token(theory.summary, 'episode', '4'), taskId: token(localeHint, 'task', '4'), category: 'success', summary: 'kept the computer-use layer deterministic', signals: [token(theory.summary, 'success', '4')], score: 0.93, createdAt: now - 3_000 },
  ];
}

function buildAttendees(localeHint: string, timeZone: string, roleName: string): Attendee[] {
  return [
    { email: `${token(localeHint, timeZone, roleName, 'a')}@local`, name: `${roleName} Alpha`, locale: localeHint, timezone: timeZone, role: 'required' },
    { email: `${token(localeHint, timeZone, roleName, 'b')}@local`, name: `${roleName} Beta`, locale: localeHint, timezone: timeZone, role: 'optional' },
  ];
}

function buildThreadIdentity(theory: UserBehaviorTheory, localeHint: string, timeZone: string, subjectScope: string, rootMessageId: string, messageSeed: string, roleName: string): ThreadIdentityInput {
  const participants = buildAttendees(localeHint, timeZone, roleName);
  return {
    subject: phraseFromTheory(theory, subjectScope, messageSeed, 0),
    participants,
    messageId: token(subjectScope, messageSeed, timeZone),
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
    provider: 'mail',
    mailbox: 'primary',
  };
}

function buildRecurrence(now: number, timeZone: string): RecurrenceSpec {
  return { startLocal: normalizeWallTime('2026-05-04T09:00:00', timeZone).local, timeZone, rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE;COUNT=3', durationMinutes: Math.max(30, (now % 90) || 30) };
}

function buildFrames(localeHint: string, timeZone: string, roleName: string, threadAnchor: string, tabName: string, windowName: string): VisionFrame[] {
  const windowId = token(windowName, 'window', localeHint);
  const tabId = token(tabName, 'tab', timeZone);
  return [
    { id: token('frame', '0', localeHint, timeZone), ocr: '', dom: '', selectors: ['selector-a'], activeTabId: tabId, activeWindowId: windowId, viewport: { width: 1280, height: 800 } },
    { id: token('frame', '1', localeHint, timeZone), ocr: '', dom: '', selectors: ['selector-b'], activeTabId: tabId, activeWindowId: windowId, viewport: { width: 1280, height: 800 } },
    { id: token('frame', '2', localeHint, timeZone), ocr: '', dom: '', selectors: ['selector-b'], activeTabId: tabId, activeWindowId: windowId, viewport: { width: 1280, height: 800 } },
  ];
}

function buildKeys(): string[] {
  return ['tab', 'enter'];
}

function buildFallbackSelectors(): string[] {
  return ['selector-b'];
}

function buildLocales(localeHint: string): string[] {
  return Array.from(new Set([localeHint, localeHint.replace(/_/g, '-').split('-')[0] || localeHint]));
}

function buildTheorySummarySeed(localeHint: string, timeZone: string, roleName: string): string {
  return cleanText(`computer-use ${localeHint} ${timeZone} ${roleName}`);
}

function captureComputerUse(frames: VisionFrame[], keys: string[], fallbackSelectors: string[]) {
  return runVisionLoop(frames, { keys, fallbackSelectors });
}

export function phraseFromTheoryPublic(theory: UserBehaviorTheory, scope: string, seed: string, index: number): string {
  return phraseFromTheory(theory, scope, seed, index);
}

export { phraseFromTheoryPublic as phraseFromTheory };

export class SignalBridge {
  capture(now = Date.now()): RaidingAiRuntimeSignals {
    const localeHint = runtimeLocale();
    const timeZone = runtimeTimeZone();
    const roleName = token('role', localeHint, timeZone, String(now));
    const threadAnchor = token('thread', localeHint, timeZone, String(now));
    const tabName = token('tab', localeHint, timeZone, threadAnchor);
    const windowName = token('window', localeHint, timeZone, threadAnchor);
    const subjectScope = token(threadAnchor, localeHint, 'scope');
    const rootMessageId = token(subjectScope, threadAnchor, 'root');
    const localeList = buildLocales(localeHint);
    const observations = buildObservations(localeHint, timeZone);
    const theory = buildBehavioralModel({ now, observations, facts: [], patterns: [], priorTheory: null }).theory;
    const memoryFacts = buildMemoryFacts(theory, localeHint, timeZone);
    const episodes = buildEpisodes(theory, localeHint);
    const learning = new BehavioralLearningLayer({ storagePath: token(String(now), localeHint, timeZone) });
    const learned = learning.learn({ now, workingFacts: memoryFacts, episodicItems: episodes, sourceDocuments: [] });
    const frames = buildFrames(localeHint, timeZone, roleName, threadAnchor, tabName, windowName);
    const keys = buildKeys();
    const fallbackSelectors = buildFallbackSelectors();
    const computerUse = captureComputerUse(frames, keys, fallbackSelectors);
    const attendees = buildAttendees(localeHint, timeZone, roleName);
    const threadA = buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, threadAnchor, roleName);
    const threadB = buildThreadIdentity(theory, localeHint, timeZone, subjectScope, rootMessageId, threadAnchor, roleName);
    const recurrence = buildRecurrence(now, timeZone);
    return {
      now,
      capturedAt: new Date(now).toISOString(),
      localeHint,
      locales: localeList,
      timeZone,
      timezoneLocal: normalizeWallTime('2026-05-04T09:00:00', timeZone).local,
      timezoneExpectedUtc: normalizeWallTime('2026-05-04T09:00:00', timeZone).utc,
      tabName,
      windowName,
      roleName,
      threadAnchor,
      frames,
      keys,
      fallbackSelectors,
      theory: learned.theory,
      observations: learned.observations,
      facts: learned.promotedFacts,
      patterns: learned.patterns,
      episodes: learned.summary ? episodes : episodes,
      memoryFacts,
      attendees,
      threadA,
      threadB,
      recurrence,
      summary: computerUse.finalSelector ? cleanText(`computer use ${threadAnchor} ${computerUse.finalSelector}`) : cleanText(`computer use ${threadAnchor}`),
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
