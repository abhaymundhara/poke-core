import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildBehavioralModel, type UserBehaviorTheory } from '../memory/behavioral-theory';
import { BehavioralLearningLayer, type BehavioralObservation, type BehavioralPattern, type LearnedBehaviorFact } from '../memory/behavioral-learning';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import { RAIDINGAI_ONTOLOGY } from './ontology';

type VisionFrame = { id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } };

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
};

export type RaidingAiHydratedScenario = {
  seed: string;
  now: number;
  label: string;
  taskHint: string;
  theory: UserBehaviorTheory;
  computerUse: { frames: VisionFrame[]; keys: string[]; fallbackSelectors: string[] };
  deepPrimitives: RaidingAiTrace['deepPrimitives'];
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

function hashText(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function readTraceFile(): RaidingAiTrace {
  const fileUrl = new URL(RAIDINGAI_ONTOLOGY.files.goldTrace, import.meta.url);
  return JSON.parse(readFileSync(fileUrl, 'utf8')) as RaidingAiTrace;
}

function captureSeed(trace: RaidingAiTrace): string {
  return hashText(trace.captureId, trace.capturedAt, trace.taskHint).slice(0, 24);
}

function buildTheoryFromTrace(trace: RaidingAiTrace): UserBehaviorTheory {
  const now = Date.parse(trace.capturedAt) || Date.now();
  const bootstrap = buildBehavioralModel({
    now,
    observations: trace.behavioral.observations,
    facts: trace.behavioral.facts,
    patterns: trace.behavioral.patterns,
    priorTheory: null,
  });
  const learning = new BehavioralLearningLayer({ storagePath: hashText(trace.captureId, trace.summary).slice(0, 32) });
  const snapshot = learning.learn({ now, workingFacts: trace.behavioral.facts, episodicItems: trace.behavioral.episodes, sourceDocuments: [] });
  return snapshot.theory ?? bootstrap.theory;
}

function buildLabel(trace: RaidingAiTrace, theory: UserBehaviorTheory): string {
  return `${trace.captureId}:${theory.summary}`;
}

export class HydrationLayer {
  loadTrace(trace?: RaidingAiTrace | null): RaidingAiTrace {
    const resolved = trace ?? readTraceFile();
    if (!resolved) throw new Error(`missing raidingai trace: ${RAIDINGAI_ONTOLOGY.traces.gold}`);
    return resolved;
  }

  hydrate(trace?: RaidingAiTrace | null): RaidingAiHydratedScenario {
    const resolved = this.loadTrace(trace);
    const theory = buildTheoryFromTrace(resolved);
    const seed = captureSeed(resolved);
    const now = Date.parse(resolved.capturedAt) || Date.now();
    const facts: MemoryFact[] = resolved.behavioral.facts.map(({ key, value, confidence, source, updatedAt }) => ({ key, value, confidence, source, updatedAt }));
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
      label: buildLabel(resolved, theory),
      taskHint: resolved.taskHint,
      theory,
      computerUse: resolved.computerUse,
      deepPrimitives: resolved.deepPrimitives,
      memory: { facts, episodes },
      traces,
    };
  }
}

export function hydrateRaidingAiScenario(trace?: RaidingAiTrace | null): RaidingAiHydratedScenario {
  return new HydrationLayer().hydrate(trace);
}

export function loadGoldRaidingAiTrace(): RaidingAiTrace {
  return readTraceFile();
}
