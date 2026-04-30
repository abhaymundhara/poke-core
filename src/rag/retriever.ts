import { randomUUID } from 'node:crypto';
import { expandTokens, tokenize } from './tokenize';
import { scoreChunk } from './scoring';
import type { ChunkRecord, MemoryDocument, RetrievalQuery, RetrievalResult } from './types';

export class RagCorpus {
  private documents = new Map<string, MemoryDocument>();
  private chunks = new Map<string, ChunkRecord>();
  private chunksByDocument = new Map<string, string[]>();

  upsertDocument(doc: Omit<MemoryDocument, 'createdAt' | 'updatedAt'> & Partial<Pick<MemoryDocument, 'createdAt' | 'updatedAt'>>) {
    const now = Date.now();
    const record: MemoryDocument = { ...doc, createdAt: doc.createdAt ?? now, updatedAt: now };
    this.documents.set(record.id, record);
    this.reindexDocument(record);
    return record;
  }

  deleteDocument(documentId: string) {
    const chunkIds = this.chunksByDocument.get(documentId) ?? [];
    for (const chunkId of chunkIds) this.chunks.delete(chunkId);
    this.chunksByDocument.delete(documentId);
    this.documents.delete(documentId);
  }

  private recencyScore(createdAt: number, updatedAt: number): number {
    const ageHours = Math.max(0.001, (Date.now() - Math.max(createdAt, updatedAt)) / (1000 * 60 * 60));
    return 1 / (1 + Math.log1p(ageHours));
  }

  private salienceScore(text: string): number {
    const tokens = tokenize(text);
    const unique = new Set(tokens);
    const density = unique.size / Math.max(1, tokens.length);
    const emphasis = (text.match(/\b[A-Z]{3,}\b/g)?.length ?? 0) * 0.1 + (text.match(/[*_]{1,2}[^*_]+[*_]{1,2}/g)?.length ?? 0) * 0.15;
    return Math.min(1, density * 0.7 + emphasis);
  }

  private chunkText(text: string, maxTokens = 220): Array<{ text: string; position: number }> {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: Array<{ text: string; position: number }> = [];
    for (let i = 0; i < words.length; i += maxTokens) {
      chunks.push({ text: words.slice(i, i + maxTokens).join(' '), position: chunks.length });
    }
    return chunks.length ? chunks : [{ text, position: 0 }];
  }

  private reindexDocument(doc: MemoryDocument) {
    const old = this.chunksByDocument.get(doc.id) ?? [];
    for (const chunkId of old) this.chunks.delete(chunkId);
    const chunkIds: string[] = [];
    const parts = this.chunkText(`${doc.title}\n\n${doc.body}`);
    const recency = this.recencyScore(doc.createdAt, doc.updatedAt);
    const salience = this.salienceScore(`${doc.title}\n${doc.body}`);
    for (const part of parts) {
      const termVector: Record<string, number> = {};
      for (const token of tokenize(part.text)) termVector[token] = (termVector[token] ?? 0) + 1;
      const chunkId = randomUUID();
      const chunk: ChunkRecord = {
        chunkId,
        documentId: doc.id,
        position: part.position,
        text: part.text,
        tokenCount: tokenize(part.text).length,
        termVector,
        salience,
        recencyScore: recency,
      };
      this.chunks.set(chunkId, chunk);
      chunkIds.push(chunkId);
    }
    this.chunksByDocument.set(doc.id, chunkIds);
  }

  retrieve(query: RetrievalQuery): RetrievalResult {
    const tokens = tokenize(query.query);
    const expandedTokens = expandTokens(tokens);
    const docs = [...this.documents.values()].filter((doc) => {
      if (query.filters?.documentIds && !query.filters.documentIds.includes(doc.id)) return false;
      if (query.filters?.source && !query.filters.source.includes(doc.source)) return false;
      if (query.filters?.tags && !query.filters.tags.every((tag) => doc.tags.includes(tag))) return false;
      return true;
    });

    const stageNotes: string[] = [];
    const hits = [...this.chunks.values()]
      .filter((chunk) => docs.some((doc) => doc.id === chunk.documentId))
      .map((chunk) => {
        const doc = this.documents.get(chunk.documentId)!;
        const hit = scoreChunk(chunk, query);
        hit.title = doc.title;
        hit.source = doc.source;
        return hit;
      })
      .sort((a, b) => b.score - a.score || b.recencyScore - a.recencyScore)
      .slice(0, query.k);

    stageNotes.push(`documents=${docs.length}`);
    stageNotes.push(`chunks=${this.chunks.size}`);
    stageNotes.push(`tokens=${tokens.length} expanded=${expandedTokens.length}`);

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
          { name: 'candidate-filter', topScore: hits[0]?.score ?? 0, notes: stageNotes },
          { name: 'rerank', topScore: hits[0]?.score ?? 0, notes: hits.map((hit) => `${hit.documentId}:${hit.score.toFixed(3)}`).slice(0, 5) },
        ],
      },
    };
  }

  listDocuments(): MemoryDocument[] {
    return [...this.documents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
