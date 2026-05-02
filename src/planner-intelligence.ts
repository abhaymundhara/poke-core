import type {
  ExecutionProfile,
  PlanStep,
  PlannerIntentGraph,
  PlannerPlanMetadata,
  PlannerRecoveryPolicy,
  PlannerRuntimeState,
  PlannerStrategy,
  PlannerToolAffordance,
  SkillDescriptor,
  TaskInput,
  TaskPlan,
} from './types';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, type SemanticNluProvider } from './search/nlu';
import type { SearchIntent } from './search/types';

export type PlannerResolveContext = Record<string, unknown> & {
  semanticIntent?: SearchIntent;
  skillCatalog?: SkillDescriptor[];
  semanticProvider?: SemanticNluProvider;
  plannerProvider?: SemanticNluProvider;
  currentGraph?: Record<string, unknown> | null;
  currentState?: Record<string, unknown> | null;
};

type PlannerSynthesisDraft = {
  strategy: PlannerStrategy;
  toolAffordances: PlannerToolAffordance[];
  steps: PlanStep[];
  recoveryPolicy: PlannerRecoveryPolicy;
  planner: PlannerPlanMetadata;
  intentGraph: PlannerIntentGraph;
  warnings?: string[];
};

export type PlannerRecoveryEvent = {
  phase: 'intent' | 'plan';
  provider: string;
  objective: string;
  reason: string;
  at: number;
};

export class RecoveryRequired extends Error {
  readonly recoveryEvent: PlannerRecoveryEvent;

  constructor(event: PlannerRecoveryEvent) {
    super('recovery-required:' + event.phase + ':' + event.provider + ':' + event.reason);
    this.name = 'RecoveryRequired';
    this.recoveryEvent = event;
  }
}

const PLANNER_SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['strategy', 'toolAffordances', 'steps', 'recoveryPolicy', 'planner', 'intentGraph'],
  properties: {
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    toolAffordances: { type: 'array' },
    steps: { type: 'array' },
    recoveryPolicy: { type: 'object' },
    planner: { type: 'object' },
    intentGraph: { type: 'object' },
    warnings: { type: 'array' },
  },
} as const;

const PLANNER_INTENT_SCHEMA = {
  type: 'object',
  required: ['objective', 'normalizedObjective', 'semanticQuery', 'entities', 'topics', 'constraints', 'sourceHints', 'sourcePriors', 'freshness', 'focus', 'hopBudget', 'trustMode', 'querySeeds', 'evidenceTerms', 'sessionKey', 'semanticFrames', 'decomposedQuestions', 'ambiguities', 'nlu'],
  properties: {
    objective: { type: 'string' },
    normalizedObjective: { type: 'string' },
    semanticQuery: { type: 'string' },
    entities: { type: 'array' },
    topics: { type: 'array' },
    constraints: { type: 'array' },
    sourceHints: { type: 'array' },
    sourcePriors: { type: 'array' },
    freshness: { enum: ['historical', 'recent', 'live'] },
    focus: { enum: ['semantic', 'trust', 'multi-hop', 'factual', 'diagnostic', 'exploratory'] },
    hopBudget: { type: 'number' },
    trustMode: { enum: ['official-first', 'diverse', 'broad'] },
    querySeeds: { type: 'array' },
    evidenceTerms: { type: 'array' },
    sessionKey: { type: 'string' },
    semanticFrames: { type: 'array' },
    decomposedQuestions: { type: 'array' },
    ambiguities: { type: 'array' },
    nlu: { type: 'object' },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlannerDraft(value: unknown, provider: string): PlannerSynthesisDraft {
  if (!isRecord(value)) throw new Error('invalid-planner-draft:' + provider);
  if (typeof value.strategy !== 'string' || !Array.isArray(value.toolAffordances) || !Array.isArray(value.steps) || !isRecord(value.recoveryPolicy) || !isRecord(value.planner) || !isRecord(value.intentGraph)) {
    throw new Error('invalid-planner-draft:' + provider);
  }
  return value as PlannerSynthesisDraft;
}

function parseIntent(value: unknown, provider: string): SearchIntent {
  if (!isRecord(value)) throw new Error('invalid-planner-intent:' + provider);
  if (!isRecord(value.nlu)) throw new Error('invalid-planner-intent:' + provider);
  return value as SearchIntent;
}

export async function resolvePlannerIntent(objective: string, context: PlannerResolveContext = {}): Promise<SearchIntent> {
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    const raw = await provider.extract({
      objective: 'resolve the objective into a structured planner intent',
      context: {
        objective,
        plannerContext: context,
      },
      schema: PLANNER_INTENT_SCHEMA,
    });
    return parseIntent(raw, provider.name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RecoveryRequired({ phase: 'intent', provider: provider.name, objective, reason, at: Date.now() });
  }
}

function combineWarnings(a?: string[], b?: string[]): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const context = (input.context ?? {}) as PlannerResolveContext;
  const semanticIntent = await resolvePlannerIntent(input.objective, context);
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    const raw = await provider.extract({
      objective: 'synthesize an execution plan and intent graph',
      context: {
        objective: input.objective,
        taskId: input.id,
        semanticIntent,
        skillCatalog: context.skillCatalog ?? [],
        currentGraph: context.currentGraph ?? null,
        currentState: context.currentState ?? null,
        plannerContext: context,
      },
      schema: PLANNER_SYNTHESIS_SCHEMA,
    });
    const draft = parsePlannerDraft(raw, provider.name);
    return {
      taskId: input.id,
      objective: input.objective,
      steps: draft.steps,
      semanticIntent,
      intentGraph: draft.intentGraph,
      planner: {
        provider: draft.planner.provider,
        fallbackUsed: false,
        strategy: draft.planner.strategy,
        confidence: draft.planner.confidence,
        warnings: combineWarnings(draft.warnings, semanticIntent.nlu.warnings),
        semanticQuery: draft.planner.semanticQuery,
        decompositionCount: draft.planner.decompositionCount,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RecoveryRequired({ phase: 'plan', provider: provider.name, objective: input.objective, reason, at: Date.now() });
  }
}

export function createPlannerRuntimeState(plan: TaskPlan): PlannerRuntimeState {
  return {
    strategy: plan.planner?.strategy ?? 'blend',
    provider: plan.planner?.provider ?? plan.semanticIntent?.nlu.provider ?? 'llm-semantic-inference',
    fallbackUsed: plan.planner?.fallbackUsed ?? false,
    confidence: plan.planner?.confidence ?? plan.semanticIntent?.nlu.confidence ?? 0.5,
    currentNodeId: plan.steps[0]?.id ?? null,
    completedNodeIds: [],
    blockedNodeIds: [],
    notes: combineWarnings(plan.planner?.warnings, plan.intentGraph?.warnings),
  };
}

export function cloneIntentGraph(graph?: PlannerIntentGraph | null): PlannerIntentGraph | undefined {
  return graph ? (JSON.parse(JSON.stringify(graph)) as PlannerIntentGraph) : undefined;
}

export function markPlannerStepOutcome(graph: PlannerIntentGraph | undefined, stepId: string, status: PlannerIntentGraph['nodes'][number]['status'], note?: string): PlannerIntentGraph | undefined {
  if (!graph) return graph;
  const next = cloneIntentGraph(graph)!;
  const node = next.nodes.find((candidate) => candidate.id === stepId);
  if (node) {
    node.status = status;
    if (note) node.metadata = { ...node.metadata, note };
  }
  const anchorId = next.stateAnchorByStepId[stepId];
  if (anchorId) {
    const anchor = next.nodes.find((candidate) => candidate.id === anchorId);
    if (anchor) {
      anchor.status = status === 'failed' ? 'blocked' : 'done';
      if (note) anchor.metadata = { ...anchor.metadata, note };
    }
  }
  const completed = new Set(next.nodes.filter((candidate) => candidate.status === 'done').map((candidate) => candidate.id));
  next.frontier = next.stepOrder.filter((candidate) => !completed.has(candidate));
  return next;
}

export function updatePlannerRuntimeState(state: PlannerRuntimeState | undefined, plan: TaskPlan, stepId: string, status: PlannerIntentGraph['nodes'][number]['status'], note?: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? (JSON.parse(JSON.stringify(state)) as PlannerRuntimeState) : createPlannerRuntimeState(plan);
  next.currentNodeId = stepId;
  if (status === 'done') {
    if (!next.completedNodeIds.includes(stepId)) next.completedNodeIds.push(stepId);
  } else if (status === 'failed') {
    if (!next.blockedNodeIds.includes(stepId)) next.blockedNodeIds.push(stepId);
  }
  if (note) next.notes = combineWarnings(next.notes, [note]);
  return next;
}

export function notePlannerRecovery(state: PlannerRuntimeState | undefined, stepId: string, reason: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? (JSON.parse(JSON.stringify(state)) as PlannerRuntimeState) : {
    strategy: 'blend',
    provider: 'llm-semantic-inference',
    fallbackUsed: true,
    confidence: 0.5,
    currentNodeId: stepId,
    completedNodeIds: [],
    blockedNodeIds: [],
    notes: [],
  };
  next.currentNodeId = stepId;
  if (!next.blockedNodeIds.includes(stepId)) next.blockedNodeIds.push(stepId);
  next.lastRecovery = { stepId, reason, at: Date.now() };
  next.notes = combineWarnings(next.notes, ['recovery:' + reason]);
  return next;
}

export function deriveExecutionProfile(plan: TaskPlan): ExecutionProfile {
  const affordances = plan.intentGraph?.toolAffordances ?? [];
  const primarySource = plan.planner?.provider ?? plan.semanticIntent?.sourceHints[0] ?? affordances[0]?.skill ?? 'integration';
  const secondarySources = [...new Set([...(plan.semanticIntent?.sourceHints ?? []), ...affordances.slice(1).map((affordance) => affordance.skill)])].filter((source) => source !== primarySource);
  return {
    primarySource,
    secondarySources,
    parallelizable: affordances.length > 1 || plan.steps.length > 1,
    rationale: combineWarnings(plan.planner?.warnings, plan.intentGraph?.warnings).concat('model-synthesized'),
    strategy: plan.planner?.strategy,
    affordanceSignals: affordances.slice(0, 5).map((affordance) => ({
      skill: affordance.skill,
      score: affordance.score,
      bucket: affordance.domain,
      kind: affordance.selectedKind,
    })),
  };
}
