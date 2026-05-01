import { extractSemanticSignals } from './embeddings';
import type { DocumentLifecycle, MemoryDocument } from './types';

export type CompactionDecision = {
  documentId: string;
  source: string;
  lifecycle: DocumentLifecycle;
  tokenCount: number;
  score: number;
  bucket: string;
  reason: string;
};

export type CompactionPlan = {
  retained: MemoryDocument[];
  dropped: MemoryDocument[];
  summary: string;
  budgetTokens: number;
  usedTokens: number;
  decisions: CompactionDecision[];
};

export type CompactionOptions = {
  tokenBudget?: number;
  maxDocuments?: number;
  preserveLifecycle?: DocumentLifecycle[];
  preserveSources?: string[];
  query?: string;
};

export function classifyLifecycle(document: MemoryDocument): DocumentLifecycle {
  const haystack = `${document.source} ${document.title} ${document.body} ${(document.tags ?? []).join(' ')}`.toLowerCase();
  const metadata = document.metadata ?? {};
  if (typeof metadata.threadId === 'string' || typeof document.threadId === 'string' || /\b(thread|reply|inbox|message|mail)\b/.test(haystack)) return 'thread';
  if (typeof metadata.relationshipId === 'string' || typeof document.relationshipId === 'string' || /\b(relationship|contact|colleague|friend|manager|client|teammate|recruiter|family)\b/.test(haystack)) return 'relationship';
  if (/\b(invoice|receipt|booking|payment|confirmation|schedule|task|ticket|status|delivery|deadline|travel|refund|bill|subscription)\b/.test(haystack)) return 'transactional';
  if (/\b(preference|persona|style|tone|profile|memory)\b/.test(haystack)) return 'preference';
  if (/\b(reference|documentation|guide|policy|spec|readme|architecture|notes|doc)\b/.test(haystack)) return 'reference';
  if (/\b(calendar|meeting|event|availability|timezone|reschedule|invite)\b/.test(haystack)) return 'calendar';
  if (/\b(file|folder|path|directory|diff|write|read|export|scan)\b/.test(haystack)) return 'filesystem';
  return 'unknown';
}

function tokenCount(document: MemoryDocument): number {
  const explicit = Number(document.metadata.tokenCount ?? document.metadata.tokens ?? document.metadata.wordCount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return Math.max(1, extractSemanticSignals(`${document.title}\n${document.body}`).tokens.length);
}

function recencyScore(document: MemoryDocument): number {
  const ageHours = Math.max(0.001, (Date.now() - Math.max(document.createdAt, document.updatedAt)) / 3_600_000);
  return 1 / (1 + Math.log1p(ageHours));
}

function sourcePriority(source: string, lifecycle: DocumentLifecycle): number {
  const normalized = source.toLowerCase();
  const sourceWeights: Record<string, number> = { email: 0.5, calendar: 0.38, memory: 0.46, docs: 0.34, notes: 0.34, filesystem: 0.28, browser: 0.24 };
  const lifecycleWeights: Record<DocumentLifecycle, number> = {
    relationship: 1.15,
    thread: 1.05,
    preference: 0.92,
    reference: 0.74,
    calendar: 0.7,
    filesystem: 0.6,
    transactional: 0.28,
    unknown: 0.42,
  };
  return (sourceWeights[normalized] ?? 0.32) + lifecycleWeights[lifecycle];
}

function queryAffinity(query: string, document: MemoryDocument, lifecycle: DocumentLifecycle): number {
  const targetSignals = extractSemanticSignals(query).axes;
  const docSignals = extractSemanticSignals(`${document.title} ${document.body} ${(document.tags ?? []).join(' ')}`).axes;
  let boost = 0;
  if (targetSignals.relationship && lifecycle === 'relationship') boost += 0.45;
  if (targetSignals.thread && lifecycle === 'thread') boost += 0.45;
  if (targetSignals.preference && lifecycle === 'preference') boost += 0.35;
  if (targetSignals.calendar && lifecycle === 'calendar') boost += 0.3;
  if (targetSignals.reference && lifecycle === 'reference') boost += 0.25;
  if (targetSignals.filesystem && lifecycle === 'filesystem') boost += 0.25;
  if (targetSignals.evidence || targetSignals.crossSource) boost += 0.12;
  if (Object.keys(targetSignals).some((axis) => docSignals[axis] !== undefined)) boost += 0.12;
  if (lifecycle === 'transactional' && /\b(relationship|thread|follow[- ]?up|reply|contact|manager|colleague)\b/.test(query.toLowerCase())) boost -= 0.14;
  return boost;
}

function bucketFor(lifecycle: DocumentLifecycle): string {
  if (lifecycle === 'relationship' || lifecycle === 'thread') return 'high-value-relationship';
  if (lifecycle === 'preference') return 'preference';
  if (lifecycle === 'reference' || lifecycle === 'filesystem') return 'reference';
  if (lifecycle === 'calendar') return 'calendar';
  if (lifecycle === 'transactional') return 'transactional';
  return 'other';
}

function retentionScore(document: MemoryDocument, query: string, preserveLifecycle: DocumentLifecycle[], preserveSources: string[]): CompactionDecision {
  const lifecycle = classifyLifecycle(document);
  const tokens = tokenCount(document);
  const recency = recencyScore(document);
  const importance = Math.max(0, Math.min(2, Number(document.importance ?? document.metadata.importance ?? 0.5)));
  const source = document.source.toLowerCase();
  const sourceBoost = sourcePriority(source, lifecycle);
  const preserveLifecycleBoost = preserveLifecycle.includes(lifecycle) ? 0.65 : 0;
  const preserveSourceBoost = preserveSources.includes(source) ? 0.3 : 0;
  const tokenPenalty = Math.log1p(tokens) * 0.08;
  const queryBoost = queryAffinity(query, document, lifecycle);
  const staleTransactionalPenalty = lifecycle === 'transactional' ? Math.min(0.75, 0.2 + Math.log1p(tokens) * 0.05) : 0;
  const score = importance + recency + sourceBoost + preserveLifecycleBoost + preserveSourceBoost + queryBoost - tokenPenalty - staleTransactionalPenalty;
  return {
    documentId: document.id,
    source,
    lifecycle,
    tokenCount: tokens,
    score,
    bucket: bucketFor(lifecycle),
    reason: lifecycle === 'relationship' || lifecycle === 'thread'
      ? 'preserve relationship and thread history'
      : lifecycle === 'transactional'
        ? 'compact stale transactional context first'
        : 'retain based on source-aware token budget',
  };
}

export function compactDocuments(documents: MemoryDocument[], options: CompactionOptions = {}): CompactionPlan {
  const budgetTokens = options.tokenBudget ?? Math.max(600, documents.reduce((sum, doc) => sum + tokenCount(doc), 0));
  const maxDocuments = options.maxDocuments ?? Number.POSITIVE_INFINITY;
  const preserveLifecycle = options.preserveLifecycle ?? ['relationship', 'thread'];
  const preserveSources = options.preserveSources ?? ['email', 'calendar', 'memory'];
  const query = options.query ?? '';

  if (documents.length === 0) {
    return { retained: [], dropped: [], summary: 'compaction noop: empty corpus', budgetTokens, usedTokens: 0, decisions: [] };
  }

  const decisions = [...documents]
    .map((document) => retentionScore(document, query, preserveLifecycle, preserveSources))
    .sort((left, right) => right.score - left.score || right.tokenCount - left.tokenCount || right.documentId.localeCompare(left.documentId));

  const retained: MemoryDocument[] = [];
  const dropped: MemoryDocument[] = [];
  let usedTokens = 0;
  let protectedUsed = 0;
  let supportingUsed = 0;
  const protectedBudget = Math.max(1, Math.floor(budgetTokens * 0.62));
  const supportingBudget = Math.max(1, Math.floor(budgetTokens * 0.2));
  const byId = new Map(documents.map((document) => [document.id, document] as const));

  for (const decision of decisions) {
    const document = byId.get(decision.documentId)!;
    const protectedBucket = decision.lifecycle === 'relationship' || decision.lifecycle === 'thread' || preserveLifecycle.includes(decision.lifecycle);
    const supportingBucket = decision.lifecycle === 'preference' || decision.lifecycle === 'reference' || preserveSources.includes(decision.source);
    const fitsBudget = usedTokens + decision.tokenCount <= budgetTokens && retained.length < maxDocuments;
    const fitsProtected = protectedBucket && protectedUsed + decision.tokenCount <= protectedBudget;
    const fitsSupporting = supportingBucket && supportingUsed + decision.tokenCount <= supportingBudget;

    if (fitsBudget && (fitsProtected || fitsSupporting || usedTokens < budgetTokens * 0.85)) {
      retained.push(document);
      usedTokens += decision.tokenCount;
      if (protectedBucket) protectedUsed += decision.tokenCount;
      if (supportingBucket) supportingUsed += decision.tokenCount;
    } else {
      dropped.push(document);
    }
  }

  const retainedIds = new Set(retained.map((document) => document.id));
  const actualDropped = documents.filter((document) => !retainedIds.has(document.id));
  const summary = `compaction kept ${retained.length}/${documents.length} documents using ${usedTokens}/${budgetTokens} tokens; protected=${protectedUsed} supporting=${supportingUsed}; dropped=${actualDropped.length}`;

  return { retained, dropped: actualDropped, summary, budgetTokens, usedTokens, decisions };
}
