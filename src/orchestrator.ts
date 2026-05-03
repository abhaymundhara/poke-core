import { randomUUID } from 'node:crypto';
import { buildPlan } from './planner';
import { classifyTransition } from './state-machine';
import { validatePlan } from './validator';
import { EpisodicMemory } from './memory/episodic-memory';
import { WorkingMemory } from './memory/working-memory';
import { RagCorpus } from './rag/retriever';
import { listSkillPlaybooks } from './skill-playbooks';
import type { ExecutionProfile, ExecutionContext, PlanStep, RuntimeState, SkillResult, TaskInput, TaskPlan, TaskRecord, TaskStatus } from './types';
import type { PokeCoreStore } from './store';
import type { SkillAdapter } from './skills/types';

export type TaskExecutionResult = {
  ok?: boolean;
  status?: TaskStatus;
  taskId: string;
  plan?: TaskPlan;
  state?: RuntimeState;
  error?: string | null;
  note?: string | null;
  rationale?: string[];
  executionProfile?: ExecutionProfile;
};

type StepControl =
  | { kind: 'continue'; note?: string }
  | { kind: 'halt'; status: TaskStatus; note: string }
  | { kind: 'replan'; note: string }
  | { kind: 'complete'; note?: string };

type FailureContext = {
  message: string;
  code?: string;
  retryable?: boolean;
  kind: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) payload.stack = error.stack;
    for (const [key, value] of Object.entries(error as Record<string, unknown>)) {
      if (!(key in payload)) payload[key] = value;
    }
    return payload;
  }
  return { message: String(error) };
}

function classifyFailure(message: string): string {
  const lower = message.toLowerCase();
  if (/(timeout|timed out|deadline exceeded)/.test(lower)) return 'timeout';
  if (/(rate limit|too many requests|429)/.test(lower)) return 'rate_limit';
  if (/(network|econn|socket|fetch failed|connection reset|connection refused)/.test(lower)) return 'network';
  if (/(permission|unauthorized|forbidden|auth|credentials)/.test(lower)) return 'permission';
  if (/(not found|missing|does not exist)/.test(lower)) return 'not_found';
  if (/(invalid|validation|schema|parse|malformed)/.test(lower)) return 'validation';
  if (/(detached|stale|closed|target closed|navigation)/.test(lower)) return 'transient';
  return 'unknown';
}

function buildExecutionProfile(plan: TaskPlan): ExecutionProfile {
  const strategy = plan.planner?.strategy ?? 'blend';
  return {
    primarySource: plan.planner?.provider ?? plan.semanticIntent?.nlu.provider ?? 'planner',
    secondarySources: plan.planner?.warnings?.length ? ['validator'] : [],
    parallelizable: false,
    rationale: [
      `strategy:${strategy}`,
      plan.planner?.fallbackUsed ? 'planner fallback used' : 'planner primary route used',
      ...(plan.planner?.warnings ?? []),
    ],
    strategy,
    affordanceSignals: plan.intentGraph?.toolAffordances?.map((affordance) => ({
      skill: affordance.skill,
      score: affordance.score,
      bucket: affordance.domain,
      kind: affordance.selectedKind,
    })),
  };
}

function buildRuntimeState(plan: TaskPlan): RuntimeState {
  return {
    objective: plan.objective,
    cursor: 0,
    attempts: {},
    outputs: {},
    artifacts: {},
    breadcrumbs: [],
    recovery: [],
    executionProfile: buildExecutionProfile(plan),
    semanticIntent: plan.semanticIntent,
    intentGraph: plan.intentGraph,
    planner: plan.planner
      ? {
          strategy: plan.planner.strategy,
          provider: plan.planner.provider,
          fallbackUsed: plan.planner.fallbackUsed,
          confidence: plan.planner.confidence,
          currentNodeId: plan.intentGraph?.frontier?.[0] ?? null,
          completedNodeIds: [],
          blockedNodeIds: [],
          notes: [...(plan.planner.warnings ?? [])],
        }
      : undefined,
  };
}

function buildTaskContext(input: TaskInput, plan: TaskPlan, state: RuntimeState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(input.context ?? {}),
    taskId: input.id,
    objective: input.objective,
    currentPlan: plan,
    runtimeState: state,
    workingMemory: extra.workingMemory ?? null,
    episodicMemory: extra.episodicMemory ?? null,
    currentStep: extra.currentStep ?? null,
    lastObservation: extra.lastObservation ?? null,
  };
}

function normalizeSkillName(step: PlanStep): string {
  if (asString(step.skill)) return asString(step.skill);
  return step.kind.split('.')[0] ?? '';
}

function stepInputSummary(plan: TaskPlan, state: RuntimeState, step: PlanStep, attemptIndex: number): Record<string, unknown> {
  return {
    taskId: plan.taskId,
    stepId: step.id,
    stepKind: step.kind,
    stepSkill: step.skill,
    stepTitle: step.title,
    attemptIndex,
    cursor: state.cursor,
    completedSteps: state.breadcrumbs.filter((entry) => entry.status === 'done' || entry.status === 'compensated').map((entry) => entry.stepId),
    outputKeys: Object.keys(state.outputs),
  };
}

function summarizeSkillResult(result: SkillResult): string {
  if (result.note) return result.note;
  if (typeof result.output === 'string') return result.output.slice(0, 240);
  if (isRecord(result.output) && asString(result.output.message)) return asString(result.output.message);
  return result.ok ? 'step completed' : 'step failed';
}

function nextActionFromOutput(output: unknown): string {
  if (!isRecord(output)) return '';
  return asString(output.nextAction || output.action || output.decision);
}

function observationDecision(step: PlanStep, result: SkillResult): StepControl {
  const output = result.output;
  const outputRecord = isRecord(output) ? output : null;
  const nextAction = nextActionFromOutput(output);
  const confidence = outputRecord ? asNumber(outputRecord.confidence) : undefined;
  const needsReplan = outputRecord ? Boolean(outputRecord.needsReplan || outputRecord.replan || outputRecord.shouldReplan) : false;
  const shouldHalt = outputRecord ? Boolean(outputRecord.halt || outputRecord.stop || outputRecord.blocked) : false;
  const shouldComplete = outputRecord ? Boolean(outputRecord.complete || outputRecord.finished) : false;

  if (nextAction === 'retry') return { kind: 'replan', note: `step ${step.id} requested retry` };
  if (nextAction === 'clarify' || nextAction === 'confirm') return { kind: 'halt', status: 'routing', note: `step ${step.id} needs clarification` };
  if (needsReplan) return { kind: 'replan', note: `step ${step.id} requested replan` };
  if (shouldHalt) return { kind: 'halt', status: 'routing', note: `step ${step.id} requested halt` };
  if (shouldComplete && step.position >= 0) return { kind: 'complete', note: `step ${step.id} marked the task complete` };

  if (confidence !== undefined && confidence < 0.55 && (step.kind === 'verify' || step.kind === 'browser.extract' || step.kind === 'grounding' || step.kind === 'signal-observation')) {
    return { kind: 'replan', note: `step ${step.id} confidence ${confidence.toFixed(2)} is too low` };
  }

  return { kind: 'continue' };
}

function dependencyCheck(step: PlanStep, state: RuntimeState): string[] {
  const completed = new Set(state.breadcrumbs.filter((entry) => entry.status === 'done' || entry.status === 'compensated').map((entry) => entry.stepId));
  return (step.dependsOn ?? []).filter((dependency) => !completed.has(dependency));
}

export class PokeCoreOrchestrator {
  private readonly skills: SkillAdapter[];
  private rag = new RagCorpus();
  private working = new WorkingMemory();
  private episodic = new EpisodicMemory();

  constructor(private readonly _store: PokeCoreStore, skills: SkillAdapter[]) {
    this.skills = skills.slice();
  }

  get skillCatalog() {
    return this.skills.map((skill) => skill.descriptor);
  }

  get skillPlaybooks() {
    return listSkillPlaybooks();
  }

  get ragCorpus() {
    return this.rag;
  }

  get workingMemory() {
    return this.working;
  }

  get episodicMemory() {
    return this.episodic;
  }

  private resolveSkill(step: PlanStep): SkillAdapter | null {
    const normalized = normalizeSkillName(step);
    return (
      this.skills.find((skill) => skill.descriptor.name === normalized || skill.descriptor.name === step.skill) ??
      this.skills.find((skill) => skill.canHandle(step)) ??
      this.skills.find((skill) => skill.descriptor.name === step.kind.split('.')[0]) ??
      null
    );
  }

  private createExecutionContext(task: TaskRecord, plan: TaskPlan, step: PlanStep, state: RuntimeState): ExecutionContext {
    return {
      taskId: task.taskId,
      task,
      plan,
      step,
      state,
    };
  }

  private async runStep(
    task: TaskRecord,
    plan: TaskPlan,
    state: RuntimeState,
    step: PlanStep,
    decisionLog: string[],
  ): Promise<{ control: StepControl; task: TaskRecord }> {
    const adapter = this.resolveSkill(step);
    if (!adapter) {
      return {
        control: { kind: 'halt', status: 'failed', note: `no skill registered for ${step.skill || step.kind}` },
        task,
      };
    }

    const maxAttempts = Math.max(1, step.retryPolicy.maxAttempts || 1);
    let lastFailure: FailureContext | null = null;

    for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
      const attemptId = randomUUID();
      const startedAt = Date.now();
      const inputPayload = stepInputSummary(plan, state, step, attemptIndex);

      this._store.recordAttempt({
        attemptId,
        taskId: plan.taskId,
        stepId: step.id,
        attemptIndex,
        status: 'started',
        skill: adapter.descriptor.name,
        inputJson: JSON.stringify(inputPayload),
        outputJson: null,
        errorJson: null,
        startedAt,
        endedAt: null,
      });

      try {
        const ctx = this.createExecutionContext(task, plan, step, state);
        const result = await adapter.execute(ctx);
        const finishedAt = Date.now();
        const validated = summarizeSkillResult(result);
        const outputPayload = {
          ...inputPayload,
          validated,
          ok: result.ok,
          note: result.note ?? null,
          trace: result.trace ?? null,
          output: result.output,
        };

        if (!result.ok) {
          lastFailure = {
            message: validated,
            kind: classifyFailure(validated),
            retryable: result.retryable,
          };
          this._store.finalizeAttempt(attemptId, {
            status: 'failed',
            outputJson: JSON.stringify(outputPayload),
            errorJson: JSON.stringify(serializeError({ message: validated, retryable: result.retryable, trace: result.trace ?? null })),
            endedAt: finishedAt,
          });

          const attemptFailureKind = lastFailure.kind;
          const retryableByPolicy = result.retryable || step.retryPolicy.retryableKinds.includes(attemptFailureKind) || step.retryPolicy.retryableKinds.includes(step.skill) || step.retryPolicy.retryableKinds.includes(step.kind) || step.retryPolicy.retryableKinds.includes('*') || step.retryPolicy.retryableKinds.includes('all');
          const hasRetriesLeft = attemptIndex < maxAttempts;

          if (retryableByPolicy && hasRetriesLeft) {
            decisionLog.push(`[${step.id}] attempt ${attemptIndex} failed (${attemptFailureKind}); retrying`);
            this.working.appendTrail('step_retry', { taskId: plan.taskId, stepId: step.id, attemptIndex, failureKind: attemptFailureKind });
            state.recovery.push({ stepId: step.id, reason: `retry:${attemptFailureKind}`, at: Date.now() });
            await sleep(Math.min(1_500, 250 * (2 ** (attemptIndex - 1))));
            continue;
          }

          break;
        }

        const observation = observationDecision(step, result);

        state.attempts[step.id] = attemptIndex;
        state.outputs[step.id] = result.output;
        state.artifacts[step.id] = {
          skill: adapter.descriptor.name,
          step,
          output: result.output,
          note: result.note ?? null,
          trace: result.trace ?? null,
          attemptedAt: finishedAt,
        };
        state.breadcrumbs.push({ stepId: step.id, kind: step.kind, skill: adapter.descriptor.name, status: 'done' });
        if (state.planner) {
          state.planner.currentNodeId = step.id;
          state.planner.completedNodeIds = [...new Set([...state.planner.completedNodeIds, step.id])];
        }

        this.working.upsertFact(`task:${plan.taskId}:step:${step.id}:status`, 'completed', 0.93, 'orchestrator');
        this.working.upsertFact(`task:${plan.taskId}:cursor`, String(step.position + 1), 0.8, 'orchestrator');
        this.working.appendTrail('step_completed', { taskId: plan.taskId, stepId: step.id, skill: adapter.descriptor.name, note: result.note ?? null });
        this.episodic.add({
          id: randomUUID(),
          taskId: plan.taskId,
          category: 'success',
          summary: `${step.title} completed via ${adapter.descriptor.name}`,
          signals: [step.kind, step.skill, result.ok ? 'ok' : 'unknown'],
          score: 0.9,
        });

        this._store.finalizeAttempt(attemptId, {
          status: 'succeeded',
          outputJson: JSON.stringify(outputPayload),
          errorJson: null,
          endedAt: finishedAt,
        });

        decisionLog.push(`[${step.id}] ${adapter.descriptor.name} succeeded: ${validated}`);

        if (observation.kind === 'continue') {
          if (step.position >= plan.steps.length - 1) {
            return { control: { kind: 'complete', note: `completed final step ${step.id}` }, task: this._store.getTask(plan.taskId) ?? task };
          }
          return { control: { kind: 'continue', note: observation.note }, task: this._store.getTask(plan.taskId) ?? task };
        }

        if (observation.kind === 'complete') {
          return { control: { kind: 'complete', note: observation.note }, task: this._store.getTask(plan.taskId) ?? task };
        }

        if (observation.kind === 'halt') {
          return { control: observation, task: this._store.getTask(plan.taskId) ?? task };
        }

        return { control: observation, task: this._store.getTask(plan.taskId) ?? task };
      } catch (error) {
        const finishedAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        const failure: FailureContext = {
          message,
          kind: classifyFailure(message),
          retryable: /timeout|network|stale|closed|detached|refused|reset|429|tempor/i.test(message.toLowerCase()),
        };
        lastFailure = failure;

        this._store.finalizeAttempt(attemptId, {
          status: 'failed',
          outputJson: JSON.stringify({ ...inputPayload, error: message, skill: adapter.descriptor.name }),
          errorJson: JSON.stringify(serializeError(error)),
          endedAt: finishedAt,
        });

        const retryableByPolicy = failure.retryable || step.retryPolicy.retryableKinds.includes(failure.kind) || step.retryPolicy.retryableKinds.includes(step.skill) || step.retryPolicy.retryableKinds.includes(step.kind) || step.retryPolicy.retryableKinds.includes('*') || step.retryPolicy.retryableKinds.includes('all');
        const hasRetriesLeft = attemptIndex < maxAttempts;

        if (retryableByPolicy && hasRetriesLeft) {
          decisionLog.push(`[${step.id}] attempt ${attemptIndex} errored (${failure.kind}); retrying`);
          this.working.appendTrail('step_retry', { taskId: plan.taskId, stepId: step.id, attemptIndex, failureKind: failure.kind, error: message });
          state.recovery.push({ stepId: step.id, reason: `error:${failure.kind}`, at: Date.now() });
          await sleep(Math.min(1_500, 250 * (2 ** (attemptIndex - 1))));
          continue;
        }

        break;
      }
    }

    if (step.compensation) {
      const compensationStep: PlanStep = {
        id: `${step.id}:compensation`,
        position: step.position,
        kind: step.kind,
        title: `Compensate ${step.title}`,
        skill: step.compensation.skill,
        args: step.compensation.args,
        dependsOn: [],
        retryPolicy: { maxAttempts: 1, retryableKinds: [] },
      };
      const compensationAdapter = this.resolveSkill(compensationStep);
      if (compensationAdapter) {
        const attemptId = randomUUID();
        const startedAt = Date.now();
        this._store.recordAttempt({
          attemptId,
          taskId: plan.taskId,
          stepId: compensationStep.id,
          attemptIndex: 1,
          status: 'started',
          skill: compensationAdapter.descriptor.name,
          inputJson: JSON.stringify(stepInputSummary(plan, state, compensationStep, 1)),
          outputJson: null,
          errorJson: null,
          startedAt,
          endedAt: null,
        });

        try {
          const result = await compensationAdapter.execute(this.createExecutionContext(task, plan, compensationStep, state));
          const finishedAt = Date.now();
          this._store.finalizeAttempt(attemptId, {
            status: result.ok ? 'succeeded' : 'failed',
            outputJson: JSON.stringify({ output: result.output, note: result.note ?? null, trace: result.trace ?? null }),
            errorJson: result.ok ? null : JSON.stringify({ note: result.note ?? null, trace: result.trace ?? null }),
            endedAt: finishedAt,
          });
          if (result.ok) {
            state.artifacts[compensationStep.id] = result.output;
            state.breadcrumbs.push({ stepId: compensationStep.id, kind: compensationStep.kind, skill: compensationAdapter.descriptor.name, status: 'compensated' });
            state.recovery.push({ stepId: step.id, reason: 'compensation-completed', at: Date.now() });
            this.working.appendTrail('step_compensated', { taskId: plan.taskId, stepId: step.id, compensationSkill: compensationAdapter.descriptor.name });
            this.episodic.add({
              id: randomUUID(),
              taskId: plan.taskId,
              category: 'correction',
              summary: `${step.title} recovered with ${compensationAdapter.descriptor.name}`,
              signals: [step.kind, step.skill, compensationAdapter.descriptor.name],
              score: 0.72,
            });
            return { control: { kind: 'replan', note: `compensation completed for ${step.id}` }, task };
          }
        } catch (error) {
          this._store.finalizeAttempt(attemptId, {
            status: 'failed',
            outputJson: JSON.stringify({ error: serializeError(error) }),
            errorJson: JSON.stringify(serializeError(error)),
            endedAt: Date.now(),
          });
        }
      }
    }

    const failureMessage = lastFailure?.message ?? `step ${step.id} failed`;
    decisionLog.push(`[${step.id}] failed: ${failureMessage}`);
    this.working.upsertFact(`task:${plan.taskId}:step:${step.id}:status`, 'failed', 0.92, 'orchestrator');
    this.working.appendTrail('step_failed', { taskId: plan.taskId, stepId: step.id, message: failureMessage });
    this.episodic.add({
      id: randomUUID(),
      taskId: plan.taskId,
      category: 'failure',
      summary: `${step.title} failed after ${step.retryPolicy.maxAttempts} attempt(s)`,
      signals: [step.kind, step.skill, lastFailure?.kind ?? 'unknown'],
      score: 0.35,
    });

    return {
      control: { kind: 'halt', status: 'failed', note: failureMessage },
      task,
    };
  }

  private async refreshPlan(input: TaskInput, plan: TaskPlan, state: RuntimeState, lastReason: string, replanCount: number): Promise<TaskPlan> {
    const nextInput: TaskInput = {
      ...input,
      context: buildTaskContext(input, plan, state, {
        currentPlan: plan,
        lastObservation: lastReason,
        workingMemory: this.working.snapshot(),
        episodicMemory: this.episodic.snapshot(),
      }),
    };
    const nextPlan = await buildPlan(nextInput);
    const validation = validatePlan(nextPlan.steps);
    if (!validation.ok) {
      throw new Error(`replan ${replanCount + 1} produced an invalid plan: ${validation.reasons.join('; ')}`);
    }
    this._store.savePlan(nextPlan);
    return nextPlan;
  }

  async execute(input: TaskInput): Promise<TaskExecutionResult> {
    this._store.upsertTask(input.id, input.objective, 'planning');
    let task = this._store.getTask(input.id);
    if (!task) {
      throw new Error(`task could not be created: ${input.id}`);
    }

    this._store.recordEvent(input.id, classifyTransition('draft', 'planning'), 'draft', 'planning', { objective: input.objective, source: 'execute' });
    this.working.upsertFact(`task:${input.id}:objective`, input.objective, 1, 'orchestrator');
    this.working.appendTrail('task_started', { taskId: input.id, objective: input.objective });

    let plan = await buildPlan({
      ...input,
      context: buildTaskContext(input, { taskId: input.id, objective: input.objective, steps: [] }, {
        objective: input.objective,
        cursor: 0,
        attempts: {},
        outputs: {},
        artifacts: {},
        breadcrumbs: [],
        recovery: [],
      }),
    });
    const validation = validatePlan(plan.steps);
    if (!validation.ok) {
      this._store.updateTask(input.id, { status: 'failed', errorJson: JSON.stringify({ validation: validation.reasons }) });
      this._store.recordEvent(input.id, classifyTransition('planning', 'failed'), 'planning', 'failed', { reasons: validation.reasons });
      return {
        ok: false,
        status: 'failed',
        taskId: input.id,
        plan,
        error: validation.reasons.join('; '),
        note: 'plan validation failed',
        rationale: validation.reasons,
      };
    }

    this._store.savePlan(plan);
    this._store.updateTask(input.id, { status: 'routing', currentStepIndex: 0, activeStepId: plan.steps[0]?.id ?? null, errorJson: null, resultJson: null });
    this._store.bumpRevision(input.id);
    this._store.recordEvent(input.id, classifyTransition('planning', 'routing'), 'planning', 'routing', { planSize: plan.steps.length, taskId: input.id });

    let state = buildRuntimeState(plan);
    this._store.recordSnapshot(input.id, 'routing', state);
    task = this._store.getTask(input.id) ?? task;

    let replanCount = 0;
    const decisionLog: string[] = [`planned ${plan.steps.length} step(s)`];

    while (true) {
      this._store.updateTask(input.id, { status: 'executing', currentStepIndex: state.cursor, activeStepId: plan.steps[state.cursor]?.id ?? null });
      this._store.bumpRevision(input.id);
      this._store.recordEvent(input.id, classifyTransition('routing', 'executing'), 'routing', 'executing', { cursor: state.cursor, activeStepId: plan.steps[state.cursor]?.id ?? null });
      this._store.recordSnapshot(input.id, 'executing', state);

      let stepOutcome: { control: StepControl; task: TaskRecord } | null = null;
      for (let index = state.cursor; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        state.cursor = index;
        const missingDependencies = dependencyCheck(step, state);
        if (missingDependencies.length > 0) {
          stepOutcome = {
            control: { kind: 'replan', note: `step ${step.id} is missing dependencies: ${missingDependencies.join(', ')}` },
            task,
          };
          decisionLog.push(stepOutcome.control.note);
          break;
        }

        stepOutcome = await this.runStep(task, plan, state, step, decisionLog);
        task = stepOutcome.task;

        if (stepOutcome.control.kind === 'continue') {
          state.cursor = index + 1;
          this._store.updateTask(input.id, { currentStepIndex: state.cursor, activeStepId: plan.steps[state.cursor]?.id ?? null });
          this._store.bumpRevision(input.id);
          this._store.recordSnapshot(input.id, 'executing', state);
          continue;
        }

        if (stepOutcome.control.kind === 'complete') {
          state.cursor = plan.steps.length;
          break;
        }

        break;
      }

      if (!stepOutcome) {
        stepOutcome = { control: { kind: 'complete', note: 'plan has no executable steps' }, task };
      }

      if (stepOutcome.control.kind === 'continue') {
        stepOutcome = { control: { kind: 'complete', note: 'all planned steps completed' }, task };
      }

      if (stepOutcome.control.kind === 'complete') {
        this._store.updateTask(input.id, {
          status: 'completed',
          currentStepIndex: plan.steps.length,
          activeStepId: null,
          resultJson: JSON.stringify({ plan, state, rationale: decisionLog }),
          errorJson: null,
        });
        this._store.bumpRevision(input.id);
        this._store.recordEvent(input.id, classifyTransition('executing', 'completed'), 'executing', 'completed', { rationale: decisionLog });
        this._store.recordSnapshot(input.id, 'completed', state);
        this.working.upsertFact(`task:${input.id}:status`, 'completed', 1, 'orchestrator');
        this.working.appendTrail('task_completed', { taskId: input.id, rationale: decisionLog.slice(-5) });
        this.episodic.add({
          id: randomUUID(),
          taskId: input.id,
          category: 'success',
          summary: `task ${input.id} completed with ${plan.steps.length} step(s)`,
          signals: ['task_completed', input.objective, String(plan.steps.length)],
          score: 1,
        });
        return {
          ok: true,
          status: 'completed',
          taskId: input.id,
          plan,
          state,
          note: decisionLog.at(-1) ?? 'execution completed',
          rationale: decisionLog,
          executionProfile: state.executionProfile,
        };
      }

      if (stepOutcome.control.kind === 'halt') {
        this._store.updateTask(input.id, {
          status: stepOutcome.control.status,
          currentStepIndex: state.cursor,
          activeStepId: plan.steps[state.cursor]?.id ?? null,
          errorJson: JSON.stringify({ reason: stepOutcome.control.note, decisionLog }),
        });
        this._store.bumpRevision(input.id);
        this._store.recordEvent(input.id, classifyTransition('executing', stepOutcome.control.status), 'executing', stepOutcome.control.status, { reason: stepOutcome.control.note, decisionLog });
        this._store.recordSnapshot(input.id, stepOutcome.control.status, state);
        this.working.upsertFact(`task:${input.id}:status`, stepOutcome.control.status, 0.95, 'orchestrator');
        this.working.appendTrail('task_halted', { taskId: input.id, status: stepOutcome.control.status, reason: stepOutcome.control.note });
        return {
          ok: false,
          status: stepOutcome.control.status,
          taskId: input.id,
          plan,
          state,
          error: stepOutcome.control.note,
          note: stepOutcome.control.note,
          rationale: decisionLog,
          executionProfile: state.executionProfile,
        };
      }

      if (stepOutcome.control.kind === 'replan') {
        if (replanCount >= 2) {
          const message = `replan limit reached after ${replanCount} recovery cycle(s)`;
          this._store.updateTask(input.id, { status: 'failed', errorJson: JSON.stringify({ message, decisionLog }) });
          this._store.bumpRevision(input.id);
          this._store.recordEvent(input.id, classifyTransition('executing', 'failed'), 'executing', 'failed', { message, decisionLog });
          this._store.recordSnapshot(input.id, 'failed', state);
          return {
            ok: false,
            status: 'failed',
            taskId: input.id,
            plan,
            state,
            error: message,
            note: message,
            rationale: decisionLog,
            executionProfile: state.executionProfile,
          };
        }

        this._store.updateTask(input.id, { status: 'recovering', activeStepId: null });
        this._store.bumpRevision(input.id);
        this._store.recordEvent(input.id, classifyTransition('executing', 'recovering'), 'executing', 'recovering', { reason: stepOutcome.control.note, replanCount });
        this._store.recordSnapshot(input.id, 'recovering', state);
        state.recovery.push({ stepId: plan.steps[Math.max(0, Math.min(state.cursor, plan.steps.length - 1))]?.id ?? input.id, reason: stepOutcome.control.note, at: Date.now() });

        plan = await this.refreshPlan(input, plan, state, stepOutcome.control.note, replanCount);
        replanCount += 1;
        state = {
          ...buildRuntimeState(plan),
          attempts: state.attempts,
          outputs: state.outputs,
          artifacts: state.artifacts,
          breadcrumbs: state.breadcrumbs,
          recovery: state.recovery,
          cursor: 0,
        };
        decisionLog.push(`replanned: ${stepOutcome.control.note}`);
        this._store.updateTask(input.id, { status: 'routing', currentStepIndex: 0, activeStepId: plan.steps[0]?.id ?? null });
        this._store.bumpRevision(input.id);
        this._store.recordEvent(input.id, classifyTransition('recovering', 'routing'), 'recovering', 'routing', { reason: stepOutcome.control.note, replanCount });
        this._store.recordSnapshot(input.id, 'routing', state);
        continue;
      }

      const message = stepOutcome.control.note;
      this._store.updateTask(input.id, { status: 'failed', errorJson: JSON.stringify({ reason: message, decisionLog }) });
      this._store.bumpRevision(input.id);
      this._store.recordEvent(input.id, classifyTransition('executing', 'failed'), 'executing', 'failed', { reason: message, decisionLog });
      this._store.recordSnapshot(input.id, 'failed', state);
      this.working.upsertFact(`task:${input.id}:status`, 'failed', 0.95, 'orchestrator');
      this.working.appendTrail('task_failed', { taskId: input.id, reason: message });
      return {
        ok: false,
        status: 'failed',
        taskId: input.id,
        plan,
        state,
        error: message,
        note: message,
        rationale: decisionLog,
        executionProfile: state.executionProfile,
      };
    }
  }
}
