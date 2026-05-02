import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';
import { SignalBridge, phraseFromTheory, type RaidingAiRuntimeSignals, type RaidingAiTrace } from './signal-bridge';

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
  signalBridge: {
    localeHint: string;
    locales: string[];
    tabName: string;
    windowName: string;
    roleName: string;
    threadAnchor: string;
  };
  traces: RaidingAiTrace[];
};

function projectSignals(signals: RaidingAiRuntimeSignals): RaidingAiScenario {
  return {
    seed: signals.threadAnchor,
    now: signals.now,
    label: phraseFromTheory(signals.theory, signals.threadAnchor, signals.localeHint, 0),
    taskHint: phraseFromTheory(signals.theory, signals.threadAnchor, signals.timeZone, 1),
    theory: signals.theory,
    computerUse: {
      frames: signals.frames,
      keys: signals.keys,
      fallbackSelectors: signals.fallbackSelectors,
    },
    deepPrimitives: {
      threadA: signals.threadA,
      threadB: signals.threadB,
      timezone: {
        local: signals.timezoneLocal,
        timeZone: signals.timeZone,
        expectedUtc: signals.timezoneExpectedUtc,
      },
      attendees: signals.attendees,
      recurrence: signals.recurrence,
    },
    memory: {
      facts: signals.memoryFacts,
      episodes: signals.episodes,
    },
    signalBridge: {
      localeHint: signals.localeHint,
      locales: signals.locales,
      tabName: signals.tabName,
      windowName: signals.windowName,
      roleName: signals.roleName,
      threadAnchor: signals.threadAnchor,
    },
    traces: [new SignalBridge().buildTrace(signals.now)],
  };
}

let cachedScenario: RaidingAiScenario | null = null;

function ensureScenario(): RaidingAiScenario {
  if (!cachedScenario) cachedScenario = projectSignals(new SignalBridge().capture());
  return cachedScenario;
}

export function getRaidingAiFixtures(): RaidingAiScenario {
  return ensureScenario();
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = new Proxy({} as RaidingAiScenario, {
  get(_target, prop) {
    return ensureScenario()[prop as keyof RaidingAiScenario];
  },
  ownKeys() {
    return Reflect.ownKeys(ensureScenario());
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
}) as RaidingAiScenario;
