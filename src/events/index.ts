import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { TimeProvider } from '../types';

export type EventSource = 'orchestrator' | 'bridge' | 'queue' | 'skill' | 'system';
export type EventCursor = number;
export type EventTopicFilter = string | readonly string[] | ((topic: string) => boolean);

export type EventRecord = {
  cursor: EventCursor;
  eventId: string;
  topic: string;
  source: EventSource;
  aggregateType?: string;
  aggregateId?: string;
  correlationId?: string;
  causationId?: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: number;
  createdAtIso: string;
};

export type EventPublishInput = {
  topic: string;
  source?: EventSource;
  aggregateType?: string;
  aggregateId?: string;
  correlationId?: string;
  causationId?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: number;
};

export type EventQuery = {
  cursor?: number;
  topic?: EventTopicFilter;
  source?: EventSource | readonly EventSource[];
  aggregateType?: string;
  aggregateId?: string;
  limit?: number;
};

export type EventSubscriptionFilter = {
  topic?: EventTopicFilter;
  source?: EventSource | readonly EventSource[];
  aggregateType?: string;
  aggregateId?: string;
  predicate?: (event: EventRecord) => boolean;
};

export type EventDispatchContext = { replay: boolean; delivery: 'live' | 'replay' };
export type EventDeliveryFailure = { subscriptionId: string; error: string };
export type EventPublishResult = { event: EventRecord; deliveredTo: number; failures: EventDeliveryFailure[] };
export type EventReplayOptions = { query?: EventQuery; limit?: number; dispatch?: boolean };
export type EventReplayResult = { events: EventRecord[]; deliveredTo: number; failures: EventDeliveryFailure[]; nextCursor: number };

export type QueueJobStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'dead' | 'cancelled';
export type QueueJobInput = {
  queueName?: string;
  topic: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt?: number;
  backoffBaseMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  correlationId?: string;
  causationId?: string;
};

export type QueueJobRecord = {
  jobId: string;
  queueName: string;
  topic: string;
  status: QueueJobStatus;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lockedAt?: number;
  lockedBy?: string;
  startedAt?: number;
  completedAt?: number;
  lastError?: Record<string, unknown>;
  lastResult?: Record<string, unknown>;
  backoffBaseMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  correlationId?: string;
  causationId?: string;
  createdAt: number;
  updatedAt: number;
};

export type QueueClaim = { job: QueueJobRecord; attemptNumber: number };
export type QueueQuery = { queueName?: string; topic?: string; status?: QueueJobStatus | readonly QueueJobStatus[]; limit?: number };
export type QueueStats = { queued: number; running: number; retrying: number; completed: number; dead: number; cancelled: number };
export type QueueProcessResult = { claimed?: QueueJobRecord; completed?: boolean; output?: unknown; error?: string };

export type EventBusOptions = { storagePath?: string; tenantId?: string; contextId?: string; clock?: TimeProvider; workerId?: string; defaultQueue?: string };

type Subscription = {
  id: string;
  filter: EventSubscriptionFilter;
  handler: (event: EventRecord, context: EventDispatchContext) => void | Promise<void>;
};

function nowIso(clock: TimeProvider): string { return clock.iso(); }
function asRecord(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function normalizePathSegment(value: string): string { return text(value) || 'global'; }
function topicMatches(filter: EventTopicFilter | undefined, topic: string): boolean {
  if (!filter) return true;
  if (typeof filter === 'function') return filter(topic);
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.some((item) => {
    const pattern = text(item);
    if (!pattern || pattern === '*') return true;
    return pattern.endsWith('*') ? topic.startsWith(pattern.slice(0, -1)) : topic === pattern;
  });
}
function sourceMatches(filter: EventSubscriptionFilter['source'], source: EventSource): boolean {
  if (!filter) return true;
  const values = Array.isArray(filter) ? filter : [filter];
  return values.includes(source);
}
function queueStatusMatches(filter: QueueQuery['status'], status: QueueJobStatus): boolean {
  if (!filter) return true;
  const values = Array.isArray(filter) ? filter : [filter];
  return values.includes(status);
}
function parseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
}
function parseEventRow(row: any): EventRecord {
  return {
    cursor: Number(row.sequence), eventId: String(row.event_id), topic: String(row.topic), source: String(row.source) as EventSource,
    aggregateType: row.aggregate_type ?? undefined, aggregateId: row.aggregate_id ?? undefined, correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined, payload: parseJson(row.payload_json), metadata: parseJson(row.metadata_json),
    createdAt: Number(row.created_at), createdAtIso: String(row.created_at_iso ?? ''),
  };
}
function parseJobRow(row: any): QueueJobRecord {
  return {
    jobId: String(row.job_id), queueName: String(row.queue_name), topic: String(row.topic), status: String(row.status) as QueueJobStatus,
    payload: parseJson(row.payload_json), metadata: parseJson(row.metadata_json), priority: Number(row.priority), attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts), availableAt: Number(row.available_at), lockedAt: row.locked_at == null ? undefined : Number(row.locked_at),
    lockedBy: row.locked_by ?? undefined, startedAt: row.started_at == null ? undefined : Number(row.started_at), completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    lastError: row.last_error_json ? parseJson(row.last_error_json) : undefined, lastResult: row.last_result_json ? parseJson(row.last_result_json) : undefined,
    backoffBaseMs: Number(row.backoff_base_ms), backoffMultiplier: Number(row.backoff_multiplier), maxBackoffMs: Number(row.max_backoff_ms),
    correlationId: row.correlation_id ?? undefined, causationId: row.causation_id ?? undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
function buildEventWhere(query: EventQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = []; const params: unknown[] = [];
  if (typeof query.cursor === 'number') { clauses.push('sequence > ?'); params.push(query.cursor); }
  if (query.topic) {
    if (typeof query.topic === 'function') throw new Error('topic predicate queries are not supported at the storage layer');
    const topics = (Array.isArray(query.topic) ? query.topic : [query.topic]).map((item) => text(item)).filter(Boolean);
    if (topics.length === 1) { clauses.push('topic = ?'); params.push(topics[0]); }
    else if (topics.length > 1) { clauses.push('topic IN (' + topics.map(() => '?').join(', ') + ')'); params.push(...topics); }
  }
  if (query.source) {
    const sources = Array.isArray(query.source) ? query.source : [query.source];
    if (sources.length === 1) { clauses.push('source = ?'); params.push(sources[0]); }
    else if (sources.length > 1) { clauses.push('source IN (' + sources.map(() => '?').join(', ') + ')'); params.push(...sources); }
  }
  if (query.aggregateType) { clauses.push('aggregate_type = ?'); params.push(query.aggregateType); }
  if (query.aggregateId) { clauses.push('aggregate_id = ?'); params.push(query.aggregateId); }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
function buildQueueWhere(query: QueueQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = []; const params: unknown[] = [];
  if (query.queueName) { clauses.push('queue_name = ?'); params.push(query.queueName); }
  if (query.topic) { clauses.push('topic = ?'); params.push(query.topic); }
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length === 1) { clauses.push('status = ?'); params.push(statuses[0]); }
    else if (statuses.length > 1) { clauses.push('status IN (' + statuses.map(() => '?').join(', ') + ')'); params.push(...statuses); }
  }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
function backoffMs(job: QueueJobRecord): number {
  const attemptIndex = Math.max(0, job.attempts - 1);
  return Math.min(job.maxBackoffMs, Math.max(job.backoffBaseMs, Math.round(job.backoffBaseMs * Math.pow(job.backoffMultiplier, attemptIndex))));
}
function normalizeQueueName(name: unknown, fallback: string): string { return text(name) || fallback; }

export class EventBus {
  private readonly db: Database;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly clock: TimeProvider;
  private readonly workerId: string;
  private readonly defaultQueue: string;

  constructor(options: EventBusOptions = {}) {
    const tenantId = normalizePathSegment(options.tenantId ?? process.env.POKE_CORE_TENANT_ID ?? 'global');
    const contextId = normalizePathSegment(options.contextId ?? process.env.POKE_CORE_CONTEXT_ID ?? 'global');
    const storagePath = resolve(options.storagePath ?? resolve(process.cwd(), '.poke-core', tenantId, contextId, 'events.sqlite'));
    mkdirSync(dirname(storagePath), { recursive: true });
    this.db = new Database(storagePath, { create: true });
    if (!options.clock) throw new Error('EventBus clock is required');
    this.clock = options.clock;
    this.workerId = options.workerId ?? 'event-bus';
    this.defaultQueue = options.defaultQueue ?? 'default';
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;' +
      "CREATE TABLE IF NOT EXISTS event_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, source TEXT NOT NULL, aggregate_type TEXT, aggregate_id TEXT, correlation_id TEXT, causation_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, created_at_iso TEXT NOT NULL);" +
      'CREATE INDEX IF NOT EXISTS idx_event_log_topic_sequence ON event_log(topic, sequence);' +
      'CREATE INDEX IF NOT EXISTS idx_event_log_source_sequence ON event_log(source, sequence);' +
      'CREATE INDEX IF NOT EXISTS idx_event_log_aggregate_sequence ON event_log(aggregate_type, aggregate_id, sequence);' +
      'CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);' +
      "CREATE TABLE IF NOT EXISTS queue_jobs (job_id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5, available_at INTEGER NOT NULL, locked_at INTEGER, locked_by TEXT, started_at INTEGER, completed_at INTEGER, last_error_json TEXT, last_result_json TEXT, backoff_base_ms INTEGER NOT NULL DEFAULT 500, backoff_multiplier REAL NOT NULL DEFAULT 2, max_backoff_ms INTEGER NOT NULL DEFAULT 30000, correlation_id TEXT, causation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      'CREATE INDEX IF NOT EXISTS idx_queue_jobs_state ON queue_jobs(queue_name, status, available_at, priority DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_queue_jobs_topic ON queue_jobs(topic, status);' +
      'CREATE INDEX IF NOT EXISTS idx_queue_jobs_updated_at ON queue_jobs(updated_at);'
    );
  }

  subscribe(filter: EventSubscriptionFilter, handler: Subscription['handler']): () => void {
    const id = randomUUID();
    this.subscriptions.set(id, { id, filter, handler });
    return () => { this.subscriptions.delete(id); };
  }

  async publish(input: EventPublishInput): Promise<EventPublishResult> {
    const now = input.createdAt ?? this.clock.now();
    const createdAtIso = nowIso(this.clock);
    const event: EventRecord = {
      cursor: 0, eventId: randomUUID(), topic: text(input.topic), source: input.source ?? 'system', aggregateType: text(input.aggregateType) || undefined,
      aggregateId: text(input.aggregateId) || undefined, correlationId: text(input.correlationId) || undefined, causationId: text(input.causationId) || undefined,
      payload: clone(asRecord(input.payload ?? {})), metadata: clone(asRecord(input.metadata ?? {})), createdAt: now, createdAtIso,
    };
    if (!event.topic) throw new Error('event topic is required');
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      this.db.prepare('INSERT INTO event_log (event_id, topic, source, aggregate_type, aggregate_id, correlation_id, causation_id, payload_json, metadata_json, created_at, created_at_iso) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(event.eventId, event.topic, event.source, event.aggregateType ?? null, event.aggregateId ?? null, event.correlationId ?? null, event.causationId ?? null, JSON.stringify(event.payload), JSON.stringify(event.metadata), event.createdAt, event.createdAtIso);
      const row = this.db.prepare('SELECT last_insert_rowid() AS cursor').get() as { cursor?: number } | undefined;
      event.cursor = Number(row?.cursor ?? 0);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    const dispatch = await this.dispatch(event, { replay: false, delivery: 'live' });
    return { event, deliveredTo: dispatch.deliveredTo, failures: dispatch.failures };
  }

  async emit(topic: string, payload: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}, source: EventSource = 'system'): Promise<EventPublishResult> {
    return await this.publish({ topic, payload, metadata, source });
  }

  async listEvents(query: EventQuery = {}): Promise<EventRecord[]> {
    const where = buildEventWhere(query);
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
    const rows = this.db.prepare('SELECT * FROM event_log ' + where.sql + ' ORDER BY sequence ASC LIMIT ' + limit).all(...where.params) as any[];
    return rows.map(parseEventRow).map((event) => ({ ...event, payload: clone(event.payload), metadata: clone(event.metadata) }));
  }

  async replay(fromCursor: number, options: EventReplayOptions = {}): Promise<EventReplayResult> {
    const events = await this.listEvents({ ...(options.query ?? {}), cursor: fromCursor, limit: options.limit ?? options.query?.limit ?? 500 });
    let deliveredTo = 0;
    const failures: EventDeliveryFailure[] = [];
    if (options.dispatch !== false) {
      for (const event of events) {
        const dispatch = await this.dispatch(event, { replay: true, delivery: 'replay' });
        deliveredTo += dispatch.deliveredTo;
        failures.push(...dispatch.failures);
      }
    }
    return { events, deliveredTo, failures, nextCursor: events.at(-1)?.cursor ?? fromCursor };
  }

  async enqueueJob(input: QueueJobInput): Promise<QueueJobRecord> {
    const now = this.clock.now();
    const job: QueueJobRecord = {
      jobId: randomUUID(), queueName: normalizeQueueName(input.queueName, this.defaultQueue), topic: text(input.topic), status: 'queued',
      payload: clone(asRecord(input.payload ?? {})), metadata: clone(asRecord(input.metadata ?? {})), priority: Number.isFinite(input.priority ?? 0) ? Number(input.priority ?? 0) : 0,
      attempts: 0, maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 5)), availableAt: input.availableAt ?? now, lockedAt: undefined, lockedBy: undefined,
      startedAt: undefined, completedAt: undefined, lastError: undefined, lastResult: undefined, backoffBaseMs: Math.max(50, Math.floor(input.backoffBaseMs ?? 500)),
      backoffMultiplier: Number.isFinite(input.backoffMultiplier ?? 2) ? Number(input.backoffMultiplier ?? 2) : 2, maxBackoffMs: Math.max(100, Math.floor(input.maxBackoffMs ?? 30000)),
      correlationId: text(input.correlationId) || undefined, causationId: text(input.causationId) || undefined, createdAt: now, updatedAt: now,
    };
    if (!job.topic) throw new Error('queue job topic is required');
    this.db.prepare('INSERT INTO queue_jobs (job_id, queue_name, topic, status, payload_json, metadata_json, priority, attempts, max_attempts, available_at, backoff_base_ms, backoff_multiplier, max_backoff_ms, correlation_id, causation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.jobId, job.queueName, job.topic, job.status, JSON.stringify(job.payload), JSON.stringify(job.metadata), job.priority, job.attempts, job.maxAttempts, job.availableAt, job.backoffBaseMs, job.backoffMultiplier, job.maxBackoffMs, job.correlationId ?? null, job.causationId ?? null, job.createdAt, job.updatedAt);
    await this.publish({ topic: 'queue.job.enqueued', source: 'queue', aggregateType: 'queue', aggregateId: job.jobId, correlationId: job.correlationId, causationId: job.causationId, payload: { jobId: job.jobId, queueName: job.queueName, topic: job.topic } });
    return clone(job);
  }

  async listJobs(query: QueueQuery = {}): Promise<QueueJobRecord[]> {
    const where = buildQueueWhere(query);
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
    const rows = this.db.prepare('SELECT * FROM queue_jobs ' + where.sql + ' ORDER BY priority DESC, available_at ASC, created_at ASC LIMIT ' + limit).all(...where.params) as any[];
    return rows.map(parseJobRow).map((job) => ({ ...job, payload: clone(job.payload), metadata: clone(job.metadata), lastError: job.lastError ? clone(job.lastError) : undefined, lastResult: job.lastResult ? clone(job.lastResult) : undefined }));
  }

  async getJob(jobId: string): Promise<QueueJobRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM queue_jobs WHERE job_id = ?').get(jobId) as any;
    return row ? ({ ...parseJobRow(row), payload: clone(parseJobRow(row).payload), metadata: clone(parseJobRow(row).metadata) }) : undefined;
  }

  async claimNextJob(options: { queueName?: string; workerId?: string } = {}): Promise<QueueClaim | null> {
    const now = this.clock.now();
    const queueName = normalizeQueueName(options.queueName, this.defaultQueue);
    const workerId = options.workerId ?? this.workerId;
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const row = this.db.prepare("SELECT * FROM queue_jobs WHERE queue_name = ? AND status IN ('queued', 'retrying') AND available_at <= ? ORDER BY priority DESC, available_at ASC, created_at ASC LIMIT 1").get(queueName, now) as any;
      if (!row) { this.db.exec('COMMIT'); return null; }
      const job = parseJobRow(row);
      const attemptNumber = job.attempts + 1;
      this.db.prepare('UPDATE queue_jobs SET status = ?, attempts = ?, locked_at = ?, locked_by = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE job_id = ?').run('running', attemptNumber, now, workerId, now, now, job.jobId);
      this.db.exec('COMMIT');
      const claimed = await this.getJob(job.jobId);
      if (!claimed) throw new Error('failed to claim queue job');
      return { job: claimed, attemptNumber };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  async completeJob(jobId: string, result?: unknown, workerId: string = this.workerId): Promise<QueueJobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const now = this.clock.now();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    this.db.prepare('UPDATE queue_jobs SET status = ?, locked_at = NULL, locked_by = ?, completed_at = ?, last_result_json = ?, updated_at = ? WHERE job_id = ?').run('completed', workerId, now, resultJson, now, jobId);
    const updated = await this.getJob(jobId);
    if (updated) await this.publish({ topic: 'queue.job.completed', source: 'queue', aggregateType: 'queue', aggregateId: jobId, correlationId: job.correlationId, causationId: job.causationId, payload: { jobId, queueName: job.queueName, topic: job.topic } });
    return updated;
  }

  async failJob(jobId: string, error: unknown, options: { retryable?: boolean; workerId?: string } = {}): Promise<QueueJobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const now = this.clock.now();
    const retryable = options.retryable !== false && job.attempts < job.maxAttempts;
    const status: QueueJobStatus = retryable ? 'retrying' : 'dead';
    const errorJson = JSON.stringify(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : typeof error === 'string' ? { message: error } : { message: String(error) });
    const nextAvailableAt = retryable ? now + backoffMs(job) : now;
    this.db.prepare('UPDATE queue_jobs SET status = ?, available_at = ?, locked_at = NULL, locked_by = ?, last_error_json = ?, updated_at = ? WHERE job_id = ?').run(status, nextAvailableAt, options.workerId ?? null, errorJson, now, jobId);
    const updated = await this.getJob(jobId);
    if (updated) await this.publish({ topic: retryable ? 'queue.job.retrying' : 'queue.job.dead', source: 'queue', aggregateType: 'queue', aggregateId: jobId, correlationId: job.correlationId, causationId: job.causationId, payload: { jobId, queueName: job.queueName, topic: job.topic, retryable } });
    return updated;
  }

  async processNextJob<T>(handler: (job: QueueJobRecord, attemptNumber: number) => Promise<T> | T, options: { queueName?: string; workerId?: string } = {}): Promise<QueueProcessResult> {
    const claimed = await this.claimNextJob(options);
    if (!claimed) return {};
    try {
      const output = await handler(claimed.job, claimed.attemptNumber);
      await this.completeJob(claimed.job.jobId, output, options.workerId ?? this.workerId);
      return { claimed: claimed.job, completed: true, output };
    } catch (error) {
      await this.failJob(claimed.job.jobId, error, { workerId: options.workerId ?? this.workerId });
      return { claimed: claimed.job, completed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async drainQueue<T>(handler: (job: QueueJobRecord, attemptNumber: number) => Promise<T> | T, options: { queueName?: string; workerId?: string; limit?: number } = {}): Promise<QueueProcessResult[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const results: QueueProcessResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.processNextJob(handler, options);
      if (!result.claimed) break;
      results.push(result);
    }
    return results;
  }

  async stats(queueName?: string): Promise<QueueStats> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM queue_jobs ' + (queueName ? 'WHERE queue_name = ? ' : '') + 'GROUP BY status').all(...(queueName ? [queueName] : [])) as Array<{ status: QueueJobStatus; count: number }>;
    const stats: QueueStats = { queued: 0, running: 0, retrying: 0, completed: 0, dead: 0, cancelled: 0 };
    for (const row of rows) { if (row.status in stats) { (stats as Record<string, number>)[row.status] = Number(row.count); } }
    return stats;
  }

  private async dispatch(event: EventRecord, context: EventDispatchContext): Promise<{ deliveredTo: number; failures: EventDeliveryFailure[] }> {
    let deliveredTo = 0; const failures: EventDeliveryFailure[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (!topicMatches(subscription.filter.topic, event.topic)) continue;
      if (!sourceMatches(subscription.filter.source, event.source)) continue;
      if (subscription.filter.aggregateType && subscription.filter.aggregateType !== event.aggregateType) continue;
      if (subscription.filter.aggregateId && subscription.filter.aggregateId !== event.aggregateId) continue;
      if (subscription.filter.predicate && !subscription.filter.predicate(event)) continue;
      try { await subscription.handler(clone(event), context); deliveredTo += 1; } catch (error) { failures.push({ subscriptionId: subscription.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { deliveredTo, failures };
  }
}
