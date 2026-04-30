import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RagCorpus } from '../src/rag/retriever';
import { WorkingMemory } from '../src/memory/working-memory';
import { EpisodicMemory } from '../src/memory/episodic-memory';
import { buildPokeGraph } from '../src/graph/poke-graph';

const corpus = new RagCorpus();
corpus.upsertDocument({
  id: 'doc-rag',
  source: 'docs',
  title: 'hybrid retrieval architecture',
  body: 'bm25 style lexical retrieval combined with recency weighting and salience reranking. graph orchestration keeps the context pack stable.',
  tags: ['rag', 'graph'],
  metadata: { kind: 'architecture' },
});
corpus.upsertDocument({
  id: 'doc-email',
  source: 'notes',
  title: 'email drafting policy',
  body: 'always confirm before send. preserve threads. attachments require provenance.',
  tags: ['email'],
  metadata: { kind: 'policy' },
});
corpus.upsertDocument({
  id: 'doc-calendar',
  source: 'notes',
  title: 'calendar scheduling policy',
  body: 'timezone canonicalization matters. conflict checks happen before mutation.',
  tags: ['calendar'],
  metadata: { kind: 'policy' },
});

const working = new WorkingMemory();
working.upsertFact('user:timezone', 'Europe/London', 0.99, 'profile');
const episodic = new EpisodicMemory();
episodic.add({ id: 'ep-1', taskId: 'task-a', category: 'success', summary: 'retrieval picked the right architecture doc', signals: ['rag', 'graph', 'retrieval'], score: 0.8 });
const graph = buildPokeGraph({ rag: corpus, working, episodic });

const query = 'world class rag retrieval architecture with graph orchestration';
const retrieval = corpus.retrieve({ query, k: 2, boost: { recency: 0.25, salience: 0.25, exactPhrase: 0.3, title: 0.15 } });
assert.equal(retrieval.hits[0]?.documentId, 'doc-rag');
assert.ok(retrieval.hits[0]!.score >= retrieval.hits[1]!.score);

const result = await graph.run({
  objective: query,
  cursor: 0,
  attempts: {},
  outputs: {},
  artifacts: {},
  breadcrumbs: [],
  recovery: [],
  query,
});
assert.ok(result.state.retrieval?.hits.length);
assert.equal(result.state.retrieval?.hits[0]?.documentId, 'doc-rag');
assert.ok((result.state.artifacts?.contextPack as string).includes('graph orchestration'));

const dir = mkdtempSync(join(tmpdir(), 'poke-rag-'));
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, topHit: retrieval.hits[0], graphTrace: result.visited.map((c) => c.nodeId) }, null, 2));
