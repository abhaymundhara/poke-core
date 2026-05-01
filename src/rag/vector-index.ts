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
};

export type VectorSearchResult<T> = {
  entry: VectorIndexEntry<T>;
  score: number;
};

export class SemanticVectorIndex<T extends { source?: string; documentId?: string }> {
  private entries = new Map<string, VectorIndexEntry<T>>();

  upsert(entry: VectorIndexEntry<T>) {
    this.entries.set(entry.id, entry);
  }

  remove(id: string) {
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
  }

  values() {
    return [...this.entries.values()];
  }

  search(queryVector: number[], options: VectorSearchOptions<T> = {}): VectorSearchResult<T>[] {
    const limit = options.limit ?? 10;
    const keepPerSource = options.keepPerSource ?? 2;
    const scored = [...this.entries.values()]
      .filter((entry) => !options.excludeIds?.has(entry.id))
      .filter((entry) => !options.sourceFilter || !entry.source || options.sourceFilter.has(entry.source))
      .filter((entry) => !options.documentFilter || !entry.documentId || options.documentFilter.has(entry.documentId))
      .filter((entry) => (options.metadata ? options.metadata(entry) : true))
      .map((entry) => ({ entry, score: cosineSimilarity(queryVector, entry.vector) }))
      .filter((result) => result.score >= (options.minScore ?? -1));

    scored.sort((left, right) => right.score - left.score);
    if (!options.diversifyBySource) return scored.slice(0, limit);

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
}
