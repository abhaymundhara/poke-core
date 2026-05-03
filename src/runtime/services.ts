import { BridgeRegistry } from '../bridge/registry.ts';
import { ConnectionManager } from '../connections/manager.ts';
import type { PermissionRegistry, PermissionScope } from '../connections/types.ts';
import { EventBus } from '../events/index.ts';
import { createHighPrecisionClock } from './context.ts';
import type { TimeProvider } from '../types';

type RuntimeServiceScope = {
  tenantId?: string;
  contextId?: string;
};

export type RuntimeServices = {
  eventBus: EventBus;
  bridgeRegistry: BridgeRegistry;
  connectionManager: ConnectionManager;
  permissionRegistry: PermissionRegistry;
  clock: TimeProvider;
  tenantId: string;
  contextId: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __pokeCoreRuntimeServices__: RuntimeServices | undefined;
}

const INTEGRATION_PROVIDERS = ['github', 'todoist', 'linear', 'notion', 'vercel'] as const;

export function integrationPermissionScope(action: string): PermissionScope {
  const normalized = action.trim().toLowerCase();
  return normalized === 'inspect' || normalized.startsWith('list_') || normalized.startsWith('get_') || normalized.startsWith('query_') || normalized.startsWith('search_') || normalized.startsWith('fetch_') || normalized.startsWith('read_') ? 'read' : 'write';
}

function registerIntegrationPermissions(registry: PermissionRegistry): void {
  for (const provider of INTEGRATION_PROVIDERS) {
    registry.register({ subject: 'integration', action: 'read', provider, scopes: ['read'], description: provider + ' integration read access' });
    registry.register({ subject: 'integration', action: 'write', provider, scopes: ['write'], description: provider + ' integration write access' });
  }
}

function createRuntimeServices(options: RuntimeServiceScope = {}): RuntimeServices {
  const clock = createHighPrecisionClock();
  const tenantId = options.tenantId ?? process.env.POKE_CORE_TENANT_ID ?? 'global';
  const contextId = options.contextId ?? process.env.POKE_CORE_CONTEXT_ID ?? 'global';
  const eventBus = new EventBus({ clock, tenantId, contextId });
  const connectionManager = new ConnectionManager({ clock, tenantId, contextId });
  const permissionRegistry = connectionManager.permissionRegistry;
  registerIntegrationPermissions(permissionRegistry);
  const bridgeRegistry = new BridgeRegistry({ eventBus });
  return { eventBus, bridgeRegistry, connectionManager, permissionRegistry, clock, tenantId, contextId };
}

export function getRuntimeServices(): RuntimeServices {
  globalThis.__pokeCoreRuntimeServices__ ??= createRuntimeServices();
  return globalThis.__pokeCoreRuntimeServices__;
}

export const runtimeServices = getRuntimeServices();
export const eventBus = runtimeServices.eventBus;
export const bridgeRegistry = runtimeServices.bridgeRegistry;
export const connectionManager = runtimeServices.connectionManager;
export const permissionRegistry = runtimeServices.permissionRegistry;
export const clock = runtimeServices.clock;
