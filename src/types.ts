import type { SearchIntent } from './search/types';
import type { IdentityResolution, IdentityResolutionSignal } from './identity/types.ts';
export type TaskStatus = 'draft' | 'planning' | 'routing' | 'executing' | 'recovering' | 'completed' | 'failed' | 'rolled_back';
export type StepKind = 'browser.navigate' | 'browser.extract' | 'integration.call' | 'verify' | 'autopilot.loop' | 'user-modeling' | 'grounding' | 'signal-observation' | 'computer-use.vision' | 'harness.readthread' | 'harness.draftreply' | 'harness.conflict_detection' | 'harness.relationship_recall' | 'harness.filesystem_scan' | 'channel.send' | 'channel.thread' | 'channel.metadata' | 'connection.list' | 'connection.request' | 'connection.rotate' | 'connection.refresh' | 'connection.delete' | 'events.history' | 'events.queue' | 'events.replay' | 'events.enqueue' | 'events.claim' | 'events.complete' | 'events.fail';
export type TransitionKind = 'plan' | 'route' | 'execute' | 'validate' | 'recover' | 'complete' | 'fail' | 'rollback';

export type TaskInput = {
  id: string;
  objective: string;
  context?: Record<string, unknown>;
};

export type StepRetryPolicy = {
  maxAttempts: number;
  retryableKinds: string[];
};

export type PlanStep = {
  id: string;
  position: number;
  kind: StepKind;
  title: string;
  skill: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
  retryPolicy: StepRetryPolicy;
  compensation?: {
    skill: string;
    args: Record<string, unknown>;
  };
};

export type TaskPlan = {
  taskId: string;
  objective: string;
  steps: PlanStep[];
  semanticIntent?: SearchIntent;
  intentGraph?: PlannerIntentGraph;
  planner?: PlannerPlanMetadata;
};

export type TaskRecord = {
  taskId: string;
  objective: string;
  status: TaskStatus;
  currentStepIndex: number;
  activeStepId: string | null;
  revision: number;
  resultJson: string | null;
  errorJson: string | null;
  leaseToken: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskSnapshot = {
  snapshotId: string;
  taskId: string;
  status: TaskStatus;
  stateJson: string;
  createdAt: number;
};

export type ExecutionEvent = {
  eventId: string;
  taskId: string;
  transitionKind: TransitionKind;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  detailJson: string;
  createdAt: number;
};

export type StepAttempt = {
  attemptId: string;
  taskId: string;
  stepId: string;
  attemptIndex: number;
  status: 'started' | 'succeeded' | 'failed' | 'compensated';
  skill: string;
  inputJson: string;
  outputJson: string | null;
  errorJson: string | null;
  startedAt: number;
  endedAt: number | null;
};

export type ValidationDecision = {
  ok: boolean;
  score: number;
  reasons: string[];
};

export type SkillResult = {
  ok: boolean;
  output: unknown;
  retryable: boolean;
  note?: string;
  trace?: Record<string, unknown>;
};

export type TimeProvider = {
  now: () => number;
  nowNs?: () => bigint;
  iso: () => string;
  advance?: (ms: number) => number;
  origin?: number;
  label?: string;
};

export type ContextWindowSource = 'objective' | 'identity' | 'step' | 'plan' | 'state' | 'memory' | 'episodic' | 'event' | 'observation' | 'system';

export type ContextWindowSegment = {
  id: string;
  source: ContextWindowSource;
  title: string;
  text: string;
  priority: number;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
};

export type ContextWindowSummary = {
  budget: number;
  usedTokens: number;
  overflowTokens: number;
  selected: ContextWindowSegment[];
  compacted: ContextWindowSegment[];
  summary: string;
};

export type ThreadIdentityResolution = {
  query: string;
  identityId: string;
  label: string;
  confidence: number;
  matchedBy: IdentityResolutionSignal | 'synthetic';
  source: 'graph' | 'synthetic';
  resolution: IdentityResolution;
  signals: string[];
  aliases: string[];
  anchor: string;
};

export type PlannerLoopObservation = {
  stepId: string;
  stepKind: StepKind;
  outcome: 'completed' | 'failed' | 'blocked' | 'replanned' | 'compensated';
  note?: string;
  summary: string;
  confidence?: number;
  evidence: string[];
  result?: unknown;
  at: number;
};

export type PlannerLoopReflection = {
  cycle: number;
  summary: string;
  shouldReplan: boolean;
  reasons: string[];
  nextQuestions: string[];
  at: number;
};

export type PlannerLoopState = {
  planId: string;
  objective: string;
  cycle: number;
  status: 'planning' | 'executing' | 'reflecting' | 'replanning' | 'done' | 'blocked';
  observations: PlannerLoopObservation[];
  reflections: PlannerLoopReflection[];
  lastObservedAt: number;
  lastReflectedAt: number;
  threadIdentity?: ThreadIdentityResolution | null;
};

export type ExecutionContext = {
  taskId: string;
  task: TaskRecord;
  plan: TaskPlan;
  step: PlanStep;
  state: RuntimeState;
  contextWindow?: ContextWindowSummary | null;
  threadIdentity?: ThreadIdentityResolution | null;
  plannerLoop?: PlannerLoopState | null;
  clock?: TimeProvider;
};

export type SkillDescriptor = {
  name: string;
  domain: string;
  capabilities: string[];
  version: string;
};

export type ExecutionProfile = {
  primarySource: string;
  secondarySources: string[];
  parallelizable: boolean;
  rationale: string[];
  strategy?: PlannerStrategy;
  affordanceSignals?: Array<{ skill: string; score: number; bucket: string; kind: StepKind }>;
};

export type PlannerStrategy = 'semantic-first' | 'trust-first' | 'multi-hop' | 'freshness-first' | 'blend';
export type PlannerRecoveryMode = 'retry' | 'replan' | 'compensate' | 'escalate';

export type PlannerToolAffordance = {
  skill: string;
  domain: string;
  capabilities: string[];
  score: number;
  reasons: string[];
  selectedKind: StepKind;
  availableKinds: StepKind[];
};

export type PlannerIntentNode = {
  id: string;
  kind: 'goal' | 'subgoal' | 'tool' | 'checkpoint' | 'state' | 'recovery' | 'ambiguity';
  label: string;
  summary: string;
  status: 'pending' | 'active' | 'done' | 'blocked' | 'failed';
  stepId?: string;
  dependsOn?: string[];
  confidence: number;
  metadata: Record<string, unknown>;
};

export type PlannerIntentEdge = {
  from: string;
  to: string;
  relation: 'decomposes-into' | 'depends-on' | 'routes-to' | 'supports' | 'tracks-state' | 'confirms' | 'recovers' | 'blocks';
  weight: number;
};

export type PlannerRecoveryPolicy = {
  mode: PlannerRecoveryMode;
  maxReplans: number;
  maxAttemptsPerStep: number;
  blockedKinds: StepKind[];
  fallbackSkills: string[];
  recoveryNotes: string[];
};

export type PlannerIntentGraph = {
  id: string;
  objective: string;
  normalizedObjective: string;
  semanticQuery: string;
  strategy: PlannerStrategy;
  semanticProvider: string;
  confidence: number;
  nodes: PlannerIntentNode[];
  edges: PlannerIntentEdge[];
  frontier: string[];
  stepOrder: string[];
  stateAnchorByStepId: Record<string, string>;
  toolAffordances: PlannerToolAffordance[];
  recoveryPolicy: PlannerRecoveryPolicy;
  warnings: string[];
};

export type PlannerPlanMetadata = {
  provider: string;
  fallbackUsed: boolean;
  strategy: PlannerStrategy;
  confidence: number;
  warnings: string[];
  semanticQuery: string;
  decompositionCount: number;
};

export type PlannerRuntimeState = {
  strategy: PlannerStrategy;
  provider: string;
  fallbackUsed: boolean;
  confidence: number;
  currentNodeId: string | null;
  completedNodeIds: string[];
  blockedNodeIds: string[];
  lastRecovery?: { stepId: string; reason: string; at: number };
  notes: string[];
};

export type RuntimeState = {
  objective: string;
  cursor: number;
  attempts: Record<string, number>;
  outputs: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  breadcrumbs: Array<{ stepId: string; kind: StepKind; skill: string; status: 'done' | 'failed' | 'compensated' }>;
  recovery: Array<{ stepId: string; reason: string; at: number }>;
  executionProfile?: ExecutionProfile;
  semanticIntent?: SearchIntent;
  intentGraph?: PlannerIntentGraph;
  planner?: PlannerRuntimeState;
  threadIdentity?: ThreadIdentityResolution | null;
  contextWindow?: ContextWindowSummary | null;
  plannerLoop?: PlannerLoopState | null;
};

