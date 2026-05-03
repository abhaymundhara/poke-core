import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  ConnectionCredentialKind,
  ConnectionRecord,
  ConnectionStore,
  ConnectionStatus,
  EncryptedSecretEnvelope,
  PermissionScope,
} from './types';

export type SQLiteConnectionStoreOptions = {
  storagePath?: string;
};

const DEFAULT_STORAGE_PATH = process.env.POKE_CORE_CONNECTIONS_DB ?? resolve(process.cwd(), '.poke-core', 'connections.sqlite');

function ensureParentDirectory(storagePath: string): void {
  mkdirSync(dirname(storagePath), { recursive: true });
}

function cloneRecord(record: ConnectionRecord): ConnectionRecord {
  return {
    ...record,
    scopes: [...record.scopes],
    metadata: { ...record.metadata },
    secretEnvelope: { ...record.secretEnvelope },
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseScopes(value: unknown): PermissionScope[] {
  return Array.isArray(value) ? value.filter((scope): scope is PermissionScope => scope === 'read' || scope === 'write' || scope === 'admin') : [];
}

function parseEnvelope(value: string): EncryptedSecretEnvelope {
  const parsed = JSON.parse(value) as EncryptedSecretEnvelope;
  if (!parsed || parsed.algorithm !== 'aes-256-gcm') {
    throw new Error('invalid secret envelope');
  }
  return parsed;
}

function rowToRecord(row: any): ConnectionRecord {
  return {
    connectionId: String(row.connection_id),
    provider: String(row.provider),
    accountId: String(row.account_id),
    label: row.label ?? undefined,
    credentialKind: row.credential_kind as ConnectionCredentialKind,
    authMode: row.auth_mode,
    scopes: parseScopes(row.scopes ?? []),
    status: row.status as ConnectionStatus,
    metadata: parseJsonObject(row.metadata_json),
    secretEnvelope: parseEnvelope(String(row.secret_envelope_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRefreshedAt: row.last_refreshed_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    ownerId: row.owner_id ?? undefined,
    providerAccountHint: row.provider_account_hint ?? undefined,
  };
}

function envelopeToJson(envelope: EncryptedSecretEnvelope): string {
  return JSON.stringify(envelope);
}

function metadataToJson(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata ?? {});
}

function normalizeScopes(scopes: PermissionScope[]): PermissionScope[] {
  return Array.from(new Set(scopes)).sort((left, right) => {
    const order: PermissionScope[] = ['read', 'write', 'admin'];
    return order.indexOf(left) - order.indexOf(right);
  });
}

export class SQLiteConnectionStore implements ConnectionStore {
  private readonly db: Database;
  private readonly upsertConnectionStatement;
  private readonly deleteConnectionStatement;

  constructor(options: SQLiteConnectionStoreOptions = {}) {
    const storagePath = resolve(options.storagePath ?? DEFAULT_STORAGE_PATH);
    ensureParentDirectory(storagePath);
    this.db = new Database(storagePath, { create: true });
    this.db.exec(
      'PRAGMA journal_mode = WAL;
' +
        'PRAGMA synchronous = FULL;
' +
        'PRAGMA foreign_keys = ON;
' +
        'PRAGMA temp_store = MEMORY;
' +
        'CREATE TABLE IF NOT EXISTS connections (
' +
        '  connection_id TEXT PRIMARY KEY,
' +
        '  provider TEXT NOT NULL,
' +
        '  account_id TEXT NOT NULL,
' +
        '  label TEXT,
' +
        '  credential_kind TEXT NOT NULL,
' +
        '  auth_mode TEXT NOT NULL,
' +
        '  status TEXT NOT NULL,
' +
        "  metadata_json TEXT NOT NULL DEFAULT '{}',
" +
        '  secret_envelope_json TEXT NOT NULL,
' +
        '  created_at TEXT NOT NULL,
' +
        '  updated_at TEXT NOT NULL,
' +
        '  last_refreshed_at TEXT,
' +
        '  expires_at TEXT,
' +
        '  owner_id TEXT,
' +
        '  provider_account_hint TEXT,
' +
        '  UNIQUE(provider, account_id)
' +
        ');
' +
        'CREATE TABLE IF NOT EXISTS connection_scopes (
' +
        '  connection_id TEXT NOT NULL,
' +
        '  scope TEXT NOT NULL,
' +
        '  PRIMARY KEY(connection_id, scope),
' +
        '  FOREIGN KEY(connection_id) REFERENCES connections(connection_id) ON DELETE CASCADE
' +
        ');
' +
        'CREATE INDEX IF NOT EXISTS idx_connections_provider_account ON connections(provider, account_id);
' +
        'CREATE INDEX IF NOT EXISTS idx_connections_provider_status ON connections(provider, status);
' +
        'CREATE INDEX IF NOT EXISTS idx_connections_provider_label ON connections(provider, label);
' +
        'CREATE INDEX IF NOT EXISTS idx_connection_scopes_scope ON connection_scopes(scope);
' +
        'CREATE INDEX IF NOT EXISTS idx_connection_scopes_connection ON connection_scopes(connection_id);',
    );
    this.upsertConnectionStatement = this.db.query(
      'INSERT INTO connections (connection_id, provider, account_id, label, credential_kind, auth_mode, status, metadata_json, secret_envelope_json, created_at, updated_at, last_refreshed_at, expires_at, owner_id, provider_account_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET provider = excluded.provider, account_id = excluded.account_id, label = excluded.label, credential_kind = excluded.credential_kind, auth_mode = excluded.auth_mode, status = excluded.status, metadata_json = excluded.metadata_json, secret_envelope_json = excluded.secret_envelope_json, created_at = excluded.created_at, updated_at = excluded.updated_at, last_refreshed_at = excluded.last_refreshed_at, expires_at = excluded.expires_at, owner_id = excluded.owner_id, provider_account_hint = excluded.provider_account_hint',
    );
    this.deleteConnectionStatement = this.db.query('DELETE FROM connections WHERE connection_id = ?');
  }

  async list(): Promise<ConnectionRecord[]> {
    const rows = this.db.query(
      'SELECT c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint, COALESCE(json_group_array(cs.scope), ''[]'') AS scopes FROM connections c LEFT JOIN connection_scopes cs ON cs.connection_id = c.connection_id GROUP BY c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint ORDER BY c.updated_at DESC, c.created_at DESC',
    ).all();
    return rows.map(rowToRecord).map(cloneRecord);
  }

  async get(connectionId: string): Promise<ConnectionRecord | undefined> {
    const row = this.db.query(
      'SELECT c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint, COALESCE(json_group_array(cs.scope), ''[]'') AS scopes FROM connections c LEFT JOIN connection_scopes cs ON cs.connection_id = c.connection_id WHERE c.connection_id = ? GROUP BY c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint LIMIT 1',
    ).get(connectionId);
    return row ? cloneRecord(rowToRecord(row)) : undefined;
  }

  async upsert(record: ConnectionRecord): Promise<void> {
    const normalizedScopes = normalizeScopes(record.scopes);
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      this.upsertConnectionStatement.run(
        record.connectionId,
        record.provider,
        record.accountId,
        record.label ?? null,
        record.credentialKind,
        record.authMode,
        record.status,
        metadataToJson(record.metadata),
        envelopeToJson(record.secretEnvelope),
        record.createdAt,
        record.updatedAt,
        record.lastRefreshedAt ?? null,
        record.expiresAt ?? null,
        record.ownerId ?? null,
        record.providerAccountHint ?? null,
      );
      this.db.query('DELETE FROM connection_scopes WHERE connection_id = ?').run(record.connectionId);
      for (const scope of normalizedScopes) {
        this.db.query('INSERT INTO connection_scopes (connection_id, scope) VALUES (?, ?)').run(record.connectionId, scope);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  }

  async delete(connectionId: string): Promise<boolean> {
    const result = this.deleteConnectionStatement.run(connectionId) as { changes?: number } | undefined;
    return Boolean(result && typeof result.changes === 'number' ? result.changes > 0 : false);
  }

  async findByProviderAndAccount(provider: string, accountId: string): Promise<ConnectionRecord | undefined> {
    const row = this.db.query(
      'SELECT c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint, COALESCE(json_group_array(cs.scope), ''[]'') AS scopes FROM connections c LEFT JOIN connection_scopes cs ON cs.connection_id = c.connection_id WHERE c.provider = ? AND c.account_id = ? GROUP BY c.connection_id, c.provider, c.account_id, c.label, c.credential_kind, c.auth_mode, c.status, c.metadata_json, c.secret_envelope_json, c.created_at, c.updated_at, c.last_refreshed_at, c.expires_at, c.owner_id, c.provider_account_hint LIMIT 1',
    ).get(provider, accountId);
    return row ? cloneRecord(rowToRecord(row)) : undefined;
  }
}
