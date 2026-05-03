import { createTrigger } from '../../../../poke/triggers/create_trigger.ts';
import { manageIngestEndpoints } from '../../../../poke/data/manage_ingest_endpoints.ts';
import { AutomationRuntime } from '../runtime/automation.ts';
import { runtimeServices } from '../runtime/services.ts';
import { SqliteDurableStore } from '../runtime/durable.ts';

function createToolset() {
  return {
    createTrigger: async (params: Parameters<typeof createTrigger>[0]) => await createTrigger(params),
    manageIngestEndpoints: async (params: Parameters<typeof manageIngestEndpoints>[0]) => await manageIngestEndpoints(params),
  };
}

export function createPokeAutomationRuntime(tenantId = runtimeServices.tenantId, contextId = runtimeServices.contextId) {
  return new AutomationRuntime({
    tools: createToolset(),
    store: new SqliteDurableStore(tenantId, contextId),
  });
}

export function createAutomationToolset() {
  return createToolset();
}
