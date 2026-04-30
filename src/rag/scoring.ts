import { expandTokens, tokenize } from './tokenize';
import type { ChunkRecord, RetrievalHit, RetrievalQuery } from './types';

function bm25ish(queryTokens: string[], chunk: ChunkRecord): number {
  const docLenNorm = 1 / Math.max(1, Math.log2(chunk.tokenCount + 2));
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.termVector[token] ?? 0;
    if (tf > 0) score += (1 + Math.log1p(tf)) * docLenNorm;
  }
  return score;
}

function semanticOverlap(queryTokens: string[], chunk: ChunkRecord): number {
  const docTokens = Object.keys(chunk.termVector);
  const querySet = new Set(queryTokens);
  let overlap = 0;
  for (const token of docTokens) if (querySet.has(token)) overlap += 1;
  return overlap / Math.max(1, queryTokens.length);
}

function structuralBoost(chunk: ChunkRecord, query: RetrievalQuery): number {
  const boost = query.boost ?? {};
  let score = 0;
  const titleMatch = query.query.toLowerCase().includes(chunk.documentId.toLowerCase()) ? 1 : 0;
  score += titleMatch * (boost.title ?? 0.15);
  score += chunk.recencyScore * (boost.recency ?? 0.2);
  score += chunk.salience * (boost.salience ?? 0.2);
  return score;
}

export function scoreChunk(chunk: ChunkRecord, query: RetrievalQuery): RetrievalHit {
  const tokens = tokenize(query.query);
  const expandedTokens = expandTokens(tokens);
  const lexicalScore = bm25ish(expandedTokens, chunk);
  const semanticScore = semanticOverlap(expandedTokens, chunk);
  const recencyScore = chunk.recencyScore;
  const salienceScore = chunk.salience;
  const phraseMatches = query.query.includes('"') || query.query.includes("'")
    ? []
    : query.query.split(/\s+/).filter((phrase) => phrase.length > 3 && chunk.text.toLowerCase().includes(phrase.toLowerCase())).slice(0, 3);
  const score = lexicalScore * 0.55 + semanticScore * 0.25 + structuralBoost(chunk, query) + Math.min(1, phraseMatches.length) * (query.boost?.exactPhrase ?? 0.35);
  const excerpt = chunk.text.slice(0, 240).replace(/\s+/g, ' ').trim();
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: '',
    source: '',
    score,
    lexicalScore,
    semanticScore,
    recencyScore,
    salienceScore,
    phraseMatches,
    excerpt,
  };
}
