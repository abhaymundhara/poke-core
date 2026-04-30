import type { PlanStep, JuryDecision } from './types';

export function juryReviewPlan(steps: PlanStep[]): JuryDecision {
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

export function juryReviewExecution(input: { output: unknown; note?: string | null; passed: boolean }): JuryDecision {
  const reasons: string[] = [];
  if (!input.passed) reasons.push(input.note ?? 'execution failed verification');
  if (input.output === null || input.output === undefined) reasons.push('missing output');
  return { ok: reasons.length === 0, score: reasons.length === 0 ? 1 : 0.4, reasons };
}
