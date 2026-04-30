import { randomUUID } from 'node:crypto';
import { buildPlan } from './planner';
import { SkillRouter } from './router';
import { juryReviewExecution, juryReviewPlan } from './jury';
import { classifyTransition, transition } from './state-machine';
import type { ExecutionRecord, TaskInput, TaskPlan, TaskStatus } from './types';
import type { PokeCoreStore } from './store';
import type { SkillContext } from './skills/types';

export type OrchestratorRuntime = {
  taskId: string;
  objective: string;
  plan: TaskPlan;
  state: Record<string, unknown>;
};

export class PokeCoreOrchestrator {
  constructor(private store: PokeCoreStore, private router: SkillRouter) {}

  planTask(input: TaskInput): OrchestratorRuntime {
    this.store.upsertTask(input.id, input.objective, 'planning');
    const plan = buildPlan(input);
    const jury = juryReviewPlan(plan.steps);
    if (!jury.ok) {
      this.store.recordHistory(input.id, 'fail', 'planning', 'failed', { reasons: jury.reasons });
      this.store.updateTask(input.id, { status: 'failed', error: jury.reasons.join('; ') });
      throw new Error(jury.reasons.join('; '));
    }
    this.store.savePlan(plan);
    this.store.recordHistory(input.id, classifyTransition('draft', 'planning'), 'draft', 'planning', { steps: plan.steps.length, score: jury.score });
    this.store.updateTask(input.id, { status: 'routing', currentStepIndex: 0, activeStepId: plan.steps[0]?.id ?? null });
    this.store.recordHistory(input.id, classifyTransition('planning', 'routing'), 'planning', 'routing', { stepIds: plan.steps.map((s) => s.id) });
    this.store.addGraphEdge(input.id, null, plan.steps[0]?.id ?? null, 'ENTRY', 'task entry point');
    for (let i = 0; i < plan.steps.length - 1; i++) this.store.addGraphEdge(input.id, plan.steps[i].id, plan.steps[i + 1].id, 'NEXT', 'sequential plan');
    return { taskId: input.id, objective: input.objective, plan, state: { objective: input.objective, steps: [] as unknown[], outputs: {} as Record<string, unknown> } };
  }

  async runTask(input: TaskInput) {
    const runtime = this.planTask(input);
    const plan = runtime.plan;
    const taskId = input.id;
    const state = runtime.state;
    const startingStatus: TaskStatus = 'routing';

    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      const beforeSnapshot = this.store.recordSnapshot(taskId, 'routing', { state, index, stepId: step.id });
      this.store.recordHistory(taskId, 'route', startingStatus, 'executing', { stepId: step.id, snapshotId: beforeSnapshot.snapshotId });

      const skill = this.router.resolve(step);
      const ctx: SkillContext = { taskId, step, state };
      const execution = await skill.execute(ctx);
      const verdict = juryReviewExecution({ output: execution.output, note: execution.note, passed: execution.verified });

      const record: ExecutionRecord = {
        executionId: randomUUID(),
        taskId,
        stepId: step.id,
        skill: skill.name,
        kind: step.kind,
        inputJson: JSON.stringify(ctx.step.args),
        outputJson: JSON.stringify(execution.output),
        passed: verdict.ok ? 1 : 0,
        note: execution.note ?? verdict.reasons.join('; '),
        createdAt: Date.now(),
      };
      this.store.recordExecution(record);
      this.store.recordHistory(taskId, 'execute', 'executing', verdict.ok ? 'verifying' : 'failed', { stepId: step.id, verdict });

      if (!verdict.ok) {
        const rollbackState = { restoredFrom: beforeSnapshot.snapshotId, state };
        this.store.recordSnapshot(taskId, 'rolled_back', rollbackState);
        this.store.recordHistory(taskId, 'rollback', 'failed', 'rolled_back', rollbackState);
        this.store.updateTask(taskId, { status: 'rolled_back', currentStepIndex: index, activeStepId: step.id, error: verdict.reasons.join('; '), resultJson: JSON.stringify(rollbackState) });
        return { ok: false, taskId, status: 'rolled_back' as const, error: verdict.reasons.join('; '), plan, state };
      }

      state.steps.push({ stepId: step.id, skill: skill.name, kind: step.kind });
      state.outputs[step.id] = execution.output;
      state.lastNote = execution.note ?? null;
      this.store.recordSnapshot(taskId, 'verifying', { state, index, stepId: step.id, output: execution.output });
      this.store.updateTask(taskId, { status: 'verifying', currentStepIndex: index + 1, activeStepId: step.id, resultJson: JSON.stringify(state), error: null });

      const nextTransition = transition('verifying', index === plan.steps.length - 1 ? 'completed' : 'routing');
      if (!nextTransition.ok) {
        throw new Error(nextTransition.reason ?? 'invalid transition');
      }
      this.store.recordHistory(taskId, classifyTransition('verifying', index === plan.steps.length - 1 ? 'completed' : 'routing'), 'verifying', index === plan.steps.length - 1 ? 'completed' : 'routing', { stepId: step.id });
    }

    const finalDecision = juryReviewExecution({ output: state, passed: true, note: 'final state accepted' });
    if (!finalDecision.ok) {
      this.store.updateTask(taskId, { status: 'failed', error: finalDecision.reasons.join('; ') });
      this.store.recordHistory(taskId, 'fail', 'verifying', 'failed', { reasons: finalDecision.reasons });
      return { ok: false, taskId, status: 'failed' as const, error: finalDecision.reasons.join('; '), plan, state };
    }

    this.store.updateTask(taskId, { status: 'completed', resultJson: JSON.stringify(state), error: null, activeStepId: plan.steps.at(-1)?.id ?? null, currentStepIndex: plan.steps.length });
    this.store.recordSnapshot(taskId, 'completed', state);
    this.store.recordHistory(taskId, 'complete', 'verifying', 'completed', { taskId, stepCount: plan.steps.length });
    return { ok: true, taskId, status: 'completed' as const, plan, state };
  }
}
