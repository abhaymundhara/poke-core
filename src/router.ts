import type { PlanStep, SkillDescriptor } from './types';
import type { SkillAdapter } from './skills/types';

export class SkillRouter {
  private skills = new Map<string, SkillAdapter>();

  constructor(skills: SkillAdapter[]) {
    for (const skill of skills) this.register(skill);
  }

  register(skill: SkillAdapter) {
    this.skills.set(skill.descriptor.name, skill);
  }

  descriptors(): SkillDescriptor[] {
    return [...this.skills.values()].map((skill) => skill.descriptor);
  }

  resolve(step: PlanStep): SkillAdapter {
    const exact = this.skills.get(step.skill);
    if (exact && exact.canHandle(step)) return exact;
    throw new Error(`no skill available for step kind=${step.kind} skill=${step.skill}`);
  }
}
