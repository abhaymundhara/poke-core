import type { DocumentLifecycle, MemoryDocument } from './types';

export type CompactionPlan = {
  retained: MemoryDocument[];
  dropped: MemoryDocument[];
  summary: string;
};

export type CompactionOptions = {
  maxDocuments?: number;
  preserveLifecycle?: DocumentLifecycle[];
  query?: string;
};

export function classifyLifecycle(document: MemoryDocument): DocumentLifecycle {
  const haystack = `${document.source} ${document.title} ${document.body} ${(document.tags ?? []).join(' ')}`.toLowerCase();
  const metadata = document.metadata ?? {};
  if (typeof metadata.threadId === 'string' || typeof document.threadId === 'string' || /\b(thread|reply|inbox|message|mail)\b/.test(haystack)) return 'thread';
  if (typeof metadata.relationshipId === 'string' || typeof document.relationshipId === 'string' || /\b(relationship|contact|colleague|friend|manager|client|teammate)\b/.test(haystack)) return 'relationship';
  if (/\b(invoice|receipt|booking|payment|confirmation|schedule|task|ticket|status|delivery|deadline)\b/.test(haystack)) return 'transactional';
  if (/\b(preference|persona|style|tone|profile|memory)\b/.test(haystack)) return 'preference';
  if (/\b(reference|documentation|guide|policy|spec|readme)\b/.test(haystack)) return 'reference';
  return 'unknown';
}

function recencyScore(document: MemoryDocument): number {
  const ageHours = Math.max(0.001, (Date.now() - Math.max(document.createdAt, document.updatedAt)) / 3_600_000);
  return 1 / (1 + Math.log1p(ageHours));
}

function queryAffinity(query: string, document: MemoryDocument, lifecycle: DocumentLifecycle): number {
  const lower = query.toLowerCase();
  const tokens = [document.title, document.source, ...(document.tags ?? []), String(document.metadata.topic ?? ''), String(document.metadata.topicId ?? '')].join(' ').toLowerCase();
  let boost = 0;
  if (/\b(thread|reply|email|mail|inbox)\b/.test(lower) && lifecycle === 'thread') boost += 0.45;
  if (/\b(relationship|contact|who|person|people|colleague|manager)\b/.test(lower) && lifecycle === 'relationship') boost += 0.45;
  if (/\b(calendar|meeting|schedule|conflict|availability|time)\b/.test(lower) && lifecycle === 'transactional') boost += 0.1;
  if (/\b(preference|style|tone|profile|memory)\b/.test(lower) && lifecycle === 'preference') boost += 0.4;
  if (lower.split(/\s+/).some((token) => token.length > 3 && tokens.includes(token))) boost += 0.18;
  return boost;
}

function retentionScore(document: MemoryDocument, query: string, preserveLifecycle: DocumentLifecycle[]): number {
  const lifecycle = classifyLifecycle(document);
  const ageHours = Math.max(0.001, (Date.now() - Math.max(document.createdAt, document.updatedAt)) / 3_600_000);
  const ageDays = ageHours / 24;
  const freshness = recencyScore(document);
  const importance = Math.max(0, Math.min(1.5, Number(document.importance ?? document.metadata.importance ?? 0.5)));
  const relationshipBoost = lifecycle === 'relationship' ? 0.55 : 0;
  const threadBoost = lifecycle === 'thread' ? 0.42 : 0;
  const preferenceBoost = lifecycle === 'preference' ? 0.22 : 0;
  const transactionalPenalty = lifecycle === 'transactional' ? Math.min(0.65, 0.12 + ageDays * 0.03) : 0;
  const preserveBoost = preserveLifecycle.includes(lifecycle) ? 0.35 : 0;
  return importance + freshness + relationshipBoost + threadBoost + preferenceBoost + preserveBoost + queryAffinity(query, document, lifecycle) - transactionalPenalty;
}

export function compactDocuments(documents: MemoryDocument[], options: CompactionOptions = {}): CompactionPlan {
  const maxDocuments = options.maxDocuments ?? 256;
  const preserveLifecycle = options.preserveLifecycle ?? ['relationship', 'thread'];
  const query = options.query ?? '';

  if (documents.length <= maxDocuments) {
    return {
      retained: [...documents],
      dropped: [],
      summary: `compaction noop: ${documents.length}/${maxDocuments}`,
    };
  }

  const ranked = [...documents]
    .map((document) => ({ document, score: retentionScore(document, query, preserveLifecycle), lifecycle: classifyLifecycle(document) }))
    .sort((left, right) => right.score - left.score || right.document.updatedAt - left.document.updatedAt);

  const preserved = ranked.filter(({ lifecycle }) => preserveLifecycle.includes(lifecycle)).map(({ document }) => document);
  const remaining = ranked.filter(({ lifecycle }) => !preserveLifecycle.includes(lifecycle)).map(({ document }) => document);
  const retained: MemoryDocument[] = [];

  for (const document of preserved) {
    if (!retained.some((entry) => entry.id === document.id)) retained.push(document);
  }

  for (const document of remaining) {
    if (retained.length >= maxDocuments) break;
    if (!retained.some((entry) => entry.id === document.id)) retained.push(document);
  }

  const retainedIds = new Set(retained.map((document) => document.id));
  const dropped = documents.filter((document) => !retainedIds.has(document.id));
  const summary = `compaction kept ${retained.length}/${documents.length} documents; dropped ${dropped.length}; preserved=${preserveLifecycle.join(',') || 'none'}`;

  return { retained, dropped, summary };
}
