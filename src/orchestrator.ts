import { randomUUID } from 'node:crypto';
import { buildPlan } from './planner';
import { SkillRouter } from './router';
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

export class PokeCoreOrchestrator {
  private router: SkillRouter;
  private rag = new RagCorpus();
  private working = new WorkingMemory();
  private episodic = new EpisodicMemory();

  constructor(private store: PokeCoreStore, skills: SkillAdapter[]) {
    this.router = new SkillRouter(skills);
  }

  get skillCatalog() {
    return this.router.descriptors();
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

  private inferPrimarySource(input: TaskInput, plan: TaskPlan): ExecutionProfile {
    const haystack = `${input.objective} ${JSON.stringify(input.context ?? {})}`.toLowerCase();
    const scores = new Map<string, number>([
      ['email', 0],
      ['calendar', 0],
      ['browser', 0],
      ['filesystem', 0],
      ['integration', 0],
    ]);

    const bump = (key: string, amount: number) => scores.set(key, (scores.get(key) ?? 0) + amount);
    if (/(email|inbox|thread|reply|forward|mail|gmail|outlook)/.test(haystack)) bump('email', 4);
    if (/(calendar|meeting|schedule|reschedule|availability|timezone|event)/.test(haystack)) bump('calendar', 4);
    if (/(browser|web|site|page|url|navigate|click|extract)/.test(haystack)) bump('browser', 4);
    if (/(file|filesystem|folder|directory|path|write|read|diff|export)/.test(haystack)) bump('filesystem', 4);
    if (/(github|notion|linear|todoist|vercel|slack|integration|repo|issue)/.test(haystack)) bump('integration', 4);

    for (const step of plan.steps) {
      bump(step.skill, 2);
      if (step.kind === 'browser.navigate' || step.kind === 'browser.extract') bump('browser', 1);
      if (step.kind === 'integration.call') bump('integration', 1);
    }

    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [primarySource = 'integration'] = ordered.map(([name]) => name);
    const secondarySources = ordered.map(([name]) => name).filter((name) => name !== primarySource && (scores.get(name) ?? 0) > 0);
    const parallelizable = secondarySources.length > 0 && primarySource !== 'calendar';
    const rationale = ordered.filter(([, score]) => score > 0).map(([name, score]) => `${name}:${score}`);
    return { primarySource, secondarySources, parallelizable, rationale };
  }

  private ensurePlan(input: TaskInput): TaskPlan {
    const plan = buildPlan(input);
    const validation = validatePlan(plan.steps);
    if (!validation.ok) throw new Error(validation.reasons.join('; '));
    this.store.savePlan(plan);
    return plan;
  }

  private buildContextState(input: TaskInput, plan: TaskPlan, executionProfile: ExecutionProfile): PokeGraphState {
    const initial: PokeGraphState = {
      objective: plan.objective,
      cursor: 0,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      query: `${input.objective}\n${JSON.stringify(input.context ?? {})}`,
      executionProfile,
    };
    return initial;
  }

  private loadOrCreateState(task: TaskRecord, plan: TaskPlan, profile: ExecutionProfile): RuntimeState {
    const existing = task.resultJson ? JSON.parse(task.resultJson) as RuntimeState : null;
    if (existing) return { ...existing, executionProfile: existing.executionProfile ?? profile };
    return {
      objective: plan.objective,
      cursor: task.currentStepIndex,
      attempts: {},
      outputs: {},
      artifacts: {},
      breadcrumbs: [],
      recovery: [],
      executionProfile: profile,
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

    const skill = this.router.resolve(step);
    const ctx: ExecutionContext = { taskId: task.taskId, task, plan, step, state };
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
        this.store.recordSnapshot(task.taskId, 'routing', state);
        this.persistTransition(task.taskId, 'executing', 'routing', { stepId: step.id, stepIndex, validation });
        return { ok: true, state };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.store.finalizeAttempt(attempt.attemptId, { status: 'failed', errorJson: JSON.stringify({ message: lastError, stepId: step.id, attemptIndex }), endedAt: Date.now() });
        attemptIndex += 1;
        state.attempts[step.id] = attemptIndex;
        state.recovery.push({ stepId: step.id, reason: lastError, at: Date.now() });
        this.store.recordSnapshot(task.taskId, 'recovering', state);
        this.persistTransition(task.taskId, 'executing', 'recovering', { stepId: step.id, attemptIndex, error: lastError });
        if (attemptIndex >= step.retryPolicy.maxAttempts) break;
      }
    }

    const compensation = skill.compensate ? await skill.compensate(ctx) : null;
    if (compensation) {
      state.breadcrumbs.push({ stepId: step.id, kind: step.kind, skill: skill.descriptor.name, status: 'compensated' });
      state.artifacts[`${step.id}:compensation`] = compensation.output;
    }

    const rollbackState = { restoredFrom: beforeSnapshot.snapshotId, state, error: lastError, compensation: compensation?.output ?? null };
    this.store.recordSnapshot(task.taskId, 'rolled_back', state);
    this.persistTransition(task.taskId, 'recovering', 'rolled_back', rollbackState);
    this.store.updateTask(task.taskId, { status: 'rolled_back', currentStepIndex: stepIndex, activeStepId: step.id, resultJson: JSON.stringify(state), errorJson: JSON.stringify({ message: lastError, stepId: step.id, stepIndex }), revision: task.revision + 1 });
    return { ok: false, state, error: lastError ?? 'step failed' };
  }

  async execute(input: TaskInput): Promise<TaskExecutionResult> {
    this.store.upsertTask(input.id, input.objective, 'planning');
    const plan = this.store.getPlan(input.id) ?? this.ensurePlan(input);
    let task = this.store.getTask(input.id)!;
    if (isTerminal(task.status)) throw new Error(`task ${input.id} is already terminal: ${task.status}`);

    const planValidation = validatePlan(plan.steps);
    if (!planValidation.ok) throw new Error(planValidation.reasons.join('; '));

    const executionProfile = this.inferPrimarySource(input, plan);
    const graph = buildPokeGraph({ rag: this.rag, working: this.working, episodic: this.episodic });
    const contextPack = await graph.run(this.buildContextState(input, plan, executionProfile));
    if (contextPack.state.retrieval) this.store.recordRetrieval(input.objective, contextPack.state.retrieval);
    this.working.appendTrail('graph_context_pack_built', { taskId: input.id, primarySource: contextPack.state.executionProfile?.primarySource, retrievalHits: contextPack.state.retrieval?.hits.length ?? 0 });
    const primarySourceFact = this.working.upsertFact(`task:${input.id}:primary_source`, contextPack.state.executionProfile?.primarySource ?? 'integration', 0.95, 'graph');
    this.store.replaceWorkingFact(primarySourceFact);
    const episode = this.episodic.add({ id: randomUUID(), taskId: input.id, category: 'decision', summary: 'built context pack for ' + input.id + ' using ' + (contextPack.state.executionProfile?.primarySource ?? 'integration'), signals: ['graph', 'retrieval', contextPack.state.executionProfile?.primarySource ?? 'integration'], score: 0.9 });
    this.store.upsertEpisodicItem(episode);

    this.persistTransition(task.taskId, 'draft', 'planning', { steps: plan.steps.length, score: planValidation.score, executionProfile });
    this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: task.currentStepIndex, activeStepId: plan.steps[task.currentStepIndex]?.id ?? null, resultJson: task.resultJson ?? JSON.stringify({ ...contextPack.state, objective: plan.objective }), errorJson: null, revision: task.revision + 1 });
    this.persistTransition(task.taskId, 'planning', 'routing', { stepIds: plan.steps.map((step) => step.id), executionProfile, playbookPaths: this.skillPlaybooks.map((playbook) => playbook.instructionPath) });

    let state = this.loadOrCreateState(this.store.getTask(input.id)!, plan, executionProfile);

    while (true) {
      task = this.store.getTask(input.id)!;
      if (task.currentStepIndex >= plan.steps.length) {
        this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: plan.steps.at(-1)?.id ?? null, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
        this.store.recordSnapshot(task.taskId, 'completed', state);
        this.persistTransition(task.taskId, 'routing', 'completed', { totalSteps: plan.steps.length, executionProfile: state.executionProfile });
        return { ok: true, taskId: input.id, status: 'completed', plan, state };
      }

      const stepIndex = task.currentStepIndex;
      const step = plan.steps[stepIndex];
      const routeTransition = transition(task.status, 'executing');
      if (!routeTransition.ok) throw new Error(routeTransition.reason ?? 'unable to advance to executing');
      this.store.updateTask(task.taskId, { status: 'executing', activeStepId: step.id, resultJson: JSON.stringify(state), revision: task.revision + 1 });
      this.persistTransition(task.taskId, 'routing', 'executing', { stepId: step.id, stepIndex, playbook: getSkillPlaybook(step.skill as any) });

      const outcome = await this.runStep(this.store.getTask(input.id)!, plan, state, stepIndex);
      state = outcome.state;
      task = this.store.getTask(input.id)!;
      if (!outcome.ok) return { ok: false, taskId: input.id, status: 'rolled_back', plan, state, error: outcome.error };

      if (stepIndex === plan.steps.length - 1) {
        this.store.updateTask(task.taskId, { status: 'completed', currentStepIndex: plan.steps.length, activeStepId: step.id, resultJson: JSON.stringify(state), errorJson: null, revision: task.revision + 1 });
        this.store.recordSnapshot(task.taskId, 'completed', state);
        this.persistTransition(task.taskId, 'routing', 'completed', { stepId: step.id, totalSteps: plan.steps.length, executionProfile: state.executionProfile });
        return { ok: true, taskId: input.id, status: 'completed', plan, state };
      }

      const backToRouting = transition(task.status, 'routing');
      if (!backToRouting.ok) throw new Error(backToRouting.reason ?? 'unable to return to routing');
      this.store.updateTask(task.taskId, { status: 'routing', currentStepIndex: stepIndex + 1, activeStepId: plan.steps[stepIndex + 1]?.id ?? null, resultJson: JSON.stringify(state), revision: task.revision + 1 });
      this.persistTransition(task.taskId, 'executing', 'routing', { stepId: step.id, nextStepId: plan.steps[stepIndex + 1]?.id ?? null, executionProfile: state.executionProfile });
    }
  }
}
