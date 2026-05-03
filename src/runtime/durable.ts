import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { runtimeServices } from './services.ts';
import type { TimeProvider } from '../types';

export type DurableStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type DurableCheckpoint = {
  label: string;
  at: string;
  state?: unknown;
  note?: string;
};

export type DurableRunRecord<TInput = unknown, TOutput = unknown> = {
  id: string;
  kind: string;
  status: DurableStatus;
  createdAt: string;
  updatedAt: string;
  input: TInput;
  output?: TOutput;
  error?: string;
  checkpoints: DurableCheckpoint[];
};

export type DurableValueRecord<T = unknown> = {
  key: string;
  value: T;
  createdAt: string;
  updatedAt: string;
};

export type DurableDocumentRecord = {
  documentId: string;
  data: Uint8Array;
  metadata: Record<string, unknown>;
  mimeType?: string;
  filename?: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeNamespace(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'default';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toBlob(data: string | Uint8Array | ArrayBuffer): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(data);
}

function fromBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return new Uint8Array();
}

export class JsonFileDurableStore<TInput = unknown, TOutput = unknown> {
  private readonly db: Database;
  private readonly namespace: string;
  private readonly clock: TimeProvider;
  private readonly dbPath: string;

  constructor(rootDir: string, clock: TimeProvider = runtimeServices.clock) {
    this.namespace = normalizeNamespace(rootDir);
    this.clock = clock;
    this.dbPath = resolve(process.cwd(), '.poke-core', 'durable.sqlite');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;' +
      'CREATE TABLE IF NOT EXISTS durable_runs (namespace TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, error TEXT, PRIMARY KEY(namespace, id));' +
      'CREATE INDEX IF NOT EXISTS idx_durable_runs_namespace_kind ON durable_runs(namespace, kind, created_at);' +
      'CREATE TABLE IF NOT EXISTS durable_run_checkpoints (namespace TEXT NOT NULL, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, label TEXT NOT NULL, at TEXT NOT NULL, state_json TEXT, note TEXT, PRIMARY KEY(namespace, run_id, ordinal));' +
      'CREATE INDEX IF NOT EXISTS idx_durable_run_checkpoints_run ON durable_run_checkpoints(namespace, run_id, ordinal);' +
      'CREATE TABLE IF NOT EXISTS durable_values (namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(namespace, key));' +
      'CREATE INDEX IF NOT EXISTS idx_durable_values_namespace_key ON durable_values(namespace, key);' +
      'CREATE TABLE IF NOT EXISTS durable_documents (namespace TEXT NOT NULL, document_id TEXT NOT NULL, mime_type TEXT, filename TEXT, metadata_json TEXT NOT NULL, blob BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(namespace, document_id));' +
      'CREATE INDEX IF NOT EXISTS idx_durable_documents_namespace_created ON durable_documents(namespace, created_at);'
    );
  }

  close(): void {
    this.db.close();
  }

  private transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  private hydrateRun(row: any, checkpoints: DurableCheckpoint[]): DurableRunRecord<TInput, TOutput> {
    return {
      id: String(row.id),
      kind: String(row.kind),
      status: String(row.status) as DurableStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      input: JSON.parse(String(row.input_json)) as TInput,
      output: row.output_json == null ? undefined : JSON.parse(String(row.output_json)) as TOutput,
      error: row.error == null ? undefined : String(row.error),
      checkpoints,
    };
  }

  private loadCheckpoints(runId: string): DurableCheckpoint[] {
    const rows = this.db.prepare('SELECT label, at, state_json AS stateJson, note FROM durable_run_checkpoints WHERE namespace = ? AND run_id = ? ORDER BY ordinal ASC').all(this.namespace, runId) as Array<{ label: string; at: string; stateJson: string | null; note: string | null }>;
    return rows.map((row) => ({
      label: row.label,
      at: row.at,
      state: row.stateJson == null ? undefined : JSON.parse(row.stateJson),
      note: row.note == null ? undefined : row.note,
    }));
  }

  private persistRun(record: DurableRunRecord<TInput, TOutput>): void {
    const checkpoints = record.checkpoints ?? [];
    this.db.prepare(
      'INSERT INTO durable_runs(namespace, id, kind, status, created_at, updated_at, input_json, output_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET kind = excluded.kind, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at, input_json = excluded.input_json, output_json = excluded.output_json, error = excluded.error'
    ).run(
      this.namespace,
      record.id,
      record.kind,
      record.status,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record.input),
      record.output === undefined ? null : JSON.stringify(record.output),
      record.error ?? null,
    );
    this.db.prepare('DELETE FROM durable_run_checkpoints WHERE namespace = ? AND run_id = ?').run(this.namespace, record.id);
    const insertCheckpoint = this.db.prepare('INSERT INTO durable_run_checkpoints(namespace, run_id, ordinal, label, at, state_json, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
    checkpoints.forEach((checkpoint, ordinal) => {
      insertCheckpoint.run(this.namespace, record.id, ordinal, checkpoint.label, checkpoint.at, checkpoint.state === undefined ? null : JSON.stringify(checkpoint.state), checkpoint.note ?? null);
    });
  }

  async create(kind: string, input: TInput): Promise<DurableRunRecord<TInput, TOutput>> {
    const now = this.clock.iso();
    const record: DurableRunRecord<TInput, TOutput> = {
      id: randomUUID(),
      kind,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      input: clone(input),
      checkpoints: [],
    };
    this.transact(() => this.persistRun(record));
    return clone(record);
  }

  async save(record: DurableRunRecord<TInput, TOutput>): Promise<void> {
    record.updatedAt = this.clock.iso();
    this.transact(() => this.persistRun(record));
  }

  async get(id: string): Promise<DurableRunRecord<TInput, TOutput> | null> {
    const row = this.db.prepare('SELECT * FROM durable_runs WHERE namespace = ? AND id = ?').get(this.namespace, id) as any;
    if (!row) return null;
    return this.hydrateRun(row, this.loadCheckpoints(id));
  }

  async list(kind?: string): Promise<DurableRunRecord<TInput, TOutput>[]> {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM durable_runs WHERE namespace = ? AND kind = ? ORDER BY created_at ASC').all(this.namespace, kind)
      : this.db.prepare('SELECT * FROM durable_runs WHERE namespace = ? ORDER BY created_at ASC').all(this.namespace)) as any[];
    const checkpointRows = this.db.prepare('SELECT run_id AS runId, label, at, state_json AS stateJson, note FROM durable_run_checkpoints WHERE namespace = ? ORDER BY run_id ASC, ordinal ASC').all(this.namespace) as Array<{ runId: string; label: string; at: string; stateJson: string | null; note: string | null }>;
    const grouped = new Map<string, DurableCheckpoint[]>();
    for (const row of checkpointRows) {
      const list = grouped.get(row.runId) ?? [];
      list.push({ label: row.label, at: row.at, state: row.stateJson == null ? undefined : JSON.parse(row.stateJson), note: row.note == null ? undefined : row.note });
      grouped.set(row.runId, list);
    }
    return rows.map((row) => this.hydrateRun(row, grouped.get(String(row.id)) ?? []));
  }

  async checkpoint(id: string, label: string, state?: unknown, note?: string): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.checkpoints.push({ label, at: this.clock.iso(), state, note });
    await this.save(record);
    return record;
  }

  async complete(id: string, output: TOutput): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.status = 'succeeded';
    record.output = clone(output);
    record.error = undefined;
    await this.save(record);
    return record;
  }

  async fail(id: string, error: unknown): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    await this.save(record);
    return record;
  }

  async resume(id: string): Promise<DurableRunRecord<TInput, TOutput>> {
    return await this.mustGet(id);
  }

  async setValue<T = unknown>(key: string, value: T): Promise<DurableValueRecord<T>> {
    const now = this.clock.iso();
    const record: DurableValueRecord<T> = { key, value: clone(value), createdAt: now, updatedAt: now };
    this.transact(() => {
      this.db.prepare('INSERT INTO durable_values(namespace, key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run(this.namespace, key, JSON.stringify(record.value), record.createdAt, record.updatedAt);
    });
    return record;
  }

  async getValue<T = unknown>(key: string): Promise<DurableValueRecord<T> | null> {
    const row = this.db.prepare('SELECT key, value_json AS valueJson, created_at AS createdAt, updated_at AS updatedAt FROM durable_values WHERE namespace = ? AND key = ?').get(this.namespace, key) as { key: string; valueJson: string; createdAt: string; updatedAt: string } | undefined;
    if (!row) return null;
    return { key: row.key, value: JSON.parse(row.valueJson) as T, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  async deleteValue(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM durable_values WHERE namespace = ? AND key = ?').run(this.namespace, key);
    return result.changes > 0;
  }

  async listValues(prefix?: string): Promise<Array<DurableValueRecord>> {
    const rows = (prefix
      ? this.db.prepare('SELECT key, value_json AS valueJson, created_at AS createdAt, updated_at AS updatedAt FROM durable_values WHERE namespace = ? AND key LIKE ? ORDER BY key ASC').all(this.namespace, prefix + '%')
      : this.db.prepare('SELECT key, value_json AS valueJson, created_at AS createdAt, updated_at AS updatedAt FROM durable_values WHERE namespace = ? ORDER BY key ASC').all(this.namespace)) as Array<{ key: string; valueJson: string; createdAt: string; updatedAt: string }>;
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.valueJson), createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }

  async putDocument(documentId: string, data: string | Uint8Array | ArrayBuffer, metadata: Record<string, unknown> = {}, options: { mimeType?: string; filename?: string } = {}): Promise<DurableDocumentRecord> {
    const now = this.clock.iso();
    const record: DurableDocumentRecord = {
      documentId,
      data: fromBlob(toBlob(data)),
      metadata: clone(asRecord(metadata)),
      mimeType: options.mimeType,
      filename: options.filename,
      createdAt: now,
      updatedAt: now,
    };
    this.transact(() => {
      this.db.prepare('INSERT INTO durable_documents(namespace, document_id, mime_type, filename, metadata_json, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, document_id) DO UPDATE SET mime_type = excluded.mime_type, filename = excluded.filename, metadata_json = excluded.metadata_json, blob = excluded.blob, updated_at = excluded.updated_at').run(this.namespace, record.documentId, record.mimeType ?? null, record.filename ?? null, JSON.stringify(record.metadata), toBlob(record.data), record.createdAt, record.updatedAt);
    });
    return record;
  }

  async getDocument(documentId: string): Promise<DurableDocumentRecord | null> {
    const row = this.db.prepare('SELECT document_id AS documentId, mime_type AS mimeType, filename, metadata_json AS metadataJson, blob, created_at AS createdAt, updated_at AS updatedAt FROM durable_documents WHERE namespace = ? AND document_id = ?').get(this.namespace, documentId) as any;
    if (!row) return null;
    return {
      documentId: String(row.documentId),
      data: fromBlob(row.blob),
      metadata: JSON.parse(String(row.metadataJson ?? '{}')) as Record<string, unknown>,
      mimeType: row.mimeType ?? undefined,
      filename: row.filename ?? undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  async deleteDocument(documentId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM durable_documents WHERE namespace = ? AND document_id = ?').run(this.namespace, documentId);
    return result.changes > 0;
  }

  async listDocuments(): Promise<DurableDocumentRecord[]> {
    const rows = this.db.prepare('SELECT document_id AS documentId, mime_type AS mimeType, filename, metadata_json AS metadataJson, blob, created_at AS createdAt, updated_at AS updatedAt FROM durable_documents WHERE namespace = ? ORDER BY created_at ASC').all(this.namespace) as any[];
    return rows.map((row) => ({
      documentId: String(row.documentId),
      data: fromBlob(row.blob),
      metadata: JSON.parse(String(row.metadataJson ?? '{}')) as Record<string, unknown>,
      mimeType: row.mimeType ?? undefined,
      filename: row.filename ?? undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }));
  }

  private async mustGet(id: string): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.get(id);
    if (!record) throw new Error('durable run not found: ' + id);
    return record;
  }
}
