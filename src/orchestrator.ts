import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER } from './search/nlu';
import { parseModelJson } from './llm-bridge';
import { EpisodicMemory } from './memory/episodic-memory';
import { WorkingMemory } from './memory/working-memory';
import { RagCorpus } from './rag/retriever';
import { listSkillPlaybooks } from './skill-playbooks';
import type { ExecutionProfile, RuntimeState, TaskInput, TaskPlan, TaskStatus } from './types';
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

type OrchestrationDirective = {
  ok?: boolean;
  status?: TaskStatus;
  plan?: TaskPlan;
  state?: RuntimeState;
  error?: string | null;
  note?: string | null;
  rationale?: string[];
  executionProfile?: ExecutionProfile;
};

const ORCHESTRATION_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { enum: ['draft', 'planning', 'routing', 'executing', 'recovering', 'completed', 'failed', 'rolled_back'] },
    plan: { type: 'object' },
    state: { type: 'object' },
    error: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    rationale: { type: 'array', items: { type: 'string' } },
    executionProfile: { type: 'object' },
  },
} as const;

async function delegateOrchestration(input: {
  taskInput: TaskInput;
  skills: SkillAdapter[];
  skillPlaybooks: ReturnType<typeof listSkillPlaybooks>;
}): Promise<OrchestrationDirective> {
  const raw = await DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.extract({
    objective: 'decide the full task execution trajectory directly in the model output; produce the plan, state, status, and any execution profile without relying on a hardcoded orchestrator loop',
    context: {
      taskInput: input.taskInput,
      skillCatalog: input.skills.map((skill) => skill.descriptor),
      skillPlaybooks: input.skillPlaybooks,
      memory: {
        rag: 'available',
        working: 'available',
        episodic: 'available',
      },
    },
    schema: ORCHESTRATION_SCHEMA,
  });
  return parseModelJson<OrchestrationDirective>(raw);
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

  async execute(input: TaskInput): Promise<TaskExecutionResult> {
    const directive = await delegateOrchestration({
      taskInput: input,
      skills: this.skills,
      skillPlaybooks: this.skillPlaybooks,
    });

    if (!directive.plan || !directive.state) {
      throw new Error('orchestration-model-missing-plan-or-state');
    }

    const status = directive.status ?? (directive.ok === false ? 'failed' : 'completed');
    return {
      ok: directive.ok ?? status === 'completed',
      taskId: input.id,
      status,
      plan: directive.plan,
      state: directive.state,
      error: directive.error ?? undefined,
    };
  }
}
