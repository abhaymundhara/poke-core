import { createHash } from 'node:crypto';
import type { ChunkRecord, MemoryDocument } from '../rag/types';
import { BehavioralLearningLayer } from './behavioral-learning';
import type { EpisodicMemoryItem } from './episodic-memory';
import type { MemoryFact } from './working-memory';

export type EntityLink = { entityId: string; label: string; sources: string[]; references: string[]; confidence: number };
export type ConsolidationInput = { now?: number; clock?: { now(): number }; workingFacts: MemoryFact[]; episodicItems: EpisodicMemoryItem[]; sourceDocuments?: MemoryDocument[]; decayHalfLifeHours?: number };
export type ConsolidationResult = { promotedFacts: MemoryFact[]; semanticDocuments: MemoryDocument[]; semanticChunks: ChunkRecord[]; links: EntityLink[]; decayedFacts: string[]; summary: string };

function normalizeKey(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9@._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }
function extractEntities(text: string): string[] {
  const lower = text.toLowerCase();
  const emails = lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  const ids = lower.match(/\b(?:thread|event|meeting|project|ticket|case|doc|page|task|user-model|preference)[-_]?[a-z0-9]+\b/g) ?? [];
  const names = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) ?? [];
  return [...new Set([...emails, ...ids, ...names].map(normalizeKey).filter(Boolean))];
}
function halfLifeDecay(ageHours: number, halfLifeHours: number): number { return Math.pow(0.5, ageHours / Math.max(1, halfLifeHours)); }
function sourceWeight(source: string): number { if (/email|calendar/.test(source)) return 1; if (/browser|filesystem/.test(source)) return 0.9; if (/memory|system/.test(source)) return 0.8; return 0.85; }
function salienceScore(params: { confidence: number; recency: number; entityDensity: number; source: string }): number { return Math.min(1, params.confidence * 0.42 + params.recency * 0.28 + params.entityDensity * 0.18 + sourceWeight(params.source) * 0.12); }
function stableId(prefix: string, parts: string[]): string { return `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 18)}`; }

function mergePromotedFacts(facts: MemoryFact[]): MemoryFact[] {
  const merged = new Map<string, MemoryFact>();
  for (const fact of facts) {
    const current = merged.get(fact.key);
    if (!current || current.confidence < fact.confidence || current.updatedAt <= fact.updatedAt) merged.set(fact.key, fact);
  }
  return [...merged.values()].sort((left, right) => right.confidence - left.confidence || right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
}

export class MemoryConsolidationJob {
  constructor(private readonly input: ConsolidationInput) {}

  run(): ConsolidationResult {
    const now = this.input.now ?? this.input.clock?.now() ?? 0;
    const halfLifeHours = this.input.decayHalfLifeHours ?? 24;
    const factsWithScores = this.input.workingFacts.map((fact) => {
      const ageHours = Math.max(0, (now - fact.updatedAt) / 3_600_000);
      const recency = halfLifeDecay(ageHours, halfLifeHours);
      const entities = extractEntities(`${fact.key} ${fact.value}`);
      return { fact, salience: salienceScore({ confidence: fact.confidence, recency, entityDensity: entities.length / 4, source: fact.source }), entities, ageHours };
    });

    const episodesWithScores = this.input.episodicItems.map((item) => {
      const ageHours = Math.max(0, (now - item.createdAt) / 3_600_000);
      const recency = halfLifeDecay(ageHours, halfLifeHours * 2);
      const entities = extractEntities(`${item.summary} ${item.signals.join(' ')}`);
      return { item, salience: Math.min(1, item.score * 0.5 + recency * 0.35 + entities.length * 0.04), entities, ageHours };
    });

    const grouped = new Map<string, { title: string; body: string[]; tags: Set<string>; source: string; factRefs: string[]; episodeRefs: string[]; updatedAt: number; importance: number; threadId?: string; relationshipId?: string }>();
    const links: EntityLink[] = [];

    const register = (entity: string, label: string, source: string, reference: string, confidence: number) => {
      const existing = links.find((link) => link.entityId === entity);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (!existing.references.includes(reference)) existing.references.push(reference);
        existing.confidence = Number(Math.min(1, Math.max(existing.confidence, confidence)).toFixed(3));
        return;
      }
      links.push({ entityId: entity, label, sources: [source], references: [reference], confidence: Number(confidence.toFixed(3)) });
    };

    for (const entry of factsWithScores) {
      const topEntity = entry.entities[0] ?? stableId('entity', [entry.fact.key, entry.fact.source]);
      register(topEntity, entry.fact.key, entry.fact.source, entry.fact.key, entry.salience);
      const documentId = stableId('semantic', [entry.fact.key, entry.fact.source]);
      const existing = grouped.get(documentId) ?? { title: entry.fact.key.replace(/^fact:/, ''), body: [], tags: new Set<string>(['semantic', entry.fact.source]), source: entry.fact.source, factRefs: [], episodeRefs: [], updatedAt: now, importance: entry.salience };
      existing.body.push(`${entry.fact.key}: ${entry.fact.value}`);
      existing.factRefs.push(entry.fact.key);
      existing.importance = Math.max(existing.importance, entry.salience);
      existing.updatedAt = Math.max(existing.updatedAt, entry.fact.updatedAt);
      if (entry.fact.key.includes(':')) existing.threadId = entry.fact.key.split(':').slice(0, 3).join(':');
      grouped.set(documentId, existing);
    }

    for (const entry of episodesWithScores) {
      const topEntity = entry.entities[0] ?? stableId('entity', [entry.item.taskId, entry.item.category, entry.item.id]);
      register(topEntity, entry.item.category, `episode:${entry.item.taskId}`, entry.item.id, entry.salience);
      const documentId = stableId('episode', [entry.item.taskId, entry.item.category, entry.item.id]);
      const existing = grouped.get(documentId) ?? { title: `${entry.item.category} ${entry.item.taskId}`.trim(), body: [], tags: new Set<string>(['episodic', entry.item.category]), source: `episode:${entry.item.taskId}`, factRefs: [], episodeRefs: [], updatedAt: now, importance: entry.salience };
      existing.body.push(entry.item.summary);
      existing.body.push(`signals: ${entry.item.signals.join(', ')}`);
      existing.episodeRefs.push(entry.item.id);
      existing.importance = Math.max(existing.importance, entry.salience);
      grouped.set(documentId, existing);
    }

    for (const doc of this.input.sourceDocuments ?? []) {
      const documentId = doc.id;
      const existing = grouped.get(documentId) ?? { title: doc.title, body: [], tags: new Set<string>(doc.tags), source: doc.source, factRefs: [], episodeRefs: [], updatedAt: doc.updatedAt, importance: doc.importance ?? 0.5, relationshipId: doc.relationshipId, threadId: doc.threadId };
      existing.body.push(doc.body);
      existing.updatedAt = Math.max(existing.updatedAt, doc.updatedAt);
      existing.importance = Math.max(existing.importance, doc.importance ?? 0.5);
      grouped.set(documentId, existing);
    }

    const behavioral = new BehavioralLearningLayer().learn({ now, workingFacts: this.input.workingFacts, episodicItems: this.input.episodicItems, sourceDocuments: this.input.sourceDocuments });

    const semanticDocuments: MemoryDocument[] = [];
    const semanticChunks: ChunkRecord[] = [];

    for (const [documentId, entry] of grouped.entries()) {
      const body = entry.body.join('\n').trim();
      semanticDocuments.push({ id: documentId, source: entry.source, title: entry.title, body, createdAt: entry.updatedAt, updatedAt: now, tags: [...entry.tags], metadata: { importance: Number(entry.importance.toFixed(3)), factRefs: entry.factRefs, episodeRefs: entry.episodeRefs }, threadId: entry.threadId, relationshipId: entry.relationshipId, importance: entry.importance });
      const chunks = body.split(/\n+/).filter(Boolean);
      for (const [position, text] of chunks.entries()) {
        const entities = extractEntities(text);
        semanticChunks.push({
          chunkId: stableId('chunk', [documentId, String(position)]),
          documentId,
          position,
          text,
          tokenCount: text.split(/\s+/).filter(Boolean).length,
          termVector: entities.reduce<Record<string, number>>((acc, entity) => { acc[entity] = (acc[entity] ?? 0) + 1; return acc; }, {}),
          embedding: [],
          salience: Number(entry.importance.toFixed(3)),
          recencyScore: Number(halfLifeDecay(Math.max(0, (now - entry.updatedAt) / 3_600_000), halfLifeHours).toFixed(3)),
          lifecycle: entry.tags.has('episodic') ? 'thread' : entry.tags.has('preference') ? 'preference' : entry.tags.has('semantic') ? 'reference' : 'unknown',
          source: entry.source,
        });
      }
    }

    semanticDocuments.push(...behavioral.semanticDocuments);
    semanticChunks.push(...behavioral.semanticChunks);

    const promotedFacts = mergePromotedFacts([
      ...factsWithScores.filter((entry) => entry.salience >= 0.5).map(({ fact, salience }) => ({ ...fact, confidence: Number(Math.min(1, Math.max(fact.confidence, salience)).toFixed(3)) })),
      ...behavioral.promotedFacts,
    ]);

    const decayedFacts = factsWithScores.filter((entry) => entry.salience < 0.35 || entry.ageHours > halfLifeHours * 3).map((entry) => entry.fact.key);
    return { promotedFacts, semanticDocuments, semanticChunks, links, decayedFacts, summary: `${promotedFacts.length} facts promoted, ${semanticDocuments.length} semantic docs, ${links.length} entity links; ${behavioral.summary}` };
  }
}
