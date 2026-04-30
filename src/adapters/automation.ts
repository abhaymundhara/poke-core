import { createTrigger } from '../../../../poke/triggers/create_trigger.ts';
import { manageIngestEndpoints } from '../../../../poke/data/manage_ingest_endpoints.ts';
import { AutomationRuntime } from '../runtime/automation.ts';
import { JsonFileDurableStore } from '../runtime/durable.ts';

function createToolset() {
  return {
    createTrigger: async (params: Parameters<typeof createTrigger>[0]) => await createTrigger(params),
    manageIngestEndpoints: async (params: Parameters<typeof manageIngestEndpoints>[0]) => await manageIngestEndpoints(params),
  };
}

export function createPokeAutomationRuntime(stateDir = '.poke-core/automation-runs') {
  return new AutomationRuntime({
    tools: createToolset(),
    store: new JsonFileDurableStore(stateDir),
  });
}

export function createAutomationToolset() {
  return createToolset();
}
