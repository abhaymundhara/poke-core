import { randomUUID } from 'node:crypto';
import { RagCorpus } from './retriever';
import type { DocumentLifecycle, MemoryDocument, RetrievalHit, RetrievalQuery } from './types';

export type RetrievalBenchmarkCase = {
  name: string;
  query: string;
  expectedLifecycle: DocumentLifecycle[];
  expectedSources?: string[];
  queryOptions?: Partial<RetrievalQuery>;
};

export type RetrievalBenchmarkResult = {
  name: string;
  query: string;
  topHit?: RetrievalHit;
  lifecycleMatch: boolean;
  sourceMatch: boolean;
  score: number;
};

export const DEFAULT_RETRIEVAL_BENCHMARK_CASES: RetrievalBenchmarkCase[] = [
  {
    name: 'relationship recall',
    query: 'who should i follow up with about the bt placement relationship context',
    expectedLifecycle: ['relationship', 'thread'],
    expectedSources: ['email', 'notes'],
  },
  {
    name: 'thread compaction',
    query: 'summarize the latest thread and preserve the reply context',
    expectedLifecycle: ['thread'],
    expectedSources: ['email'],
  },
  {
    name: 'transactional cleanup',
    query: 'find the booking and invoice details but drop stale transactional noise',
    expectedLifecycle: ['transactional'],
    expectedSources: ['email', 'calendar'],
  },
  {
    name: 'preference recall',
    query: 'what tone and style does abhay prefer for concise professional replies',
    expectedLifecycle: ['preference', 'relationship'],
    expectedSources: ['memory'],
  },
  {
    name: 'hybrid knowledge lookup',
    query: 'retrieve the architecture notes and any related relationship history',
    expectedLifecycle: ['reference', 'relationship'],
    expectedSources: ['docs', 'memory'],
  },
];

export function buildRetrievalBenchmarkCorpus(): RagCorpus {
  const corpus = new RagCorpus();
  const documents: Array<Omit<MemoryDocument, 'createdAt' | 'updatedAt'>> = [
    {
      id: randomUUID(),
      source: 'email',
      title: 'BT placement follow-up thread',
      body: 'Stephen Razzell and Gareth Ewart confirmed the next check-in, plus the onboarding timeline and relationship context for the placement cohort.',
      tags: ['relationship', 'thread', 'email'],
      metadata: { threadId: 'thread-1', relationshipId: 'bt-placement', importance: 1.2 },
      relationshipId: 'bt-placement',
    },
    {
      id: randomUUID(),
      source: 'email',
      title: 'Invoice booking confirmation',
      body: 'The hotel booking and invoice were confirmed, but the transactional items are stale and should compact out after the next planning cycle.',
      tags: ['transactional', 'email'],
      metadata: { importance: 0.4 },
    },
    {
      id: randomUUID(),
      source: 'calendar',
      title: 'Placement cohort check-in',
      body: 'Calendar note with the recurring meeting, attendee list, and a potential conflict with the placement report deadline.',
      tags: ['calendar', 'thread'],
      metadata: { threadId: 'calendar-1', importance: 0.9 },
      threadId: 'calendar-1',
    },
    {
      id: randomUUID(),
      source: 'memory',
      title: 'Abhay style guide',
      body: 'Abhay prefers concise professional replies, clear bullet points, and direct follow-up language when the relationship context matters.',
      tags: ['preference', 'relationship'],
      metadata: { importance: 1.1 },
      relationshipId: 'abhay-style',
    },
    {
      id: randomUUID(),
      source: 'docs',
      title: 'Architecture overview',
      body: 'The harness-first architecture prioritizes durable retrieval, explicit state transitions, and compaction that preserves relationship history while dropping stale transactional data.',
      tags: ['reference', 'architecture'],
      metadata: { importance: 1.0 },
    },
  ];

  for (const document of documents) corpus.upsertDocument(document);
  return corpus;
}

export function runRetrievalBenchmark(corpus = buildRetrievalBenchmarkCorpus(), cases = DEFAULT_RETRIEVAL_BENCHMARK_CASES): {
  results: RetrievalBenchmarkResult[];
  summary: { meanScore: number; lifecycleAccuracy: number; sourceAccuracy: number };
} {
  const results = cases.map((benchmarkCase) => {
    const result = corpus.retrieve({ query: benchmarkCase.query, k: 3, mode: 'hybrid', ...(benchmarkCase.queryOptions ?? {}) });
    const topHit = result.hits[0];
    const lifecycle = topHit ? corpus.listDocuments().find((document) => document.id === topHit.documentId) : null;
    const lifecycleName = lifecycle ? (lifecycle.metadata.lifecycle as DocumentLifecycle | undefined) ?? (lifecycle.tags.find((tag) => benchmarkCase.expectedLifecycle.includes(tag as DocumentLifecycle)) as DocumentLifecycle | undefined) ?? 'unknown' : 'unknown';
    const sourceMatch = topHit ? (benchmarkCase.expectedSources?.length ? benchmarkCase.expectedSources.includes(topHit.source) : true) : false;
    const lifecycleMatch = benchmarkCase.expectedLifecycle.includes(lifecycleName);
    return {
      name: benchmarkCase.name,
      query: benchmarkCase.query,
      topHit,
      lifecycleMatch,
      sourceMatch,
      score: topHit?.score ?? 0,
    };
  });

  const meanScore = results.reduce((sum, result) => sum + result.score, 0) / Math.max(1, results.length);
  const lifecycleAccuracy = results.filter((result) => result.lifecycleMatch).length / Math.max(1, results.length);
  const sourceAccuracy = results.filter((result) => result.sourceMatch).length / Math.max(1, results.length);

  return {
    results,
    summary: { meanScore, lifecycleAccuracy, sourceAccuracy },
  };
}

export function formatRetrievalBenchmark(result = runRetrievalBenchmark()): string {
  const lines = [
    `mean score: ${result.summary.meanScore.toFixed(3)}`,
    `lifecycle accuracy: ${(result.summary.lifecycleAccuracy * 100).toFixed(1)}%`,
    `source accuracy: ${(result.summary.sourceAccuracy * 100).toFixed(1)}%`,
    '',
  ];

  for (const row of result.results) {
    lines.push(`${row.name}: ${row.topHit?.title ?? 'no hit'} (${row.score.toFixed(3)}) lifecycle=${row.lifecycleMatch} source=${row.sourceMatch}`);
  }

  return lines.join('\n');
}

if (import.meta.main) {
  console.log(formatRetrievalBenchmark());
}
