import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ExecutionEvent, StepAttempt, TaskPlan, TaskRecord, TaskSnapshot, TaskStatus, RuntimeState } from './types';

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
