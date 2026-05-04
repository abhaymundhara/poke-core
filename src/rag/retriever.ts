import { randomUUID } from 'node:crypto';
import { compactDocuments, classifyLifecycle } from './compaction';
import { defaultSemanticEmbeddingModel, extractSemanticSignals } from './embeddings';
import { expandTokens, tokenize } from './tokenize';
import { rerankHits, scoreChunk, scoreEvidence } from './scoring';
import { SemanticVectorIndex } from './vector-index';
import type { ChunkRecord, EmbeddingModel, MemoryDocument, RagCorpusSnapshot, RetrievalEvidenceHit, RetrievalQuery, RetrievalResult, RetrievalHit } from './types';

export type RagCorpusOptions = {
  embeddingModel?: EmbeddingModel;
  chunkTokens?: number;
  autoCompaction?: {
    enabled?: boolean;
    minDocuments?: number;
    intervalDocuments?: number;
    tokenBudget?: number;
  };
  retrieval?: {
    candidateMultiplier?: number;
    minGradeScore?: number;
  };
};

type CandidateSearch = {
  compacted: ReturnType<typeof compactDocuments>;
  docs: MemoryDocument[];
};

export class RagCorpus {
  private documents = new Map<string, MemoryDocument>();
  private chunks = new Map<string, ChunkRecord>();
  private chunksByDocument = new Map<string, string[]>();
  private index = new SemanticVectorIndex<ChunkRecord>();
  private lastCompaction: string | null = null;
  private upsertsSinceCompaction = 0;
  private readonly embeddingModel: EmbeddingModel;
  private readonly chunkTokens: number;
  private readonly autoCompaction: Required<NonNullable<RagCorpusOptions['autoCompaction']>>;
  private readonly retrieval: Required<NonNullable<RagCorpusOptions['retrieval']>>;

  constructor(options: RagCorpusOptions = {}) {
    this.embeddingModel = options.embeddingModel ?? defaultSemanticEmbeddingModel;
    this.chunkTokens = options.chunkTokens ?? 220;
    this.autoCompaction = {
      enabled: options.autoCompaction?.enabled ?? true,
      minDocuments: options.autoCompaction?.minDocuments ?? 256,
      intervalDocuments: options.autoCompaction?.intervalDocuments ?? 32,
      tokenBudget: options.autoCompaction?.tokenBudget ?? 12_000,
    };
    this.retrieval = {
      candidateMultiplier: options.retrieval?.candidateMultiplier ?? 12,
      minGradeScore: options.retrieval?.minGradeScore ?? 0.08,
    };
  }

  upsertDocument(doc: Omit<MemoryDocument, 'createdAt' | 'updatedAt'> & Partial<Pick<MemoryDocument, 'createdAt' | 'updatedAt'>>) {
    const now = Date.now();
    const record: MemoryDocument = { ...doc, createdAt: doc.createdAt ?? now, updatedAt: now };
    this.documents.set(record.id, record);
    this.reindexDocument(record);
    this.upsertsSinceCompaction += 1;
    if (this.shouldAutoCompact()) {
      this.compact({ tokenBudget: this.autoCompaction.tokenBudget, query: `${record.title} ${record.body}`, apply: true });
      this.upsertsSinceCompaction = 0;
    }
    return record;
  }

  private shouldAutoCompact(): boolean {
    return this.autoCompaction.enabled
      && this.documents.size > this.autoCompaction.minDocuments
      && this.upsertsSinceCompaction >= this.autoCompaction.intervalDocuments;
  }

  deleteDocument(documentId: string) {
    const chunkIds = this.chunksByDocument.get(documentId) ?? [];
    for (const chunkId of chunkIds) {
      this.chunks.delete(chunkId);
      this.index.remove(chunkId);
    }
    this.chunksByDocument.delete(documentId);
    this.documents.delete(documentId);
  }

  compact(options: { tokenBudget?: number; maxDocuments?: number; query?: string; preserveLifecycle?: ReturnType<typeof classifyLifecycle>[]; preserveSources?: string[]; apply?: boolean } = {}) {
    const plan = compactDocuments([...this.documents.values()], {
      tokenBudget: options.tokenBudget,
      maxDocuments: options.maxDocuments,
      query: options.query,
      preserveLifecycle: options.preserveLifecycle,
      preserveSources: options.preserveSources,
    });

    if (options.apply && plan.dropped.length > 0) {
      for (const document of plan.dropped) this.deleteDocument(document.id);
      this.lastCompaction = plan.summary;
    }

    return plan;
  }

  private chunkText(text: string, maxTokens = this.chunkTokens): Array<{ text: string; position: number; tokenCount: number }> {
    const tokens = tokenize(text);
    const chunks: Array<{ text: string; position: number; tokenCount: number }> = [];
    for (let i = 0; i < tokens.length; i += maxTokens) {
      const slice = tokens.slice(i, i + maxTokens);
      chunks.push({ text: slice.join(' '), position: chunks.length, tokenCount: slice.length });
    }
    return chunks.length ? chunks : [{ text, position: 0, tokenCount: Math.max(1, tokens.length) }];
  }

  private recencyScore(createdAt: number, updatedAt: number): number {
    const ageHours = Math.max(0.001, (Date.now() - Math.max(createdAt, updatedAt)) / 3_600_000);
    return 1 / (1 + Math.log1p(ageHours));
  }

  private salienceScore(text: string): number {
    const signals = extractSemanticSignals(text);
    const emphasis = (text.match(/\b[A-Z]{3,}\b/g)?.length ?? 0) * 0.08 + signals.phrases.length * 0.12;
    return Math.min(1, signals.tokens.length > 0 ? 0.25 + (new Set(signals.tokens).size / signals.tokens.length) * 0.45 + emphasis : 0.2);
  }

  private reindexDocument(doc: MemoryDocument) {
    const old = this.chunksByDocument.get(doc.id) ?? [];
    for (const chunkId of old) {
      this.chunks.delete(chunkId);
      this.index.remove(chunkId);
    }

    const chunkIds: string[] = [];
    const parts = this.chunkText(`${doc.title}\n\n${doc.body}`);
    const recency = this.recencyScore(doc.createdAt, doc.updatedAt);
    const salience = this.salienceScore(`${doc.title}\n${doc.body}`);
    const lifecycle = classifyLifecycle(doc);

    for (const part of parts) {
      const terms = tokenize(part.text);
      const termVector: Record<string, number> = {};
      for (const token of terms) termVector[token] = (termVector[token] ?? 0) + 1;
      const chunkId = randomUUID();
      const chunk: ChunkRecord = {
        chunkId,
        documentId: doc.id,
        position: part.position,
        text: part.text,
        tokenCount: part.tokenCount,
        termVector,
        embedding: this.embeddingModel.embedText(part.text),
        salience,
        recencyScore: recency,
        lifecycle,
        source: doc.source,
      };
      this.chunks.set(chunkId, chunk);
      this.index.upsert({ id: chunkId, vector: chunk.embedding, ...chunk });
      chunkIds.push(chunkId);
    }

    this.chunksByDocument.set(doc.id, chunkIds);
  }

  private buildCandidates(query: RetrievalQuery, tokenBudget: number): CandidateSearch {
    const compacted = this.compact({
      tokenBudget,
      query: query.query,
      preserveLifecycle: query.filters?.compaction?.preserveLifecycle,
      preserveSources: query.filters?.compaction?.preserveSources,
      maxDocuments: query.filters?.compaction?.maxDocuments,
    });

    const allowedDocumentIds = new Set(compacted.retained.map((document) => document.id));
    const docs = [...this.documents.values()].filter((doc) => {
      if (!allowedDocumentIds.has(doc.id)) return false;
      if (query.filters?.documentIds && !query.filters.documentIds.includes(doc.id)) return false;
      if (query.filters?.source && !query.filters.source.includes(doc.source)) return false;
      if (query.filters?.tags && !query.filters.tags.every((tag) => doc.tags.includes(tag))) return false;
      return true;
    });

    return { compacted, docs };
  }

  private buildEvidence(anchor: RetrievalHit, query: RetrievalQuery, availableHits: RetrievalHit[]): RetrievalEvidenceHit[] {
    const candidates = availableHits
      .filter((hit) => hit.documentId !== anchor.documentId)
      .filter((hit) => hit.source !== anchor.source || hit.lifecycle !== anchor.lifecycle)
      .slice(0, 12);

    return candidates
      .map((candidate) => scoreEvidence(anchor, candidate, query, this.embeddingModel))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
  }

  private rewriteQuery(query: RetrievalQuery): { tokens: string[]; expandedTokens: string[]; rewrites: string[] } {
    const tokens = tokenize(query.query);
    const expandedTokens = expandTokens(tokens);
    const signals = extractSemanticSignals(query.query).axes;
    const rewrites = new Set<string>([query.query]);
    if (signals.thread || signals.reply || signals.followup) rewrites.add(`${query.query} thread reply followup`);
    if (signals.relationship || signals.people) rewrites.add(`${query.query} relationship contact history`);
    if (signals.reference || signals.knowledge) rewrites.add(`${query.query} docs reference architecture`);
    if (signals.transactional || signals.finance || signals.travel) rewrites.add(`${query.query} invoice booking confirmation`);
    return { tokens, expandedTokens, rewrites: [...rewrites] };
  }

  exportSnapshot(): RagCorpusSnapshot {
    return {
      version: 1,
      exportedAt: Date.now(),
      documents: this.listDocuments(),
      chunks: [...this.chunks.values()].sort((left, right) => left.documentId.localeCompare(right.documentId) || left.position - right.position),
      lastCompaction: this.lastCompaction,
    };
  }

  loadSnapshot(snapshot: RagCorpusSnapshot) {
    this.documents.clear();
    this.chunks.clear();
    this.chunksByDocument.clear();
    this.index.clear();
    this.lastCompaction = snapshot.lastCompaction;
    for (const document of snapshot.documents) this.documents.set(document.id, document);
    for (const chunk of snapshot.chunks) {
      this.chunks.set(chunk.chunkId, chunk);
      const chunkIds = this.chunksByDocument.get(chunk.documentId) ?? [];
      chunkIds.push(chunk.chunkId);
      this.chunksByDocument.set(chunk.documentId, chunkIds);
      this.index.upsert({ id: chunk.chunkId, vector: chunk.embedding, ...chunk });
    }
  }

  static fromSnapshot(snapshot: RagCorpusSnapshot, options: RagCorpusOptions = {}) {
    const corpus = new RagCorpus(options);
    corpus.loadSnapshot(snapshot);
    return corpus;
  }

  stats() {
    return {
      documents: this.documents.size,
      chunks: this.chunks.size,
      indexedChunks: this.index.size(),
      lastCompaction: this.lastCompaction,
      upsertsSinceCompaction: this.upsertsSinceCompaction,
    };
  }

  retrieve(query: RetrievalQuery): RetrievalResult {
    const tokenBudget = query.filters?.compaction?.tokenBudget ?? 12_000;
    const { compacted, docs } = this.buildCandidates(query, tokenBudget);
    const { tokens, expandedTokens, rewrites } = this.rewriteQuery(query);
    const queryVector = this.embeddingModel.embedText(rewrites.join('\n'));
    const allowedDocuments = new Set(docs.map((doc) => doc.id));
    const sourceFilter = query.filters?.source ? new Set(query.filters.source) : undefined;
    const documentFilter = new Set(docs.map((doc) => doc.id));
    const candidateLimit = Math.max(query.k * this.retrieval.candidateMultiplier, 32);
    const lexicalCandidates = query.mode === 'semantic' ? [] : this.index.lexicalSearch(expandedTokens, {
      limit: candidateLimit,
      lexicalLimit: Math.max(candidateLimit * 2, 64),
      sourceFilter,
      documentFilter,
      diversifyBySource: true,
      keepPerSource: 5,
      metadata: (entry) => allowedDocuments.has(entry.documentId),
    });
    const lexicalCandidateIds = new Set(lexicalCandidates.map((candidate) => candidate.entry.id));

    let vectorStats = query.mode === 'lexical' ? { results: [], scanned: 0, candidatePoolSize: 0 } : this.index.searchWithStats(queryVector, {
      limit: candidateLimit,
      sourceFilter,
      documentFilter,
      diversifyBySource: true,
      keepPerSource: 3,
      metadata: (entry) => allowedDocuments.has(entry.documentId),
      candidateIds: lexicalCandidateIds.size >= query.k ? lexicalCandidateIds : undefined,
      lexicalTokens: query.mode === 'semantic' || lexicalCandidateIds.size >= query.k ? undefined : expandedTokens,
      lexicalLimit: Math.max(candidateLimit * 3, 96),
    });
    if (query.mode !== 'lexical' && lexicalCandidateIds.size > 0 && vectorStats.results.length < query.k) {
      vectorStats = this.index.searchWithStats(queryVector, {
        limit: candidateLimit,
        sourceFilter,
        documentFilter,
        diversifyBySource: true,
        keepPerSource: 3,
        metadata: (entry) => allowedDocuments.has(entry.documentId),
      });
    }
    const rawCandidates = [...lexicalCandidates, ...vectorStats.results];
    const candidateById = new Map<string, typeof rawCandidates[number]>();
    for (const candidate of rawCandidates) {
      const existing = candidateById.get(candidate.entry.id);
      if (!existing || candidate.score > existing.score) candidateById.set(candidate.entry.id, candidate);
    }

    const scoredHits = [...candidateById.values()].map(({ entry }) => {
      const document = this.documents.get(entry.documentId)!;
      const hit = scoreChunk(entry, query, { embeddingModel: this.embeddingModel, queryEmbedding: queryVector, queryTokens: expandedTokens });
      return {
        ...hit,
        title: document.title,
        source: document.source,
      };
    }).filter((hit) => hit.gradeScore >= this.retrieval.minGradeScore);

    const reranked = rerankHits(scoredHits, query).slice(0, Math.max(query.k * 2, query.k));
    const evidenceTrace: Array<{ anchorDocumentId: string; evidence: RetrievalEvidenceHit[] }> = [];
    const hits: RetrievalHit[] = reranked.slice(0, query.k).map((hit) => {
      const evidence = this.buildEvidence(hit, query, reranked.filter((candidate) => candidate.documentId !== hit.documentId));
      evidenceTrace.push({ anchorDocumentId: hit.documentId, evidence });
      return { ...hit, evidence };
    });

    const stageNotes: string[] = [
      `documents=${docs.length}`,
      `chunks=${this.chunks.size}`,
      `lexicalCandidates=${lexicalCandidates.length}`,
      `vectorCandidates=${vectorStats.results.length}`,
      `vectorScanned=${vectorStats.scanned}`,
      `tokens=${tokens.length} expanded=${expandedTokens.length}`,
    ];
    if (compacted.dropped.length > 0) stageNotes.push(compacted.summary);

    return {
      query: query.query,
      hits,
      coverage: {
        chunksScanned: Math.max(candidateById.size, vectorStats.scanned),
        chunksIndexed: this.chunks.size,
        lexicalCandidates: lexicalCandidates.length,
        vectorCandidates: vectorStats.results.length,
        gradedCandidates: scoredHits.length,
        documentsScanned: docs.length,
        matchedDocuments: new Set(hits.map((hit) => hit.documentId)).size,
      },
      trace: {
        tokens,
        expandedTokens,
        rewrites,
        stages: [
          { name: 'query-rewrite', topScore: rewrites.length, notes: rewrites.slice(0, 4) },
          { name: 'lexical-bm25-candidate-search', topScore: lexicalCandidates[0]?.score ?? 0, notes: lexicalCandidates.map((candidate) => `${candidate.entry.documentId}:${candidate.score.toFixed(3)}`).slice(0, 5) },
          { name: 'vector-candidate-search', topScore: vectorStats.results[0]?.score ?? 0, notes: stageNotes },
          { name: 'retrieval-grading', topScore: scoredHits[0]?.gradeScore ?? 0, notes: scoredHits.map((hit) => `${hit.documentId}:${hit.grade}:${hit.gradeScore.toFixed(3)}`).slice(0, 6) },
          { name: 'semantic-rerank', topScore: reranked[0]?.score ?? 0, notes: reranked.map((hit) => `${hit.documentId}:${hit.score.toFixed(3)}`).slice(0, 5) },
          { name: 'cross-source-evidence', topScore: hits[0]?.evidence[0]?.score ?? 0, notes: evidenceTrace.flatMap((entry) => entry.evidence.map((evidence) => `${entry.anchorDocumentId}<-${evidence.documentId}:${evidence.score.toFixed(3)}`)).slice(0, 6) },
        ],
        compaction: {
          summary: compacted.summary,
          budgetTokens: compacted.budgetTokens,
          usedTokens: compacted.usedTokens,
          retained: compacted.retained.length,
          dropped: compacted.dropped.length,
        },
        evidence: evidenceTrace,
        needsFallback: hits.length < query.k || hits.every((hit) => hit.grade === 'weak'),
      },
    };
  }

  listDocuments(): MemoryDocument[] {
    return [...this.documents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
