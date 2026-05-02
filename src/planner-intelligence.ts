import type {
  PlannerIntentGraph,
  PlannerPlanMetadata,
  PlannerRecoveryPolicy,
  PlannerStrategy,
  PlannerToolAffordance,
  SkillDescriptor,
  TaskInput,
  TaskPlan,
} from './types';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, type SemanticNluProvider } from './search/nlu';
import type { SearchIntent } from './search/types';
import { parseModelJson } from './llm-bridge';

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
  steps: TaskPlan['steps'];
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
