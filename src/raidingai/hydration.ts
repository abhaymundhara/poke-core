import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';
import { captureRaidingAiSignals, deriveRaidingAiTrace, type RaidingAiRuntimeSignals, type RaidingAiTrace } from './signal-bridge';

export type RaidingAiHydratedScenario = {
  seed: string;
  now: number;
  label: string;
  taskHint: string;
  theory: UserBehaviorTheory;
  computerUse: { frames: Array<{ id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } }>; keys: string[]; fallbackSelectors: string[] };
  deepPrimitives: RaidingAiTrace['deepPrimitives'];
  memory: { facts: MemoryFact[]; episodes: EpisodicMemoryItem[] };
  traces: Array<{
    id: string;
    kind: string;
    description: string;
    frames?: Array<{ id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } }>;
    fallbackSelectors?: string[];
    threadInputs?: ThreadIdentityInput[];
    workingFacts?: MemoryFact[];
    episodicItems?: EpisodicMemoryItem[];
    objective?: string;
    expected: Record<string, boolean | number | string>;
  }>;
  signalBridge: {
    localeHint: string;
    locales: string[];
    tabName: string;
    windowName: string;
    roleName: string;
    threadAnchor: string;
  };
};

function buildSeed(signals: RaidingAiRuntimeSignals): string {
  return signals.threadAnchor;
}

function buildLabel(signals: RaidingAiRuntimeSignals): string {
  return `${signals.theory.summary} ${signals.localeHint}`.trim();
}

export class HydrationLayer {
  capture(now = Date.now()): RaidingAiRuntimeSignals {
    return captureRaidingAiSignals(now);
  }

  hydrate(trace?: RaidingAiTrace | null): RaidingAiHydratedScenario {
    const runtime = trace ? deriveRaidingAiTrace(Date.parse(trace.capturedAt) || Date.now()) : deriveRaidingAiTrace();
    const resolved = trace ?? runtime;
    const signals = this.capture(Date.parse(resolved.capturedAt) || Date.now());
    const seed = buildSeed(signals);
    const now = Date.parse(resolved.capturedAt) || Date.now();
    const facts = resolved.behavioral.facts.map(({ key, value, confidence, source, updatedAt }) => ({ key, value, confidence, source, updatedAt }));
    const episodes = resolved.behavioral.episodes.map((episode) => ({ ...episode }));
    const traces = [{
      id: seed,
      kind: resolved.captureId,
      description: resolved.summary,
      frames: resolved.computerUse.frames,
      fallbackSelectors: resolved.computerUse.fallbackSelectors,
      threadInputs: [resolved.deepPrimitives.threadA, resolved.deepPrimitives.threadB],
      workingFacts: facts,
      episodicItems: episodes,
      objective: resolved.taskHint,
      expected: { hydrated: true, grounded: true, captureAligned: true },
    }];
    return {
      seed,
      now,
      label: buildLabel(signals),
      taskHint: resolved.taskHint,
      theory: signals.theory,
      computerUse: resolved.computerUse,
      deepPrimitives: resolved.deepPrimitives,
      memory: { facts: signals.memoryFacts, episodes: signals.episodes },
      traces,
      signalBridge: {
        localeHint: signals.localeHint,
        locales: signals.locales,
        tabName: signals.tabName,
        windowName: signals.windowName,
        roleName: signals.roleName,
        threadAnchor: signals.threadAnchor,
      },
    };
  }
}

export function hydrateRaidingAiScenario(trace?: RaidingAiTrace | null): RaidingAiHydratedScenario {
  return new HydrationLayer().hydrate(trace ?? undefined);
}
