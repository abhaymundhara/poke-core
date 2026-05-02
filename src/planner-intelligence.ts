import { randomUUID } from 'node:crypto';
import type { ExecutionProfile, PlanStep, PlannerIntentEdge, PlannerIntentGraph, PlannerIntentNode, PlannerPlanMetadata, PlannerRecoveryPolicy, PlannerRuntimeState, PlannerStrategy, PlannerToolAffordance, SkillDescriptor, StepKind, TaskInput, TaskPlan } from './types';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, understandSearchIntentWithNlu, type SemanticNluProvider } from './search/nlu';
import type { SearchIntent, SearchSource } from './search/types';
import { clamp, normalize, stableHash, uniq } from './search/utils';

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
  steps: Array<{
    id?: string;
    position?: number;
    kind: StepKind;
    title: string;
    skill: string;
    args: Record<string, unknown>;
    dependsOn?: string[];
    retryPolicy: { maxAttempts: number; retryableKinds: string[] };
    compensation?: { skill: string; args: Record<string, unknown> };
  }>;
  recoveryPolicy: PlannerRecoveryPolicy;
  planner: PlannerPlanMetadata;
  warnings?: string[];
};

export type PlannerRecoveryEvent = {
  phase: 'intent' | 'plan';
  provider: string;
  objective: string;
  reason: string;
  at: number;
};

export class PlannerRecoverySignal extends Error {
  readonly recoveryEvent: PlannerRecoveryEvent;

  constructor(event: PlannerRecoveryEvent) {
    super('planner-recovery:' + event.phase + ':' + event.provider + ':' + event.reason);
    this.name = 'PlannerRecoverySignal';
    this.recoveryEvent = event;
  }
}

const STEP_KIND_VALUES: StepKind[] = [
  'browser.navigate',
  'browser.extract',
  'integration.call',
  'verify',
  'autopilot.loop',
  'user-modeling',
  'grounding',
  'signal-observation',
  'computer-use.vision',
  'harness.readthread',
  'harness.draftreply',
  'harness.conflict_detection',
  'harness.relationship_recall',
  'harness.filesystem_scan',
];
const STEP_KIND_SET = new Set<StepKind>(STEP_KIND_VALUES);

const DEFAULT_SKILL_CATALOG: SkillDescriptor[] = [
  { name: 'browser', domain: 'web-navigation', capabilities: ['navigate', 'extract', 'verify'], version: '1.0.0' },
  { name: 'integration', domain: 'external-integrations', capabilities: ['inspect', 'comment', 'update', 'append', 'post_message', 'deploy'], version: '1.0.0' },
  { name: 'harness', domain: 'domain-primitives', capabilities: ['readthread', 'draftreply', 'conflict_detection', 'relationship_recall', 'filesystem_scan'], version: '1.0.0' },
  { name: 'autopilot', domain: 'cognitive-orchestration', capabilities: ['planning', 'delegation', 'checkpointing', 'proactivity'], version: '1.0.0' },
  { name: 'user-modeling', domain: 'user-context', capabilities: ['preference extraction', 'tone detection', 'profile shaping'], version: '1.0.0' },
  { name: 'grounding', domain: 'evidence-management', capabilities: ['claim tracing', 'evidence pairing', 'assumption tagging'], version: '1.0.0' },
  { name: 'signal-observation', domain: 'telemetry-analysis', capabilities: ['trend detection', 'anomaly detection', 'signal summarization'], version: '1.0.0' },
  { name: 'computer-use', domain: 'desktop-interaction', capabilities: ['ui action planning', 'surface selection', 'vision snapshots', 'coordinate clicks'], version: '1.0.0' },
];

const PLANNER_SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['strategy', 'toolAffordances', 'steps', 'recoveryPolicy', 'planner'],
  properties: {
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    toolAffordances: { type: 'array' },
    steps: { type: 'array' },
    recoveryPolicy: { type: 'object' },
    planner: { type: 'object' },
    warnings: { type: 'array' },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSearchIntent(value: unknown): SearchIntent | null {
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.semanticQuery !== 'string') return null;
  if (!Array.isArray(record.entities) || !Array.isArray(record.topics) || !Array.isArray(record.sourceHints) || !Array.isArray(record.sourcePriors) || !Array.isArray(record.decomposedQuestions) || !Array.isArray(record.ambiguities) || !Array.isArray(record.semanticFrames)) return null;
  if (!isRecord(record.nlu) || typeof record.nlu.provider !== 'string') return null;
  return record as SearchIntent;
}

function normalizeSkills(skillCatalog?: SkillDescriptor[] | null): SkillDescriptor[] {
  const list = Array.isArray(skillCatalog) && skillCatalog.length > 0 ? skillCatalog : DEFAULT_SKILL_CATALOG;
  return uniq(list.map((skill) => skill.name)).map((name) => list.find((skill) => skill.name === name)!).filter(Boolean);
}

function normalizeStepKind(kind: unknown): StepKind {
  if (typeof kind !== 'string' || !STEP_KIND_SET.has(kind as StepKind)) throw new Error('invalid-step-kind:' + String(kind));
  return kind as StepKind;
}

function normalizeAffordance(value: unknown, provider: string): PlannerToolAffordance {
  if (!isRecord(value) || typeof value.skill !== 'string' || typeof value.domain !== 'string' || !Array.isArray(value.capabilities) || typeof value.score !== 'number' || !Array.isArray(value.reasons) || typeof value.selectedKind !== 'string' || !Array.isArray(value.availableKinds)) {
    throw new Error('invalid-planner-affordance:' + provider);
  }
  const selectedKind = normalizeStepKind(value.selectedKind);
  const availableKinds = value.availableKinds.map(normalizeStepKind);
  return {
    skill: value.skill,
    domain: value.domain,
    capabilities: value.capabilities.map((entry) => String(entry)),
    score: clamp(value.score, 0, 1),
    reasons: value.reasons.map((entry) => String(entry)).filter((entry) => entry.length > 0),
    selectedKind,
    availableKinds,
  };
}

function normalizeRecoveryPolicy(value: unknown, provider: string): PlannerRecoveryPolicy {
  if (!isRecord(value) || typeof value.mode !== 'string' || typeof value.maxReplans !== 'number' || typeof value.maxAttemptsPerStep !== 'number' || !Array.isArray(value.blockedKinds) || !Array.isArray(value.fallbackSkills) || !Array.isArray(value.recoveryNotes)) {
    throw new Error('invalid-planner-recovery-policy:' + provider);
  }
  return {
    mode: value.mode as PlannerRecoveryPolicy['mode'],
    maxReplans: value.maxReplans,
    maxAttemptsPerStep: value.maxAttemptsPerStep,
    blockedKinds: value.blockedKinds.map(normalizeStepKind),
    fallbackSkills: value.fallbackSkills.map((entry) => String(entry)).filter((entry) => entry.length > 0),
    recoveryNotes: value.recoveryNotes.map((entry) => String(entry)).filter((entry) => entry.length > 0),
  };
}

function normalizePlannerMetadata(value: unknown, provider: string, intent: SearchIntent): PlannerPlanMetadata {
  if (!isRecord(value)) throw new Error('invalid-planner-metadata:' + provider);
  if (typeof value.provider !== 'string' || typeof value.strategy !== 'string' || typeof value.confidence !== 'number' || typeof value.fallbackUsed !== 'boolean' || !Array.isArray(value.warnings) || typeof value.semanticQuery !== 'string' || typeof value.decompositionCount !== 'number') {
    throw new Error('invalid-planner-metadata:' + provider);
  }
  return {
    provider: value.provider,
    fallbackUsed: value.fallbackUsed,
    strategy: value.strategy as PlannerStrategy,
    confidence: clamp(value.confidence, 0, 1),
    warnings: value.warnings.map((entry) => String(entry)).filter((entry) => entry.length > 0),
    semanticQuery: value.semanticQuery,
    decompositionCount: value.decompositionCount,
  };
}

function normalizeStep(value: unknown, index: number, provider: string, maxAttempts: number): PlanStep {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.title !== 'string' || typeof value.skill !== 'string' || !isRecord(value.args)) {
    throw new Error('invalid-planner-step:' + provider);
  }
  const retryPolicy = isRecord(value.retryPolicy) && typeof value.retryPolicy.maxAttempts === 'number' && Array.isArray(value.retryPolicy.retryableKinds)
    ? { maxAttempts: value.retryPolicy.maxAttempts, retryableKinds: value.retryPolicy.retryableKinds.map((entry) => String(entry)).filter((entry) => entry.length > 0) }
    : null;
  if (!retryPolicy) throw new Error('invalid-planner-step:' + provider);
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : randomUUID(),
    position: typeof value.position === 'number' ? value.position : index,
    kind: normalizeStepKind(value.kind),
    title: value.title,
    skill: value.skill,
    args: value.args,
    dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map((entry) => String(entry)).filter((entry) => entry.length > 0) : undefined,
    retryPolicy: {
      maxAttempts: Math.max(1, Math.min(maxAttempts, retryPolicy.maxAttempts)),
      retryableKinds: retryPolicy.retryableKinds,
    },
    compensation: isRecord(value.compensation) && typeof value.compensation.skill === 'string' && isRecord(value.compensation.args)
      ? { skill: value.compensation.skill, args: value.compensation.args }
      : undefined,
  };
}

function sourceBucketForSkill(skill: string, intent?: SearchIntent, context: PlannerResolveContext = {}): string {
  const lower = skill.toLowerCase();
  if (lower === 'browser' || lower === 'computer-use') return 'browser';
  if (lower === 'integration' || lower === 'autopilot') return 'integration';
  if (lower === 'user-modeling' || lower === 'grounding' || lower === 'signal-observation' || lower === 'harness') return 'memory';
  if (typeof context.provider === 'string') return String(context.provider);
  if (intent?.sourceHints.includes('email')) return 'email';
  if (intent?.sourceHints.includes('calendar')) return 'calendar';
  if (intent?.sourceHints.includes('filesystem')) return 'filesystem';
  return 'integration';
}

function buildIntentGraph(input: TaskInput, intent: SearchIntent, affordances: PlannerToolAffordance[], strategy: PlannerStrategy, context: PlannerResolveContext, steps: PlanStep[], recoveryPolicy: PlannerRecoveryPolicy): PlannerIntentGraph {
  const goalId = stableHash('goal:' + input.id + ':' + intent.semanticQuery);
  const stepOrder = steps.map((step) => step.id);
  const nodes: PlannerIntentNode[] = [
    { id: goalId, kind: 'goal', label: 'goal', summary: input.objective, status: 'active', confidence: intent.confidence, metadata: { semanticQuery: intent.semanticQuery, strategy } },
  ];
  const edges: PlannerIntentEdge[] = [];
  const stateAnchorByStepId: Record<string, string> = {};
  const frontier: string[] = [];
  const questionSeeds = uniq([...(intent.decomposedQuestions ?? []), intent.semanticQuery || input.objective]).slice(0, Math.max(2, Math.min(6, intent.hopBudget + 1)));

  for (const [index, question] of questionSeeds.entries()) {
    const questionId = stableHash('question:' + input.id + ':' + index + ':' + question);
    nodes.push({ id: questionId, kind: 'subgoal', label: 'subgoal-' + (index + 1), summary: question, status: index === 0 ? 'active' : 'pending', confidence: clamp(intent.confidence + 0.05 - index * 0.02), dependsOn: [goalId], metadata: { question, index, semanticQuery: intent.semanticQuery } });
    edges.push({ from: goalId, to: questionId, relation: 'decomposes-into', weight: clamp(0.72 - index * 0.08) });
  }

  for (const [index, affordance] of affordances.slice(0, Math.max(2, steps.length)).entries()) {
    nodes.push({ id: 'tool:' + affordance.skill + ':' + index, kind: 'tool', label: affordance.skill, summary: affordance.reasons.join('; '), status: 'pending', confidence: affordance.score, metadata: { skill: affordance.skill, selectedKind: affordance.selectedKind, capabilities: affordance.capabilities } });
  }

  for (const step of steps) {
    const stateNodeId = stableHash('state:' + step.id);
    stateAnchorByStepId[step.id] = stateNodeId;
    nodes.push({ id: step.id, kind: 'tool', label: step.skill + ':' + step.kind, summary: step.title, status: 'pending', stepId: step.id, dependsOn: step.dependsOn ?? [], confidence: 0.7, metadata: { args: step.args } });
    nodes.push({ id: stateNodeId, kind: 'state', label: 'checkpoint', summary: 'checkpoint after ' + step.title, status: 'pending', dependsOn: [step.id], confidence: 0.62, metadata: { afterStepId: step.id, stepTitle: step.title } });
    if (step.dependsOn && step.dependsOn.length > 0) {
      for (const dependency of step.dependsOn) edges.push({ from: dependency, to: step.id, relation: 'depends-on', weight: 0.82 });
    } else {
      edges.push({ from: goalId, to: step.id, relation: 'routes-to', weight: 0.82 });
    }
    edges.push({ from: step.id, to: stateNodeId, relation: 'tracks-state', weight: 0.78 });
    frontier.push(step.id);
  }

  const recoveryNodeId = stableHash('recovery:' + input.id + ':' + strategy);
  nodes.push({ id: recoveryNodeId, kind: 'recovery', label: 'recovery-policy', summary: recoveryPolicy.recoveryNotes.join(' | '), status: 'pending', confidence: clamp(0.6 + intent.confidence * 0.2), metadata: { policy: recoveryPolicy, strategy } });
  for (const stepId of stepOrder) edges.push({ from: stepId, to: recoveryNodeId, relation: 'recovers', weight: 0.3 });
  if (stepOrder.length > 0) {
    edges.push({ from: stepOrder.at(-1)!, to: recoveryNodeId, relation: 'confirms', weight: 0.45 });
    frontier.push(stepOrder.at(-1)!);
  }

  return {
    id: stableHash('planner-graph:' + input.id + ':' + intent.semanticQuery + ':' + strategy),
    objective: input.objective,
    normalizedObjective: normalize(input.objective),
    semanticQuery: intent.semanticQuery,
    strategy,
    semanticProvider: intent.nlu.provider,
    confidence: intent.confidence,
    nodes,
    edges,
    frontier: uniq(frontier),
    stepOrder,
    stateAnchorByStepId,
    toolAffordances: affordances,
    recoveryPolicy,
    warnings: uniq(intent.nlu.warnings ?? []),
  };
}

function buildPlannerDraft(input: TaskInput, intent: SearchIntent, context: PlannerResolveContext): PlannerSynthesisDraft {
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  const skills = normalizeSkills(context.skillCatalog);
  const promptContext = {
    ...context,
    semanticIntent: intent,
    skillCatalog: skills,
    availableSkills: skills.map((skill) => ({ name: skill.name, domain: skill.domain, capabilities: skill.capabilities, version: skill.version })),
    graphState: context.currentGraph ?? null,
    runtimeState: context.currentState ?? null,
  };
  const request = { objective: input.objective, context: promptContext, schema: PLANNER_SYNTHESIS_SCHEMA };
  return provider.extract(request).then((raw) => {
    if (!isRecord(raw)) throw new Error('invalid-planner-draft:' + provider.name);
    if (typeof raw.strategy !== 'string') throw new Error('invalid-planner-draft:' + provider.name);
    const strategy = raw.strategy as PlannerStrategy;
    const toolAffordances = Array.isArray(raw.toolAffordances) ? raw.toolAffordances.map((entry) => normalizeAffordance(entry, provider.name)) : null;
    const recoveryPolicy = raw.recoveryPolicy ? normalizeRecoveryPolicy(raw.recoveryPolicy, provider.name) : null;
    const planner = raw.planner ? normalizePlannerMetadata(raw.planner, provider.name, intent) : null;
    if (!toolAffordances || !recoveryPolicy || !planner || !Array.isArray(raw.steps)) throw new Error('invalid-planner-draft:' + provider.name);
    const steps = raw.steps.map((step, index) => normalizeStep(step, index, provider.name, recoveryPolicy.maxAttemptsPerStep));
    return {
      strategy,
      toolAffordances,
      steps,
      recoveryPolicy,
      planner,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [],
    };
  }).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PlannerRecoverySignal({ phase: 'plan', provider: provider.name, objective: input.objective, reason, at: Date.now() });
  });
}

export async function resolvePlannerIntent(objective: string, context: PlannerResolveContext = {}): Promise<SearchIntent> {
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    return await understandSearchIntentWithNlu(objective, context, provider, true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PlannerRecoverySignal({ phase: 'intent', provider: provider.name, objective, reason, at: Date.now() });
  }
}

export async function buildPlan(input: TaskInput): Promise<TaskPlan> {
  const context = (input.context ?? {}) as PlannerResolveContext;
  const semanticIntent = asSearchIntent(context.semanticIntent) ?? await resolvePlannerIntent(input.objective, context);
  const synthesized = await buildPlannerDraft(input, semanticIntent, { ...context, semanticIntent, skillCatalog: normalizeSkills(context.skillCatalog) });
  const steps = synthesized.steps.map((step, index) => ({ ...step, position: index }));
  const graph = buildIntentGraph(input, semanticIntent, synthesized.toolAffordances, synthesized.strategy, context, steps, synthesized.recoveryPolicy);
  return {
    taskId: input.id,
    objective: input.objective,
    steps,
    semanticIntent,
    intentGraph: graph,
    planner: {
      provider: synthesized.planner.provider,
      fallbackUsed: false,
      strategy: synthesized.planner.strategy,
      confidence: synthesized.planner.confidence,
      warnings: uniq([...(synthesized.warnings ?? []), ...(semanticIntent.nlu.warnings ?? [])]),
      semanticQuery: synthesized.planner.semanticQuery,
      decompositionCount: synthesized.planner.decompositionCount,
    },
  };
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
    notes: uniq([...(plan.planner?.warnings ?? []), ...(plan.intentGraph?.warnings ?? []), 'objective=' + plan.objective]),
  };
}

export function cloneIntentGraph(graph?: PlannerIntentGraph | null): PlannerIntentGraph | undefined {
  return graph ? JSON.parse(JSON.stringify(graph)) as PlannerIntentGraph : undefined;
}

export function markPlannerStepOutcome(graph: PlannerIntentGraph | undefined, stepId: string, status: PlannerIntentNode['status'], note?: string): PlannerIntentGraph | undefined {
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

export function updatePlannerRuntimeState(state: PlannerRuntimeState | undefined, plan: TaskPlan, stepId: string, status: PlannerIntentNode['status'], note?: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? JSON.parse(JSON.stringify(state)) as PlannerRuntimeState : createPlannerRuntimeState(plan);
  next.currentNodeId = stepId;
  if (status === 'done') {
    if (!next.completedNodeIds.includes(stepId)) next.completedNodeIds.push(stepId);
  } else if (status === 'failed') {
    if (!next.blockedNodeIds.includes(stepId)) next.blockedNodeIds.push(stepId);
  }
  if (note) next.notes = uniq([...next.notes, note]);
  return next;
}

export function notePlannerRecovery(state: PlannerRuntimeState | undefined, stepId: string, reason: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? JSON.parse(JSON.stringify(state)) as PlannerRuntimeState : {
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
  next.notes = uniq([...next.notes, 'recovery:' + reason]);
  return next;
}

export function deriveExecutionProfile(plan: TaskPlan): ExecutionProfile {
  const intent = plan.semanticIntent;
  const scores = new Map<string, number>([
    ['email', 0],
    ['calendar', 0],
    ['browser', 0],
    ['filesystem', 0],
    ['integration', 0],
    ['memory', 0],
  ]);
  const bump = (key: string, amount: number) => scores.set(key, (scores.get(key) ?? 0) + amount);
  const sourceHintBucket = (source: SearchSource | string): string => {
    if (source === 'web' || source === 'realtime-web') return 'browser';
    if (source === 'github' || source === 'integration' || source === 'slack' || source === 'vercel' || source === 'todoist' || source === 'linear' || source === 'notion') return 'integration';
    if (source === 'calendar') return 'calendar';
    if (source === 'email') return 'email';
    if (source === 'filesystem') return 'filesystem';
    return 'memory';
  };
  if (intent) {
    for (const hint of intent.sourceHints) bump(sourceHintBucket(hint), 4);
    if (intent.freshness === 'live') bump('browser', 2.5);
    if (intent.freshness === 'recent') bump('integration', 1);
    if (intent.focus === 'trust' || intent.focus === 'diagnostic') bump('memory', 1.5);
    if (intent.hopBudget > 2) bump('integration', 1.5);
  }
  for (const affordance of plan.intentGraph?.toolAffordances ?? []) bump(sourceBucketForSkill(affordance.skill, intent), 2 + affordance.score * 2.5);
  for (const step of plan.steps) bump(sourceBucketForSkill(step.skill, intent), 1.2);
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [primarySource = 'integration'] = ordered.map(([name]) => name);
  const secondarySources = ordered.map(([name]) => name).filter((name) => name !== primarySource && (scores.get(name) ?? 0) > 0);
  const parallelizable = plan.steps.length > 1 && primarySource !== 'calendar' && (intent?.hopBudget ?? 1) > 1;
  const rationale = [
    'strategy=' + (plan.planner?.strategy ?? 'blend'),
    'semantic=' + (intent?.semanticQuery ?? plan.objective),
    ...(intent?.decomposedQuestions ?? []).slice(0, 3).map((question) => 'question=' + question),
    ...ordered.filter(([, score]) => score > 0).slice(0, 4).map(([source, score]) => source + ':' + score.toFixed(2)),
  ];
  return {
    primarySource,
    secondarySources,
    parallelizable,
    rationale,
    strategy: plan.planner?.strategy,
    affordanceSignals: (plan.intentGraph?.toolAffordances ?? []).slice(0, 5).map((affordance) => ({ skill: affordance.skill, score: affordance.score, bucket: sourceBucketForSkill(affordance.skill, intent), kind: affordance.selectedKind })),
  };
}
