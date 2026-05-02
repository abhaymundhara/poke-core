export * from './planner-intelligence';
import { buildPlan as buildPlannerPlan, observePlannerTrajectory } from './planner-intelligence';
import type { PlannerIntentGraph, SearchIntent, TaskInput, TaskPlan } from './types';
import { stableHash, uniq } from './search/utils';

const TRAJECTORY_DIMENSIONS = 24;

type TrajectoryEntry = {
  label: string;
  vector: number[];
  weight: number;
  updatedAt: number;
};

type TrajectorySession = {
  key: string;
  centroid: number[];
  entries: TrajectoryEntry[];
  memory: string[];
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

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector.slice();
}

function blendVectors(base: number[], addition: number[], weight: number): number[] {
  const next = base.length === addition.length ? base.slice() : Array.from({ length: TRAJECTORY_DIMENSIONS }, (_, index) => base[index] ?? 0);
  for (let index = 0; index < next.length; index += 1) next[index] += (addition[index] ?? 0) * weight;
  return normalizeVector(next);
}

function projectText(text: string, dimensions = TRAJECTORY_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const seed = parseInt(stableHash(text).slice(0, 8), 16) || 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const slot = Math.abs((seed + code * 31 + index * 17) % dimensions);
    vector[slot] += ((code % 23) - 11) / 11;
  }
  return normalizeVector(vector);
}

function ensureSession(key: string): TrajectorySession {
  const existing = sessions.get(key);
  if (existing) return existing;
  const created: TrajectorySession = { key, centroid: Array.from({ length: TRAJECTORY_DIMENSIONS }, () => 0), entries: [], memory: [], lastUpdated: Date.now() };
  sessions.set(key, created);
  return created;
}

function observeLabel(session: TrajectorySession, label: string, text: string, weight = 1): void {
  if (!text.trim()) return;
  const vector = projectText(text);
  session.centroid = blendVectors(session.centroid, vector, weight);
  session.entries.push({ label, vector, weight, updatedAt: Date.now() });
  session.memory = uniq([...session.memory, label]);
  session.lastUpdated = Date.now();
}

export function observePlannerTrajectory(plan: TaskPlan): void {
  const sessionKey = plan.semanticIntent?.sessionKey ?? plan.taskId;
  const session = ensureSession(sessionKey);
  observeLabel(session, 'objective', plan.objective, 1.4);
  observeLabel(session, 'semanticQuery', plan.semanticIntent?.semanticQuery ?? plan.objective, 1.2);
  observeLabel(session, 'strategy', plan.planner?.strategy ?? 'blend', 0.9);
  observeLabel(session, 'confidence', String(plan.planner?.confidence ?? plan.semanticIntent?.nlu.confidence ?? 0.5), 0.6);

  for (const step of plan.steps) {
    observeLabel(session, step.title, [step.kind, step.skill, JSON.stringify(step.args), step.dependsOn?.join(',') ?? ''].join(' | '), 1.1);
  }

  for (const affordance of plan.intentGraph?.toolAffordances ?? []) {
    observeLabel(session, affordance.skill, [affordance.skill, affordance.domain, affordance.reasons.join(' | ')].join(' | '), 0.8 + affordance.score * 0.6);
  }

  for (const note of plan.planner?.warnings ?? []) observeLabel(session, note, note, 0.7);
  for (const note of plan.intentGraph?.warnings ?? []) observeLabel(session, note, note, 0.7);
  for (const node of plan.intentGraph?.nodes ?? []) observeLabel(session, node.label, [node.summary, node.kind, JSON.stringify(node.metadata ?? {})].join(' | '), 0.9);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  const scale = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return scale > 0 ? dot / scale : 0;
}

export function inferLatentGoalsFromTrajectory(input: PlannerTrajectoryProbe): string[] {
  const session = ensureSession(input.sessionKey);
  const probeText = [
    input.objective,
    input.query,
    input.semanticIntent?.semanticQuery ?? '',
    ...(input.eventJournal ?? []).map((entry) => [entry.kind, entry.status, entry.reason, JSON.stringify(entry.detail ?? {})].filter(Boolean).join(' | ')),
    ...(input.breadcrumbs ?? []).map((crumb) => [crumb.kind, crumb.skill, crumb.status].join(' | ')),
    ...(input.intentGraph?.nodes ?? []).map((node) => [node.label, node.summary, node.kind].join(' | ')),
  ].filter(Boolean).join('
');
  const probeVector = projectText(probeText);

  const candidates = uniq([
    ...session.memory,
    ...session.entries.map((entry) => entry.label),
    input.semanticIntent?.semanticQuery ?? input.objective,
    ...(input.intentGraph?.nodes ?? []).slice(0, 6).map((node) => node.summary || node.label),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0));

  const ranked = candidates.map((label) => {
    const known = session.entries.find((entry) => entry.label === label);
    const vector = known?.vector ?? projectText(label);
    const recencyBoost = known ? Math.min(0.2, (Date.now() - known.updatedAt) / 1000000000) : 0;
    return { label, score: cosineSimilarity(probeVector, vector) + recencyBoost };
  }).sort((left, right) => right.score - left.score);

  return ranked.slice(0, Math.max(3, Math.min(6, ranked.length))).map((entry) => entry.label);
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const plan = await buildPlannerPlan(input);
  observePlannerTrajectory(plan);
  return plan;
}
