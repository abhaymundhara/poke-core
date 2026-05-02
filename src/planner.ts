export * from './planner-intelligence';
import { buildPlan as buildPlannerPlan } from './planner-intelligence';
import type { PlannerIntentGraph, SearchIntent, TaskInput, TaskPlan } from './types';

type TrajectoryEntry = {
  label: string;
  history: string[];
  weight: number;
  updatedAt: number;
};

type TrajectorySession = {
  key: string;
  history: string[];
  entries: Map<string, TrajectoryEntry>;
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
  const created: TrajectorySession = { key, history: [], entries: new Map(), lastUpdated: Date.now() };
  sessions.set(key, created);
  return created;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length > 3);
}

function observeText(session: TrajectorySession, text: string, weight = 1): void {
  const tokens = tokenize(text);
  if (tokens.length === 0) return;
  session.history.push(text);
  for (const token of tokens) {
    const current = session.entries.get(token);
    session.entries.set(token, {
      label: token,
      history: [...(current?.history ?? []), text],
      weight: (current?.weight ?? 0.2) * 0.82 + weight * 0.18,
      updatedAt: Date.now(),
    });
  }
  session.lastUpdated = Date.now();
}

function relevanceScore(label: string, probe: PlannerTrajectoryProbe, session: TrajectorySession): number {
  const probeText = [
    probe.objective,
    probe.query,
    probe.semanticIntent?.semanticQuery ?? '',
    ...(probe.eventJournal ?? []).map((entry) => [entry.kind, entry.status, entry.reason, JSON.stringify(entry.detail ?? {})].filter(Boolean).join(' | ')),
    ...(probe.breadcrumbs ?? []).map((crumb) => [crumb.kind, crumb.skill, crumb.status].join(' | ')),
    ...(probe.intentGraph?.nodes ?? []).map((node) => [node.label, node.summary, node.kind].join(' | ')),
  ].filter(Boolean).join(' ');
  const labelTokens = tokenize(label);
  const probeTokens = new Set(tokenize(probeText));
  const overlap = labelTokens.filter((token) => probeTokens.has(token)).length;
  const remembered = session.entries.get(label);
  const recency = remembered ? Math.max(0.1, 1 - Math.min(0.8, (Date.now() - remembered.updatedAt) / 12_000_000)) : 0.15;
  const historyHits = session.history.slice(-24).filter((entry) => tokenize(entry).some((token) => labelTokens.includes(token))).length;
  return (remembered?.weight ?? 0.25) * 0.4 + overlap * 0.2 + historyHits * 0.08 + recency;
}

export class LatentGoalTracker {
  observe(input: PlannerTrajectoryProbe): void {
    const session = ensureSession(input.sessionKey);
    observeText(session, input.objective, 1.4);
    observeText(session, input.query, 1.2);
    observeText(session, input.semanticIntent?.semanticQuery ?? '', 1.1);
    for (const entry of input.eventJournal ?? []) observeText(session, [entry.kind, entry.status, entry.reason, JSON.stringify(entry.detail ?? {})].filter(Boolean).join(' | '), 0.9);
    for (const crumb of input.breadcrumbs ?? []) observeText(session, [crumb.kind, crumb.skill, crumb.status].join(' | '), 0.8);
    for (const node of input.intentGraph?.nodes ?? []) observeText(session, [node.label, node.summary, node.kind].join(' | '), 0.75);
  }

  infer(input: PlannerTrajectoryProbe): string[] {
    const session = ensureSession(input.sessionKey);
    const candidates = new Set<string>();
    for (const value of [
      input.objective,
      input.query,
      input.semanticIntent?.semanticQuery ?? '',
      ...(input.intentGraph?.nodes ?? []).slice(0, 6).map((node) => node.summary || node.label),
      ...(input.eventJournal ?? []).slice(0, 8).map((entry) => entry.reason ?? entry.kind ?? ''),
      ...(input.breadcrumbs ?? []).slice(0, 8).map((crumb) => crumb.kind),
      ...session.history.slice(-32),
    ]) {
      for (const token of tokenize(String(value))) candidates.add(token);
    }
    return [...candidates]
      .map((label) => ({ label, score: relevanceScore(label, input, session) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((entry) => entry.label);
  }
}

const tracker = new LatentGoalTracker();

export function observePlannerTrajectory(plan: TaskPlan): void {
  tracker.observe({
    sessionKey: plan.semanticIntent?.sessionKey ?? plan.taskId,
    objective: plan.objective,
    query: plan.semanticIntent?.semanticQuery ?? plan.objective,
    intentGraph: plan.intentGraph,
    semanticIntent: plan.semanticIntent,
    breadcrumbs: plan.steps.map((step) => ({ stepId: step.id, kind: step.kind, skill: step.skill, status: 'done' as const })),
  });
}

export function inferLatentGoalsFromTrajectory(input: PlannerTrajectoryProbe): string[] {
  tracker.observe(input);
  return tracker.infer(input);
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const plan = await buildPlannerPlan(input);
  observePlannerTrajectory(plan);
  return plan;
}
