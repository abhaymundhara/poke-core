import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER } from './search/nlu';
import { parseModelJson } from './llm-bridge';
import { EpisodicMemory } from './memory/episodic-memory';
import { WorkingMemory } from './memory/working-memory';
import { RagCorpus } from './rag/retriever';
import { listSkillPlaybooks } from './skill-playbooks';
import type { ExecutionProfile, RuntimeState, TaskInput, TaskPlan, TaskRecord, TaskStatus } from './types';
import type { PokeCoreStore } from './store';
import type { SkillAdapter } from './skills/types';

export type TaskExecutionResult = {
  ok: boolean;
  taskId: string;
  status: TaskStatus;
  plan: TaskPlan;
  state: RuntimeState;
  error?: string;
};

const ORCHESTRATION_FRAME_SCHEMA = {
  type: 'object',
  properties: {
    phase: { enum: ['draft', 'planning', 'routing', 'executing', 'recovering', 'completed', 'failed', 'rolled_back'] },
    plan: { type: 'object' },
    state: { type: 'object' },
    executionProfile: { type: 'object' },
    stepIndex: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    adapterName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    error: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rationale: { type: 'array', items: { type: 'string' } },
    recovery: { type: 'object' },
  },
} as const;

type OrchestrationFrame = {
  phase?: TaskStatus;
  plan?: TaskPlan;
  state?: RuntimeState;
  executionProfile?: ExecutionProfile;
  stepIndex?: number | null;
  adapterName?: string | null;
  error?: string | null;
  note?: string | null;
  rationale?: string[];
  recovery?: Record<string, unknown> | null;
};

async function runOrchestrationModel<T>(objective: string, context: Record<string, unknown>): Promise<T> {
  const raw = await DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.extract({ objective, context, schema: ORCHESTRATION_FRAME_SCHEMA });
  return parseModelJson<T>(raw);
}

export class PokeCoreOrchestrator {
  private readonly skills: SkillAdapter[];
  private rag = new RagCorpus();
  private working = new WorkingMemory();
  private episodic = new EpisodicMemory();

  constructor(private store: PokeCoreStore, skills: SkillAdapter[]) {
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

  private pickStep(plan: TaskPlan, stepIndex: number | null | undefined): TaskPlan['steps'][number] | null {
    if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) return null;
    return plan.steps[stepIndex] ?? null;
  }

  private resolveAdapter(name: string | null | undefined): SkillAdapter | null {
    if (!name) return null;
    return this.skills.find((skill) => skill.descriptor.name === name) ?? null;
  }

  private async askFrame(input: {
    phase: TaskStatus;
    task: TaskRecord;
    plan: TaskPlan | null;
    state: RuntimeState | null;
    stepId?: string | null;
    stepIndex?: number | null;
    adapterName?: string | null;
    error?: string | null;
    note?: string | null;
    result?: unknown;
  }): Promise<OrchestrationFrame> {
    return await runOrchestrationModel<OrchestrationFrame>('drive the task orchestration loop end-to-end; decide the next status transition, plan shape, execution profile, step routing, retries, and recovery directly in the model output', {
      phase: input.phase,
      task: input.task,
      plan: input.plan,
      state: input.state,
      stepId: input.stepId ?? null,
      stepIndex: input.stepIndex ?? null,
      adapterName: input.adapterName ?? null,
      error: input.error ?? null,
      note: input.note ?? null,
      result: input.result ?? null,
      skillCatalog: this.skillCatalog,
      skillPlaybooks: this.skillPlaybooks,
      memory: {
        rag: 'available',
        working: 'available',
        episodic: 'available',
      },
    });
  }

  async execute(input: TaskInput): Promise<TaskExecutionResult> {
    this.store.upsertTask(input.id, input.objective, 'planning');
    let task = this.store.getTask(input.id)!;
    let plan = this.store.getPlan(input.id) ?? null;
    let state = task.resultJson ? JSON.parse(task.resultJson) as RuntimeState : null;

    let frame = await this.askFrame({
      phase: 'planning',
      task,
      plan,
      state,
      note: 'start orchestration from the current task context',
      result: {
        objective: input.objective,
        context: input.context ?? {},
      },
    });

    if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
      frame = await this.askFrame({
        phase: 'recovering',
        task,
        plan,
        state,
        error: 'model output was missing the orchestration frame',
        note: 'repair the frame and emit a complete plan/state/stepIndex',
      });
    }

    if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
      throw new Error('orchestration-model-missing-plan-state-or-stepIndex');
    }

    plan = frame.plan;
    state = frame.state;
    this.store.savePlan(plan);
    this.store.updateTask(task.taskId, {
      status: frame.phase ?? 'planning',
      currentStepIndex: frame.stepIndex,
      activeStepId: this.pickStep(plan, frame.stepIndex)?.id ?? null,
      resultJson: JSON.stringify(state),
      errorJson: frame.error ? JSON.stringify({ message: frame.error }) : null,
      revision: task.revision + 1,
    });
    task = this.store.getTask(input.id)!;

    while (true) {
      const step = this.pickStep(plan, frame.stepIndex);

      if (frame.phase === 'completed') {
        this.store.updateTask(task.taskId, {
          status: 'completed',
          currentStepIndex: frame.stepIndex,
          activeStepId: step?.id ?? null,
          resultJson: JSON.stringify(state),
          errorJson: null,
          revision: task.revision + 1,
        });
        return { ok: true, taskId: input.id, status: 'completed', plan, state };
      }

      if (frame.phase === 'failed') {
        this.store.updateTask(task.taskId, {
          status: 'failed',
          currentStepIndex: frame.stepIndex,
          activeStepId: step?.id ?? null,
          resultJson: JSON.stringify(state),
          errorJson: frame.error ? JSON.stringify({ message: frame.error }) : null,
          revision: task.revision + 1,
        });
        return { ok: false, taskId: input.id, status: 'failed', plan, state, error: frame.error ?? 'model-directed-failure' };
      }

      if (!step) {
        frame = await this.askFrame({
          phase: 'recovering',
          task,
          plan,
          state,
          stepIndex: frame.stepIndex,
          error: 'the current stepIndex did not resolve to a plan step',
          note: 'repair routing and choose the next valid step',
        });
        if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
          throw new Error('orchestration-model-missing-plan-state-or-stepIndex');
        }
        plan = frame.plan;
        state = frame.state;
        this.store.savePlan(plan);
        this.store.updateTask(task.taskId, {
          status: frame.phase ?? 'recovering',
          currentStepIndex: frame.stepIndex,
          activeStepId: this.pickStep(plan, frame.stepIndex)?.id ?? null,
          resultJson: JSON.stringify(state),
          errorJson: frame.error ? JSON.stringify({ message: frame.error }) : null,
          revision: task.revision + 1,
        });
        task = this.store.getTask(input.id)!;
        continue;
      }

      const adapter = this.resolveAdapter(frame.adapterName);
      if (!adapter) {
        frame = await this.askFrame({
          phase: 'recovering',
          task,
          plan,
          state,
          stepId: step.id,
          stepIndex: frame.stepIndex,
          error: 'the model selected an unavailable adapter: ' + String(frame.adapterName ?? ''),
          note: 'recover by choosing a valid adapter or revising the plan',
        });
        if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
          throw new Error('orchestration-model-missing-plan-state-or-stepIndex');
        }
        plan = frame.plan;
        state = frame.state;
        this.store.savePlan(plan);
        this.store.updateTask(task.taskId, {
          status: frame.phase ?? 'recovering',
          currentStepIndex: frame.stepIndex,
          activeStepId: this.pickStep(plan, frame.stepIndex)?.id ?? null,
          resultJson: JSON.stringify(state),
          errorJson: frame.error ? JSON.stringify({ message: frame.error }) : null,
          revision: task.revision + 1,
        });
        task = this.store.getTask(input.id)!;
        continue;
      }

      const result = await adapter.execute({ taskId: task.taskId, task, plan, step, state });
      state = {
        ...state,
        outputs: {
          ...state.outputs,
          [step.id]: result.output,
        },
        artifacts: {
          ...state.artifacts,
          [step.id]: result.trace ?? result.output,
        },
      };

      frame = await this.askFrame({
        phase: result.ok ? 'routing' : 'recovering',
        task,
        plan,
        state,
        stepId: step.id,
        stepIndex: frame.stepIndex,
        adapterName: adapter.descriptor.name,
        error: result.ok ? null : (result.note ?? 'model-directed-step-failure'),
        note: result.note ?? null,
        result,
      });

      if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
        frame = await this.askFrame({
          phase: 'recovering',
          task,
          plan,
          state,
          stepId: step.id,
          stepIndex: frame.stepIndex,
          adapterName: adapter.descriptor.name,
          error: 'the model returned an incomplete follow-up frame',
          note: 'repair the follow-up frame and continue or complete the task',
          result,
        });
      }

      if (!frame.plan || !frame.state || typeof frame.stepIndex !== 'number') {
        throw new Error('orchestration-model-missing-plan-state-or-stepIndex');
      }

      plan = frame.plan;
      state = frame.state;
      this.store.savePlan(plan);
      this.store.updateTask(task.taskId, {
        status: frame.phase ?? (result.ok ? 'routing' : 'recovering'),
        currentStepIndex: frame.stepIndex,
        activeStepId: this.pickStep(plan, frame.stepIndex)?.id ?? null,
        resultJson: JSON.stringify(state),
        errorJson: frame.error ? JSON.stringify({ message: frame.error }) : null,
        revision: task.revision + 1,
      });
      task = this.store.getTask(input.id)!;
    }
  }
}
