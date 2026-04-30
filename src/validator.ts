import type { PlanStep } from './types';

export type ValidationDecision = {
  ok: boolean;
  score: number;
  reasons: string[];
};

export function validatePlan(steps: PlanStep[]): ValidationDecision {
  const reasons: string[] = [];
  if (steps.length === 0) reasons.push('plan must contain at least one step');
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) reasons.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.skill) reasons.push(`missing skill for step: ${step.id}`);
    if (!step.title) reasons.push(`missing title for step: ${step.id}`);
  }
  return { ok: reasons.length === 0, score: reasons.length === 0 ? 1 : Math.max(0, 1 - reasons.length * 0.2), reasons };
}

export function validateExecution(input: { output: unknown; note?: string | null; passed: boolean }): ValidationDecision {
  const reasons: string[] = [];
  if (!input.passed) reasons.push(input.note ?? 'execution failed verification');
  if (input.output === null || input.output === undefined) reasons.push('missing output');
  return { ok: reasons.length === 0, score: reasons.length === 0 ? 1 : 0.4, reasons };
}
