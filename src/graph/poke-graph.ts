import { GraphExecutor, type GraphNode } from './executor';
import type { ExecutionProfile, PlannerRecoveryPolicy, RuntimeState } from '../types';
import type { RagCorpus } from '../rag/retriever';
import type { WorkingMemory } from '../memory/working-memory';
import type { EpisodicMemory } from '../memory/episodic-memory';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, type SemanticNluProvider } from '../search/nlu';
import { inferLatentGoalsFromTrajectory } from '../planner';

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
  executionProfile: ExecutionProfile;
  trajectoryNotes: string[];
};

const RECOVERY_SCHEMA = {
  type: 'object',
  required: ['recoveryPolicy', 'recoverySignals', 'executionProfile', 'trajectoryNotes'],
  properties: {
    recoveryPolicy: {
      type: 'object',
      required: ['mode', 'maxReplans', 'maxAttemptsPerStep', 'blockedKinds', 'fallbackSkills', 'recoveryNotes'],
      properties: {
        mode: { enum: ['retry', 'replan', 'compensate', 'escalate'] },
        maxReplans: { type: 'integer', minimum: 0, maximum: 10 },
        maxAttemptsPerStep: { type: 'integer', minimum: 1, maximum: 10 },
        blockedKinds: { type: 'array', items: { type: 'string' } },
        fallbackSkills: { type: 'array', items: { type: 'string' } },
        recoveryNotes: { type: 'array', items: { type: 'string' } },
      },
    },
    recoverySignals: { type: 'array', items: { type: 'string' } },
    executionProfile: {
      type: 'object',
      required: ['primarySource', 'secondarySources', 'parallelizable', 'rationale'],
      properties: {
        primarySource: { type: 'string' },
        secondarySources: { type: 'array', items: { type: 'string' } },
        parallelizable: { type: 'boolean' },
        rationale: { type: 'array', items: { type: 'string' } },
        strategy: { type: 'string' },
        affordanceSignals: { type: 'array' },
      },
    },
    trajectoryNotes: { type: 'array', items: { type: 'string' } },
  },
} as const;

function normalizeJournal(state: PokeGraphState): NonNullable<PokeGraphState['eventJournal']> {
  if (Array.isArray(state.eventJournal) && state.eventJournal.length > 0) return state.eventJournal;
  return (state.recovery ?? []).map((entry) => ({ stepId: entry.stepId, kind: 'recovery', status: 'failed', reason: entry.reason, at: entry.at, detail: entry }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];
}

function normalizeRecoveryDraft(value: unknown, provider: string): RecoveryTrajectoryDraft {
  if (!isRecord(value)) throw new Error('invalid-recovery-draft:' + provider);
  const policy = value.recoveryPolicy;
  const executionProfile = value.executionProfile;
  if (!isRecord(policy) || !isRecord(executionProfile)) throw new Error('invalid-recovery-draft:' + provider);
  if (!Array.isArray(policy.blockedKinds) || !Array.isArray(policy.fallbackSkills) || !Array.isArray(policy.recoveryNotes) || !Array.isArray(value.recoverySignals) || !Array.isArray(value.trajectoryNotes)) {
    throw new Error('invalid-recovery-draft:' + provider);
  }
  if (typeof executionProfile.primarySource !== 'string' || !Array.isArray(executionProfile.secondarySources) || typeof executionProfile.parallelizable !== 'boolean' || !Array.isArray(executionProfile.rationale)) {
    throw new Error('invalid-recovery-draft:' + provider);
  }
  return {
    recoveryPolicy: {
      mode: policy.mode as PlannerRecoveryPolicy['mode'],
      maxReplans: Number(policy.maxReplans),
      maxAttemptsPerStep: Number(policy.maxAttemptsPerStep),
      blockedKinds: toStringArray(policy.blockedKinds) as PlannerRecoveryPolicy['blockedKinds'],
      fallbackSkills: toStringArray(policy.fallbackSkills),
      recoveryNotes: toStringArray(policy.recoveryNotes),
    },
    recoverySignals: toStringArray(value.recoverySignals),
    executionProfile: {
      primarySource: executionProfile.primarySource,
      secondarySources: toStringArray(executionProfile.secondarySources),
      parallelizable: Boolean(executionProfile.parallelizable),
      rationale: toStringArray(executionProfile.rationale),
      strategy: typeof executionProfile.strategy === 'string' ? executionProfile.strategy : undefined,
      affordanceSignals: Array.isArray(executionProfile.affordanceSignals) ? executionProfile.affordanceSignals : undefined,
    },
    trajectoryNotes: toStringArray(value.trajectoryNotes),
  };
}

export class RecoveryPlanner {
  constructor(private provider: SemanticNluProvider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER) {}

  async synthesize(state: PokeGraphState): Promise<RecoveryTrajectoryDraft & { latentGoals: string[] }> {
    const journal = normalizeJournal(state);
    const sessionKey = state.sessionKey ?? state.semanticIntent?.sessionKey ?? state.intentGraph?.id ?? state.objective;
    const latentGoals = inferLatentGoalsFromTrajectory({
      sessionKey,
      objective: state.objective,
      query: state.query,
      eventJournal: journal,
      breadcrumbs: state.breadcrumbs,
      intentGraph: state.intentGraph,
      semanticIntent: state.semanticIntent,
    });
    const raw = await this.provider.extract({
      objective: 'recover trajectory for ' + state.objective,
      context: {
        objective: state.objective,
        query: state.query,
        sessionKey,
        eventJournal: journal,
        breadcrumbs: state.breadcrumbs ?? [],
        recovery: state.recovery ?? [],
        latentGoals,
        intentGraph: state.intentGraph ?? null,
        semanticIntent: state.semanticIntent ?? null,
        executionProfile: state.executionProfile ?? null,
      },
      schema: RECOVERY_SCHEMA,
    });
    return { ...normalizeRecoveryDraft(raw, this.provider.name), latentGoals };
  }
}

export function buildPokeGraph(deps: { rag: RagCorpus; working: WorkingMemory; episodic: EpisodicMemory; }) {
  const recoveryPlanner = new RecoveryPlanner();
  const nodes: GraphNode<PokeGraphState>[] = [
    {
      id: 'recovery-policy',
      name: 'plan recovery policy from event journal',
      run: async (state) => {
        const synthesis = await recoveryPlanner.synthesize(state);
        return {
          ...state,
          eventJournal: normalizeJournal(state),
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
          ...(state.retrieval?.hits ?? []).map((hit) => hit.excerpt),
          ...(state.episodicRecall ?? []).map((item) => item.summary),
        ];
        const combined = snippets.slice(0, 12).join('\n');
        return {
          ...state,
          artifacts: {
            ...(state.artifacts ?? {}),
            contextPack: combined,
            retrievalTrace: state.retrieval?.trace,
          },
        };
      },
    },
  ];

  return new GraphExecutor<PokeGraphState>(nodes, [
    { from: 'recovery-policy', to: 'profile' },
    { from: 'profile', to: 'recall-working' },
    { from: 'recall-working', to: 'recall-episodic' },
    { from: 'recall-episodic', to: 'retrieve-rag' },
    { from: 'retrieve-rag', to: 'synthesize' },
  ]);
}
