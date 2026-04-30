import { randomUUID } from 'node:crypto';
import type { PlanStep, TaskPlan, TaskInput } from './types';

function hasUrl(text: string): string | null {
  const match = text.match(/(?:https?|file):\/\/\S+/i);
  return match?.[0] ?? null;
}

export function buildPlan(input: TaskInput): TaskPlan {
  const objective = input.objective.trim();
  const url = hasUrl(objective) ?? (typeof input.context?.url === 'string' ? String(input.context.url) : null);
  const steps: PlanStep[] = [];

  if (url) {
    steps.push({
      id: randomUUID(),
      kind: 'browser.navigate',
      title: 'navigate to target url',
      skill: 'browser',
      args: { url },
    });
    steps.push({
      id: randomUUID(),
      kind: 'browser.extract',
      title: 'extract readable page text',
      skill: 'browser',
      args: { selector: 'body' },
      dependsOn: [steps[0].id],
    });
  } else {
    steps.push({
      id: randomUUID(),
      kind: 'verify',
      title: 'confirm request is structurally valid',
      skill: 'browser',
      args: { objective },
    });
  }

  return { taskId: input.id, objective, steps };
}
