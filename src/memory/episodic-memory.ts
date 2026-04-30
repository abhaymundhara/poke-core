export type EpisodicMemoryItem = {
  id: string;
  taskId: string;
  category: 'success' | 'failure' | 'decision' | 'correction' | 'preference';
  summary: string;
  signals: string[];
  score: number;
  createdAt: number;
};

export class EpisodicMemory {
  private items: EpisodicMemoryItem[] = [];

  add(item: Omit<EpisodicMemoryItem, 'createdAt'>) {
    const record = { ...item, createdAt: Date.now() };
    this.items.push(record);
    return record;
  }

  recall(taskHint: string, limit = 8): EpisodicMemoryItem[] {
    const q = taskHint.toLowerCase();
    return [...this.items]
      .map((item) => ({
        item,
        score: item.score + this.matchScore(q, item),
      }))
      .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
      .slice(0, limit)
      .map((x) => x.item);
  }

  private matchScore(q: string, item: EpisodicMemoryItem): number {
    const hay = `${item.summary} ${item.signals.join(' ')}`.toLowerCase();
    const matches = q.split(/\s+/).filter((token) => token.length > 2 && hay.includes(token)).length;
    return matches / Math.max(1, q.split(/\s+/).length);
  }
}
