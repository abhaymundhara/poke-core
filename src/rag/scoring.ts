import { cosineSimilarity, embedText } from './embeddings';
import { expandTokens, tokenize } from './tokenize';
import type { ChunkRecord, RetrievalHit, RetrievalQuery } from './types';

function lexicalScore(queryTokens: string[], chunk: ChunkRecord): number {
  const docLenNorm = 1 / Math.max(1, Math.log2(chunk.tokenCount + 2));
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.termVector[token] ?? 0;
    if (tf > 0) score += (1 + Math.log1p(tf)) * docLenNorm;
  }
  return score;
}

function structuralBoost(chunk: ChunkRecord, query: RetrievalQuery): number {
  const boost = query.boost ?? {};
  const lifecycleBoost = chunk.lifecycle === 'relationship' ? 0.18 : chunk.lifecycle === 'thread' ? 0.14 : chunk.lifecycle === 'preference' ? 0.1 : chunk.lifecycle === 'transactional' ? 0.03 : 0;
  const recencyBoost = chunk.recencyScore * (boost.recency ?? 0.25);
  const salienceBoost = chunk.salience * (boost.salience ?? 0.22);
  const titleBoost = chunk.text.toLowerCase().includes(query.query.toLowerCase()) ? (boost.title ?? 0.15) : 0;
  return lifecycleBoost + recencyBoost + salienceBoost + titleBoost;
}

export function scoreChunk(chunk: ChunkRecord, query: RetrievalQuery): RetrievalHit {
  const tokens = tokenize(query.query);
  const expandedTokens = expandTokens(tokens);
  const queryEmbedding = embedText(query.query);
  const chunkEmbedding = chunk.embedding.length ? chunk.embedding : embedText(chunk.text);
  const semanticScore = Math.max(0, (cosineSimilarity(queryEmbedding, chunkEmbedding) + 1) / 2);
  const lexical = lexicalScore(expandedTokens, chunk);
  const mode = query.mode ?? 'hybrid';
  const lexicalWeight = mode === 'lexical' ? 0.6 : mode === 'semantic' ? 0.2 : 0.35;
  const semanticWeight = mode === 'semantic' ? 0.6 : mode === 'lexical' ? 0.2 : 0.45;
  const phraseMatches = query.query.includes('"') || query.query.includes("'")
    ? []
    : query.query
        .split(/\s+/)
        .filter((phrase) => phrase.length > 3 && chunk.text.toLowerCase().includes(phrase.toLowerCase()))
        .slice(0, 3);
  const exactPhraseBoost = Math.min(1, phraseMatches.length) * (query.boost?.exactPhrase ?? 0.32);
  const score = lexical * lexicalWeight + semanticScore * semanticWeight + structuralBoost(chunk, query) + exactPhraseBoost;
  const excerpt = chunk.text.slice(0, 240).replace(/\s+/g, ' ').trim();
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: '',
    source: '',
    score,
    lexicalScore: lexical,
    semanticScore,
    recencyScore: chunk.recencyScore,
    salienceScore: chunk.salience,
    phraseMatches,
    excerpt,
  };
}
