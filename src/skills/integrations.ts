import type { SkillAdapter, SkillContext, SkillExecution } from './types';

export class IntegrationSkill implements SkillAdapter {
  name = 'integrations';

  canHandle(step: SkillContext['step']): boolean {
    return step.kind === 'integration.call';
  }

  async execute(ctx: SkillContext): Promise<SkillExecution> {
    return {
      output: {
        integration: String(ctx.step.args.integration ?? 'unknown'),
        action: String(ctx.step.args.action ?? 'noop'),
        accepted: true,
      },
      verified: true,
      note: 'integration boundary acknowledged',
    };
  }
}
