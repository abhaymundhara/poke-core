import { strict as assert } from 'node:assert';
import { RagCorpus } from '../src/rag/retriever';
import { tokenize } from '../src/rag/tokenize';
import type { EmbeddingModel } from '../src/rag/types';

const customEmbeddingModel: EmbeddingModel = {
  dimension: 2,
  embedText(text: string) {
    const lower = text.toLowerCase();
    const vector = [lower.includes('alpha') ? 1 : 0, lower.includes('beta') ? 1 : 0];
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  },
};

const injected = new RagCorpus({ embeddingModel: customEmbeddingModel });
injected.upsertDocument({
  id: 'custom-alpha',
  source: 'docs',
  title: 'alpha reference',
  body: 'alpha only',
  tags: ['reference'],
  metadata: {},
});
injected.upsertDocument({
  id: 'custom-beta',
  source: 'docs',
  title: 'beta reference',
  body: 'beta only',
  tags: ['reference'],
  metadata: {},
});
const injectedResult = injected.retrieve({ query: 'beta', k: 1, mode: 'semantic' });
assert.equal(injectedResult.hits[0]?.documentId, 'custom-beta');

const semanticFallback = new RagCorpus({
  embeddingModel: {
  dimension: 2,
  embedText(text: string) {
    const lower = text.toLowerCase();
    const vector = [lower.includes('alias') || lower.includes('semantic-target') || lower.includes('semantic target') ? 1 : 0, lower.includes('distractor') ? 1 : 0];
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    },
  },
});
semanticFallback.upsertDocument({
  id: 'lexical-distractor',
  source: 'docs',
  title: 'alias distractor',
  body: 'alias distractor lexical match',
  tags: ['reference'],
  metadata: {},
});
semanticFallback.upsertDocument({
  id: 'semantic-match',
  source: 'docs',
  title: 'semantic target',
  body: 'semantic-target vector-only match',
  tags: ['reference'],
  metadata: {},
});
const semanticFallbackResult = semanticFallback.retrieve({ query: 'alias', k: 1, mode: 'semantic' });
assert.equal(semanticFallbackResult.hits[0]?.documentId, 'semantic-match');
assert.equal(semanticFallbackResult.coverage.chunksScanned, semanticFallbackResult.coverage.chunksIndexed);

const pruning = new RagCorpus();
for (let i = 0; i < 80; i += 1) {
  pruning.upsertDocument({
    id: `bulk-${i}`,
    source: 'docs',
    title: `bulk note ${i}`,
    body: i === 42 ? 'needle42 exact marker for indexed retrieval' : 'ordinary filler reference text',
    tags: ['reference'],
    metadata: {},
  });
}
const prunedResult = pruning.retrieve({ query: 'needle42', k: 1, mode: 'hybrid' });
assert.equal(prunedResult.hits[0]?.documentId, 'bulk-42');
assert.ok(prunedResult.coverage.chunksScanned < prunedResult.coverage.chunksIndexed, JSON.stringify(prunedResult.coverage));
assert.ok(prunedResult.coverage.lexicalCandidates > 0);

const snapshot = pruning.exportSnapshot();
const restored = RagCorpus.fromSnapshot(snapshot);
const restoredResult = restored.retrieve({ query: 'needle42', k: 1, mode: 'hybrid' });
assert.equal(restoredResult.hits[0]?.documentId, prunedResult.hits[0]?.documentId);
assert.equal(restored.stats().chunks, pruning.stats().chunks);
assert.equal(restored.stats().indexedChunks, pruning.stats().indexedChunks);

const lexical = new RagCorpus();
lexical.upsertDocument({
  id: 'rare-term',
  source: 'docs',
  title: 'rare marker',
  body: 'zephyrxylophone is the exact token that must be recoverable by lexical search',
  tags: ['reference'],
  metadata: {},
});
lexical.upsertDocument({
  id: 'common-term',
  source: 'docs',
  title: 'common marker',
  body: 'ordinary reference material without the rare marker',
  tags: ['reference'],
  metadata: {},
});
const lexicalResult = lexical.retrieve({ query: 'zephyrxylophone', k: 1, mode: 'lexical' });
assert.equal(lexicalResult.hits[0]?.documentId, 'rare-term');

const unicodeTokens = tokenize('Café-naïve baz_qux 東京');
assert.ok(unicodeTokens.includes('café'), unicodeTokens.join(','));
assert.ok(unicodeTokens.includes('naïve'), unicodeTokens.join(','));
assert.ok(unicodeTokens.includes('baz'), unicodeTokens.join(','));
assert.ok(unicodeTokens.includes('qux'), unicodeTokens.join(','));
assert.ok(unicodeTokens.includes('東京'), unicodeTokens.join(','));

const compacting = new RagCorpus({ autoCompaction: { minDocuments: 2, intervalDocuments: 1, tokenBudget: 4 } });
for (let i = 0; i < 5; i += 1) {
  compacting.upsertDocument({
    id: `compact-${i}`,
    source: i === 0 ? 'memory' : 'browser',
    title: `compact candidate ${i}`,
    body: 'low value transient transactional booking receipt noise',
    tags: ['transactional'],
    metadata: { importance: i === 0 ? 1.2 : 0.1 },
  });
}
assert.ok(compacting.stats().lastCompaction, JSON.stringify(compacting.stats()));
assert.ok(compacting.stats().documents < 5, JSON.stringify(compacting.stats()));

const defaultCompaction = new RagCorpus();
defaultCompaction.upsertDocument({
  id: 'default-no-jitter',
  source: 'docs',
  title: 'small corpus',
  body: 'small corpus should not compact eagerly',
  tags: ['reference'],
  metadata: {},
});
assert.equal(defaultCompaction.stats().lastCompaction, null);

const traceStages = prunedResult.trace.stages.map((stage) => stage.name);
assert.ok(traceStages.includes('query-rewrite'), traceStages.join(','));
assert.ok(traceStages.includes('lexical-bm25-candidate-search'), traceStages.join(','));
assert.ok(traceStages.includes('vector-candidate-search'), traceStages.join(','));
assert.ok(traceStages.includes('retrieval-grading'), traceStages.join(','));
assert.ok(prunedResult.trace.rewrites?.length);
assert.ok(prunedResult.hits[0]?.gradeScore >= prunedResult.hits[0]!.semanticScore * 0.2);

const weakCorpus = new RagCorpus({ retrieval: { minGradeScore: 0 } });
weakCorpus.upsertDocument({
  id: 'weak',
  source: 'docs',
  title: 'unrelated',
  body: 'plain document with no useful semantic axes',
  tags: [],
  metadata: {},
});
const weakResult = weakCorpus.retrieve({ query: 'zzzzzz', k: 1, mode: 'hybrid' });
assert.equal(weakResult.hits[0]?.grade, 'weak');
assert.equal(weakResult.trace.needsFallback, true);

console.log(JSON.stringify({
  ok: true,
  injectedTopHit: injectedResult.hits[0]?.documentId,
  semanticFallbackTopHit: semanticFallbackResult.hits[0]?.documentId,
  prunedCoverage: prunedResult.coverage,
  restoredTopHit: restoredResult.hits[0]?.documentId,
  traceStages,
  unicodeTokens,
}, null, 2));
