import { cosineSimilarity, defaultSemanticEmbeddingModel, extractSemanticSignals } from './embeddings';
import { expandTokens } from './tokenize';
import type { ChunkRecord, DocumentLifecycle, EmbeddingModel, RetrievalEvidenceHit, RetrievalHit, RetrievalQuery } from './types';

function lexicalScore(queryTokens: string[], chunk: ChunkRecord): number {
  const docLenNorm = 1 / Math.max(1, Math.log2(chunk.tokenCount + 2));
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.termVector[token] ?? 0;
    if (tf > 0) score += (1 + Math.log1p(tf)) * docLenNorm;
  }
  return score;
}

function sourceScore(documentSource: string, lifecycle: DocumentLifecycle, query: RetrievalQuery): number {
  const normalized = documentSource.toLowerCase();
  const signals = extractSemanticSignals(query.query).axes;
  let score = 0;
  if ((signals.relationship || signals.thread || signals.followup) && lifecycle === 'relationship') score += 0.55;
  if ((signals.relationship || signals.thread || signals.followup) && lifecycle === 'thread') score += 0.5;
  if (signals.preference && lifecycle === 'preference') score += 0.4;
  if (signals.calendar && lifecycle === 'calendar') score += 0.35;
  if (signals.reference && lifecycle === 'reference') score += 0.3;
  if (signals.filesystem && lifecycle === 'filesystem') score += 0.25;
  if (signals.evidence || signals.crossSource) score += 0.14;
  if (normalized === 'email') score += 0.24;
  else if (normalized === 'calendar') score += 0.18;
  else if (normalized === 'memory') score += 0.2;
  else if (normalized === 'docs') score += 0.16;
  else if (normalized === 'filesystem') score += 0.12;
  return score + (lifecycle === 'transactional' ? -0.08 : 0);
}

function structuralBoost(chunk: ChunkRecord, query: RetrievalQuery): number {
  const boost = query.boost ?? {};
  const recencyBoost = chunk.recencyScore * (boost.recency ?? 0.24);
  const salienceBoost = chunk.salience * (boost.salience ?? 0.18);
  const titleBoost = chunk.text.toLowerCase().includes(query.query.toLowerCase()) ? (boost.title ?? 0.14) : 0;
  const lifecycleBoost = chunk.lifecycle === 'relationship' ? 0.18 : chunk.lifecycle === 'thread' ? 0.14 : chunk.lifecycle === 'preference' ? 0.1 : chunk.lifecycle === 'reference' ? 0.06 : 0;
  return recencyBoost + salienceBoost + titleBoost + lifecycleBoost;
}

export type ScoreChunkContext = {
  embeddingModel?: EmbeddingModel;
  queryEmbedding?: number[];
  queryTokens?: string[];
};

export function gradeRetrievalHit(hit: Omit<RetrievalHit, 'grade' | 'gradeScore' | 'gradeRationale' | 'evidence'> & { evidence?: RetrievalEvidenceHit[] }, query: RetrievalQuery): Pick<RetrievalHit, 'grade' | 'gradeScore' | 'gradeRationale'> {
  const queryAxisMass = Object.entries(extractSemanticSignals(query.query).axes)
    .filter(([axis]) => axis !== 'workflow')
    .reduce((sum, [, value]) => sum + value, 0);
  const lexicalSignal = Math.min(1, hit.lexicalScore / 1.5);
  const phraseSignal = hit.phraseMatches.length > 0 ? 0.15 : 0;
  const structuralSignal = Math.min(0.2, hit.recencyScore * 0.08 + hit.salienceScore * 0.08 + Math.max(0, hit.sourceScore) * 0.04);
  const mode = query.mode ?? 'hybrid';
  const semanticWeight = mode === 'lexical' ? 0.25 : 0.45;
  const lexicalWeight = mode === 'semantic' ? 0.25 : 0.42;
  const sparseUnanchoredPenalty = hit.lexicalScore === 0 && hit.phraseMatches.length === 0 && queryAxisMass === 0 ? 0.45 : 1;
  const gradeScore = (hit.semanticScore * semanticWeight + lexicalSignal * lexicalWeight + phraseSignal + structuralSignal) * sparseUnanchoredPenalty;
  const grade = gradeScore >= 0.68 ? 'strong' : gradeScore >= 0.4 ? 'usable' : 'weak';
  const gradeRationale = `semantic=${hit.semanticScore.toFixed(3)} lexical=${hit.lexicalScore.toFixed(3)} phrase=${hit.phraseMatches.length}`;
  return { grade, gradeScore, gradeRationale };
}

export function scoreChunk(chunk: ChunkRecord, query: RetrievalQuery, context: ScoreChunkContext = {}): RetrievalHit {
  const querySignals = extractSemanticSignals(query.query);
  const queryTokens = context.queryTokens ?? expandTokens(querySignals.tokens);
  const embeddingModel = context.embeddingModel ?? defaultSemanticEmbeddingModel;
  const queryEmbedding = context.queryEmbedding ?? embeddingModel.embedText(query.query);
  const chunkEmbedding = chunk.embedding.length ? chunk.embedding : embeddingModel.embedText(chunk.text);
  const semanticScore = Math.max(0, (cosineSimilarity(queryEmbedding, chunkEmbedding) + 1) / 2);
  const lexical = lexicalScore(queryTokens, chunk);
  const mode = query.mode ?? 'hybrid';
  const lexicalWeight = mode === 'lexical' ? 0.58 : mode === 'semantic' ? 0.04 : 0.32;
  const semanticWeight = mode === 'semantic' ? 0.86 : mode === 'lexical' ? 0.2 : 0.48;
  const phraseMatches = query.query.includes('"') || query.query.includes("'")
    ? []
    : query.query.split(/\s+/).filter((phrase) => phrase.length > 3 && chunk.text.toLowerCase().includes(phrase.toLowerCase())).slice(0, 4);
  const exactPhraseBoost = Math.min(1, phraseMatches.length) * (query.boost?.exactPhrase ?? 0.28) * (mode === 'semantic' ? 0.15 : 1);
  const sourceWeight = sourceScore(chunk.source, chunk.lifecycle, query) * (mode === 'semantic' ? 0.35 : 1);
  const structural = structuralBoost(chunk, query) * (mode === 'semantic' ? 0.35 : 1);
  const baseScore = lexical * lexicalWeight + semanticScore * semanticWeight + sourceWeight + structural + exactPhraseBoost;
  const excerpt = chunk.text.slice(0, 260).replace(/\s+/g, ' ').trim();
  const baseHit = {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: '',
    source: '',
    lifecycle: chunk.lifecycle,
    score: baseScore,
    baseScore,
    lexicalScore: lexical,
    semanticScore,
    rerankScore: baseScore,
    recencyScore: chunk.recencyScore,
    salienceScore: chunk.salience,
    sourceScore: sourceWeight,
    phraseMatches,
    excerpt,
  };
  return { ...baseHit, ...gradeRetrievalHit(baseHit, query), evidence: [] };
}

export function rerankHits(hits: RetrievalHit[], query: RetrievalQuery): RetrievalHit[] {
  const querySignals = extractSemanticSignals(query.query).axes;
  const seenSources = new Map<string, number>();
  const seenLifecycle = new Map<DocumentLifecycle, number>();
  return [...hits]
    .sort((left, right) => right.score - left.score)
    .map((hit, index) => {
      const sourceCount = seenSources.get(hit.source) ?? 0;
      const lifecycleCount = seenLifecycle.get(hit.lifecycle) ?? 0;
      const diversityPenalty = sourceCount * 0.06 + lifecycleCount * 0.03;
      const evidenceBoost = hit.evidence.length * 0.08 + (querySignals.crossSource || querySignals.evidence ? 0.09 : 0);
      const threadAffinity = (hit.lifecycle === 'relationship' || hit.lifecycle === 'thread') && (querySignals.relationship || querySignals.thread || querySignals.followup) ? 0.12 : 0;
      const transactionalPenalty = hit.lifecycle === 'transactional' && (querySignals.relationship || querySignals.thread || querySignals.followup) ? 0.1 : 0;
      const rerankScore = hit.baseScore + evidenceBoost + threadAffinity - diversityPenalty - transactionalPenalty - index * 0.005;
      seenSources.set(hit.source, sourceCount + 1);
      seenLifecycle.set(hit.lifecycle, lifecycleCount + 1);
      return { ...hit, rerankScore, score: rerankScore };
    })
    .sort((left, right) => right.rerankScore - left.rerankScore || right.semanticScore - left.semanticScore || right.recencyScore - left.recencyScore);
}

export function scoreEvidence(anchor: RetrievalHit, candidate: RetrievalHit, query: RetrievalQuery, embeddingModel: EmbeddingModel = defaultSemanticEmbeddingModel): RetrievalEvidenceHit {
  const querySignals = extractSemanticSignals(query.query).axes;
  const anchorSignals = extractSemanticSignals(anchor.excerpt).axes;
  const candidateSignals = extractSemanticSignals(candidate.excerpt).axes;
  const crossSourceBoost = anchor.source !== candidate.source ? 0.2 : 0;
  const complementarity = Object.keys(querySignals).some((axis) => candidateSignals[axis] !== undefined) ? 0.12 : 0;
  const lifecycleBoost = anchor.lifecycle === candidate.lifecycle ? 0.08 : 0.02;
  const semanticBridge = Math.max(0, candidate.semanticScore * 0.5 + cosineSimilarity(embeddingModel.embedText(anchor.excerpt), embeddingModel.embedText(candidate.excerpt)) * 0.35);
  const score = semanticBridge + crossSourceBoost + complementarity + lifecycleBoost + (Object.keys(anchorSignals).some((axis) => candidateSignals[axis] !== undefined) ? 0.05 : 0);
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    title: candidate.title,
    source: candidate.source,
    lifecycle: candidate.lifecycle,
    score,
    excerpt: candidate.excerpt,
    rationale: anchor.source === candidate.source ? 'same-source corroboration' : 'cross-source corroboration',
  };
}
