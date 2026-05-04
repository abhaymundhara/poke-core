import { cosineSimilarity } from './embeddings';

export type VectorIndexEntry<T> = T & {
  id: string;
  vector: number[];
};

export type VectorSearchOptions<T> = {
  limit?: number;
  excludeIds?: Set<string>;
  sourceFilter?: Set<string>;
  documentFilter?: Set<string>;
  minScore?: number;
  diversifyBySource?: boolean;
  keepPerSource?: number;
  metadata?: (entry: VectorIndexEntry<T>) => boolean;
  candidateIds?: Set<string>;
  lexicalTokens?: string[];
  lexicalLimit?: number;
};

export type VectorSearchResult<T> = {
  entry: VectorIndexEntry<T>;
  score: number;
};

export type VectorSearchStats<T> = {
  results: VectorSearchResult<T>[];
  scanned: number;
  candidatePoolSize: number;
};

export class SemanticVectorIndex<T extends { source?: string; documentId?: string; termVector?: Record<string, number>; tokenCount?: number }> {
  private entries = new Map<string, VectorIndexEntry<T>>();
  private postings = new Map<string, Set<string>>();

  upsert(entry: VectorIndexEntry<T>) {
    this.remove(entry.id);
    this.entries.set(entry.id, entry);
    for (const token of Object.keys(entry.termVector ?? {})) {
      const posting = this.postings.get(token) ?? new Set<string>();
      posting.add(entry.id);
      this.postings.set(token, posting);
    }
  }

  remove(id: string) {
    const entry = this.entries.get(id);
    if (entry?.termVector) {
      for (const token of Object.keys(entry.termVector)) {
        const posting = this.postings.get(token);
        if (!posting) continue;
        posting.delete(id);
        if (posting.size === 0) this.postings.delete(token);
      }
    }
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
    this.postings.clear();
  }

  values() {
    return [...this.entries.values()];
  }

  size() {
    return this.entries.size;
  }

  private lexicalCandidateIds(tokens: string[], limit: number): Set<string> {
    const scores = new Map<string, number>();
    const totalDocuments = Math.max(1, this.entries.size);
    for (const token of tokens) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const idf = Math.log(1 + (totalDocuments - posting.size + 0.5) / (posting.size + 0.5));
      for (const id of posting) {
        const entry = this.entries.get(id);
        const tf = entry?.termVector?.[token] ?? 0;
        if (!entry || tf <= 0) continue;
        const lengthNorm = 1 / Math.max(1, Math.log2((entry.tokenCount ?? 0) + 2));
        scores.set(id, (scores.get(id) ?? 0) + (1 + Math.log1p(tf)) * idf * lengthNorm);
      }
    }
    return new Set([...scores.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([id]) => id));
  }

  private candidateEntries(options: VectorSearchOptions<T>): VectorIndexEntry<T>[] {
    let ids = options.candidateIds;
    if (!ids && options.lexicalTokens?.length) {
      const lexicalIds = this.lexicalCandidateIds(options.lexicalTokens, options.lexicalLimit ?? Math.max(options.limit ?? 10, 64));
      if (lexicalIds.size > 0) ids = lexicalIds;
    }
    if (!ids) return [...this.entries.values()];
    return [...ids].map((id) => this.entries.get(id)).filter((entry): entry is VectorIndexEntry<T> => Boolean(entry));
  }

  private applySourceDiversity(scored: VectorSearchResult<T>[], limit: number, keepPerSource: number): VectorSearchResult<T>[] {
    const selected: VectorSearchResult<T>[] = [];
    const sourceCounts = new Map<string, number>();

    for (const result of scored) {
      const source = result.entry.source ?? '__unknown__';
      const count = sourceCounts.get(source) ?? 0;
      if (count >= keepPerSource) continue;
      selected.push(result);
      sourceCounts.set(source, count + 1);
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      for (const result of scored) {
        if (selected.some((entry) => entry.entry.id === result.entry.id)) continue;
        selected.push(result);
        if (selected.length >= limit) break;
      }
    }

    return selected.slice(0, limit);
  }

  lexicalSearch(tokens: string[], options: Omit<VectorSearchOptions<T>, 'lexicalTokens' | 'candidateIds'> = {}): VectorSearchResult<T>[] {
    const limit = options.limit ?? 10;
    const keepPerSource = options.keepPerSource ?? 2;
    const totalDocuments = Math.max(1, this.entries.size);
    const scored = [...this.lexicalCandidateIds(tokens, options.lexicalLimit ?? Math.max(limit * 8, 64))]
      .map((id) => this.entries.get(id))
      .filter((entry): entry is VectorIndexEntry<T> => Boolean(entry))
      .filter((entry) => !options.excludeIds?.has(entry.id))
      .filter((entry) => !options.sourceFilter || !entry.source || options.sourceFilter.has(entry.source))
      .filter((entry) => !options.documentFilter || !entry.documentId || options.documentFilter.has(entry.documentId))
      .filter((entry) => (options.metadata ? options.metadata(entry) : true))
      .map((entry) => {
        let score = 0;
        for (const token of tokens) {
          const tf = entry.termVector?.[token] ?? 0;
          if (tf <= 0) continue;
          const postingSize = this.postings.get(token)?.size ?? 0;
          const idf = Math.log(1 + (totalDocuments - postingSize + 0.5) / (postingSize + 0.5));
          const lengthNorm = 1 / Math.max(1, Math.log2((entry.tokenCount ?? 0) + 2));
          score += (1 + Math.log1p(tf)) * idf * lengthNorm;
        }
        return { entry, score };
      })
      .filter((result) => result.score >= (options.minScore ?? -1));

    scored.sort((left, right) => right.score - left.score);
    if (!options.diversifyBySource) return scored.slice(0, limit);
    return this.applySourceDiversity(scored, limit, keepPerSource);
  }

  searchWithStats(queryVector: number[], options: VectorSearchOptions<T> = {}): VectorSearchStats<T> {
    const limit = options.limit ?? 10;
    const keepPerSource = options.keepPerSource ?? 2;
    const candidates = this.candidateEntries(options);
    const scored = candidates
      .filter((entry) => !options.excludeIds?.has(entry.id))
      .filter((entry) => !options.sourceFilter || !entry.source || options.sourceFilter.has(entry.source))
      .filter((entry) => !options.documentFilter || !entry.documentId || options.documentFilter.has(entry.documentId))
      .filter((entry) => (options.metadata ? options.metadata(entry) : true))
      .map((entry) => ({ entry, score: cosineSimilarity(queryVector, entry.vector) }))
      .filter((result) => result.score >= (options.minScore ?? -1));

    scored.sort((left, right) => right.score - left.score);
    const ranked = !options.diversifyBySource ? scored.slice(0, limit) : this.applySourceDiversity(scored, limit, keepPerSource);

    return { results: ranked, scanned: candidates.length, candidatePoolSize: candidates.length };
  }

  search(queryVector: number[], options: VectorSearchOptions<T> = {}): VectorSearchResult<T>[] {
    return this.searchWithStats(queryVector, options).results;
  }
}
