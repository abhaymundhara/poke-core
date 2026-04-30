export type TaskStatus = 'draft' | 'planning' | 'routing' | 'executing' | 'verifying' | 'completed' | 'failed' | 'rolled_back';
export type StepKind = 'browser.navigate' | 'browser.extract' | 'integration.call' | 'verify';
export type TransitionKind = 'plan' | 'route' | 'execute' | 'verify' | 'complete' | 'fail' | 'rollback';

export type TaskInput = {
  id: string;
  objective: string;
  context?: Record<string, unknown>;
};

export type PlanStep = {
  id: string;
  kind: StepKind;
  title: string;
  skill: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
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
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ExecutionRecord = {
  executionId: string;
  taskId: string;
  stepId: string;
  skill: string;
  kind: StepKind;
  inputJson: string;
  outputJson: string;
  passed: number;
  note: string | null;
  createdAt: number;
};

export type SnapshotRecord = {
  snapshotId: string;
  taskId: string;
  status: TaskStatus;
  stateJson: string;
  createdAt: number;
};

export type JuryDecision = {
  ok: boolean;
  score: number;
  reasons: string[];
};
