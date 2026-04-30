import type { PlanStep } from './types';
import type { SkillAdapter } from './skills/types';

export class SkillRouter {
  constructor(private skills: SkillAdapter[]) {}

  resolve(step: PlanStep): SkillAdapter {
    const skill = this.skills.find((entry) => entry.canHandle(step));
    if (!skill) throw new Error(`no skill available for step kind ${step.kind}`);
    return skill;
  }
}
