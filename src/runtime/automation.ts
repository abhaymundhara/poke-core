import type { SqliteDurableStore, DurableRunRecord } from './durable.ts';

export type AutomationSpec =
  | { type: 'email'; condition: string; action: string; repeating: boolean }
  | { type: 'cron'; condition: string; action: string; repeating: boolean }
  | { type: 'datetime'; condition: string; action: string; repeating: boolean }
  | { type: 'webhook'; condition: string; action: string; repeating: boolean }
  | { type: 'ingest'; condition: string; action: string; repeating: boolean; ingestEndpointId: string; evaluationScriptPath?: string | null; triggersUntilStop?: number | null };

export type AutomationRunOutput = {
  triggerId: string;
  spec: AutomationSpec;
  endpointId?: string;
  raw: unknown;
};

export type AutomationToolset = {
  createTrigger(params: AutomationSpec): Promise<unknown>;
  manageIngestEndpoints(params: { action?: 'list' | 'create' | 'update'; name?: string; endpointId?: string; evaluationIntervalSeconds?: number; enableWebhookAuth?: boolean }): Promise<unknown>;
};

function parseToolPayload(result: unknown): unknown {
  const candidate = result as { content?: Array<{ text?: string; resource?: { text?: string } }> };
  const items = candidate?.content ?? [];
  for (const item of items) {
    const text = item.text ?? item.resource?.text;
    if (!text) continue;
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { /* ignore */ }
    }
  }
  return items.map((item) => item.text ?? item.resource?.text ?? '').filter(Boolean);
}

function unwrapToolResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'content' in result) return parseToolPayload(result);
  return result;
}

async function withRun<T>(store: JsonFileDurableStore<AutomationSpec, AutomationRunOutput>, kind: string, input: AutomationSpec, fn: (runId: string) => Promise<T>): Promise<{ run: DurableRunRecord<AutomationSpec, AutomationRunOutput>; output: T }> {
  const run = await store.create(kind, input);
  await store.checkpoint(run.id, 'start', { kind });
  try {
    const output = await fn(run.id);
    await store.checkpoint(run.id, 'complete', { kind });
    return { run: await store.complete(run.id, output as AutomationRunOutput), output };
  } catch (error) {
    await store.checkpoint(run.id, 'failed', { kind }, error instanceof Error ? error.message : String(error));
    await store.fail(run.id, error);
    throw error;
  }
}

function extractTriggerId(raw: Record<string, unknown>): string {
  return String(raw.triggerId ?? raw.id ?? raw.trigger_id ?? raw.trigger ?? '');
}

function extractEndpointId(raw: Record<string, unknown>): string {
  return String(raw.endpointId ?? raw.id ?? raw.endpoint_id ?? raw.ingestEndpointId ?? '');
}

function normalizeEndpointList(parsed: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => (typeof item === 'object' && item ? item as Record<string, unknown> : { value: item }));
}

export class AutomationRuntime {
  constructor(private deps: { tools: AutomationToolset; store: JsonFileDurableStore<AutomationSpec, AutomationRunOutput> }) {}

  async createEmailAutomation(condition: string, action: string, repeating = true) {
    const { run, output } = await withRun(this.deps.store, 'createEmailAutomation', { type: 'email', condition, action, repeating }, async () => {
      const parsed = unwrapToolResult(await this.deps.tools.createTrigger({ type: 'email', condition, action, repeating })) as Record<string, unknown>;
      return { triggerId: extractTriggerId(parsed), spec: { type: 'email', condition, action, repeating } as const, raw: parsed };
    });
    return { runId: run.id, triggerId: output.triggerId, raw: output.raw };
  }

  async createCronAutomation(condition: string, action: string, repeating = true) {
    const { run, output } = await withRun(this.deps.store, 'createCronAutomation', { type: 'cron', condition, action, repeating }, async () => {
      const parsed = unwrapToolResult(await this.deps.tools.createTrigger({ type: 'cron', condition, action, repeating })) as Record<string, unknown>;
      return { triggerId: extractTriggerId(parsed), spec: { type: 'cron', condition, action, repeating } as const, raw: parsed };
    });
    return { runId: run.id, triggerId: output.triggerId, raw: output.raw };
  }

  async createDatetimeAutomation(condition: string, action: string, repeating = false) {
    const { run, output } = await withRun(this.deps.store, 'createDatetimeAutomation', { type: 'datetime', condition, action, repeating }, async () => {
      const parsed = unwrapToolResult(await this.deps.tools.createTrigger({ type: 'datetime', condition, action, repeating })) as Record<string, unknown>;
      return { triggerId: extractTriggerId(parsed), spec: { type: 'datetime', condition, action, repeating } as const, raw: parsed };
    });
    return { runId: run.id, triggerId: output.triggerId, raw: output.raw };
  }

  async createWebhookAutomation(condition: string, action: string, repeating = true) {
    const { run, output } = await withRun(this.deps.store, 'createWebhookAutomation', { type: 'webhook', condition, action, repeating }, async () => {
      const parsed = unwrapToolResult(await this.deps.tools.createTrigger({ type: 'webhook', condition, action, repeating })) as Record<string, unknown>;
      return { triggerId: extractTriggerId(parsed), spec: { type: 'webhook', condition, action, repeating } as const, raw: parsed };
    });
    return { runId: run.id, triggerId: output.triggerId, raw: output.raw };
  }

  async resolveIngestEndpoint(input: { ingestEndpointId?: string; endpointName?: string; createIfMissing?: boolean }): Promise<{ endpointId: string; raw: unknown }> {
    if (input.ingestEndpointId) return { endpointId: input.ingestEndpointId, raw: { endpointId: input.ingestEndpointId } };
    const listed = unwrapToolResult(await this.deps.tools.manageIngestEndpoints({ action: 'list' }));
    const endpoints = normalizeEndpointList(listed);
    const byName = input.endpointName ? endpoints.find((row) => String(row.name ?? row.endpointName ?? row.label ?? '').toLowerCase() === input.endpointName?.toLowerCase()) : undefined;
    if (byName) return { endpointId: extractEndpointId(byName), raw: byName };
    if (input.createIfMissing && input.endpointName) {
      const created = unwrapToolResult(await this.deps.tools.manageIngestEndpoints({ action: 'create', name: input.endpointName })) as Record<string, unknown>;
      return { endpointId: extractEndpointId(created), raw: created };
    }
    throw new Error(`unable to resolve ingest endpoint${input.endpointName ? `: ${input.endpointName}` : ''}`);
  }

  async createIngestAutomation(input: { condition: string; action: string; ingestEndpointId?: string; endpointName?: string; createIfMissing?: boolean; evaluationScriptPath?: string | null; repeating?: boolean; triggersUntilStop?: number | null; }) {
    const resolved = await this.resolveIngestEndpoint({ ingestEndpointId: input.ingestEndpointId, endpointName: input.endpointName, createIfMissing: input.createIfMissing ?? false });
    const repeating = input.repeating ?? true;
    const spec: AutomationSpec = {
      type: 'ingest',
      condition: input.condition,
      action: input.action,
      repeating,
      ingestEndpointId: resolved.endpointId,
      evaluationScriptPath: input.evaluationScriptPath ?? null,
      triggersUntilStop: input.triggersUntilStop ?? (repeating ? null : 1),
    };
    const { run, output } = await withRun(this.deps.store, 'createIngestAutomation', spec, async () => {
      const parsed = unwrapToolResult(await this.deps.tools.createTrigger(spec)) as Record<string, unknown>;
      return { triggerId: extractTriggerId(parsed), endpointId: resolved.endpointId, spec, raw: parsed };
    });
    return { runId: run.id, triggerId: output.triggerId, endpointId: output.endpointId, raw: output.raw };
  }

  async recover(runId: string) {
    return await this.deps.store.resume(runId);
  }
}
