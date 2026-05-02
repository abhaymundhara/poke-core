import { randomUUID } from 'node:crypto';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER } from './search/nlu';
import { buildPlan, resolvePlannerIntent } from './planner';
import { parseModelJson } from './llm-bridge';
import { buildPokeGraph, type PokeGraphState } from './graph';
import { RagCorpus } from './rag/retriever';
import { EpisodicMemory } from './memory/episodic-memory';
import { WorkingMemory } from './memory/working-memory';
import { getSkillPlaybook, listSkillPlaybooks } from './skill-playbooks';
import type { ExecutionContext, ExecutionProfile, PlannerRuntimeState, RuntimeState, StepAttempt, TaskInput, TaskPlan, TaskRecord, TaskStatus } from './types';
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

const AFFORDANCE_EVALUATION_SCHEMA = {
  type: 'object',
  required: ['selectedAdapterName', 'confidence', 'rationale', 'rankedAdapters'],
  properties: {
    selectedAdapterName: { type: 'string' },
    confidence: { type: 'number' },
    rationale: { type: 'array', items: { type: 'string' } },
    rankedAdapters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'score', 'reason', 'invoke'],
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'array', items: { type: 'string' } },
          invoke: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const PLANNER_RUNTIME_STATE_SCHEMA = {
  type: 'object',
  required: ['strategy', 'provider', 'fallbackUsed', 'confidence', 'currentNodeId', 'completedNodeIds', 'blockedNodeIds', 'notes'],
  properties: {
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    provider: { type: 'string' },
    fallbackUsed: { type: 'boolean' },
    confidence: { type: 'number' },
    currentNodeId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    completedNodeIds: { type: 'array', items: { type: 'string' } },
    blockedNodeIds: { type: 'array', items: { type: 'string' } },
    lastRecovery: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        reason: { type: 'string' },
        at: { type: 'number' },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

const EXECUTION_PROFILE_SCHEMA = {
  type: 'object',
  required: ['primarySource', 'secondarySources', 'parallelizable', 'rationale'],
  properties: {
    primarySource: { type: 'string' },
    secondarySources: { type: 'array', items: { type: 'string' } },
    parallelizable: { type: 'boolean' },
    rationale: { type: 'array', items: { type: 'string' } },
    strategy: { enum: ['semantic-first', 'trust-first', 'multi-hop', 'freshness-first', 'blend'] },
    affordanceSignals: { type: 'array' },
  },
} as const;

type AffordanceEvaluation = {
  selectedAdapterName: string;
  confidence: number;
  rationale: string[];
  rankedAdapters: Array<{ name: string; score: number; reason: string[]; invoke: boolean }>;
};

type ModelPlannerFrame = {
  planner: PlannerRuntimeState;
  executionProfile: ExecutionProfile;
};

async function runModelExtraction<T>(provider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): Promise<T> {
  const raw = await provider.extract({ objective, context, schema });
  return parseModelJson<T>(raw);
}

function cloneIntentGraph(graph: TaskPlan['intentGraph'] | undefined): TaskPlan['intentGraph'] | undefined {
  return graph ? JSON.parse(JSON.stringify(graph)) as TaskPlan['intentGraph'] : undefined;
}

function stepKindLabel(step: TaskPlan['steps'][number]): string {
  return step.kind + ':' + step.id;
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

  private async synthesizeModelFrame(input: { plan: TaskPlan; task?: TaskRecord | null; state?: RuntimeState | null; step?: TaskPlan['steps'][number] | null; phase: string; note?: string | null; }): Promise<ModelPlannerFrame> {
    const draft = await runModelExtraction<ModelPlannerFrame>(DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, 'synthesize runtime planner state and execution profile from the current orchestration context', {
      objective: input.plan.objective,
      task: input.task ? { taskId: input.task.taskId, status: input.task.status, currentStepIndex: input.task.currentStepIndex, activeStepId: input.task.activeStepId, revision: input.task.revision } : null,
      state: input.state ?? null,
      step: input.step ?? null,
      phase: input.phase,
      note: input.note ?? null,
      plan: {
        taskId: input.plan.taskId,
        objective: input.plan.objective,
        semanticIntent: input.plan.semanticIntent,
        intentGraph: input.plan.intentGraph,
        planner: input.plan.planner,
        steps: input.plan.steps.map((step) => ({ id: step.id, position: step.position, kind: step.kind, title: step.title, skill: step.skill, dependsOn: step.dependsOn ?? [], retryPolicy: step.retryPolicy })),
      },
      skillCatalog: this.skillCatalog,
    }, {
      type: 'object',
      required: ['planner', 'executionProfile'],
      properties: {
        planner: PLANNER_RUNTIME_STATE_SCHEMA,
        executionProfile: EXECUTION_PROFILE_SCHEMA,
      },
    });
    return draft;
  }

  private async evaluateSkillAdapterAffordance(adapterCandidates: SkillAdapter[], step: TaskPlan['steps'][number], plan: TaskPlan, state: RuntimeState): Promise<AffordanceEvaluation> {
    const raw = await DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.extract({
      objective: 'select the best skill adapter for the current step',
      context: {
        objective: plan.objective,
        step,
        plan: {
          taskId: plan.taskId,
          objective: plan.objective,
          semanticIntent: plan.semanticIntent,
          planner: plan.planner,
          executionProfile: state.executionProfile,
          graph: state.intentGraph,
        },
        graphState: {
          executionProfile: state.executionProfile,
          planner: state.planner,
          breadcrumbs: state.breadcrumbs,
          recovery: state.recovery,
          outputs: state.outputs,
          artifacts: state.artifacts,
          intentGraph: state.intentGraph,
        },
        candidates: adapterCandidates.map((adapter) => ({
          name: adapter.descriptor.name,
          domain: adapter.descriptor.domain,
          capabilities: adapter.descriptor.capabilities,
          version: adapter.descriptor.version,
          playbook: getSkillPlaybook(adapter.descriptor.name as any),
        })),
      },
      schema: AFFORDANCE_EVALUATION_SCHEMA,
    });
    const evaluation = parseModelJson<AffordanceEvaluation>(raw);
    if (!evaluation || typeof evaluation !== 'object' || !Array.isArray(evaluation.rankedAdapters) || evaluation.rankedAdapters.length === 0) {
      throw new Error('invalid-affordance-evaluation:' + DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.name);
    }
    if (typeof evaluation.selectedAdapterName !== 'string' || typeof evaluation.confidence !== 'number' || !Array.isArray(evaluation.rationale)) {
      throw new Error('invalid-affordance-evaluation:' + DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.name);
    }
    const selected = evaluation.rankedAdapters.find((entry) => entry.name === evaluation.selectedAdapterName);
    if (!selected || !selected.invoke) throw new Error('no-adapter-selected:' + DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.name);
    return evaluation;
  }

  private async resolveSkill(step: TaskPlan['steps'][number], plan: TaskPlan, state: RuntimeState): Promise<SkillAdapter> {
    const candidates = this.skills.filter((candidate) => candidate.canHandle(step));
    if (candidates.length === 0) throw new Error('no skill adapter can handle step ' + step.id + ' (' + step.kind + ')');
    const evaluation = await this.evaluateSkillAdapterAffordance(candidates, step, plan, state);
    const selected = candidates.find((candidate) => candidate.descriptor.name === evaluation.selectedAdapterName);
    if (!selected) throw new Error('invalid-affordance-evaluation:' + evaluation.selectedAdapterName);
    return selected;
  }

  private async ensurePlan(input: TaskInput): Promise<TaskPlan> {
    const plan = await buildPlan(input);
    this.store.savePlan(plan);
    return plan;
  }

  private async buildContextState(input: TaskInput, plan: TaskPlan): Promise<PokeGraphState> {
    const frame = await this.synthesizeModelFrame({ plan, phase: 'initial' });
    return {
      objective: plan.objective,
      cursor: 0,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      query: input.objective + '\n' + JSON.stringify(input.context ?? {}),
      executionProfile: frame.executionProfile,
      semanticIntent: plan.semanticIntent,
      intentGraph: cloneIntentGraph(plan.intentGraph),
      planner: frame.planner,
      sessionKey: plan.semanticIntent?.sessionKey,
    };
  }

  private async loadOrCreateState(task: TaskRecord, plan: TaskPlan, profile: ExecutionProfile): Promise<RuntimeState> {
    const existing = task.resultJson ? JSON.parse(task.resultJson) as RuntimeState : null;
    if (existing) {
      const planner = existing.planner ?? (await this.synthesizeModelFrame({ plan, task, state: existing, phase: 'resume' })).planner;
      return {
        ...existing,
        executionProfile: existing.executionProfile ?? profile,
        semanticIntent: existing.semanticIntent ?? plan.semanticIntent,
        intentGraph: existing.intentGraph ?? cloneIntentGraph(plan.intentGraph),
        planner,
      };
    }
    const frame = await this.synthesizeModelFrame({ plan, task, phase: 'seed' });
    return {
      objective: plan.objective,
      cursor: task.currentStepIndex,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      executionProfile: frame.executionProfile ?? profile,
      semanticIntent: plan.semanticIntent,
      intentGraph: cloneIntentGraph(plan.intentGraph),
      planner: frame.planner,
    };
  }

  private recordLifecycle(taskId: string, kind: 'plan' | 'route' | 'execute' | 'validate' | 'recover' | 'complete' | 'fail' | 'rollback', from: TaskStatus | null, to: TaskStatus | null, detail: unknown) {
    this.store.recordEvent(taskId, kind, from, to, detail);
  }

  private createAttempt(taskId: string, stepId: string, attemptIndex: number, skill: string, input: unknown): StepAttempt {
    return { attemptId: randomUUID(), taskId, stepId, attemptIndex, status: 'started', skill, inputJson: JSON.stringify(input), outputJson: null, errorJson: null, startedAt: Date.now(), endedAt: null };
  }

  private async runStep(task: TaskRecord, plan: TaskPlan, state: RuntimeState, stepIndex: number): Promise<{ ok: boolean; state: RuntimeState; error?: string }> {
    const step = plan.steps[stepIndex];
    const beforeSnapshot = this.store.recordSnapshot(task.taskId, 'executing', state);
    this.recordLifecycle(task.taskId, 'execute', task.status, 'executing', { stepId: step.id, snapshotId: beforeSnapshot.snapshotId, stepIndex });

    let skill: SkillAdapter;
    try {
      skill = await this.resolveSkill(step, plan, state);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state.recovery.push({ stepId: step.id, reason, at: Date.now() });
      this.recordLifecycle(task.taskId, 'recover', 'executing', 'recovering', { stepId: step.id, phase: 'affordance-evaluation', error: reason, recoveryEvent: (err as any)?.recoveryEvent ?? null });
      throw err;
    }

    const ctx: ExecutionContext = { taskId: task.taskId, task, plan, step, state };
    state.planner = state.planner ? { ...state.planner, currentNodeId: step.id, notes: [...state.planner.notes, 'active:' + step.id] } : (await this.synthesizeModelFrame({ plan, task, state, step, phase: 'active' })).planner;
    let attemptIndex = state.attempts[step.id] ?? 0;
    let lastError: string | null = null;

    while (attemptIndex < step.retryPolicy.maxAttempts) {
      const attempt = this.createAttempt(task.taskId, step.id, attemptIndex, skill.descriptor.name, step.args);
      this.store.recordAttempt(attempt);
      try {
        const result = await skill.execute(ctx);
        this.store.finalizeAttempt(attempt.attemptId, { status: 'succeeded', outputJson: JSON.stringify(result.output), endedAt: Date.now() });
        state.cursor = stepIndex + 1;
        state.attempts[step.id] = attemptIndex + 1;
        state.outputs[step.id] = result.output;
        state.breadcrumbs.push({ stepId: step.id, kind: step.kind, skill: skill.descriptor.name, status: 'done' });
        state.artifacts[step.id] = { note: result.note ?? null, trace: result.trace ?? null };
        state.planner = (await this.synthesizeModelFrame({ plan, task, state, step, phase: 'success', note: result.note ?? ('completed ' + step.kind) })).planner;
        this.store.recordSnapshot(task.taskId, 'routing', state);
        this.recordLifecycle(task.taskId, 'route', 'executing', 'routing', { stepId: step.id, stepIndex, planner: state.planner?.strategy, note: result.note ?? null });
        return { ok: true, state };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.store.finalizeAttempt(attempt.attemptId, { status: 'failed', errorJson: JSON.stringify({ message: lastError, stepId: step.id, attemptIndex }), endedAt: Date.now() });
        attemptIndex += 1;
        state.attempts[step.id] = attemptIndex;
        state.recovery.push({ stepId: step.id, reason: lastError, at: Date.now() });
        state.planner = (await this.synthesizeModelFrame({ plan, task, state, step, phase: 'failure', note: lastError })).planner;
        this.store.recordSnapshot(task.taskId, 'recovering', state);
        this.recordLifecycle(task.taskId, 'recover', 'executing', 'recovering', { stepId: step.id, attemptIndex, error: lastError, planner: state.planner?.lastRecovery ?? null });
        if (attemptIndex >= step.retryPolicy.maxAttempts) break;
      }
    }

    const compensation = skill.compensate ? await skill.compensate(ctx) : null;
    if (compensation) {
      state.breadcrumbs.push({ stepId: step.id, kind: step.kind, skill: skill.descriptor.name, status: 'compensated' });
      state.artifacts[step.id + ':compensation'] = compensation.output;
    }

    const rollbackState = { restoredFrom: beforeSnapshot.snapshotId, state, error: lastError, compensation: compensation?.output ?? null };
    this.store.recordSnapshot(task.taskId, 'rolled_back', state);
    this.recordLifecycle(task.taskId, 'rollback', 'recovering', 'rolled_back', rollbackState);
    this.store.updateTask(task.taskId, { status: 'rolled_back', currentStepIndex: stepIndex, activeStepId: step.id, resultJson: JSON.stringify(state), errorJson: JSON.stringify({ message: lastError, stepId: step.id, stepIndex }), revision: task.revision + 1 });
    return { ok: false, state, error: lastError ?? 'step failed' };
  }

  async execute(input: TaskInput): Promise<TaskExecutionResult> {
    this.store.upsertTask(input.id, input.objective, 'planning');
    let task = this.store.getTask(input.id)!;
    try {
      const plannerContext = { ...(input.context ?? {}), skillCatalog: this.skillCatalog };
      const semanticIntent = await resolvePlannerIntent(input.objective, plannerContext);
      const planInput: TaskInput = { ...input, context: { ...plannerContext, semanticIntent } };
      let plan = this.store.getPlan(input.id) ?? await this.ensurePlan(planInput);
      task = this.store.getTask(input.id)!;

      const profileFrame = await this.synthesizeModelFrame({ plan, task, phase: 'profile' });
      const executionProfile = profileFrame.executionProfile;
      const graph = buildPokeGraph({ rag: this.rag, working: this.working, episodic: this.episodic });
      let contextPack;
      try {
        contextPack = await graph.run(await this.buildContextState(input, plan));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.recordLifecycle(task.taskId, 'recover', 'routing', 'recovering', { phase: 'graph', error: message, recoveryEvent: (err as any)?.recoveryEvent ?? null });
        this.store.updateTask(task.taskId, { status: 'failed', currentStepIndex: task.currentStepIndex, activeStepId: task.activeStepId, errorJson: JSON.stringify({ message }), revision: task.revision + 1 });
        return { ok: false, taskId: input.id, status: 'failed', plan, state: await this.loadOrCreateState(task, plan, executionProfile), error: message };
      }

      if (contextPack.state.retrieval) this.store.recordRetrieval(input.objective, contextPack.state.retrieval);
      this.working.appendTrail('graph_context_pack_built', { taskId: input.id, primarySource: contextPack.state.executionProfile?.primarySource, retrievalHits: contextPack.state.retrieval?.hits.length ?? 0 });
      const primarySourceFact = this.working.upsertFact('task:' + input.id + ':primary_source', contextPack.state.executionProfile?.primarySource ?? 'integration', 0.95, 'graph');
      this.store.replaceWorkingFact(primarySourceFact);
      const episode = this.episodic.add({ id: randomUUID(), taskId: input.id, category: 'decision', summary: 'built context pack for ' + input.id + ' using ' + (contextPack.state.executionProfile?.primarySource ?? 'integration'), signals: ['graph', 'retrieval', contextPack.state.executionProfile?.primarySource ?? 'integration'], metadata: { planId: plan.taskId, strategy: plan.planner?.strategy } });
      this.store.upsertEpisodicItem(episode);

      this.recordLifecycle(task.taskId, 'plan', 'draft', 'planning', { steps: plan.steps.length, executionProfile, semanticProvider: semanticIntent.nlu.provider });
      this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: task.currentStepIndex, activeStepId: plan.steps[task.currentStepIndex]?.id ?? null, resultJson: task.resultJson ?? JSON.stringify({ ...contextPack.state, objective: plan.objective }), errorJson: null, revision: task.revision + 1 });
      this.recordLifecycle(task.taskId, 'route', 'planning', 'routing', { stepIds: plan.steps.map((step) => step.id), executionProfile, playbookPaths: this.skillPlaybooks.map((playbook) => playbook.instructionPath), planner: plan.planner });

      let state = await this.loadOrCreateState(this.store.getTask(input.id)!, plan, executionProfile);

      while (true) {
        task = this.store.getTask(input.id)!;
        if (task.currentStepIndex >= plan.steps.length) {
          this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: plan.steps.at(-1)?.id ?? null, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
          this.store.recordSnapshot(task.taskId, 'completed', state);
          this.recordLifecycle(task.taskId, 'complete', 'routing', 'completed', { totalSteps: plan.steps.length, executionProfile: state.executionProfile, planner: state.planner?.strategy });
          return { ok: true, taskId: input.id, status: 'completed', plan, state };
        }

        const stepIndex = task.currentStepIndex;
        const step = plan.steps[stepIndex];
        this.store.updateTask(task.taskId, { status: 'executing', activeStepId: step.id, resultJson: JSON.stringify(state), revision: task.revision + 1 });
        this.recordLifecycle(task.taskId, 'execute', 'routing', 'executing', { stepId: step.id, stepIndex, playbook: getSkillPlaybook(step.skill as any), planner: state.planner?.strategy, kind: stepKindLabel(step) });

        const outcome = await this.runStep(this.store.getTask(input.id)!, plan, state, stepIndex);
        state = outcome.state;
        task = this.store.getTask(input.id)!;
        if (!outcome.ok) return { ok: false, taskId: input.id, status: 'rolled_back', plan, state, error: outcome.error };

        if (stepIndex === plan.steps.length - 1) {
          this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: step.id, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
          this.store.recordSnapshot(task.taskId, 'completed', state);
          this.recordLifecycle(task.taskId, 'complete', 'routing', 'completed', { stepId: step.id, totalSteps: plan.steps.length, executionProfile: state.executionProfile, planner: state.planner?.strategy });
          return { ok: true, taskId: input.id, status: 'completed', plan, state };
        }

        this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: stepIndex + 1, activeStepId: plan.steps[stepIndex + 1]?.id ?? null, resultJson: JSON.stringify(state), revision: task.revision + 1 });
        this.recordLifecycle(task.taskId, 'route', 'executing', 'routing', { stepId: step.id, nextStepId: plan.steps[stepIndex + 1]?.id ?? null, executionProfile: state.executionProfile, planner: state.planner?.strategy });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordLifecycle(task.taskId, 'fail', 'draft', 'failed', { phase: 'planning', error: message, recoveryEvent: (err as any)?.recoveryEvent ?? null });
      this.store.updateTask(task.taskId, { status: 'failed', errorJson: JSON.stringify({ message }), revision: task.revision + 1 });
      throw err;
    }
  }
}
