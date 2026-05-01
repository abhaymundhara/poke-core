import { randomUUID } from 'node:crypto';
import { RagCorpus } from './retriever';
import type { DocumentLifecycle, MemoryDocument, RetrievalHit, RetrievalQuery } from './types';

export type RetrievalBenchmarkCase = {
  name: string;
  query: string;
  expectedLifecycle: DocumentLifecycle[];
  expectedSources?: string[];
  expectedEvidenceSources?: string[];
  queryOptions?: Partial<RetrievalQuery>;
};

export type RetrievalBenchmarkResult = {
  name: string;
  query: string;
  topHit?: RetrievalHit;
  lifecycleMatch: boolean;
  sourceMatch: boolean;
  evidenceMatch: boolean;
  score: number;
};

export const DEFAULT_RETRIEVAL_BENCHMARK_CASES: RetrievalBenchmarkCase[] = [
  {
    name: 'relationship recall',
    query: 'who should i follow up with about the bt placement relationship context',
    expectedLifecycle: ['relationship', 'thread'],
    expectedSources: ['email', 'memory'],
    expectedEvidenceSources: ['email', 'memory'],
  },
  {
    name: 'thread compaction',
    query: 'summarize the latest thread and preserve the reply context',
    expectedLifecycle: ['thread'],
    expectedSources: ['email'],
    expectedEvidenceSources: ['email', 'docs'],
  },
  {
    name: 'transactional cleanup',
    query: 'find the booking and invoice details but drop stale transactional noise',
    expectedLifecycle: ['transactional'],
    expectedSources: ['email', 'calendar'],
    expectedEvidenceSources: ['email', 'calendar'],
  },
  {
    name: 'preference recall',
    query: 'what tone and style does abhay prefer for concise professional replies',
    expectedLifecycle: ['preference', 'relationship'],
    expectedSources: ['memory'],
    expectedEvidenceSources: ['memory', 'email'],
  },
  {
    name: 'hybrid knowledge lookup',
    query: 'retrieve the architecture notes and any related relationship history',
    expectedLifecycle: ['reference', 'relationship'],
    expectedSources: ['docs', 'memory'],
    expectedEvidenceSources: ['docs', 'memory'],
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
      metadata: { threadId: 'thread-1', relationshipId: 'bt-placement', importance: 1.2, tokenCount: 38 },
      relationshipId: 'bt-placement',
    },
    {
      id: randomUUID(),
      source: 'email',
      title: 'Invoice booking confirmation',
      body: 'The hotel booking and invoice were confirmed, but the transactional items are stale and should compact out after the next planning cycle.',
      tags: ['transactional', 'email'],
      metadata: { importance: 0.4, tokenCount: 34 },
    },
    {
      id: randomUUID(),
      source: 'calendar',
      title: 'Placement cohort check-in',
      body: 'Calendar note with the recurring meeting, attendee list, and a potential conflict with the placement report deadline.',
      tags: ['calendar', 'thread'],
      metadata: { threadId: 'calendar-1', importance: 0.9, tokenCount: 30 },
      threadId: 'calendar-1',
    },
    {
      id: randomUUID(),
      source: 'memory',
      title: 'Abhay style guide',
      body: 'Abhay prefers concise professional replies, clear bullet points, and direct follow-up language when the relationship context matters.',
      tags: ['preference', 'relationship'],
      metadata: { importance: 1.1, tokenCount: 26 },
      relationshipId: 'abhay-style',
    },
    {
      id: randomUUID(),
      source: 'docs',
      title: 'Architecture overview',
      body: 'The harness-first architecture prioritizes durable retrieval, explicit state transitions, and compaction that preserves relationship history while dropping stale transactional data.',
      tags: ['reference', 'architecture'],
      metadata: { importance: 1.0, tokenCount: 32 },
    },
  ];

  for (const document of documents) corpus.upsertDocument(document);
  return corpus;
}

function classifyDocument(document: MemoryDocument): DocumentLifecycle {
  const lifecycle = typeof document.metadata.lifecycle === 'string' ? (document.metadata.lifecycle as DocumentLifecycle) : undefined;
  if (lifecycle) return lifecycle;
  return (document.tags.find((tag) => ['relationship', 'thread', 'transactional', 'preference', 'reference', 'calendar', 'filesystem'].includes(tag)) as DocumentLifecycle | undefined) ?? 'unknown';
}

export function runRetrievalBenchmark(corpus = buildRetrievalBenchmarkCorpus(), cases = DEFAULT_RETRIEVAL_BENCHMARK_CASES): {
  results: RetrievalBenchmarkResult[];
  summary: { meanScore: number; lifecycleAccuracy: number; sourceAccuracy: number; evidenceAccuracy: number };
} {
  const results = cases.map((benchmarkCase) => {
    const result = corpus.retrieve({ query: benchmarkCase.query, k: 3, mode: 'hybrid', filters: { compaction: { tokenBudget: 4_000, preserveLifecycle: ['relationship', 'thread'] } }, ...(benchmarkCase.queryOptions ?? {}) });
    const topHit = result.hits[0];
    const document = topHit ? corpus.listDocuments().find((entry) => entry.id === topHit.documentId) : null;
    const lifecycleName = document ? classifyDocument(document) : 'unknown';
    const sourceMatch = topHit ? (benchmarkCase.expectedSources?.length ? benchmarkCase.expectedSources.includes(topHit.source) : true) : false;
    const lifecycleMatch = benchmarkCase.expectedLifecycle.includes(lifecycleName);
    const evidenceSources = new Set(topHit?.evidence.map((entry) => entry.source) ?? []);
    const evidenceMatch = benchmarkCase.expectedEvidenceSources?.length ? benchmarkCase.expectedEvidenceSources.some((source) => evidenceSources.has(source)) : evidenceSources.size > 0;
    return {
      name: benchmarkCase.name,
      query: benchmarkCase.query,
      topHit,
      lifecycleMatch,
      sourceMatch,
      evidenceMatch,
      score: topHit?.score ?? 0,
    };
  });

  const meanScore = results.reduce((sum, result) => sum + result.score, 0) / Math.max(1, results.length);
  const lifecycleAccuracy = results.filter((result) => result.lifecycleMatch).length / Math.max(1, results.length);
  const sourceAccuracy = results.filter((result) => result.sourceMatch).length / Math.max(1, results.length);
  const evidenceAccuracy = results.filter((result) => result.evidenceMatch).length / Math.max(1, results.length);

  return {
    results,
    summary: { meanScore, lifecycleAccuracy, sourceAccuracy, evidenceAccuracy },
  };
}

export function runCompactionBenchmark() {
  const corpus = new RagCorpus();
  const syntheticDocuments: Array<Omit<MemoryDocument, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'rel-1',
      source: 'email',
      title: 'Relationship history',
      body: 'Important relationship context, repeated follow-ups, contact notes, and durable thread memory.',
      tags: ['relationship', 'thread'],
      metadata: { importance: 1.4, tokenCount: 18, lifecycle: 'relationship' },
      relationshipId: 'rel-1',
    },
    {
      id: 'thr-1',
      source: 'email',
      title: 'Open thread',
      body: 'Latest thread state, reply cadence, and unresolved follow-up context.',
      tags: ['thread'],
      metadata: { importance: 1.2, tokenCount: 16, lifecycle: 'thread' },
      threadId: 'thr-1',
    },
    {
      id: 'txn-1',
      source: 'email',
      title: 'Old invoice',
      body: 'Stale invoice confirmation and booking receipt that should not crowd the harness.',
      tags: ['transactional'],
      metadata: { importance: 0.2, tokenCount: 16, lifecycle: 'transactional' },
    },
    {
      id: 'txn-2',
      source: 'calendar',
      title: 'Travel confirmation',
      body: 'Ancillary travel confirmation with little downstream value.',
      tags: ['transactional'],
      metadata: { importance: 0.2, tokenCount: 14, lifecycle: 'transactional' },
    },
    {
      id: 'ref-1',
      source: 'docs',
      title: 'Architecture note',
      body: 'Reference architecture and durable retrieval guidance.',
      tags: ['reference'],
      metadata: { importance: 0.8, tokenCount: 20, lifecycle: 'reference' },
    },
  ];

  for (const document of syntheticDocuments) corpus.upsertDocument(document);
  const compacted = corpus.compact({ tokenBudget: 40, query: 'keep relationship and thread history, compact stale transactional noise' });
  const retainedIds = new Set(compacted.retained.map((document) => document.id));
  return {
    compacted,
    retainedIds,
    keptRelationship: retainedIds.has('rel-1') && retainedIds.has('thr-1'),
    droppedTransactionals: !retainedIds.has('txn-1') || !retainedIds.has('txn-2'),
  };
}

export function runRagSelfAudit() {
  const retrieval = runRetrievalBenchmark();
  const compaction = runCompactionBenchmark();
  const passed = retrieval.summary.lifecycleAccuracy >= 0.8 && retrieval.summary.sourceAccuracy >= 0.8 && retrieval.summary.evidenceAccuracy >= 0.8 && compaction.keptRelationship && compaction.droppedTransactionals;
  return {
    passed,
    retrieval,
    compaction,
    checks: [
      { name: 'lifecycle_accuracy', ok: retrieval.summary.lifecycleAccuracy >= 0.8 },
      { name: 'source_accuracy', ok: retrieval.summary.sourceAccuracy >= 0.8 },
      { name: 'evidence_accuracy', ok: retrieval.summary.evidenceAccuracy >= 0.8 },
      { name: 'relationship_thread_preserved', ok: compaction.keptRelationship },
      { name: 'transactional_noise_compacted', ok: compaction.droppedTransactionals },
    ],
  };
}

export function formatRetrievalBenchmark(result = runRetrievalBenchmark()): string {
  const lines = [
    `mean score: ${result.summary.meanScore.toFixed(3)}`,
    `lifecycle accuracy: ${(result.summary.lifecycleAccuracy * 100).toFixed(1)}%`,
    `source accuracy: ${(result.summary.sourceAccuracy * 100).toFixed(1)}%`,
    `evidence accuracy: ${(result.summary.evidenceAccuracy * 100).toFixed(1)}%`,
    '',
  ];

  for (const row of result.results) {
    lines.push(`${row.name}: ${row.topHit?.title ?? 'no hit'} (${row.score.toFixed(3)}) lifecycle=${row.lifecycleMatch} source=${row.sourceMatch} evidence=${row.evidenceMatch}`);
  }

  return lines.join('\n');
}

export function formatRagSelfAudit() {
  const audit = runRagSelfAudit();
  const lines = [
    `passed: ${audit.passed}`,
    `retrieval lifecycle: ${(audit.retrieval.summary.lifecycleAccuracy * 100).toFixed(1)}%`,
    `retrieval source: ${(audit.retrieval.summary.sourceAccuracy * 100).toFixed(1)}%`,
    `retrieval evidence: ${(audit.retrieval.summary.evidenceAccuracy * 100).toFixed(1)}%`,
    `kept relationship history: ${audit.compaction.keptRelationship}`,
    `dropped transactional noise: ${audit.compaction.droppedTransactionals}`,
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  console.log(formatRetrievalBenchmark());
  console.log('');
  console.log(formatRagSelfAudit());
}
