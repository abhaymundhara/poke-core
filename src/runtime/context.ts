import { randomUUID } from 'node:crypto';
import { IdentityGraph } from '../identity/graph.ts';
import type { IdentityResolution } from '../identity/types.ts';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import { buildContextCompactionTelemetry } from './soul-contract.ts';
import type { PokeCoreStore } from '../store';
import type {
  ContextWindowSegment,
  ContextWindowSource,
  ContextWindowSummary,
  PlanStep,
  PlannerLoopObservation,
  PlannerLoopReflection,
  PlannerLoopState,
  RuntimeState,
  TaskInput,
  TaskPlan,
  TaskRecord,
  ThreadIdentityResolution,
  TimeProvider,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toMillis(value: string | number | Date): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid clock value: ' + String(value));
  return parsed;
}

export function createHighPrecisionClock(start: string | number | Date = new Date()): TimeProvider {
  const anchorEpoch = toMillis(start);
  const anchorTick = typeof performance !== 'undefined' ? performance.now() : 0;
  const anchorNs = typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint() : null;

  const now = () => {
    const tick = typeof performance !== 'undefined' ? performance.now() : anchorTick;
    return anchorEpoch + (tick - anchorTick);
  };

  return {
    label: 'high-precision',
    origin: anchorEpoch,
    now,
    nowNs: anchorNs ? () => anchorNs + BigInt(Math.max(0, Math.round((now() - anchorEpoch) * 1_000_000))) : undefined,
    iso: () => new Date(now()).toISOString(),
    advance: (ms: number) => anchorEpoch + ms,
  };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/[^\p{L}\p{N}]+/gu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function estimateTokens(value: unknown): number {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!textValue) return 0;
  return Math.max(1, Math.ceil(tokenize(textValue).length * 1.12));
}

function splitSentences(value: string): string[] {
  return normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9\"'“(])/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function sentenceScore(sentence: string, hints: string[]): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const hint of hints) {
    if (!hint) continue;
    const normalizedHint = hint.toLowerCase();
    if (lower.includes(normalizedHint)) score += 2;
    score += tokenize(normalizedHint).filter((token) => token.length > 2 && lower.includes(token)).length * 0.35;
  }
  if (/\b(error|fail|blocked|replan|retry|missing|conflict|identity|context|plan|step)\b/i.test(sentence)) score += 1;
  if (sentence.length < 140) score += 0.2;
  return score;
}

export function compactText(value: unknown, tokenBudget = 120, hints: string[] = []): string {
  const textValue = typeof value === 'string' ? normalizeWhitespace(value) : normalizeWhitespace(JSON.stringify(value ?? ''));
  if (!textValue) return '';
  const budget = Math.max(8, Math.floor(tokenBudget));
  const tokens = estimateTokens(textValue);
  if (tokens <= budget) return textValue;

  const sentences = splitSentences(textValue);
  if (sentences.length === 0) {
    return tokenize(textValue).slice(0, budget).join(' ');
  }

  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      tokens: estimateTokens(sentence),
      score: sentenceScore(sentence, hints) + (index === 0 ? 0.35 : 0) + (index < 3 ? 0.15 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.tokens - b.tokens || a.index - b.index);

  const chosen = new Map<number, { sentence: string; tokens: number }>();
  let used = 0;
  for (const candidate of ranked) {
    if (used + candidate.tokens > budget) continue;
    chosen.set(candidate.index, { sentence: candidate.sentence, tokens: candidate.tokens });
    used += candidate.tokens;
    if (used >= Math.max(24, budget * 0.75)) break;
  }

  if (chosen.size === 0) {
    return tokenize(textValue).slice(0, budget).join(' ');
  }

  return [...chosen.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => entry.sentence)
    .join(' ');
}

function normalizeSegmentText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return normalizeWhitespace(value);
  return compactText(value, 160);
}

function segmentId(source: ContextWindowSource, index: number): string {
  return `${source}:${index}:${randomUUID().slice(0, 8)}`;
}

function pushSegment(segments: ContextWindowSegment[], source: ContextWindowSource, title: string, value: unknown, priority: number, metadata: Record<string, unknown> = {}): void {
  const textValue = normalizeSegmentText(value);
  if (!textValue) return;
  segments.push({
    id: segmentId(source, segments.length),
    source,
    title,
    text: textValue,
    priority,
    tokenEstimate: estimateTokens(textValue),
    metadata,
  });
}

function compactSegments(segments: ContextWindowSegment[], budget: number, hints: string[]): ContextWindowSummary {
  const ordered = segments.slice().sort((a, b) => b.priority - a.priority || a.tokenEstimate - b.tokenEstimate || a.title.localeCompare(b.title));
  const selected: ContextWindowSegment[] = [];
  const omitted: ContextWindowSegment[] = [];
  let usedTokens = 0;

  for (const segment of ordered) {
    if (usedTokens + segment.tokenEstimate <= budget) {
      selected.push(segment);
      usedTokens += segment.tokenEstimate;
      continue;
    }
    omitted.push(segment);
  }

  const compacted: ContextWindowSegment[] = [];
  const overflowTokens = omitted.reduce((sum, segment) => sum + segment.tokenEstimate, 0);
  if (omitted.length > 0) {
    const overflowText = omitted
      .map((segment) => `${segment.title}: ${segment.text}`)
      .join('\n\n');
    const compactedText = compactText(overflowText, Math.max(24, Math.min(180, budget - usedTokens + Math.floor(budget * 0.25))), hints);
    if (compactedText) {
      const compactedSegment: ContextWindowSegment = {
        id: segmentId('system', compacted.length),
        source: 'system',
        title: 'compressed overflow',
        text: compactedText,
        priority: 0.25,
        tokenEstimate: estimateTokens(compactedText),
        metadata: { omittedCount: omitted.length },
      };
      compacted.push(compactedSegment);
      usedTokens += compactedSegment.tokenEstimate;
    }
  }

  const selectedTokenEstimate = selected.reduce((sum, segment) => sum + segment.tokenEstimate, 0);
  const compactedTokenEstimate = compacted.reduce((sum, segment) => sum + segment.tokenEstimate, 0);
  const telemetry = buildContextCompactionTelemetry({
    source: 'runtime.context.compactSegments',
    budget,
    selectedSegments: selected.length,
    compactedSegments: compacted.length,
    selectedTokenEstimate,
    compactedTokenEstimate,
    overflowTokens,
  });
  const summary = [...selected, ...compacted]
    .map((segment) => '[' + segment.title + '] ' + segment.text)
    .join('\n');

  return {
    budget,
    usedTokens,
    overflowTokens,
    selected,
    compacted,
    summary,
    telemetry,
  };
}

function bestIdentityLabel(resolution: IdentityResolution): string {
  if (resolution.bestMatch) return resolution.bestMatch.identity.name;
  return resolution.normalizedQuery || resolution.query || 'thread';
}

function mergeSignals(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []).map((entry) => text(entry)).filter((entry) => entry.length > 0))];
}

function scoreResolution(resolution: IdentityResolution): number {
  return resolution.bestMatch?.confidence ?? 0;
}

export type ContextWindowRequest = {
  taskId: string;
  objective: string;
  plan?: TaskPlan;
  state?: RuntimeState;
  step?: PlanStep | null;
  threadIdentity?: ThreadIdentityResolution | null;
  limitTokens?: number;
};

export class OrchestratorRuntimeContext {
  readonly identityGraph: IdentityGraph;
  readonly workingMemory: {
    upsertFact: (key: string, value: string, confidence?: number, source?: string) => MemoryFact;
    getFact: (key: string) => MemoryFact | null;
    query: (prefix: string) => MemoryFact[];
    appendTrail: (event: string, detail?: Record<string, unknown>) => void;
    snapshot: () => { facts: MemoryFact[]; trail: Array<{ event: string; at: number; detail: Record<string, unknown> }> };
  };
  readonly episodicMemory: {
    add: (item: Omit<EpisodicMemoryItem, 'createdAt'>) => EpisodicMemoryItem;
    recall: (taskHint: string, limit?: number) => EpisodicMemoryItem[];
    snapshot: () => EpisodicMemoryItem[];
  };
  private readonly factCache = new Map<string, MemoryFact>();
  private readonly trailCache: Array<{ event: string; at: number; detail: Record<string, unknown> }> = [];
  private readonly episodicCache: EpisodicMemoryItem[] = [];

  constructor(private readonly store: PokeCoreStore, readonly clock: TimeProvider = createHighPrecisionClock(), identityGraph?: IdentityGraph) {
    this.identityGraph = identityGraph ?? new IdentityGraph();
    this.workingMemory = {
      upsertFact: (key: string, value: string, confidence = 0.8, source = 'system') => {
        const fact: MemoryFact = { key, value, confidence, source, updatedAt: Math.round(this.now()) };
        this.factCache.set(key, fact);
        this.store.replaceWorkingFact(fact);
        return fact;
      },
      getFact: (key: string) => this.factCache.get(key) ?? null,
      query: (prefix: string) => [...this.factCache.values()].filter((fact) => fact.key.startsWith(prefix)).sort((a, b) => b.updatedAt - a.updatedAt),
      appendTrail: (event: string, detail: Record<string, unknown> = {}) => {
        const entry = { event, at: this.now(), detail };
        this.trailCache.push(entry);
        this.store.recordEvent(
          text(detail.taskId) || 'orchestrator',
          'context',
          null,
          null,
          { event, detail, at: entry.at },
        );
      },
      snapshot: () => ({
        facts: [...this.factCache.values()].sort((a, b) => a.key.localeCompare(b.key)),
        trail: [...this.trailCache],
      }),
    };
    this.episodicMemory = {
      add: (item: Omit<EpisodicMemoryItem, 'createdAt'>) => {
        const record: EpisodicMemoryItem = { ...item, createdAt: Math.round(this.now()) };
        this.episodicCache.push(record);
        this.store.upsertEpisodicItem(record);
        return record;
      },
      recall: (taskHint: string, limit = 8) => {
        const q = taskHint.toLowerCase();
        return [...this.episodicCache]
          .map((item) => ({ item, score: item.score + this.matchScore(q, item) }))
          .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
          .slice(0, limit)
          .map((x) => x.item);
      },
      snapshot: () => [...this.episodicCache],
    };
  }

  now(): number {
    return this.clock.now();
  }

  iso(): string {
    return this.clock.iso();
  }

  createPlannerLoopState(taskId: string, objective: string, threadIdentity?: ThreadIdentityResolution | null): PlannerLoopState {
    return {
      planId: taskId,
      objective,
      cycle: 0,
      status: 'planning',
      observations: [],
      reflections: [],
      lastObservedAt: 0,
      lastReflectedAt: 0,
      threadIdentity: threadIdentity ?? null,
    };
  }

  observePlannerLoop(
    loop: PlannerLoopState | undefined,
    input: {
      stepId: string;
      stepKind: string;
      outcome: PlannerLoopObservation['outcome'];
      at?: number;
      note?: string | null;
      summary?: string | null;
      confidence?: number;
      observation?: string;
      result?: unknown;
    },
  ): PlannerLoopState {
    const current = loop ?? this.createPlannerLoopState(input.stepId, input.summary ?? input.note ?? 'task');
    const observation: PlannerLoopObservation = {
      stepId: input.stepId,
      stepKind: input.stepKind as PlannerLoopObservation['stepKind'],
      outcome: input.outcome,
      note: input.note ?? undefined,
      summary: input.summary ?? input.note ?? '',
      confidence: input.confidence,
      at: input.at ?? this.now(),
      evidence: input.observation ? [input.observation] : [],
      result: input.result,
    };
    const nextStatus = input.outcome === 'failed' || input.outcome === 'blocked' ? 'blocked' : input.outcome === 'replanned' ? 'replanning' : 'executing';
    return {
      ...current,
      status: nextStatus,
      observations: [...current.observations, observation],
      lastObservedAt: input.at ?? this.now(),
    };
  }

  reflectPlannerLoop(
    loop: PlannerLoopState | undefined,
    input: {
      reason: string;
      stepId?: string;
      cycle?: number;
      at?: number;
      objective?: string;
      notes?: string[];
      threadIdentity?: ThreadIdentityResolution | null;
    },
  ): PlannerLoopState {
    const current = loop ?? this.createPlannerLoopState(input.stepId ?? input.reason, input.objective ?? input.reason, input.threadIdentity ?? null);
    const reflection: PlannerLoopReflection = {
      cycle: input.cycle ?? current.cycle + 1,
      summary: compactText(input.reason, 80, input.notes ?? []),
      shouldReplan: true,
      reasons: [input.reason],
      nextQuestions: input.notes ?? [],
      at: input.at ?? this.now(),
    };
    return {
      ...current,
      cycle: reflection.cycle,
      status: 'replanning',
      reflections: [...current.reflections, reflection],
      lastReflectedAt: reflection.at,
    };
  }

  buildContextWindow(request: ContextWindowRequest): ContextWindowSummary {
    const hints = mergeSignals(
      request.threadIdentity?.signals,
      request.plan?.semanticIntent?.topics,
      request.plan?.semanticIntent?.entities,
      request.plan ? [request.plan.objective, request.plan.taskId] : undefined,
      request.state?.plannerLoop?.observations.map((observation) => observation.note ?? observation.summary),
    );
    const segments: ContextWindowSegment[] = [];
    pushSegment(segments, 'objective', 'objective', request.objective, 100, { taskId: request.taskId });
    if (request.threadIdentity) {
      pushSegment(segments, 'identity', 'resolved thread identity', {
        identityId: request.threadIdentity.identityId,
        label: request.threadIdentity.label,
        confidence: request.threadIdentity.confidence,
        matchedBy: request.threadIdentity.matchedBy,
        source: request.threadIdentity.source,
        signals: request.threadIdentity.signals,
      }, 96, { source: request.threadIdentity.source });
    }
    if (request.step) {
      pushSegment(segments, 'step', 'active step', {
        id: request.step.id,
        title: request.step.title,
        kind: request.step.kind,
        skill: request.step.skill,
        position: request.step.position,
        dependsOn: request.step.dependsOn ?? [],
      }, 94, { stepId: request.step.id, kind: request.step.kind });
    }
    if (request.plan) {
      pushSegment(segments, 'plan', 'plan summary', {
        taskId: request.plan.taskId,
        objective: request.plan.objective,
        stepCount: request.plan.steps.length,
        steps: request.plan.steps.slice(0, 8).map((step) => ({ id: step.id, title: step.title, kind: step.kind, skill: step.skill, dependsOn: step.dependsOn ?? [] })),
        planner: request.plan.planner,
      }, 92, { taskId: request.plan.taskId });
    }
    if (request.state) {
      pushSegment(segments, 'state', 'runtime state', {
        cursor: request.state.cursor,
        attemptKeys: Object.keys(request.state.attempts ?? {}),
        outputKeys: Object.keys(request.state.outputs ?? {}),
        breadcrumbCount: request.state.breadcrumbs?.length ?? 0,
        recoveryCount: request.state.recovery?.length ?? 0,
        plannerLoop: request.state.plannerLoop,
      }, 88, { cursor: request.state.cursor });
      if (request.state.contextWindow?.summary) {
        pushSegment(segments, 'state', 'previous context window', request.state.contextWindow.summary, 70, { budget: request.state.contextWindow.budget });
      }
      if (request.state.threadIdentity) {
        pushSegment(segments, 'identity', 'thread identity snapshot', request.state.threadIdentity, 90, { identityId: request.state.threadIdentity.identityId });
      }
      const memoryFacts = Object.entries(request.state.outputs ?? {});
      for (const [key, value] of memoryFacts.slice(0, 6)) {
        pushSegment(segments, 'memory', `output ${key}`, value, 72, { key });
      }
    }
    if (request.state?.plannerLoop?.observations?.length) {
      pushSegment(segments, 'observation', 'planner observations', request.state.plannerLoop.observations.slice(-6).map((observation) => ({
        stepId: observation.stepId,
        stepKind: observation.stepKind,
        outcome: observation.outcome,
        note: observation.note,
        summary: observation.summary,
      })), 76, { count: request.state.plannerLoop.observations.length });
    }
    if (request.state?.plannerLoop?.reflections?.length) {
      pushSegment(segments, 'observation', 'planner reflections', request.state.plannerLoop.reflections.slice(-4), 74, { count: request.state.plannerLoop.reflections.length });
    }
    if (request.state?.recovery?.length) {
      pushSegment(segments, 'state', 'recovery trail', request.state.recovery.slice(-6), 78, { count: request.state.recovery.length });
    }
    if (request.state?.breadcrumbs?.length) {
      pushSegment(segments, 'event', 'breadcrumbs', request.state.breadcrumbs.slice(-8), 80, { count: request.state.breadcrumbs.length });
    }
    const memoryFacts = this.workingMemory.snapshot().facts;
    if (memoryFacts.length > 0) {
      pushSegment(segments, 'memory', 'working memory', memoryFacts.slice(-8), 68, { factCount: memoryFacts.length });
    }
    const episodes = this.episodicMemory.snapshot();
    if (episodes.length > 0) {
      pushSegment(segments, 'episodic', 'episodic memory', episodes.slice(-8), 64, { episodeCount: episodes.length });
    }
    const budget = Math.max(96, Math.min(4096, request.limitTokens ?? request.state?.contextWindow?.budget ?? 1600));
    return compactSegments(segments, budget, hints);
  }

  async resolveThreadIdentity(input: TaskInput, task?: TaskRecord | null, plan?: TaskPlan | null): Promise<ThreadIdentityResolution> {
    const context = isRecord(input.context) ? input.context : {};
    const candidateQueries = mergeSignals(
      [input.id, input.objective],
      task ? [task.taskId, task.objective] : undefined,
      plan ? [plan.taskId, plan.objective, plan.semanticIntent?.semanticQuery] : undefined,
      [
        context.threadId,
        context.thread,
        context.threadIdentity,
        context.conversationId,
        context.messageId,
        context.email,
        context.from,
        context.sender,
        context.handle,
        context.name,
        context.subject,
        context.participant,
        context.participants,
      ].flatMap((value) => (Array.isArray(value) ? value : [value])),
    );
    const resolutions: IdentityResolution[] = [];
    for (const query of candidateQueries) {
      try {
        resolutions.push(await this.identityGraph.resolveIdentity(query));
      } catch {
        // ignore malformed signals and continue searching the graph.
      }
    }
    const bestResolution = resolutions.sort((a, b) => scoreResolution(b) - scoreResolution(a))[0] ?? null;
    const bestMatch = bestResolution?.bestMatch ?? null;
    if (bestMatch && bestMatch.confidence >= 0.62) {
      return {
        query: bestResolution?.query ?? input.objective,
        identityId: bestMatch.identity.identityId,
        label: bestIdentityLabel(bestResolution!),
        confidence: bestMatch.confidence,
        matchedBy: bestMatch.matchedBy,
        source: 'graph',
        resolution: bestResolution!,
        signals: mergeSignals(bestMatch.signals, bestResolution?.candidates.flatMap((candidate) => candidate.signals)),
        aliases: bestMatch.identity.aliases,
        anchor: `graph:${bestMatch.identity.identityId}`,
      };
    }

    const labelSeed = normalizeWhitespace([
      text(context.threadId),
      text(context.threadIdentity),
      text(context.conversationId),
      text(context.messageId),
      task?.taskId,
      plan?.taskId,
      input.id,
    ].filter((entry) => entry.length > 0).join(' ')) || input.objective || 'thread';
    const syntheticIdentity = this.identityGraph.upsertIdentity({
      kind: 'agent',
      name: labelSeed.slice(0, 128),
      aliases: candidateQueries,
      metadata: {
        synthetic: true,
        source: 'orchestrator-runtime',
        taskId: input.id,
        objective: input.objective,
        taskObjective: task?.objective ?? null,
        planTaskId: plan?.taskId ?? null,
      },
    });
    const syntheticResolution: IdentityResolution = {
      query: labelSeed,
      normalizedQuery: labelSeed.toLowerCase(),
      candidates: [
        {
          identity: syntheticIdentity,
          confidence: 0.58,
          matchedBy: 'alias',
          reason: 'synthetic thread identity created from durable orchestrator signals',
          signals: candidateQueries,
        },
      ],
      bestMatch: {
        identity: syntheticIdentity,
        confidence: 0.58,
        matchedBy: 'alias',
        reason: 'synthetic thread identity created from durable orchestrator signals',
        signals: candidateQueries,
      },
    };
    return {
      query: labelSeed,
      identityId: syntheticIdentity.identityId,
      label: syntheticIdentity.name,
      confidence: 0.58,
      matchedBy: 'alias',
      source: 'synthetic',
      resolution: syntheticResolution,
      signals: candidateQueries,
      aliases: syntheticIdentity.aliases,
      anchor: `synthetic:${syntheticIdentity.identityId}`,
    };
  }

  private matchScore(q: string, item: EpisodicMemoryItem): number {
    const hay = `${item.summary} ${item.signals.join(' ')}`.toLowerCase();
    const matches = q.split(/\s+/).filter((token) => token.length > 2 && hay.includes(token)).length;
    return matches / Math.max(1, q.split(/\s+/).length);
  }
}
