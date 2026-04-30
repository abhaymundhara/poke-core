import type { PlanStep } from '../types';

export type SkillExecution = {
  output: unknown;
  note?: string;
  verified: boolean;
};

export type SkillContext = {
  taskId: string;
  step: PlanStep;
  state: Record<string, unknown>;
};

export interface SkillAdapter {
  name: string;
  canHandle(step: PlanStep): boolean;
  execute(ctx: SkillContext): Promise<SkillExecution>;
}
