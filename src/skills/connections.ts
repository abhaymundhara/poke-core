import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { ConnectionManager, PermissionRegistry, type ConnectionAuthorizationRequest, type ConnectionQuery, type ConnectionRotationInput, type ConnectionScope, type ConnectionView } from '../connections/index.ts';
import type { SkillAdapter } from './types';

export type ConnectionSkillMode = 'list' | 'request' | 'rotate';

export type ConnectionSkillOptions = {
  manager?: ConnectionManager;
  permissions?: PermissionRegistry;
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toScopes(value: unknown, fallback: ConnectionScope[] = []): ConnectionScope[] {
  const scopes = asArray(value).map((item) => String(item).toLowerCase()).filter((item): item is ConnectionScope => item === 'read' || item === 'write' || item === 'admin');
  return Array.from(new Set([...scopes, ...fallback]));
}

function modeFromStep(step: PlanStep, args: Record<string, unknown>): ConnectionSkillMode {
  const raw = asText(args.mode || args.action || step.kind).toLowerCase();
  if (raw.includes('request')) {
    return 'request';
  }
  if (raw.includes('rotate')) {
    return 'rotate';
  }
  return 'list';
}

function viewSummary(connection: ConnectionView) {
  return {
    connectionId: connection.connectionId,
    provider: connection.provider,
    accountId: connection.accountId,
    label: connection.label,
    credentialKind: connection.credentialKind,
    authMode: connection.authMode,
    scopes: connection.scopes,
    status: connection.status,
    expiresAt: connection.expiresAt,
    lastRefreshedAt: connection.lastRefreshedAt,
    secretPresent: connection.secretPresent,
    metadata: connection.metadata,
  };
}

export class ConnectionSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'connections',
    domain: 'permission-and-connection-management',
    capabilities: ['list_connections', 'request_permissions', 'rotate_keys', 'refresh_credentials', 'multi_account_routing'],
    version: '1.0.0',
  };

  private readonly manager: ConnectionManager;
  private readonly permissions: PermissionRegistry;

  constructor(options: ConnectionSkillOptions = {}) {
    this.manager = options.manager ?? new ConnectionManager();
    this.permissions = options.permissions ?? this.manager.permissionRegistry;
  }

  canHandle(step: PlanStep): boolean {
    return step.skill === 'connections' || step.kind.startsWith('connection.');
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = asRecord(ctx.step.args);
    const mode = modeFromStep(ctx.step, args);
    const provider = asText(args.provider) || undefined;
    const accountId = asText(args.accountId) || undefined;
    const label = asText(args.label) || undefined;

    try {
      let output: Record<string, unknown>;

      if (mode === 'request') {
        this.permissions.ensure({ subject: 'connections', action: 'request', provider }, ['admin']);
        const request: ConnectionAuthorizationRequest = {
          provider: provider ?? this.requireValue('provider is required for permission requests'),
          accountId,
          requestedScopes: toScopes(args.scopes, toScopes(args.requestedScopes)),
          existingScopes: toScopes(args.existingScopes),
          authorizationUrl: asText(args.authorizationUrl) || undefined,
          clientId: asText(args.clientId) || undefined,
          redirectUri: asText(args.redirectUri) || undefined,
          state: asText(args.state) || undefined,
          responseType: asText(args.responseType) || undefined,
          prompt: asText(args.prompt) || undefined,
          additionalParameters: asRecord(args.additionalParameters) as Record<string, string>,
          metadata: asRecord(args.metadata),
        };
        const authorization = await this.manager.requestAuthorizationUrl(request);
        output = {
          mode,
          authorization,
        };
      } else if (mode === 'rotate') {
        this.permissions.ensure({ subject: 'connections', action: 'rotate', provider }, ['write']);
        const rotation: ConnectionRotationInput = {
          newSecrets: asRecord(args.newSecrets),
          reauthorize: Boolean(args.reauthorize ?? args.requestAuthorization),
          request: provider
            ? {
                provider,
                accountId,
                requestedScopes: toScopes(args.scopes, toScopes(args.requestedScopes)),
                existingScopes: toScopes(args.existingScopes),
                authorizationUrl: asText(args.authorizationUrl) || undefined,
                clientId: asText(args.clientId) || undefined,
                redirectUri: asText(args.redirectUri) || undefined,
                state: asText(args.state) || undefined,
                responseType: asText(args.responseType) || undefined,
                prompt: asText(args.prompt) || undefined,
                additionalParameters: asRecord(args.additionalParameters) as Record<string, string>,
                metadata: asRecord(args.metadata),
              }
            : undefined,
          encryptionKey: asText(args.encryptionKey) || undefined,
        };
        const connection = await this.resolveConnection(provider, accountId, label);
        const rotated = await this.manager.rotateConnection(connection?.connectionId ?? this.requireValue('connectionId or provider is required'), rotation);
        output = {
          mode,
          connection: viewSummary(rotated.connection),
          refreshed: rotated.refreshed,
          authorization: rotated.authorization,
        };
      } else {
        this.permissions.ensure({ subject: 'connections', action: 'list', provider }, ['read']);
        const query: ConnectionQuery = {
          provider,
          accountId,
          label,
          status: args.status as ConnectionQuery['status'],
          includeRevoked: Boolean(args.includeRevoked),
        };
        const connections = await this.manager.listConnections(query, Boolean(args.includeSecrets));
        output = {
          mode,
          activeCount: connections.filter((item) => item.status === 'active').length,
          connections: connections.map(viewSummary),
        };
      }

      ctx.state.artifacts[ctx.step.id] = { mode, output };
      ctx.state.outputs[ctx.step.id] = output;
      return {
        ok: true,
        output,
        retryable: false,
        note: mode === 'list' ? 'connections listed' : mode === 'request' ? 'authorization url generated' : 'connection rotated',
        trace: {
          skill: 'connections',
          mode,
          provider,
          accountId,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = {
        mode,
        provider,
        accountId,
        error: message,
      };
      ctx.state.artifacts[ctx.step.id] = failure;
      return {
        ok: false,
        output: failure,
        retryable: /temporar|timeout|rate limit|refresh/i.test(message.toLowerCase()),
        note: 'connections skill failed',
        trace: {
          skill: 'connections',
          mode,
          provider,
          accountId,
          error: message,
        },
      };
    }
  }

  private requireValue(message: string): never {
    throw new Error(message);
  }

  private async resolveConnection(provider?: string, accountId?: string, label?: string): Promise<ConnectionView | null> {
    if (!provider) {
      return null;
    }
    const connections = await this.manager.listConnections({ provider, accountId, label }, true);
    if (connections.length === 0) {
      return null;
    }
    if (connections.length > 1 && !accountId && !label) {
      throw new Error('multiple connections found; specify accountId or label');
    }
    return connections[0];
  }
}
