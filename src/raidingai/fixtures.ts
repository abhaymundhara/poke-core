import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';
import { HydrationLayer, type RaidingAiHydratedScenario } from './hydration';

export type RaidingAiScenario = RaidingAiHydratedScenario & {
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
  theory: UserBehaviorTheory;
};

function hydrateScenario(): RaidingAiScenario {
  return new HydrationLayer().hydrate();
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = hydrateScenario();
