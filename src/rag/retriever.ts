import { randomUUID } from 'node:crypto';
import { compactDocuments, classifyLifecycle } from './compaction';
import { defaultSemanticEmbeddingModel, extractSemanticSignals } from './embeddings';
import { expandTokens, tokenize } from './tokenize';
import { rerankHits, scoreChunk, scoreEvidence } from './scoring';
import { SemanticVectorIndex } from './vector-index';
import type { ChunkRecord, MemoryDocument, RetrievalEvidenceHit, RetrievalQuery, RetrievalResult, RetrievalHit } from './types';

export class RagCorpus {
  private documents = new Map<string, MemoryDocument>();
  private chunks = new Map<string, ChunkRecord>();
  private chunksByDocument = new Map<string, string[]>();
  private index = new SemanticVectorIndex<ChunkRecord>();
  private lastCompaction: string | null = null;

  upsertDocument(doc: Omit<MemoryDocument, 'createdAt' | 'updatedAt'> & Partial<Pick<MemoryDocument, 'createdAt' | 'updatedAt'>>) {
    const now = Date.now();
    const record: MemoryDocument = { ...doc, createdAt: doc.createdAt ?? now, updatedAt: now };
    this.documents.set(record.id, record);
    this.reindexDocument(record);
    if (this.documents.size > 256) this.compact({ tokenBudget: 12_000, query: `${record.title} ${record.body}`, apply: true });
    return record;
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

  private chunkText(text: string, maxTokens = 220): Array<{ text: string; position: number; tokenCount: number }> {
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
        embedding: defaultSemanticEmbeddingModel.embedText(part.text),
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

  private buildCandidates(query: RetrievalQuery, tokenBudget: number) {
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
      .map((candidate) => scoreEvidence(anchor, candidate, query))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
  }

  retrieve(query: RetrievalQuery): RetrievalResult {
    const tokenBudget = query.filters?.compaction?.tokenBudget ?? 12_000;
    const { compacted, docs } = this.buildCandidates(query, tokenBudget);
    const tokens = tokenize(query.query);
    const expandedTokens = expandTokens(tokens);
    const queryVector = defaultSemanticEmbeddingModel.embedText(query.query);
    const allowedDocuments = new Set(docs.map((doc) => doc.id));
    const sourceFilter = query.filters?.source ? new Set(query.filters.source) : undefined;
    const documentFilter = new Set(docs.map((doc) => doc.id));

    const rawCandidates = this.index.search(queryVector, {
      limit: Math.max(query.k * 8, 32),
      sourceFilter,
      documentFilter,
      diversifyBySource: true,
      keepPerSource: 3,
      metadata: (entry) => allowedDocuments.has(entry.documentId),
    });

    const scoredHits = rawCandidates.map(({ entry }) => {
      const document = this.documents.get(entry.documentId)!;
      const hit = scoreChunk(entry, query);
      return {
        ...hit,
        title: document.title,
        source: document.source,
      };
    });

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
      `tokens=${tokens.length} expanded=${expandedTokens.length}`,
    ];
    if (compacted.dropped.length > 0) stageNotes.push(compacted.summary);

    return {
      query: query.query,
      hits,
      coverage: {
        chunksScanned: this.chunks.size,
        documentsScanned: docs.length,
        matchedDocuments: new Set(hits.map((hit) => hit.documentId)).size,
      },
      trace: {
        tokens,
        expandedTokens,
        stages: [
          { name: 'vector-candidate-search', topScore: rawCandidates[0]?.score ?? 0, notes: stageNotes },
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
      },
    };
  }

  listDocuments(): MemoryDocument[] {
    return [...this.documents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
