export * from './planner-intelligence';
import { buildPlan as buildPlannerPlan } from './planner-intelligence';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, type SemanticNluProvider } from './search/nlu';
import type { PlannerIntentGraph, SearchIntent, TaskInput, TaskPlan } from './types';

type TrajectorySession = {
  key: string;
  history: string[];
  lastUpdated: number;
};

export type PlannerTrajectoryProbe = {
  sessionKey: string;
  objective: string;
  query: string;
  eventJournal?: Array<{ stepId?: string; kind?: string; status?: string; reason?: string; at?: number; detail?: unknown }>;
  breadcrumbs?: Array<{ stepId: string; kind: string; skill: string; status: 'done' | 'failed' | 'compensated' }>;
  intentGraph?: PlannerIntentGraph;
  semanticIntent?: SearchIntent;
};

const sessions = new Map<string, TrajectorySession>();

function ensureSession(key: string): TrajectorySession {
  const existing = sessions.get(key);
  if (existing) return existing;
  const created: TrajectorySession = { key, history: [], lastUpdated: Date.now() };
  sessions.set(key, created);
  return created;
}

function snapshotProbe(input: PlannerTrajectoryProbe): Record<string, unknown> {
  return {
    sessionKey: input.sessionKey,
    objective: input.objective,
    query: input.query,
    eventJournal: input.eventJournal ?? [],
    breadcrumbs: input.breadcrumbs ?? [],
    intentGraph: input.intentGraph ?? null,
    semanticIntent: input.semanticIntent ?? null,
  };
}

function appendHistory(session: TrajectorySession, entry: Record<string, unknown>): void {
  session.history.push(JSON.stringify(entry));
  session.lastUpdated = Date.now();
}

function parseLatentGoals(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.latentGoals) ? record.latentGoals : Array.isArray(record.goals) ? record.goals : [];
  return raw.map((entry) => String(entry)).filter((entry) => entry.length > 0);
}

export class LatentGoalTracker {
  constructor(private provider: SemanticNluProvider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER) {}

  observe(input: PlannerTrajectoryProbe): void {
    const session = ensureSession(input.sessionKey);
    appendHistory(session, { type: 'observation', observedAt: Date.now(), ...snapshotProbe(input) });
  }

  async infer(input: PlannerTrajectoryProbe): Promise<string[]> {
    const session = ensureSession(input.sessionKey);
    const raw = await this.provider.extract({
      objective: 'infer latent goals from accumulated session history',
      context: {
        sessionKey: input.sessionKey,
        objective: input.objective,
        query: input.query,
        history: session.history,
        latest: snapshotProbe(input),
      },
      schema: {
        type: 'object',
        required: ['latentGoals'],
        properties: {
          latentGoals: { type: 'array', items: { type: 'string' } },
          goals: { type: 'array', items: { type: 'string' } },
          trajectorySummary: { type: 'string' },
          confidence: { type: 'number' },
          rationale: { type: 'array', items: { type: 'string' } },
        },
      },
    });
    return parseLatentGoals(raw);
  }
}

const tracker = new LatentGoalTracker();

export async function observePlannerTrajectory(plan: TaskPlan): Promise<void> {
  tracker.observe({
    sessionKey: plan.semanticIntent?.sessionKey ?? plan.taskId,
    objective: plan.objective,
    query: plan.semanticIntent?.semanticQuery ?? plan.objective,
    intentGraph: plan.intentGraph,
    semanticIntent: plan.semanticIntent,
    breadcrumbs: plan.steps.map((step) => ({ stepId: step.id, kind: step.kind, skill: step.skill, status: 'done' as const })),
  });
}

export async function inferLatentGoalsFromTrajectory(input: PlannerTrajectoryProbe): Promise<string[]> {
  tracker.observe(input);
  return await tracker.infer(input);
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const plan = await buildPlannerPlan(input);
  await observePlannerTrajectory(plan);
  return plan;
}
