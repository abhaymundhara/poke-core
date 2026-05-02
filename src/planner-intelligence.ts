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
import { extractWithDefaultProviderSync, parseModelJson } from './llm-bridge';

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

const PLANNER_INTENT_SCHEMA = {
  type: 'object',
  required: ['objective', 'normalizedObjective', 'semanticQuery', 'entities', 'topics', 'constraints', 'sourceHints', 'sourcePriors', 'freshness', 'focus', 'hopBudget', 'trustMode', 'querySeeds', 'evidenceTerms', 'sessionKey', 'semanticFrames', 'decomposedQuestions', 'ambiguities', 'nlu'],
  properties: {
    objective: { type: 'string' },
    normalizedObjective: { type: 'string' },
    semanticQuery: { type: 'string' },
    entities: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array' },
    sourceHints: { type: 'array' },
    sourcePriors: { type: 'array' },
    freshness: { enum: ['historical', 'recent', 'live'] },
    focus: { enum: ['semantic', 'trust', 'multi-hop', 'factual', 'diagnostic', 'exploratory'] },
    hopBudget: { type: 'integer' },
    trustMode: { enum: ['official-first', 'diverse', 'broad'] },
    querySeeds: { type: 'array', items: { type: 'string' } },
    evidenceTerms: { type: 'array', items: { type: 'string' } },
    sessionKey: { type: 'string' },
    semanticFrames: { type: 'array' },
    decomposedQuestions: { type: 'array', items: { type: 'string' } },
    ambiguities: { type: 'array' },
    nlu: { type: 'object' },
  },
};

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
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const EXECUTION_PROFILE_SCHEMA = {
  type: 'object',
  required: ['primarySource', 'secondarySources', 'parallelizable', 'rationale'],
  properties: {
    primarySource: { type: 'string' },
    secondarySources: { type: 'array', items: { type: 'string' } },
    parallelizable: { type: 'boolean' },
    rationale: { type: 'array', items: { type: 'string' } },
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    affordanceSignals: { type: 'array' },
  },
};

async function runPlannerExtraction<T>(provider: SemanticNluProvider, objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): Promise<T> {
  const raw = await provider.extract({ objective, context, schema });
  return parseModelJson<T>(raw);
}

export async function resolvePlannerIntent(objective: string, context: PlannerResolveContext = {}): Promise<SearchIntent> {
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    return await runPlannerExtraction<SearchIntent>(provider, 'resolve the task objective into a planner intent', { objective, plannerContext: context }, PLANNER_INTENT_SCHEMA);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RecoveryRequired({ phase: 'intent', provider: provider.name, objective, reason, at: Date.now() });
  }
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const context = (input.context ?? {}) as PlannerResolveContext;
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    const semanticIntent = context.semanticIntent ?? await resolvePlannerIntent(input.objective, context);
    const draft = await runPlannerExtraction<PlannerSynthesisDraft>(provider, 'synthesize a task plan from the resolved intent and session context', { input, semanticIntent, currentGraph: context.currentGraph ?? null, currentState: context.currentState ?? null, skillCatalog: context.skillCatalog ?? [] }, PLANNER_SYNTHESIS_SCHEMA);
    return {
      taskId: input.id,
      objective: input.objective,
      steps: draft.steps,
      semanticIntent,
      intentGraph: draft.intentGraph,
      planner: draft.planner,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RecoveryRequired({ phase: 'plan', provider: provider.name, objective: input.objective, reason, at: Date.now() });
  }
}


const PLANNER_RUNTIME_STATE_SCHEMA = {
  type: 'object',
  required: ['strategy', 'provider', 'fallbackUsed', 'confidence', 'currentNodeId', 'completedNodeIds', 'blockedNodeIds', 'notes'],
  properties: {
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    provider: { type: 'string' },
    fallbackUsed: { type: 'boolean' },
    confidence: { type: 'number' },
    currentNodeId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    completedNodeIds: { type: 'array', items: { type: 'string' } },
    blockedNodeIds: { type: 'array', items: { type: 'string' } },
    lastRecovery: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        reason: { type: 'string' },
        at: { type: 'number' },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

const PLANNER_INTENT_GRAPH_SCHEMA = {
  type: 'object',
  required: ['id', 'objective', 'normalizedObjective', 'semanticQuery', 'strategy', 'semanticProvider', 'confidence', 'nodes', 'edges', 'frontier', 'stepOrder', 'stateAnchorByStepId', 'toolAffordances', 'recoveryPolicy', 'warnings'],
  properties: {
    id: { type: 'string' },
    objective: { type: 'string' },
    normalizedObjective: { type: 'string' },
    semanticQuery: { type: 'string' },
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    semanticProvider: { type: 'string' },
    confidence: { type: 'number' },
    nodes: { type: 'array' },
    edges: { type: 'array' },
    frontier: { type: 'array', items: { type: 'string' } },
    stepOrder: { type: 'array', items: { type: 'string' } },
    stateAnchorByStepId: { type: 'object' },
    toolAffordances: { type: 'array' },
    recoveryPolicy: { type: 'object' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

function runPlannerRuntimeExtraction<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

export function createPlannerRuntimeState(plan: TaskPlan): PlannerRuntimeState {
  return runPlannerRuntimeExtraction<PlannerRuntimeState>(
    'derive the initial planner runtime state for a task execution',
    { plan },
    PLANNER_RUNTIME_STATE_SCHEMA,
  );
}

export function markPlannerStepOutcome(
  graph: PlannerIntentGraph | undefined,
  plan: TaskPlan,
  stepId: string,
  status: PlannerIntentGraph['nodes'][number]['status'],
  note?: string,
): PlannerIntentGraph | undefined {
  if (!graph) return graph;
  return runPlannerRuntimeExtraction<PlannerIntentGraph>(
    'update the planner intent graph after a step outcome',
    { currentGraph: graph, plan, stepId, status, note: note ?? null },
    PLANNER_INTENT_GRAPH_SCHEMA,
  );
}

export function updatePlannerRuntimeState(
  state: PlannerRuntimeState | undefined,
  plan: TaskPlan,
  stepId: string,
  status: PlannerIntentGraph['nodes'][number]['status'],
  note?: string,
): PlannerRuntimeState {
  return runPlannerRuntimeExtraction<PlannerRuntimeState>(
    'update the planner runtime state after a step outcome',
    { currentState: state ?? null, plan, stepId, status, note: note ?? null },
    PLANNER_RUNTIME_STATE_SCHEMA,
  );
}

export function notePlannerRecovery(state: PlannerRuntimeState | undefined, plan: TaskPlan, stepId: string, reason: string): PlannerRuntimeState {
  return runPlannerRuntimeExtraction<PlannerRuntimeState>(
    'record planner recovery details in the planner runtime state',
    { currentState: state ?? null, plan, stepId, reason },
    PLANNER_RUNTIME_STATE_SCHEMA,
  );
}

export function deriveExecutionProfile(plan: TaskPlan): ExecutionProfile {
  return runPlannerRuntimeExtraction<ExecutionProfile>(
    'derive the execution profile for a completed task plan',
    { plan, semanticIntent: plan.semanticIntent ?? null, intentGraph: plan.intentGraph ?? null, planner: plan.planner ?? null },
    EXECUTION_PROFILE_SCHEMA,
  );
}
