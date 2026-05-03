import { randomUUID } from 'node:crypto';
import { ConnectionCryptoService } from './crypto.ts';
import { SQLiteConnectionStore } from './store.ts';
import { PermissionRegistry } from './permissions.ts';
import type { TimeProvider } from '../types';
import type {
  ConnectionAuthorizationRequest,
  ConnectionAuthorizationResult,
  ConnectionCreateInput,
  ConnectionDeleteResult,
  ConnectionManagerOptions,
  ConnectionProviderAdapter,
  ConnectionQuery,
  ConnectionRecord,
  ConnectionRefreshInput,
  ConnectionRefreshResult,
  ConnectionRotationInput,
  ConnectionRotationResult,
  ConnectionScope,
  ConnectionSecretMaterial,
  ConnectionSelector,
  ConnectionStatus,
  ConnectionStore,
  ConnectionView,
} from './types';

function nowIso(clock: TimeProvider): string {
  return clock.iso();
}

function dedupeScopes(scopes: ConnectionScope[] | undefined, fallback: ConnectionScope[] = []): ConnectionScope[] {
  return Array.from(new Set([...(scopes ?? []), ...fallback]));
}

function normalizeLabel(provider: string, accountId: string, label?: string): string {
  return label && label.trim().length > 0 ? label.trim() : provider + ':' + accountId;
}

function normalizeQueryStatus(status: ConnectionQuery['status']): ConnectionStatus[] {
  if (!status) {
    return [];
  }
  return Array.isArray(status) ? status : [status];
}

function summaryView(record: ConnectionRecord, secrets?: ConnectionSecretMaterial): ConnectionView {
  const view: ConnectionView = {
    connectionId: record.connectionId,
    provider: record.provider,
    accountId: record.accountId,
    label: record.label,
    credentialKind: record.credentialKind,
    authMode: record.authMode,
    scopes: [...record.scopes],
    status: record.status,
    metadata: { ...record.metadata },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRefreshedAt: record.lastRefreshedAt,
    expiresAt: record.expiresAt,
    ownerId: record.ownerId,
    providerAccountHint: record.providerAccountHint,
    secretPresent: true,
  };
  if (secrets) {
    view.secrets = { ...secrets };
  }
  return view;
}

function isNearExpiry(record: ConnectionRecord, thresholdMs: number, now: number): boolean {
  if (!record.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return false;
  }
  return expiresAt - now <= thresholdMs;
}

function isExpired(record: ConnectionRecord, now: number): boolean {
  if (!record.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(record.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

export class ConnectionLifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionLifecycleError';
    this.code = code;
  }
}

export class ConnectionManager {
  private readonly storage: ConnectionStore;
  private readonly crypto: ConnectionCryptoService;
  private readonly permissions: PermissionRegistry;
  private readonly providers = new Map<string, ConnectionProviderAdapter>();
  private readonly clock: TimeProvider;
  private readonly autoRefreshWindowMs: number;
  private readonly defaultEncryptionKey?: string;
  private readonly keyResolver?: ConnectionManagerOptions['keyResolver'];

  constructor(options: ConnectionManagerOptions = {}) {
    this.storage = options.storage ?? new SQLiteConnectionStore();
    this.crypto = new ConnectionCryptoService({ defaultKey: options.encryptionKey });
    this.permissions = new PermissionRegistry();
    if (!options.clock) throw new Error('ConnectionManager clock is required');
    this.clock = options.clock;
    this.autoRefreshWindowMs = options.autoRefreshWindowMs ?? 5 * 60 * 1000;
    this.defaultEncryptionKey = options.encryptionKey;
    this.keyResolver = options.keyResolver;
    this.registerDefaultPermissions();
    this.registerProviders(options.providers);
    if (options.permissions) {
      for (const rule of options.permissions) {
        this.permissions.register(rule);
      }
    }
  }

  get permissionRegistry(): PermissionRegistry {
    return this.permissions;
  }

  registerProvider(provider: ConnectionProviderAdapter): this {
    this.providers.set(provider.provider, provider);
    return this;
  }

  async listConnections(query: ConnectionQuery = {}, includeSecrets = false): Promise<ConnectionView[]> {
    const records = await this.storage.list();
    const statusFilter = normalizeQueryStatus(query.status);
    return Promise.all(records.filter((record) => this.matchesQuery(record, query, statusFilter)).map(async (record) => summaryView(record, includeSecrets ? await this.decryptSecrets(record) : undefined)));
  }

  async createConnection(input: ConnectionCreateInput): Promise<ConnectionView> {
    const provider = this.requireProviderName(input.provider);
    const providerAdapter = this.providers.get(provider);
    const accountId = this.resolveAccountId(input, providerAdapter);
    const existing = await this.findByProviderAndAccount(provider, accountId);
    if (existing && !input.allowReplace) {
      throw new ConnectionLifecycleError('connection_exists', 'connection already exists for provider and account');
    }

    const secretEnvelope = await this.encryptSecrets(provider, accountId, input.secrets, input.encryptionKey);
    const record: ConnectionRecord = {
      connectionId: existing?.connectionId ?? randomUUID(),
      provider,
      accountId,
      label: normalizeLabel(provider, accountId, input.label ?? existing?.label),
      credentialKind: input.credentialKind,
      authMode: input.authMode ?? input.credentialKind,
      scopes: dedupeScopes(input.scopes, providerAdapter?.defaultScopes),
      status: this.initialStatus(input.expiresAt),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      secretEnvelope,
      createdAt: existing?.createdAt ?? nowIso(this.clock),
      updatedAt: nowIso(this.clock),
      lastRefreshedAt: existing?.lastRefreshedAt,
      expiresAt: input.expiresAt ?? existing?.expiresAt,
      ownerId: input.ownerId ?? existing?.ownerId,
      providerAccountHint: input.providerAccountHint ?? existing?.providerAccountHint,
    };

    await this.storage.upsert(record);
    return summaryView(record);
  }

  async getConnection(selector: ConnectionSelector, options: { includeSecrets?: boolean; autoRefresh?: boolean; refreshWindowMs?: number } = {}): Promise<ConnectionView | null> {
    const record = await this.resolveRecord(selector);
    if (!record) {
      return null;
    }
    const now = this.clock.now();
    if (options.autoRefresh && (isNearExpiry(record, options.refreshWindowMs ?? this.autoRefreshWindowMs, now) || isExpired(record, now))) {
      return await this.refreshConnection(selector, { refreshWindowMs: options.refreshWindowMs });
    }
    return summaryView(record, options.includeSecrets ? await this.decryptSecrets(record) : undefined);
  }

  async refreshConnection(selector: ConnectionSelector, options: ConnectionRefreshInput = {}): Promise<ConnectionRefreshResult> {
    const record = await this.resolveRecord(selector);
    if (!record) {
      throw new ConnectionLifecycleError('connection_not_found', 'connection not found');
    }

    const refreshWindowMs = options.refreshWindowMs ?? this.autoRefreshWindowMs;
    const now = this.clock.now();
    const shouldRefresh = options.force || isNearExpiry(record, refreshWindowMs, now) || isExpired(record, now) || record.status === 'pending_refresh';
    const currentSecrets = await this.decryptSecrets(record, options.encryptionKey);
    if (!shouldRefresh) {
      return { connection: summaryView(record, currentSecrets), refreshed: false };
    }

    const provider = this.providers.get(record.provider);
    if (options.newSecrets) {
      const updated = await this.persistSecrets(record, options.newSecrets, options.encryptionKey, {
        status: 'active',
        lastRefreshedAt: nowIso(this.clock),
      });
      return { connection: summaryView(updated, options.newSecrets), refreshed: true, renewedSecrets: options.newSecrets };
    }

    if (!provider?.refreshConnection) {
      throw new ConnectionLifecycleError('connection_refresh_unavailable', 'connection cannot be refreshed automatically');
    }

    const refreshed = await provider.refreshConnection({
      connection: summaryView(record, currentSecrets),
      secrets: currentSecrets,
      encryptionKey: await this.resolveMasterKey(record.provider, record.accountId, options.encryptionKey),
      requestedScopes: record.scopes,
      refreshWindowMs,
    });

    const next = await this.persistSecrets(record, refreshed.renewedSecrets ?? currentSecrets, options.encryptionKey, {
      status: refreshed.connection.status ?? 'active',
      scopes: refreshed.connection.scopes ?? record.scopes,
      expiresAt: refreshed.connection.expiresAt ?? record.expiresAt,
      lastRefreshedAt: nowIso(this.clock),
      metadata: refreshed.connection.metadata ?? {},
    });
    return {
      connection: summaryView(next, refreshed.renewedSecrets ?? currentSecrets),
      refreshed: true,
      renewedSecrets: refreshed.renewedSecrets ?? currentSecrets,
    };
  }

  async deleteConnection(selector: ConnectionSelector): Promise<ConnectionDeleteResult> {
    const record = await this.resolveRecord(selector);
    if (!record) {
      return { deleted: false };
    }
    const deleted = await this.storage.delete(record.connectionId);
    return { deleted, connection: summaryView(record) };
  }

  async rotateConnection(selector: ConnectionSelector, options: ConnectionRotationInput = {}): Promise<ConnectionRotationResult> {
    const record = await this.resolveRecord(selector);
    if (!record) {
      throw new ConnectionLifecycleError('connection_not_found', 'connection not found');
    }

    const provider = this.providers.get(record.provider);
    const currentSecrets = await this.decryptSecrets(record, options.encryptionKey);

    if (options.newSecrets) {
      const rotated = await this.persistSecrets(record, options.newSecrets, options.encryptionKey, {
        status: 'active',
        lastRefreshedAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
      });
      return { connection: summaryView(rotated, options.newSecrets), refreshed: true, rotatedSecrets: options.newSecrets };
    }

    if (options.reauthorize && provider) {
      const authorization = await this.requestAuthorizationUrl({
        provider: record.provider,
        accountId: record.accountId,
        requestedScopes: record.scopes,
        existingScopes: record.scopes,
        ...(options.request ?? {}),
      });
      const pending = await this.persistRecord(record, {
        status: 'pending_refresh',
        updatedAt: nowIso(this.clock),
      });
      return {
        connection: summaryView(pending, currentSecrets),
        refreshed: false,
        authorization,
      };
    }

    if (provider?.rotateConnection) {
      const rotated = await provider.rotateConnection({
        connection: summaryView(record, currentSecrets),
        secrets: currentSecrets,
        encryptionKey: await this.resolveMasterKey(record.provider, record.accountId, options.encryptionKey),
        request: options.request,
      });
      const next = await this.persistSecrets(record, rotated.rotatedSecrets ?? currentSecrets, options.encryptionKey, {
        status: rotated.connection.status ?? 'active',
        scopes: rotated.connection.scopes ?? record.scopes,
        expiresAt: rotated.connection.expiresAt ?? record.expiresAt,
        lastRefreshedAt: nowIso(this.clock),
        metadata: rotated.connection.metadata ?? {},
      });
      return {
        connection: summaryView(next, rotated.rotatedSecrets ?? currentSecrets),
        refreshed: true,
        authorization: rotated.authorization,
        rotatedSecrets: rotated.rotatedSecrets ?? currentSecrets,
      };
    }

    throw new ConnectionLifecycleError('connection_rotation_unavailable', 'connection cannot be rotated without new secrets or provider support');
  }

  async requestAuthorizationUrl(request: ConnectionAuthorizationRequest): Promise<ConnectionAuthorizationResult> {
    const provider = this.providers.get(request.provider);
    const mergedScopes = dedupeScopes(request.requestedScopes, request.existingScopes ?? provider?.defaultScopes);
    const normalizedState = request.state ?? randomUUID();
    if (provider?.buildAuthorizationUrl) {
      const authorizationUrl = await provider.buildAuthorizationUrl({
        ...request,
        requestedScopes: mergedScopes,
        state: normalizedState,
      });
      return {
        provider: request.provider,
        accountId: request.accountId,
        authorizationUrl,
        state: normalizedState,
        requestedScopes: mergedScopes,
        mergedScopes,
      };
    }

    const baseUrl = request.authorizationUrl ?? provider?.authUrl;
    if (!baseUrl) {
      throw new ConnectionLifecycleError('authorization_url_unavailable', 'provider authorization url is not configured');
    }

    const url = new URL(baseUrl);
    url.searchParams.set('response_type', request.responseType ?? 'code');
    if (request.clientId ?? provider?.clientId) {
      url.searchParams.set('client_id', request.clientId ?? provider?.clientId ?? '');
    }
    if (request.redirectUri ?? provider?.redirectUri) {
      url.searchParams.set('redirect_uri', request.redirectUri ?? provider?.redirectUri ?? '');
    }
    url.searchParams.set('scope', mergedScopes.join(' '));
    url.searchParams.set('state', normalizedState);
    if ((request.prompt ?? '') || provider?.supportsMultipleAccounts === false) {
      url.searchParams.set('prompt', request.prompt ?? 'consent');
    }
    if (request.additionalParameters) {
      for (const [key, value] of Object.entries(request.additionalParameters)) {
        url.searchParams.set(key, value);
      }
    }
    return {
      provider: request.provider,
      accountId: request.accountId,
      authorizationUrl: url.toString(),
      state: normalizedState,
      requestedScopes: mergedScopes,
      mergedScopes,
    };
  }

  async findByProviderAndAccount(provider: string, accountId: string): Promise<ConnectionRecord | undefined> {
    if (this.storage instanceof SQLiteConnectionStore) {
      return await this.storage.findByProviderAndAccount(provider, accountId);
    }
    const records = await this.storage.list();
    return records.find((record) => record.provider === provider && record.accountId === accountId);
  }

  private registerProviders(providers?: ConnectionManagerOptions['providers']): void {
    if (!providers) {
      return;
    }
    if (Array.isArray(providers)) {
      for (const provider of providers) {
        this.registerProvider(provider);
      }
      return;
    }
    for (const provider of Object.values(providers)) {
      this.registerProvider(provider);
    }
  }

  private registerDefaultPermissions(): void {
    this.permissions.register({ subject: 'connections', action: 'list', scopes: ['read'], description: 'list active connections' });
    this.permissions.register({ subject: 'connections', action: 'request', scopes: ['admin'], description: 'request new permissions or auth URLs' });
    this.permissions.register({ subject: 'connections', action: 'rotate', scopes: ['write'], description: 'rotate secrets or reauthorize' });
    this.permissions.register({ subject: 'connections', action: 'refresh', scopes: ['write'], description: 'refresh expiring credentials' });
    this.permissions.register({ subject: 'connections', action: 'delete', scopes: ['admin'], description: 'delete stored connection' });
  }

  private requireProviderName(provider: string): string {
    const normalized = provider.trim();
    if (!normalized) {
      throw new ConnectionLifecycleError('provider_required', 'provider is required');
    }
    return normalized;
  }

  private resolveAccountId(input: ConnectionCreateInput, provider?: ConnectionProviderAdapter): string {
    return (input.accountId ?? input.secrets.accountEmail ?? input.secrets.tenantId ?? input.secrets.apiKey ?? randomUUID()).toString();
  }

  private initialStatus(expiresAt?: string): ConnectionStatus {
    if (!expiresAt) {
      return 'active';
    }
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry)) {
      return 'active';
    }
    return expiry <= this.clock.now() ? 'expired' : 'active';
  }

  private matchesQuery(record: ConnectionRecord, query: ConnectionQuery, statuses: ConnectionStatus[]): boolean {
    if (query.provider && record.provider !== query.provider) {
      return false;
    }
    if (query.accountId && record.accountId !== query.accountId) {
      return false;
    }
    if (query.label && record.label !== query.label) {
      return false;
    }
    if (statuses.length > 0 && !statuses.includes(record.status)) {
      return false;
    }
    if (!query.includeRevoked && record.status === 'revoked') {
      return false;
    }
    return true;
  }

  private async resolveRecord(selector: ConnectionSelector): Promise<ConnectionRecord | undefined> {
    if (typeof selector === 'string') {
      const byId = await this.storage.get(selector);
      if (byId) {
        return byId;
      }
    } else if (selector.connectionId) {
      const byId = await this.storage.get(selector.connectionId);
      if (byId) {
        return byId;
      }
    }

    const records = await this.storage.list();
    if (typeof selector !== 'string' && selector.provider) {
      const matches = records.filter((record) => record.provider === selector.provider && (!selector.accountId || record.accountId === selector.accountId) && (!selector.label || record.label === selector.label));
      if (matches.length > 1 && !selector.accountId && !selector.label) {
        throw new ConnectionLifecycleError('connection_ambiguous', 'multiple connections found for provider; specify accountId or label');
      }
      return matches[0];
    }
    return undefined;
  }

  private async resolveMasterKey(provider: string, accountId: string, override?: string): Promise<string | undefined> {
    if (override) {
      return override;
    }
    if (this.keyResolver) {
      const resolved = await this.keyResolver({ provider, accountId, encryptionKey: this.defaultEncryptionKey });
      if (resolved) {
        return resolved;
      }
    }
    return this.defaultEncryptionKey;
  }

  private async encryptSecrets(provider: string, accountId: string, secrets: ConnectionSecretMaterial, override?: string): Promise<ConnectionRecord['secretEnvelope']> {
    const masterKey = await this.resolveMasterKey(provider, accountId, override);
    return this.crypto.encrypt(secrets, masterKey);
  }

  private async decryptSecrets(record: ConnectionRecord, override?: string): Promise<ConnectionSecretMaterial> {
    const masterKey = await this.resolveMasterKey(record.provider, record.accountId, override);
    return this.crypto.decrypt(record.secretEnvelope, masterKey);
  }

  private async persistSecrets(record: ConnectionRecord, secrets: ConnectionSecretMaterial, override?: string, updates: Partial<ConnectionRecord> = {}): Promise<ConnectionRecord> {
    const next: ConnectionRecord = {
      ...record,
      ...updates,
      scopes: updates.scopes ? [...updates.scopes] : [...record.scopes],
      metadata: {
        ...record.metadata,
        ...(updates.metadata ?? {}),
      },
      secretEnvelope: await this.encryptSecrets(record.provider, record.accountId, secrets, override),
      updatedAt: updates.updatedAt ?? nowIso(this.clock),
    };
    await this.storage.upsert(next);
    return next;
  }

  private async persistRecord(record: ConnectionRecord, updates: Partial<ConnectionRecord>): Promise<ConnectionRecord> {
    const next: ConnectionRecord = {
      ...record,
      ...updates,
      scopes: updates.scopes ? [...updates.scopes] : [...record.scopes],
      metadata: {
        ...record.metadata,
        ...(updates.metadata ?? {}),
      },
      secretEnvelope: record.secretEnvelope,
      updatedAt: updates.updatedAt ?? nowIso(this.clock),
    };
    await this.storage.upsert(next);
    return next;
  }
}
