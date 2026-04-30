import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ExecutionRecord, SnapshotRecord, TaskPlan, TaskRecord, TaskStatus } from './types';

export class PokeCoreStore {
  private db: Database;
  constructor(private dbPath: string) {
    this.db = new Database(dbPath, { create: true });
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        task_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step_index INTEGER NOT NULL,
        active_step_id TEXT,
        result_json TEXT,
        error TEXT,
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
      CREATE TABLE IF NOT EXISTS task_graph_edges(
        edge_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        from_step_id TEXT,
        to_step_id TEXT,
        edge_kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions(
        execution_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        passed INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots(
        snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history(
        history_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        transition_kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  upsertTask(taskId: string, objective: string, status: TaskStatus) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tasks(task_id, objective, status, current_step_index, active_step_id, result_json, error, created_at, updated_at)
      VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, updated_at = excluded.updated_at
    `).run(taskId, objective, status, now, now);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT task_id as taskId, objective, status, current_step_index as currentStepIndex, active_step_id as activeStepId, result_json as resultJson, error, created_at as createdAt, updated_at as updatedAt FROM tasks WHERE task_id = ?`).get(taskId) as any;
    return row ?? null;
  }

  updateTask(taskId: string, patch: Partial<Pick<TaskRecord, 'status' | 'currentStepIndex' | 'activeStepId' | 'resultJson' | 'error'>>) {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`task not found: ${taskId}`);
    const next = {
      status: patch.status ?? current.status,
      currentStepIndex: patch.currentStepIndex ?? current.currentStepIndex,
      activeStepId: patch.activeStepId === undefined ? current.activeStepId : patch.activeStepId,
      resultJson: patch.resultJson === undefined ? current.resultJson : patch.resultJson,
      error: patch.error === undefined ? current.error : patch.error,
    };
    this.db.prepare(`UPDATE tasks SET status = ?, current_step_index = ?, active_step_id = ?, result_json = ?, error = ?, updated_at = ? WHERE task_id = ?`).run(next.status, next.currentStepIndex, next.activeStepId, next.resultJson, next.error, Date.now(), taskId);
  }

  savePlan(plan: TaskPlan) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO task_plans(task_id, objective, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET objective = excluded.objective, plan_json = excluded.plan_json, updated_at = excluded.updated_at`).run(plan.taskId, plan.objective, JSON.stringify(plan), now, now);
  }

  getPlan(taskId: string): TaskPlan | null {
    const row = this.db.prepare(`SELECT plan_json as planJson FROM task_plans WHERE task_id = ?`).get(taskId) as any;
    return row ? JSON.parse(row.planJson) as TaskPlan : null;
  }

  addGraphEdge(taskId: string, fromStepId: string | null, toStepId: string | null, edgeKind: string, reason: string) {
    this.db.prepare(`INSERT INTO task_graph_edges(edge_id, task_id, from_step_id, to_step_id, edge_kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, fromStepId, toStepId, edgeKind, reason, Date.now());
  }

  recordExecution(record: ExecutionRecord) {
    this.db.prepare(`INSERT INTO executions(execution_id, task_id, step_id, skill, kind, input_json, output_json, passed, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.executionId, record.taskId, record.stepId, record.skill, record.kind, record.inputJson, record.outputJson, record.passed, record.note, record.createdAt);
  }

  recordSnapshot(taskId: string, status: TaskStatus, state: unknown) {
    const snapshot: SnapshotRecord = { snapshotId: randomUUID(), taskId, status, stateJson: JSON.stringify(state), createdAt: Date.now() };
    this.db.prepare(`INSERT INTO snapshots(snapshot_id, task_id, status, state_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(snapshot.snapshotId, snapshot.taskId, snapshot.status, snapshot.stateJson, snapshot.createdAt);
    return snapshot;
  }

  recordHistory(taskId: string, transitionKind: string, fromStatus: string | null, toStatus: string | null, detail: unknown) {
    this.db.prepare(`INSERT INTO history(history_id, task_id, transition_kind, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, transitionKind, fromStatus, toStatus, JSON.stringify(detail), Date.now());
  }

  allExecutions(taskId: string): ExecutionRecord[] {
    return this.db.prepare(`SELECT execution_id as executionId, task_id as taskId, step_id as stepId, skill, kind, input_json as inputJson, output_json as outputJson, passed, note, created_at as createdAt FROM executions WHERE task_id = ? ORDER BY created_at ASC`).all(taskId) as ExecutionRecord[];
  }

  allSnapshots(taskId: string) { return this.db.prepare(`SELECT snapshot_id as snapshotId, task_id as taskId, status, state_json as stateJson, created_at as createdAt FROM snapshots WHERE task_id = ? ORDER BY created_at ASC`).all(taskId); }
  allHistory(taskId: string) { return this.db.prepare(`SELECT * FROM history WHERE task_id = ? ORDER BY created_at ASC`).all(taskId); }
}
