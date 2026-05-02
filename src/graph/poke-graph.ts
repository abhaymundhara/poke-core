import { GraphExecutor, type GraphNode } from './executor';
import type { ExecutionProfile, PlannerRecoveryPolicy, RuntimeState } from '../types';
import type { RagCorpus } from '../rag/retriever';
import type { WorkingMemory } from '../memory/working-memory';
import type { EpisodicMemory } from '../memory/episodic-memory';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, type SemanticNluProvider } from '../search/nlu';
import { parseModelJson } from '../llm-bridge';

export type PokeGraphState = RuntimeState & {
  query: string;
  eventJournal?: Array<{ stepId?: string; kind?: string; status?: string; reason?: string; at?: number; detail?: unknown }>;
  recoveryPolicy?: PlannerRecoveryPolicy;
  recoverySignals?: string[];
  latentGoals?: string[];
  retrieval?: ReturnType<RagCorpus['retrieve']>;
  workingSnapshot?: ReturnType<WorkingMemory['snapshot']>;
  episodicRecall?: ReturnType<EpisodicMemory['recall']>;
  executionProfile?: ExecutionProfile;
  sessionKey?: string;
};

type RecoveryTrajectoryDraft = {
  recoveryPolicy: PlannerRecoveryPolicy;
  recoverySignals: string[];
  latentGoals: string[];
  executionProfile: ExecutionProfile;
  trajectoryNotes: string[];
};

const RECOVERY_SCHEMA = {
  type: 'object',
  required: ['recoveryPolicy', 'recoverySignals', 'latentGoals', 'executionProfile', 'trajectoryNotes'],
  properties: {
    recoveryPolicy: { type: 'object' },
    recoverySignals: { type: 'array', items: { type: 'string' } },
    latentGoals: { type: 'array', items: { type: 'string' } },
    executionProfile: { type: 'object' },
    trajectoryNotes: { type: 'array', items: { type: 'string' } },
  },
};

function journalSnapshot(state: PokeGraphState): Array<Record<string, unknown>> {
  return Array.isArray(state.eventJournal) ? state.eventJournal : [];
}

export class RecoveryPlanner {
  constructor(private provider: SemanticNluProvider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER) {}

  async synthesize(state: PokeGraphState): Promise<RecoveryTrajectoryDraft> {
    const raw = await this.provider.extract({
      objective: 'synthesize a recovery trajectory from the event journal',
      context: {
        objective: state.objective,
        query: state.query,
        sessionKey: state.sessionKey ?? state.semanticIntent?.sessionKey ?? state.intentGraph?.id ?? state.objective,
        eventJournal: journalSnapshot(state),
        breadcrumbs: state.breadcrumbs ?? [],
        recovery: state.recovery ?? [],
        latentGoals: state.latentGoals ?? [],
        intentGraph: state.intentGraph ?? null,
        semanticIntent: state.semanticIntent ?? null,
        executionProfile: state.executionProfile ?? null,
      },
      schema: RECOVERY_SCHEMA,
    });
    return parseModelJson<RecoveryTrajectoryDraft>(raw);
  }
}

export function buildPokeGraph(deps: { rag: RagCorpus; working: WorkingMemory; episodic: EpisodicMemory; }) {
  const recoveryPlanner = new RecoveryPlanner();
  const nodes: GraphNode<PokeGraphState>[] = [
    {
      id: 'recovery-plan',
      name: 'synthesize recovery trajectory',
      run: async (state) => {
        const synthesis = await recoveryPlanner.synthesize(state);
        return {
          ...state,
          eventJournal: journalSnapshot(state),
          recoveryPolicy: synthesis.recoveryPolicy,
          recoverySignals: synthesis.recoverySignals,
          latentGoals: synthesis.latentGoals,
          executionProfile: synthesis.executionProfile,
          artifacts: {
            ...(state.artifacts ?? {}),
            recoveryTrajectory: synthesis.trajectoryNotes,
          },
        };
      },
    },
    {
      id: 'profile',
      name: 'validate recovery profile',
      run: (state) => {
        if (!state.executionProfile) throw new Error('recovery execution profile missing');
        return state;
      },
    },
    {
      id: 'recall-working',
      name: 'recall working memory',
      run: (state) => ({ ...state, workingSnapshot: deps.working.snapshot() }),
    },
    {
      id: 'recall-episodic',
      name: 'recall episodic memory',
      run: (state) => ({ ...state, episodicRecall: deps.episodic.recall(state.query, 12) }),
    },
    {
      id: 'retrieve-rag',
      name: 'retrieve knowledge',
      retryPolicy: { maxAttempts: 2, retryableErrors: ['timeout', 'temporary'] },
      run: (state) => ({ ...state, retrieval: deps.rag.retrieve({ query: state.query, k: 8, boost: { recency: 0.3, salience: 0.25, exactPhrase: 0.4, title: 0.2 } }) }),
    },
    {
      id: 'synthesize',
      name: 'synthesize context',
      run: (state) => {
        const snippets = [
          ...(state.retrieval?.hits ?? []).map((hit: any) => hit.excerpt),
          ...(state.episodicRecall ?? []).map((item: any) => item.summary),
        ];
        return {
          ...state,
          artifacts: {
            ...(state.artifacts ?? {}),
            contextPack: snippets.slice(0, 12).join('
'),
          },
        };
      },
    },
  ];
  const edges = [
    { from: 'recovery-plan', to: 'profile' },
    { from: 'profile', to: 'recall-working' },
    { from: 'recall-working', to: 'recall-episodic' },
    { from: 'recall-episodic', to: 'retrieve-rag' },
    { from: 'retrieve-rag', to: 'synthesize' },
  ];
  return new GraphExecutor(nodes, edges);
}
