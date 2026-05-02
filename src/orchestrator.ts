import { randomUUID } from 'node:crypto';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER } from './search/nlu';
import { buildPlan, cloneIntentGraph, createPlannerRuntimeState, deriveExecutionProfile, markPlannerStepOutcome, notePlannerRecovery, resolvePlannerIntent, updatePlannerRuntimeState } from './planner';
import { buildPokeGraph, type PokeGraphState } from './graph';
import { RagCorpus } from './rag/retriever';
import { EpisodicMemory } from './memory/episodic-memory';
import { WorkingMemory } from './memory/working-memory';
import { getSkillPlaybook, listSkillPlaybooks } from './skill-playbooks';
import { validatePlan, validateSkillResult } from './validator';
import { classifyTransition, isTerminal, transition } from './state-machine';
import type { ExecutionContext, ExecutionProfile, RuntimeState, StepAttempt, TaskInput, TaskPlan, TaskRecord, TaskStatus } from './types';
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

type AffordanceEvaluation = {
  selectedAdapterName: string;
  confidence: number;
  rationale: string[];
  rankedAdapters: Array<{ name: string; score: number; reason: string[]; invoke: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];
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

  private async evaluateSkillAdapterAffordance(adapterCandidates: SkillAdapter[], step: TaskPlan['steps'][number], plan: TaskPlan, state: RuntimeState): Promise<AffordanceEvaluation> {
    const provider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
    const raw = await provider.extract({
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
    if (!isRecord(raw)) throw new Error('invalid-affordance-evaluation:' + provider.name);
    const ranked = toStringArray(raw.rationale); // touch early for validation below
    void ranked;
    const entries = Array.isArray(raw.rankedAdapters) ? raw.rankedAdapters : null;
    if (!entries || entries.length === 0) throw new Error('invalid-affordance-evaluation:' + provider.name);
    const normalized = entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.score !== 'number' || !Array.isArray(entry.reason) || typeof entry.invoke !== 'boolean') {
        throw new Error('invalid-affordance-evaluation:' + provider.name);
      }
      return { name: entry.name, score: entry.score, reason: toStringArray(entry.reason), invoke: entry.invoke };
    }).sort((left, right) => right.score - left.score);
    const selectedName = typeof raw.selectedAdapterName === 'string' ? raw.selectedAdapterName : normalized[0]!.name;
    const selected = normalized.find((entry) => entry.name === selectedName && entry.invoke) ?? normalized.find((entry) => entry.invoke) ?? normalized[0];
    if (!selected) throw new Error('no-adapter-selected:' + provider.name);
    return {
      selectedAdapterName: selected.name,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : selected.score,
      rationale: toStringArray(raw.rationale),
      rankedAdapters: normalized,
    };
  }

  private async resolveSkill(step: TaskPlan['steps'][number], plan: TaskPlan, state: RuntimeState): Promise<SkillAdapter> {
    const candidates = this.skills.filter((candidate) => candidate.canHandle(step));
    if (candidates.length === 0) throw new Error('no skill adapter can handle step ' + step.id + ' (' + step.kind + ')');
    const evaluation = await this.evaluateSkillAdapterAffordance(candidates, step, plan, state);
    const selected = candidates.find((candidate) => candidate.descriptor.name === evaluation.selectedAdapterName);
    if (!selected) throw new Error('invalid-affordance-evaluation:' + provider.name);
    return selected;
  }

  private async ensurePlan(input: TaskInput): Promise<TaskPlan> {
    const plan = await buildPlan(input);
    const validation = validatePlan(plan.steps);
    if (!validation.ok) throw new Error(validation.reasons.join('; '));
    this.store.savePlan(plan);
    return plan;
  }

  private buildContextState(input: TaskInput, plan: TaskPlan, executionProfile: ExecutionProfile): PokeGraphState {
    return {
      objective: plan.objective,
      cursor: 0,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      query: input.objective + '\n' + JSON.stringify(input.context ?? {}),
      executionProfile,
      semanticIntent: plan.semanticIntent,
      intentGraph: cloneIntentGraph(plan.intentGraph),
      planner: createPlannerRuntimeState(plan),
      sessionKey: plan.semanticIntent?.sessionKey,
    };
  }

  private loadOrCreateState(task: TaskRecord, plan: TaskPlan, profile: ExecutionProfile): RuntimeState {
    const existing = task.resultJson ? JSON.parse(task.resultJson) as RuntimeState : null;
    if (existing) {
      return {
        ...existing,
        executionProfile: existing.executionProfile ?? profile,
        semanticIntent: existing.semanticIntent ?? plan.semanticIntent,
        intentGraph: existing.intentGraph ?? cloneIntentGraph(plan.intentGraph),
        planner: existing.planner ?? createPlannerRuntimeState(plan),
      };
    }
    return {
      objective: plan.objective,
      cursor: task.currentStepIndex,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      executionProfile: profile,
      semanticIntent: plan.semanticIntent,
      intentGraph: cloneIntentGraph(plan.intentGraph),
      planner: createPlannerRuntimeState(plan),
    };
  }

  private persistTransition(taskId: string, from: TaskStatus | null, to: TaskStatus | null, detail: unknown) {
    const kind = from && to ? classifyTransition(from, to) : 'validate';
    this.store.recordEvent(taskId, kind, from, to, detail);
  }

  private createAttempt(taskId: string, stepId: string, attemptIndex: number, skill: string, input: unknown): StepAttempt {
    return { attemptId: randomUUID(), taskId, stepId, attemptIndex, status: 'started', skill, inputJson: JSON.stringify(input), outputJson: null, errorJson: null, startedAt: Date.now(), endedAt: null };
  }

  private async runStep(task: TaskRecord, plan: TaskPlan, state: RuntimeState, stepIndex: number): Promise<{ ok: boolean; state: RuntimeState; error?: string }> {
    const step = plan.steps[stepIndex];
    const beforeSnapshot = this.store.recordSnapshot(task.taskId, 'executing', state);
    this.persistTransition(task.taskId, task.status, 'executing', { stepId: step.id, snapshotId: beforeSnapshot.snapshotId, stepIndex });

    let skill: SkillAdapter;
    try {
      skill = await this.resolveSkill(step, plan, state);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      state.recovery.push({ stepId: step.id, reason, at: Date.now() });
      this.persistTransition(task.taskId, 'executing', 'recovering', { stepId: step.id, phase: 'affordance-evaluation', error: reason, recoveryEvent: (err as any)?.recoveryEvent ?? null });
      throw err;
    }

    const ctx: ExecutionContext = { taskId: task.taskId, task, plan, step, state };
    state.planner = state.planner ? { ...state.planner, currentNodeId: step.id, notes: [...state.planner.notes, 'active:' + step.id] } : createPlannerRuntimeState(plan);
    let attemptIndex = state.attempts[step.id] ?? 0;
    let lastError: string | null = null;

    while (attemptIndex < step.retryPolicy.maxAttempts) {
      const attempt = this.createAttempt(task.taskId, step.id, attemptIndex, skill.descriptor.name, step.args);
      this.store.recordAttempt(attempt);
      try {
        const result = await skill.execute(ctx);
        const validation = validateSkillResult(result);
        if (!validation.ok) throw new Error(validation.reasons.join('; '));
        this.store.finalizeAttempt(attempt.attemptId, { status: 'succeeded', outputJson: JSON.stringify(result.output), endedAt: Date.now() });
        state.cursor = stepIndex + 1;
        state.attempts[step.id] = attemptIndex + 1;
        state.outputs[step.id] = result.output;
        state.breadcrumbs.push({ stepId: step.id, kind: step.kind, skill: skill.descriptor.name, status: 'done' });
        state.artifacts[step.id] = { note: result.note ?? null, trace: result.trace ?? null };
        state.intentGraph = markPlannerStepOutcome(state.intentGraph ?? plan.intentGraph, step.id, 'done', result.note ?? ('completed ' + step.kind));
        state.planner = updatePlannerRuntimeState(state.planner, plan, step.id, 'done', result.note ?? ('completed ' + step.kind));
        this.store.recordSnapshot(task.taskId, 'routing', state);
        this.persistTransition(task.taskId, 'executing', 'routing', { stepId: step.id, stepIndex, validation, planner: state.planner?.strategy });
        return { ok: true, state };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.store.finalizeAttempt(attempt.attemptId, { status: 'failed', errorJson: JSON.stringify({ message: lastError, stepId: step.id, attemptIndex }), endedAt: Date.now() });
        attemptIndex += 1;
        state.attempts[step.id] = attemptIndex;
        state.recovery.push({ stepId: step.id, reason: lastError, at: Date.now() });
        state.intentGraph = markPlannerStepOutcome(state.intentGraph ?? plan.intentGraph, step.id, 'failed', lastError);
        state.planner = notePlannerRecovery(state.planner, step.id, lastError);
        this.store.recordSnapshot(task.taskId, 'recovering', state);
        this.persistTransition(task.taskId, 'executing', 'recovering', { stepId: step.id, attemptIndex, error: lastError, planner: state.planner?.lastRecovery });
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
    this.persistTransition(task.taskId, 'recovering', 'rolled_back', rollbackState);
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
      if (!plan.semanticIntent || !plan.intentGraph || !plan.planner) {
        const hydrated = await buildPlan(planInput);
        plan = { ...plan, semanticIntent: plan.semanticIntent ?? hydrated.semanticIntent, intentGraph: plan.intentGraph ?? hydrated.intentGraph, planner: plan.planner ?? hydrated.planner };
        this.store.savePlan(plan);
      }

      task = this.store.getTask(input.id)!;
      if (isTerminal(task.status)) throw new Error('task ' + input.id + ' is already terminal: ' + task.status);

      const planValidation = validatePlan(plan.steps);
      if (!planValidation.ok) throw new Error(planValidation.reasons.join('; '));

      const executionProfile = deriveExecutionProfile(plan);
      const graph = buildPokeGraph({ rag: this.rag, working: this.working, episodic: this.episodic });
      let contextPack;
      try {
        contextPack = await graph.run(this.buildContextState(input, plan, executionProfile));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.persistTransition(task.taskId, 'routing', 'recovering', { phase: 'graph', error: message, recoveryEvent: (err as any)?.recoveryEvent ?? null });
        this.store.updateTask(task.taskId, { status: 'failed', currentStepIndex: task.currentStepIndex, activeStepId: task.activeStepId, errorJson: JSON.stringify({ message }), revision: task.revision + 1 });
        return { ok: false, taskId: input.id, status: 'failed', plan, state: this.loadOrCreateState(task, plan, executionProfile), error: message };
      }

      if (contextPack.state.retrieval) this.store.recordRetrieval(input.objective, contextPack.state.retrieval);
      this.working.appendTrail('graph_context_pack_built', { taskId: input.id, primarySource: contextPack.state.executionProfile?.primarySource, retrievalHits: contextPack.state.retrieval?.hits.length ?? 0 });
      const primarySourceFact = this.working.upsertFact('task:' + input.id + ':primary_source', contextPack.state.executionProfile?.primarySource ?? 'integration', 0.95, 'graph');
      this.store.replaceWorkingFact(primarySourceFact);
      const episode = this.episodic.add({ id: randomUUID(), taskId: input.id, category: 'decision', summary: 'built context pack for ' + input.id + ' using ' + (contextPack.state.executionProfile?.primarySource ?? 'integration'), signals: ['graph', 'retrieval', contextPack.state.executionProfile?.primarySource ?? 'integration'], metadata: { planId: plan.taskId, strategy: plan.planner?.strategy } });
      this.store.upsertEpisodicItem(episode);

      this.persistTransition(task.taskId, 'draft', 'planning', { steps: plan.steps.length, score: planValidation.score, executionProfile, semanticProvider: semanticIntent.nlu.provider });
      this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: task.currentStepIndex, activeStepId: plan.steps[task.currentStepIndex]?.id ?? null, resultJson: task.resultJson ?? JSON.stringify({ ...contextPack.state, objective: plan.objective }), errorJson: null, revision: task.revision + 1 });
      this.persistTransition(task.taskId, 'planning', 'routing', { stepIds: plan.steps.map((step) => step.id), executionProfile, playbookPaths: this.skillPlaybooks.map((playbook) => playbook.instructionPath), planner: plan.planner });

      let state = this.loadOrCreateState(this.store.getTask(input.id)!, plan, executionProfile);

      while (true) {
        task = this.store.getTask(input.id)!;
        if (task.currentStepIndex >= plan.steps.length) {
          this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: plan.steps.at(-1)?.id ?? null, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
          this.store.recordSnapshot(task.taskId, 'completed', state);
          this.persistTransition(task.taskId, 'routing', 'completed', { totalSteps: plan.steps.length, executionProfile: state.executionProfile, planner: state.planner?.strategy });
          return { ok: true, taskId: input.id, status: 'completed', plan, state };
        }

        const stepIndex = task.currentStepIndex;
        const step = plan.steps[stepIndex];
        const routeTransition = transition(task.status, 'executing');
        if (!routeTransition.ok) throw new Error(routeTransition.reason ?? 'unable to advance to executing');
        this.store.updateTask(task.taskId, { status: 'executing', activeStepId: step.id, resultJson: JSON.stringify(state), revision: task.revision + 1 });
        this.persistTransition(task.taskId, 'routing', 'executing', { stepId: step.id, stepIndex, playbook: getSkillPlaybook(step.skill as any), planner: state.planner?.strategy });

        const outcome = await this.runStep(this.store.getTask(input.id)!, plan, state, stepIndex);
        state = outcome.state;
        task = this.store.getTask(input.id)!;
        if (!outcome.ok) return { ok: false, taskId: input.id, status: 'rolled_back', plan, state, error: outcome.error };

        if (stepIndex === plan.steps.length - 1) {
          this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: step.id, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
          this.store.recordSnapshot(task.taskId, 'completed', state);
          this.persistTransition(task.taskId, 'routing', 'completed', { stepId: step.id, totalSteps: plan.steps.length, executionProfile: state.executionProfile, planner: state.planner?.strategy });
          return { ok: true, taskId: input.id, status: 'completed', plan, state };
        }

        const backToRouting = transition(task.status, 'routing');
        if (!backToRouting.ok) throw new Error(backToRouting.reason ?? 'unable to return to routing');
        this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: stepIndex + 1, activeStepId: plan.steps[stepIndex + 1]?.id ?? null, resultJson: JSON.stringify(state), revision: task.revision + 1 });
        this.persistTransition(task.taskId, 'executing', 'routing', { stepId: step.id, nextStepId: plan.steps[stepIndex + 1]?.id ?? null, executionProfile: state.executionProfile, planner: state.planner?.strategy });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.persistTransition(task.taskId, 'draft', 'recovering', { phase: 'planning', error: message, recoveryEvent: (err as any)?.recoveryEvent ?? null });
      this.store.updateTask(task.taskId, { status: 'failed', errorJson: JSON.stringify({ message }), revision: task.revision + 1 });
      throw err;
    }
  }
}
