import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MemoryClock = { now(): number };
export type SqliteMemoryOptions = { storagePath?: string; clock?: MemoryClock };

const DEFAULT_STORAGE_PATH = process.env.POKE_CORE_MEMORY_DB ?? resolve(process.cwd(), '.poke-core', 'memory.sqlite');

function ensureDirectory(storagePath: string): void {
  mkdirSync(dirname(storagePath), { recursive: true });
}

export function resolveStoragePath(storagePath?: string): string {
  return resolve(storagePath ?? DEFAULT_STORAGE_PATH);
}

export function openMemoryDatabase(storagePath?: string): DatabaseSync {
  const resolved = resolveStoragePath(storagePath);
  ensureDirectory(resolved);
  const db = new DatabaseSync(resolved);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS working_facts (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS working_trail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      at INTEGER NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodic_items (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      category TEXT NOT NULL,
      summary TEXT NOT NULL,
      signals TEXT NOT NULL,
      score REAL NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS behavioral_state (
      name TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_working_facts_updatedAt ON working_facts(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_working_facts_key ON working_facts(key);
    CREATE INDEX IF NOT EXISTS idx_working_trail_at ON working_trail(at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_task_createdAt ON episodic_items(taskId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_score ON episodic_items(score DESC, createdAt DESC);
  `);
  return db;
}

export function vacuumDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('PRAGMA optimize;');
}
