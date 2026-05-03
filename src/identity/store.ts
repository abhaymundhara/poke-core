import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IdentityEdge, IdentityEdgeKind, IdentityHandle, IdentityKind, IdentityLinkInput, IdentityPhone, IdentityRecord, IdentityUpsertInput } from './types.ts';

export const DEFAULT_IDENTITY_DB_PATH = resolve(process.cwd(), '.poke-core', 'identity.sqlite');

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/s+/g, ' ');
}

function normalizeName(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^p{L}p{N}]+/gu, ' ').replace(/s+/g, ' ').trim();
}

function normalizeAlias(value: string): string {
  return normalizeName(value);
}

function normalizeEmail(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizePhone(value: string): string {
  const trimmed = normalizeWhitespace(value);
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/D/g, '');
  return hasPlus ? '+' + digits : digits;
}

function canonicalPlatform(platform: string): string {
  const normalized = normalizeWhitespace(platform).toLowerCase();
  if (normalized === 'x') return 'twitter';
  return normalized;
}

function normalizeHandle(value: string): string {
  return normalizeWhitespace(value).replace(/^@+/, '').toLowerCase();
}

function normalizeSearchTerm(value: string): string {
  return normalizeAlias(value).replace(/[%_]/g, '');
}

function defaultBidirectional(edgeKind: IdentityEdgeKind): boolean {
  return edgeKind === 'manager' || edgeKind === 'advisor' ? false : true;
}

function rowMetadata(row: any): Record<string, unknown> {
  return json<Record<string, unknown>>(row ? row.metadata_json ?? null : null, {});
}

export class IdentityStore {
  private readonly db: Database;

  constructor(dbPath: string = DEFAULT_IDENTITY_DB_PATH) {
    ensureDirectory(dbPath);
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  init(): void {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS identities (identity_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, name_normalized TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS identity_aliases (identity_id TEXT NOT NULL, alias TEXT NOT NULL, alias_normalized TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (identity_id, alias_normalized)); CREATE INDEX IF NOT EXISTS idx_identity_aliases_alias_normalized ON identity_aliases(alias_normalized); CREATE TABLE IF NOT EXISTS identity_emails (email_normalized TEXT PRIMARY KEY, identity_id TEXT NOT NULL, email TEXT NOT NULL, verified INTEGER NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_identity_emails_identity_id ON identity_emails(identity_id); CREATE TABLE IF NOT EXISTS identity_phones (phone_normalized TEXT PRIMARY KEY, identity_id TEXT NOT NULL, phone_number TEXT NOT NULL, verified INTEGER NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_identity_phones_identity_id ON identity_phones(identity_id); CREATE TABLE IF NOT EXISTS identity_handles (handle_key TEXT PRIMARY KEY, identity_id TEXT NOT NULL, platform TEXT NOT NULL, handle TEXT NOT NULL, handle_normalized TEXT NOT NULL, verified INTEGER NOT NULL, confidence REAL NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_identity_handles_identity_id ON identity_handles(identity_id); CREATE INDEX IF NOT EXISTS idx_identity_handles_handle_normalized ON identity_handles(handle_normalized); CREATE TABLE IF NOT EXISTS identity_edges (edge_id TEXT PRIMARY KEY, edge_key TEXT NOT NULL UNIQUE, from_identity_id TEXT NOT NULL, to_identity_id TEXT NOT NULL, edge_kind TEXT NOT NULL, bidirectional INTEGER NOT NULL, confidence REAL NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_identity_edges_from_id ON identity_edges(from_identity_id); CREATE INDEX IF NOT EXISTS idx_identity_edges_to_id ON identity_edges(to_identity_id);');
  }

  close(): void {
    this.db.close();
  }

  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsertIdentity(input: IdentityUpsertInput): IdentityRecord {
    const identityId = text(input.identityId) || randomUUID();
    const name = normalizeWhitespace(input.name);
    if (!name) throw new Error('identity name is required');
    const kind = input.kind ?? 'contact';
    const now = Date.now();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    this.db.prepare('INSERT INTO identities(identity_id, kind, name, name_normalized, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, name_normalized = excluded.name_normalized, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at').run(identityId, kind, name, normalizeName(name), metadataJson, now, now);

    const aliases = new Set<string>([name, ...(input.aliases ?? [])].map((alias) => normalizeWhitespace(alias)).filter(Boolean));
    for (const alias of aliases) {
      this.db.prepare('INSERT INTO identity_aliases(identity_id, alias, alias_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(identity_id, alias_normalized) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at').run(identityId, alias, normalizeAlias(alias), now, now);
    }

    for (const entry of input.verifiedEmails ?? []) {
      const email = typeof entry === 'string' ? entry : entry.email;
      const verified = typeof entry === 'string' ? true : entry.verified ?? true;
      const confidence = typeof entry === 'string' ? 0.98 : clamp(entry.confidence ?? (verified ? 0.98 : 0.84));
      const source = typeof entry === 'string' ? 'manual' : entry.source ?? 'manual';
      const normalized = normalizeEmail(email);
      this.db.prepare('INSERT INTO identity_emails(email_normalized, identity_id, email, verified, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email_normalized) DO UPDATE SET identity_id = excluded.identity_id, email = excluded.email, verified = excluded.verified, confidence = excluded.confidence, source = excluded.source, updated_at = excluded.updated_at').run(normalized, identityId, normalizeWhitespace(email), verified ? 1 : 0, confidence, source, now, now);
    }

    for (const entry of input.phoneNumbers ?? []) {
      const phoneNumber = typeof entry === 'string' ? entry : entry.phoneNumber;
      const verified = typeof entry === 'string' ? true : entry.verified ?? true;
      const confidence = typeof entry === 'string' ? 0.92 : clamp(entry.confidence ?? (verified ? 0.92 : 0.78));
      const source = typeof entry === 'string' ? 'manual' : entry.source ?? 'manual';
      const normalized = normalizePhone(phoneNumber);
      this.db.prepare('INSERT INTO identity_phones(phone_normalized, identity_id, phone_number, verified, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone_normalized) DO UPDATE SET identity_id = excluded.identity_id, phone_number = excluded.phone_number, verified = excluded.verified, confidence = excluded.confidence, source = excluded.source, updated_at = excluded.updated_at').run(normalized, identityId, normalizeWhitespace(phoneNumber), verified ? 1 : 0, confidence, source, now, now);
    }

    for (const entry of input.platformHandles ?? []) {
      const platform = canonicalPlatform(entry.platform);
      const handle = normalizeHandle(entry.handle);
      const verified = entry.verified ?? true;
      const confidence = clamp(entry.confidence ?? (verified ? 0.9 : 0.76));
      const source = entry.source ?? 'manual';
      const handleKey = platform + ':' + handle;
      this.db.prepare('INSERT INTO identity_handles(handle_key, identity_id, platform, handle, handle_normalized, verified, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handle_key) DO UPDATE SET identity_id = excluded.identity_id, platform = excluded.platform, handle = excluded.handle, handle_normalized = excluded.handle_normalized, verified = excluded.verified, confidence = excluded.confidence, source = excluded.source, updated_at = excluded.updated_at').run(handleKey, identityId, platform, normalizeWhitespace(entry.handle), handle, verified ? 1 : 0, confidence, source, now, now);
    }

    const record = this.getIdentity(identityId);
    if (!record) throw new Error('failed to persist identity ' + identityId);
    return record;
  }

  getIdentity(identityId: string): IdentityRecord | null {
    const row = this.db.prepare('SELECT * FROM identities WHERE identity_id = ?').get(identityId) as any;
    if (!row) return null;
    return this.rowToIdentity(row);
  }

  getIdentitiesByIds(identityIds: string[]): IdentityRecord[] {
    const ids = [...new Set(identityIds.map((value) => text(value)).filter(Boolean))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare('SELECT * FROM identities WHERE identity_id IN (' + placeholders + ') ORDER BY updated_at DESC').all(...ids) as any[];
    return rows.map((row) => this.rowToIdentity(row));
  }

  listIdentities(options: { kind?: IdentityKind; limit?: number } = {}): IdentityRecord[] {
    const limit = Math.max(1, Math.min(250, options.limit ?? 50));
    const rows = options.kind
      ? (this.db.prepare('SELECT * FROM identities WHERE kind = ? ORDER BY updated_at DESC LIMIT ?').all(options.kind, limit) as any[])
      : (this.db.prepare('SELECT * FROM identities ORDER BY updated_at DESC LIMIT ?').all(limit) as any[]);
    return rows.map((row) => this.rowToIdentity(row));
  }

  searchIdentities(term: string, limit = 20): IdentityRecord[] {
    const normalized = normalizeSearchTerm(term);
    if (!normalized) return [];
    const like = '%' + normalized + '%';
    const ids = new Set<string>();
    const pushIds = (rows: any[]) => { for (const row of rows) ids.add(row.identity_id); };
    pushIds(this.db.prepare('SELECT identity_id FROM identities WHERE name_normalized LIKE ? LIMIT ?').all(like, limit) as any[]);
    pushIds(this.db.prepare('SELECT identity_id FROM identity_aliases WHERE alias_normalized LIKE ? LIMIT ?').all(like, limit) as any[]);
    pushIds(this.db.prepare('SELECT identity_id FROM identity_handles WHERE handle_normalized LIKE ? OR platform LIKE ? LIMIT ?').all(like, like, limit) as any[]);
    pushIds(this.db.prepare('SELECT identity_id FROM identity_emails WHERE email_normalized LIKE ? LIMIT ?').all(like, limit) as any[]);
    pushIds(this.db.prepare('SELECT identity_id FROM identity_phones WHERE phone_normalized LIKE ? LIMIT ?').all(like, limit) as any[]);
    return this.getIdentitiesByIds([...ids]).slice(0, limit);
  }

  findIdentityIdsByEmail(email: string): string[] {
    const rows = this.db.prepare('SELECT identity_id FROM identity_emails WHERE email_normalized = ?').all(normalizeEmail(email)) as any[];
    return rows.map((row) => row.identity_id);
  }

  findIdentityIdsByPhone(phoneNumber: string): string[] {
    const rows = this.db.prepare('SELECT identity_id FROM identity_phones WHERE phone_normalized = ?').all(normalizePhone(phoneNumber)) as any[];
    return rows.map((row) => row.identity_id);
  }

  findIdentityIdsByHandle(handle: string, platform?: string): string[] {
    const normalizedHandle = normalizeHandle(handle);
    const normalizedPlatform = platform ? canonicalPlatform(platform) : '';
    const rows = normalizedPlatform
      ? (this.db.prepare('SELECT identity_id FROM identity_handles WHERE handle_normalized = ? AND platform = ?').all(normalizedHandle, normalizedPlatform) as any[])
      : (this.db.prepare('SELECT identity_id FROM identity_handles WHERE handle_normalized = ?').all(normalizedHandle) as any[]);
    return rows.map((row) => row.identity_id);
  }

  findIdentityIdsByNameOrAlias(term: string): string[] {
    const normalized = normalizeSearchTerm(term);
    if (!normalized) return [];
    const like = '%' + normalized + '%';
    const ids = new Set<string>();
    const nameRows = this.db.prepare('SELECT identity_id FROM identities WHERE name_normalized LIKE ?').all(like) as any[];
    const aliasRows = this.db.prepare('SELECT identity_id FROM identity_aliases WHERE alias_normalized LIKE ?').all(like) as any[];
    for (const row of nameRows) ids.add(row.identity_id);
    for (const row of aliasRows) ids.add(row.identity_id);
    return [...ids];
  }

  getAllIdentities(): IdentityRecord[] {
    const rows = this.db.prepare('SELECT * FROM identities ORDER BY updated_at DESC').all() as any[];
    return rows.map((row) => this.rowToIdentity(row));
  }

  getAllEdges(): IdentityEdge[] {
    const rows = this.db.prepare('SELECT * FROM identity_edges ORDER BY updated_at DESC').all() as any[];
    return rows.map((row) => this.rowToEdge(row));
  }

  getEdgesForIdentity(identityId: string): IdentityEdge[] {
    const rows = this.db.prepare('SELECT * FROM identity_edges WHERE from_identity_id = ? OR to_identity_id = ? ORDER BY updated_at DESC').all(identityId, identityId) as any[];
    return rows.map((row) => this.rowToEdge(row));
  }

  upsertEdge(input: IdentityLinkInput): IdentityEdge {
    const edgeId = randomUUID();
    const now = Date.now();
    const bidirectional = input.bidirectional ?? defaultBidirectional(input.edgeKind);
    const confidence = clamp(input.confidence ?? 0.9);
    const edgeKey = input.fromIdentityId + ':' + input.toIdentityId + ':' + input.edgeKind + ':' + (bidirectional ? 'bi' : 'uni');
    this.db.prepare('INSERT INTO identity_edges(edge_id, edge_key, from_identity_id, to_identity_id, edge_kind, bidirectional, confidence, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(edge_key) DO UPDATE SET confidence = excluded.confidence, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at').run(edgeId, edgeKey, input.fromIdentityId, input.toIdentityId, input.edgeKind, bidirectional ? 1 : 0, confidence, JSON.stringify(input.metadata ?? {}), now, now);
    return this.getEdgeByKey(edgeKey) as IdentityEdge;
  }

  getEdgeByKey(edgeKey: string): IdentityEdge | null {
    const row = this.db.prepare('SELECT * FROM identity_edges WHERE edge_key = ?').get(edgeKey) as any;
    return row ? this.rowToEdge(row) : null;
  }

  private rowToIdentity(row: any): IdentityRecord {
    const identityId = row.identity_id as string;
    const aliases = this.db.prepare('SELECT alias FROM identity_aliases WHERE identity_id = ? ORDER BY updated_at DESC, alias ASC').all(identityId) as any[];
    const emails = this.db.prepare('SELECT email, verified, confidence, source FROM identity_emails WHERE identity_id = ? ORDER BY updated_at DESC, email ASC').all(identityId) as any[];
    const phones = this.db.prepare('SELECT phone_number, verified, confidence, source FROM identity_phones WHERE identity_id = ? ORDER BY updated_at DESC, phone_number ASC').all(identityId) as any[];
    const handles = this.db.prepare('SELECT platform, handle, verified, confidence, source FROM identity_handles WHERE identity_id = ? ORDER BY updated_at DESC, platform ASC, handle ASC').all(identityId) as any[];
    return {
      identityId,
      kind: row.kind as IdentityKind,
      name: row.name as string,
      aliases: aliases.map((item) => item.alias as string),
      verifiedEmails: emails.filter((item) => Boolean(item.verified)).map((item) => ({ email: item.email as string, value: item.email as string, verified: Boolean(item.verified), confidence: Number(item.confidence), source: item.source as string })),
      phoneNumbers: phones.map((item) => ({ phoneNumber: item.phone_number as string, value: item.phone_number as string, verified: Boolean(item.verified), confidence: Number(item.confidence), source: item.source as string })),
      platformHandles: handles.map((item) => ({ platform: item.platform as string, handle: item.handle as string, value: item.handle as string, verified: Boolean(item.verified), confidence: Number(item.confidence), source: item.source as string })),
      metadata: rowMetadata(row),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToEdge(row: any): IdentityEdge {
    return {
      edgeId: row.edge_id as string,
      fromIdentityId: row.from_identity_id as string,
      toIdentityId: row.to_identity_id as string,
      edgeKind: row.edge_kind as IdentityEdgeKind,
      bidirectional: Boolean(row.bidirectional),
      confidence: Number(row.confidence),
      metadata: json<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
