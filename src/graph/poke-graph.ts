import { GraphExecutor, type GraphNode } from './executor';
import type { ExecutionProfile, PlannerRecoveryPolicy, RuntimeState } from '../types';
import type { RagCorpus } from '../rag/retriever';
import type { WorkingMemory } from '../memory/working-memory';
import type { EpisodicMemory } from '../memory/episodic-memory';

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
};

function normalizeJournal(state: PokeGraphState): NonNullable<PokeGraphState['eventJournal']> {
  if (Array.isArray(state.eventJournal) && state.eventJournal.length > 0) return state.eventJournal;
  return (state.recovery ?? []).map((entry) => ({ stepId: entry.stepId, kind: 'recovery', status: 'failed', reason: entry.reason, at: entry.at, detail: entry }));
}

function deriveRecoveryPolicy(state: PokeGraphState): PlannerRecoveryPolicy {
  const journal = normalizeJournal(state);
  const failures = journal.filter((entry) => /fail|error|timeout|recover|rollback/i.test(String(entry.kind ?? '') + ' ' + String(entry.status ?? '') + ' ' + String(entry.reason ?? '') + ' ' + JSON.stringify(entry.detail ?? {})));
  const blockedKinds = Array.from(new Set(failures.map((entry) => entry.kind).filter((kind): kind is string => Boolean(kind) && kind !== 'recovery'))).filter(Boolean) as PlannerRecoveryPolicy['blockedKinds'];
  const fallbackSkills = Array.from(new Set([
    ...(state.intentGraph?.toolAffordances ?? []).filter((affordance) => affordance.score >= 0.55).map((affordance) => affordance.skill),
    ...(state.breadcrumbs ?? []).slice(-3).map((crumb) => crumb.skill),
  ])).slice(0, 4);
  return {
    mode: failures.length >= 3 ? 'replan' : failures.length > 0 ? 'retry' : 'compensate',
    maxReplans: failures.length >= 4 ? 3 : failures.length > 0 ? 2 : 1,
    maxAttemptsPerStep: failures.length >= 2 ? 3 : 2,
    blockedKinds,
    fallbackSkills: fallbackSkills.length > 0 ? fallbackSkills : ['verify'],
    recoveryNotes: [
      'journalEntries=' + journal.length,
      'failures=' + failures.length,
      ...(failures.slice(0, 4).map((entry) => [entry.stepId, entry.reason].filter(Boolean).join(':')).filter(Boolean)),
    ],
  };
}

function derivePrimarySource(state: PokeGraphState): ExecutionProfile {
  const policy = state.recoveryPolicy ?? deriveRecoveryPolicy(state);
  const recoveryPressure = policy.mode === 'replan' ? 2 : policy.mode === 'retry' ? 1 : 0;
  const latentGoalHints = Array.from(new Set([
    ...(state.intentGraph?.nodes ?? []).filter((node) => node.kind === 'goal' || node.kind === 'subgoal').map((node) => node.label),
    ...(state.intentGraph?.frontier ?? []).slice(0, 3),
  ])).slice(0, 6);
  const executionProfile: ExecutionProfile = state.executionProfile ?? {
    primarySource: recoveryPressure > 0 ? 'memory' : 'integration',
    secondarySources: recoveryPressure > 1 ? ['integration', 'browser'] : ['integration'],
    parallelizable: (state.executionProfile?.parallelizable ?? true) && policy.mode !== 'replan',
    rationale: [
      'recovery-mode=' + policy.mode,
      'fallback-skills=' + policy.fallbackSkills.join(','),
      ...policy.recoveryNotes.slice(0, 4),
      ...latentGoalHints.map((hint) => 'latent=' + hint),
    ],
    strategy: state.executionProfile?.strategy ?? state.planner?.strategy,
    affordanceSignals: (state.intentGraph?.toolAffordances ?? []).slice(0, 5).map((affordance) => ({
      skill: affordance.skill,
      score: affordance.score,
      bucket: affordance.skill === 'browser' || affordance.skill === 'computer-use' ? 'browser' : affordance.skill === 'harness' ? 'memory' : affordance.skill === 'integration' ? 'integration' : 'memory',
      kind: affordance.selectedKind,
    })),
  };
  return executionProfile;
}

export function buildPokeGraph(deps: {
  rag: RagCorpus;
  working: WorkingMemory;
  episodic: EpisodicMemory;
}) {
  const nodes: GraphNode<PokeGraphState>[] = [
    {
      id: 'recovery-policy',
      name: 'plan recovery policy from event journal',
      run: (state) => {
        const recoveryPolicy = deriveRecoveryPolicy(state);
        return {
          ...state,
          eventJournal: normalizeJournal(state),
          recoveryPolicy,
          recoverySignals: recoveryPolicy.recoveryNotes,
          latentGoals: Array.from(new Set([
            ...(state.intentGraph?.nodes ?? []).filter((node) => node.kind === 'goal' || node.kind === 'subgoal').map((node) => node.label),
            ...(state.intentGraph?.frontier ?? []),
          ])).slice(0, 8),
        };
      },
    },
    {
      id: 'profile',
      name: 'profile request',
      run: (state) => ({ ...state, executionProfile: derivePrimarySource(state) }),
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
