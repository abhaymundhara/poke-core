export type TaskStatus = 'draft' | 'planning' | 'routing' | 'executing' | 'recovering' | 'completed' | 'failed' | 'rolled_back';
export type StepKind = 'browser.navigate' | 'browser.extract' | 'integration.call' | 'verify' | 'autopilot' | 'user-modeling' | 'grounding' | 'signal-observation' | 'computer-use';
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

export type ExecutionContext = {
  taskId: string;
  task: TaskRecord;
  plan: TaskPlan;
  step: PlanStep;
  state: RuntimeState;
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
};