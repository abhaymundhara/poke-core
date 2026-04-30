import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';

export interface SkillAdapter {
  descriptor: SkillDescriptor;
  canHandle(step: PlanStep): boolean;
  execute(ctx: ExecutionContext): Promise<SkillResult>;
  compensate?(ctx: ExecutionContext): Promise<SkillResult>;
}
