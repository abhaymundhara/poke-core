import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';
import { HydrationLayer, type RaidingAiTrace } from './hydration';
import { RAIDINGAI_ONTOLOGY } from './ontology';

type VisionFrame = { id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } };

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
  traces: Array<{
    id: string;
    kind: string;
    description: string;
    frames?: VisionFrame[];
    fallbackSelectors?: string[];
    threadInputs?: ThreadIdentityInput[];
    workingFacts?: MemoryFact[];
    episodicItems?: EpisodicMemoryItem[];
    objective?: string;
    expected: Record<string, boolean | number | string>;
  }>;
};

function hydrateScenario(trace?: RaidingAiTrace | null): RaidingAiScenario {
  void RAIDINGAI_ONTOLOGY.files.goldTrace;
  return new HydrationLayer().hydrate(trace ?? undefined);
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = hydrateScenario();
