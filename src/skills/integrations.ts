import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

type IntegrationActionContext = {
  provider: string;
  action: string;
  payload: Record<string, unknown>;
};

interface IntegrationProviderAdapter {
  provider: string;
  actions: string[];
  execute(ctx: IntegrationActionContext): Promise<SkillResult>;
  compensate?(ctx: IntegrationActionContext): Promise<SkillResult>;
}

class GithubIntegrationAdapter implements IntegrationProviderAdapter {
  provider = 'github';
  actions = ['inspect', 'upsert_file', 'create_issue', 'comment'];

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    return {
      ok: true,
      output: { provider: this.provider, action: ctx.action, mode: 'dry-run', payload: ctx.payload },
      retryable: false,
      note: 'github action routed through the integration boundary',
      trace: { provider: this.provider, action: ctx.action },
    };
  }
}

class TodoistIntegrationAdapter implements IntegrationProviderAdapter {
  provider = 'todoist';
  actions = ['add_task', 'complete_task', 'list_tasks'];

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    return {
      ok: true,
      output: { provider: this.provider, action: ctx.action, mode: 'dry-run', payload: ctx.payload },
      retryable: false,
      note: 'todoist action accepted by the router',
      trace: { provider: this.provider, action: ctx.action },
    };
  }
}

class GenericIntegrationAdapter implements IntegrationProviderAdapter {
  constructor(public provider: string, public actions: string[] = ['inspect']) {}

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    return {
      ok: true,
      output: { provider: this.provider, action: ctx.action, mode: 'dry-run', payload: ctx.payload },
      retryable: false,
      note: `${this.provider} routed through generic integration adapter`,
      trace: { provider: this.provider, action: ctx.action },
    };
  }
}

class IntegrationRegistry {
  private adapters = new Map<string, IntegrationProviderAdapter>();

  constructor() {
    this.register(new GithubIntegrationAdapter());
    this.register(new TodoistIntegrationAdapter());
    this.register(new GenericIntegrationAdapter('linear', ['inspect', 'update_issue']));
    this.register(new GenericIntegrationAdapter('notion', ['inspect', 'append', 'create_page']));
    this.register(new GenericIntegrationAdapter('vercel', ['inspect', 'deploy']));
    this.register(new GenericIntegrationAdapter('slack', ['inspect', 'post_message']));
  }

  register(adapter: IntegrationProviderAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  resolve(provider: string): IntegrationProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`unsupported integration provider: ${provider}`);
    return adapter;
  }
}

export class IntegrationSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'integration',
    domain: 'external-integrations',
    capabilities: ['github', 'todoist', 'linear', 'notion', 'vercel', 'slack'],
    version: '1.0.0',
  };

  private registry = new IntegrationRegistry();

  canHandle(step: PlanStep): boolean {
    return step.skill === 'integration';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const provider = String(ctx.step.args.provider ?? 'github');
    const action = String(ctx.step.args.action ?? 'inspect');
    const payload = (ctx.step.args.payload ?? {}) as Record<string, unknown>;
    const adapter = this.registry.resolve(provider);
    if (!adapter.actions.includes(action)) throw new Error(`unsupported action ${action} for provider ${provider}`);
    return await adapter.execute({ provider, action, payload });
  }

  async compensate(ctx: ExecutionContext): Promise<SkillResult> {
    const provider = String(ctx.step.args.provider ?? 'github');
    const action = String(ctx.step.args.action ?? 'inspect');
    const payload = (ctx.step.args.payload ?? {}) as Record<string, unknown>;
    const adapter = this.registry.resolve(provider);
    if (!adapter.compensate) return { ok: true, output: { provider, action, compensated: false }, retryable: false, note: 'no compensation hook registered' };
    return await adapter.compensate({ provider, action, payload });
  }
}
