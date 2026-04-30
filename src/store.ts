import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ExecutionEvent, StepAttempt, TaskPlan, TaskRecord, TaskSnapshot, TaskStatus, RuntimeState } from './types';
import type { MemoryDocument, ChunkRecord, RetrievalResult } from './rag/types';
import type { MemoryFact } from './memory/working-memory';
import type { EpisodicMemoryItem } from './memory/episodic-memory';

export class PokeCoreStore {
  private db: Database;

  constructor(private dbPath: string) {
    this.db = new Database(dbPath, { create: true });
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks(
        task_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step_index INTEGER NOT NULL,
        active_step_id TEXT,
        revision INTEGER NOT NULL,
        result_json TEXT,
        error_json TEXT,
        lease_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_plans(
        task_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions(
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        skill TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS snapshots(
        snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        transition_kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_edges(
        edge_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        from_step_id TEXT,
        to_step_id TEXT,
        edge_kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_documents(
        document_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_chunks(
        chunk_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        term_vector_json TEXT NOT NULL,
        salience REAL NOT NULL,
        recency_score REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS working_facts(
        fact_key TEXT PRIMARY KEY,
        fact_value TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodic_memory(
        item_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        score REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retrieval_queries(
        query_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  withTransaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  upsertTask(taskId: string, objective: string, status: TaskStatus) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tasks(task_id, objective, status, current_step_index, active_step_id, revision, result_json, error_json, lease_token, created_at, updated_at)
      VALUES (?, ?, ?, 0, NULL, 0, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, updated_at = excluded.updated_at
    `).run(taskId, objective, status, now, now);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT task_id as taskId, objective, status, current_step_index as currentStepIndex, active_step_id as activeStepId, revision, result_json as resultJson, error_json as errorJson, lease_token as leaseToken, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE task_id = ?`).get(taskId) as any;
    return row ?? null;
  }

  getPlan(taskId: string): TaskPlan | null {
    const row = this.db.prepare(`SELECT plan_json as planJson FROM task_plans WHERE task_id = ?`).get(taskId) as any;
    return row ? JSON.parse(row.planJson) as TaskPlan : null;
  }

  savePlan(plan: TaskPlan) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO task_plans(task_id, objective, plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET objective = excluded.objective, plan_json = excluded.plan_json, updated_at = excluded.updated_at
    `).run(plan.taskId, plan.objective, JSON.stringify(plan), now, now);
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, 'status' | 'currentStepIndex' | 'activeStepId' | 'revision' | 'resultJson' | 'errorJson' | 'leaseToken'>>) {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`task not found: ${taskId}`);
    const next = {
      status: patch.status ?? current.status,
      currentStepIndex: patch.currentStepIndex ?? current.currentStepIndex,
      activeStepId: patch.activeStepId === undefined ? current.activeStepId : patch.activeStepId,
      revision: patch.revision ?? current.revision,
      resultJson: patch.resultJson === undefined ? current.resultJson : patch.resultJson,
      errorJson: patch.errorJson === undefined ? current.errorJson : patch.errorJson,
      leaseToken: patch.leaseToken === undefined ? current.leaseToken : patch.leaseToken,
    };
    this.db.prepare(`UPDATE tasks SET status = ?, current_step_index = ?, active_step_id = ?, revision = ?, result_json = ?, error_json = ?, lease_token = ?, updated_at = ? WHERE task_id = ?`).run(next.status, next.currentStepIndex, next.activeStepId, next.revision, next.resultJson, next.errorJson, next.leaseToken, Date.now(), taskId);
  }

  bumpRevision(taskId: string) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    this.updateTask(taskId, { revision: task.revision + 1 });
  }

  recordEvent(taskId: string, transitionKind: string, fromStatus: TaskStatus | null, toStatus: TaskStatus | null, detail: unknown) {
    this.db.prepare(`INSERT INTO events(event_id, task_id, transition_kind, from_status, to_status, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, transitionKind, fromStatus, toStatus, JSON.stringify(detail), Date.now());
  }

  recordAttempt(attempt: StepAttempt) {
    this.db.prepare(`INSERT INTO executions(attempt_id, task_id, step_id, attempt_index, status, skill, input_json, output_json, error_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(attempt.attemptId, attempt.taskId, attempt.stepId, attempt.attemptIndex, attempt.status, attempt.skill, attempt.inputJson, attempt.outputJson, attempt.errorJson, attempt.startedAt, attempt.endedAt);
  }

  finalizeAttempt(attemptId: string, patch: Partial<Pick<StepAttempt, 'status' | 'outputJson' | 'errorJson' | 'endedAt'>>) {
    const row = this.db.prepare(`SELECT * FROM executions WHERE attempt_id = ?`).get(attemptId) as any;
    if (!row) throw new Error(`attempt not found: ${attemptId}`);
    this.db.prepare(`UPDATE executions SET status = ?, output_json = ?, error_json = ?, ended_at = ? WHERE attempt_id = ?`).run(patch.status ?? row.status, patch.outputJson ?? row.output_json, patch.errorJson ?? row.error_json, patch.endedAt ?? Date.now(), attemptId);
  }

  recordSnapshot(taskId: string, status: TaskStatus, state: RuntimeState) {
    const snapshot: TaskSnapshot = { snapshotId: randomUUID(), taskId, status, stateJson: JSON.stringify(state), createdAt: Date.now() };
    this.db.prepare(`INSERT INTO snapshots(snapshot_id, task_id, status, state_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(snapshot.snapshotId, snapshot.taskId, snapshot.status, snapshot.stateJson, snapshot.createdAt);
    return snapshot;
  }

  recordGraphEdge(taskId: string, fromStepId: string | null, toStepId: string | null, edgeKind: string, reason: string) {
    this.db.prepare(`INSERT INTO graph_edges(edge_id, task_id, from_step_id, to_step_id, edge_kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, fromStepId, toStepId, edgeKind, reason, Date.now());
  }

  upsertMemoryDocument(doc: MemoryDocument) {
    this.db.prepare(`
      INSERT INTO memory_documents(document_id, source, title, body, tags_json, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET source = excluded.source, title = excluded.title, body = excluded.body, tags_json = excluded.tags_json, metadata_json = excluded.metadata_json, created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run(doc.id, doc.source, doc.title, doc.body, JSON.stringify(doc.tags), JSON.stringify(doc.metadata), doc.createdAt, doc.updatedAt);
  }

  upsertMemoryChunk(chunk: ChunkRecord) {
    this.db.prepare(`
      INSERT INTO memory_chunks(chunk_id, document_id, position, text, token_count, term_vector_json, salience, recency_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET document_id = excluded.document_id, position = excluded.position, text = excluded.text, token_count = excluded.token_count, term_vector_json = excluded.term_vector_json, salience = excluded.salience, recency_score = excluded.recency_score, updated_at = excluded.updated_at
    `).run(chunk.chunkId, chunk.documentId, chunk.position, chunk.text, chunk.tokenCount, JSON.stringify(chunk.termVector), chunk.salience, chunk.recencyScore, Date.now(), Date.now());
  }

  replaceWorkingFact(fact: MemoryFact) {
    this.db.prepare(`
      INSERT INTO working_facts(fact_key, fact_value, confidence, source, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fact_key) DO UPDATE SET fact_value = excluded.fact_value, confidence = excluded.confidence, source = excluded.source, updated_at = excluded.updated_at
    `).run(fact.key, fact.value, fact.confidence, fact.source, fact.updatedAt);
  }

  upsertEpisodicItem(item: EpisodicMemoryItem) {
    this.db.prepare(`
      INSERT INTO episodic_memory(item_id, task_id, category, summary, signals_json, score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET task_id = excluded.task_id, category = excluded.category, summary = excluded.summary, signals_json = excluded.signals_json, score = excluded.score, created_at = excluded.created_at
    `).run(item.id, item.taskId, item.category, item.summary, JSON.stringify(item.signals), item.score, item.createdAt);
  }

  recordRetrieval(query: string, result: RetrievalResult) {
    this.db.prepare(`INSERT INTO retrieval_queries(query_id, query, result_json, created_at) VALUES (?, ?, ?, ?)`).run(randomUUID(), query, JSON.stringify(result), Date.now());
  }

  allEvents(taskId: string): ExecutionEvent[] {
    return this.db.prepare(`SELECT event_id as eventId, task_id as taskId, transition_kind as transitionKind, from_status as fromStatus, to_status as toStatus, detail_json as detailJson, created_at as createdAt FROM events WHERE task_id = ? ORDER BY created_at ASC`).all(taskId) as ExecutionEvent[];
  }

  allSnapshots(taskId: string): TaskSnapshot[] {
    return this.db.prepare(`SELECT snapshot_id as snapshotId, task_id as taskId, status, state_json as stateJson, created_at as createdAt FROM snapshots WHERE task_id = ? ORDER BY created_at ASC`).all(taskId) as TaskSnapshot[];
  }

  allAttempts(taskId: string): StepAttempt[] {
    return this.db.prepare(`SELECT attempt_id as attemptId, task_id as taskId, step_id as stepId, attempt_index as attemptIndex, status, skill, input_json as inputJson, output_json as outputJson, error_json as errorJson, started_at as startedAt, ended_at as endedAt FROM executions WHERE task_id = ? ORDER BY started_at ASC`).all(taskId) as StepAttempt[];
  }
}
