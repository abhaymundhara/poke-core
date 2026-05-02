import { GraphExecutor, type GraphNode } from './executor';
import type { ExecutionProfile, RuntimeState } from '../types';
import type { RagCorpus } from '../rag/retriever';
import type { WorkingMemory } from '../memory/working-memory';
import type { EpisodicMemory } from '../memory/episodic-memory';

export type PokeGraphState = RuntimeState & {
  query: string;
  retrieval?: ReturnType<RagCorpus['retrieve']>;
  workingSnapshot?: ReturnType<WorkingMemory['snapshot']>;
  episodicRecall?: ReturnType<EpisodicMemory['recall']>;
  executionProfile?: ExecutionProfile;
};

export function buildPokeGraph(deps: {
  rag: RagCorpus;
  working: WorkingMemory;
  episodic: EpisodicMemory;
}) {
  const nodes: GraphNode<PokeGraphState>[] = [
    {
      id: 'profile',
      name: 'profile request',
      run: (state) => {
        const executionProfile: ExecutionProfile = state.executionProfile ?? {
          primarySource: 'integration',
          secondarySources: [],
          parallelizable: true,
          rationale: ['planner-provided execution profile fallback'],
          strategy: state.planner?.strategy,
          affordanceSignals: state.intentGraph?.toolAffordances?.slice(0, 4).map((affordance) => ({ skill: affordance.skill, score: affordance.score, bucket: affordance.skill === 'browser' || affordance.skill === 'computer-use' ? 'browser' : affordance.skill === 'harness' ? 'memory' : affordance.skill === 'integration' ? 'integration' : 'memory', kind: affordance.selectedKind })) ?? [],
        };
        return { ...state, executionProfile };
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
    { from: 'profile', to: 'recall-working' },
    { from: 'recall-working', to: 'recall-episodic' },
    { from: 'recall-episodic', to: 'retrieve-rag' },
    { from: 'retrieve-rag', to: 'synthesize' },
  ]);
}

