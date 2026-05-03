import type { TimeProvider } from '../types';

export type PermissionScope = 'read' | 'write' | 'admin';
export type ConnectionCredentialKind = 'oauth' | 'api_key' | 'service_account' | 'session';
export type ConnectionStatus = 'active' | 'pending_refresh' | 'expired' | 'revoked' | 'error';
export type ConnectionAuthMode = 'oauth' | 'api_key' | 'service_account';

export type ConnectionSecretMaterial = {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  clientSecret?: string;
  tokenType?: string;
  expiresAt?: string;
  tenantId?: string;
  accountEmail?: string;
  serviceAccount?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type EncryptedSecretEnvelope = {
  algorithm: 'aes-256-gcm';
  keyId: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
};

export type ConnectionRecord = {
  connectionId: string;
  provider: string;
  accountId: string;
  label?: string;
  credentialKind: ConnectionCredentialKind;
  authMode: ConnectionAuthMode;
  scopes: PermissionScope[];
  status: ConnectionStatus;
  metadata: Record<string, unknown>;
  secretEnvelope: EncryptedSecretEnvelope;
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  expiresAt?: string;
  ownerId?: string;
  providerAccountHint?: string;
};

export type ConnectionView = Omit<ConnectionRecord, 'secretEnvelope'> & {
  secretPresent: boolean;
  secrets?: ConnectionSecretMaterial;
};

export type ConnectionSelector =
  | string
  | {
      connectionId?: string;
      provider?: string;
      accountId?: string;
      label?: string;
    };

export type ConnectionQuery = {
  provider?: string;
  accountId?: string;
  label?: string;
  status?: ConnectionStatus | ConnectionStatus[];
  includeRevoked?: boolean;
};

export type ConnectionCreateInput = {
  provider: string;
  accountId?: string;
  label?: string;
  credentialKind: ConnectionCredentialKind;
  authMode?: ConnectionAuthMode;
  scopes?: PermissionScope[];
  secrets: ConnectionSecretMaterial;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  ownerId?: string;
  providerAccountHint?: string;
  encryptionKey?: string;
  allowReplace?: boolean;
};

export type ConnectionRefreshInput = {
  refreshWindowMs?: number;
  force?: boolean;
  newSecrets?: ConnectionSecretMaterial;
  encryptionKey?: string;
};

export type ConnectionDeleteResult = {
  deleted: boolean;
  connection?: ConnectionView;
};

export type ConnectionAuthorizationRequest = {
  provider: string;
  accountId?: string;
  requestedScopes: PermissionScope[];
  existingScopes?: PermissionScope[];
  authorizationUrl?: string;
  clientId?: string;
  redirectUri?: string;
  state?: string;
  responseType?: string;
  prompt?: string;
  additionalParameters?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type ConnectionAuthorizationResult = {
  provider: string;
  accountId?: string;
  authorizationUrl: string;
  state: string;
  requestedScopes: PermissionScope[];
  mergedScopes: PermissionScope[];
};

export type ConnectionRefreshResult = {
  connection: ConnectionView;
  refreshed: boolean;
  renewedSecrets?: ConnectionSecretMaterial;
};

export type ConnectionRotationInput = {
  newSecrets?: ConnectionSecretMaterial;
  reauthorize?: boolean;
  request?: ConnectionAuthorizationRequest;
  encryptionKey?: string;
};

export type ConnectionRotationResult = {
  connection: ConnectionView;
  refreshed: boolean;
  authorization?: ConnectionAuthorizationResult;
  rotatedSecrets?: ConnectionSecretMaterial;
};

export type PermissionRule = {
  subject: string;
  action?: string;
  provider?: string;
  scopes: PermissionScope[];
  description?: string;
};

export type PermissionSubject = {
  subject: string;
  action?: string;
  provider?: string;
};

export type PermissionDecision = {
  allowed: boolean;
  requiredScopes: PermissionScope[];
  grantedScopes: PermissionScope[];
  missingScopes: PermissionScope[];
  rule?: PermissionRule;
};

export interface ConnectionStore {
  list(): Promise<ConnectionRecord[]>;
  get(connectionId: string): Promise<ConnectionRecord | undefined>;
  upsert(record: ConnectionRecord): Promise<void>;
  delete(connectionId: string): Promise<boolean>;
}

export type ConnectionProviderAdapter = {
  provider: string;
  displayName?: string;
  authUrl?: string;
  clientId?: string;
  redirectUri?: string;
  defaultScopes?: PermissionScope[];
  supportsMultipleAccounts?: boolean;
  buildAuthorizationUrl?(request: ConnectionAuthorizationRequest): string | Promise<string>;
  refreshConnection?(request: {
    connection: ConnectionView;
    secrets: ConnectionSecretMaterial;
    encryptionKey?: string;
    requestedScopes: PermissionScope[];
    refreshWindowMs: number;
  }): Promise<ConnectionRefreshResult> | ConnectionRefreshResult;
  rotateConnection?(request: {
    connection: ConnectionView;
    secrets: ConnectionSecretMaterial;
    encryptionKey?: string;
    request?: ConnectionAuthorizationRequest;
  }): Promise<ConnectionRotationResult> | ConnectionRotationResult;
};

export type ConnectionManagerOptions = {
  storage?: ConnectionStore;
  providers?: ConnectionProviderAdapter[] | Record<string, ConnectionProviderAdapter>;
  permissions?: PermissionRule[];
  encryptionKey?: string;
  keyResolver?: (params: { provider: string; accountId: string; encryptionKey?: string }) => string | Promise<string>;
  clock?: TimeProvider;
  autoRefreshWindowMs?: number;
};
