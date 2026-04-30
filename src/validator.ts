import type { PlanStep, SkillResult, ValidationDecision } from './types';

export function validatePlan(steps: PlanStep[]): ValidationDecision {
  const reasons: string[] = [];
  const seen = new Set<string>();
  if (steps.length === 0) reasons.push('plan must contain at least one step');
  for (const step of steps) {
    if (seen.has(step.id)) reasons.push(`duplicate step id: ${step.id}`);
    seen.add(step.id);
    if (!step.title.trim()) reasons.push(`missing title for step: ${step.id}`);
    if (!step.skill.trim()) reasons.push(`missing skill for step: ${step.id}`);
    if (step.retryPolicy.maxAttempts < 1) reasons.push(`invalid retry policy for step: ${step.id}`);
  }
  return { ok: reasons.length === 0, score: reasons.length === 0 ? 1 : Math.max(0, 1 - reasons.length * 0.15), reasons };
}

export function validateSkillResult(result: SkillResult): ValidationDecision {
  const reasons: string[] = [];
  if (!result.ok) reasons.push(result.note ?? 'skill returned a non-ok result');
  if (result.output === undefined) reasons.push('skill output is undefined');
  return { ok: reasons.length === 0, score: reasons.length === 0 ? 1 : 0.35, reasons };
}
