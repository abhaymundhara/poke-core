export type MemoryFact = {
  key: string;
  value: string;
  confidence: number;
  source: string;
  updatedAt: number;
};

export class WorkingMemory {
  private facts = new Map<string, MemoryFact>();
  private trail: Array<{ event: string; at: number; detail: Record<string, unknown> }> = [];

  upsertFact(key: string, value: string, confidence = 0.8, source = 'system') {
    const fact: MemoryFact = { key, value, confidence, source, updatedAt: Date.now() };
    this.facts.set(key, fact);
    this.trail.push({ event: 'upsert_fact', at: Date.now(), detail: { key, confidence, source } });
    return fact;
  }

  getFact(key: string): MemoryFact | null {
    return this.facts.get(key) ?? null;
  }

  query(prefix: string): MemoryFact[] {
    return [...this.facts.values()].filter((fact) => fact.key.startsWith(prefix)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  appendTrail(event: string, detail: Record<string, unknown> = {}) {
    this.trail.push({ event, at: Date.now(), detail });
  }

  snapshot() {
    return {
      facts: [...this.facts.values()].sort((a, b) => a.key.localeCompare(b.key)),
      trail: [...this.trail],
    };
  }
}
