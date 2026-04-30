import { randomUUID } from 'node:crypto';
import type { PlanStep, TaskInput, TaskPlan } from './types';

function hasUrl(text: string): string | null {
  const match = text.match(/(?:https?|file):\/\/\S+/i);
  return match?.[0] ?? null;
}

export function buildPlan(input: TaskInput): TaskPlan {
  const objective = input.objective.trim();
  const url = hasUrl(objective) ?? (typeof input.context?.url === 'string' ? String(input.context.url) : null);
  const provider = typeof input.context?.provider === 'string' ? String(input.context.provider) : 'github';
  const action = typeof input.context?.action === 'string' ? String(input.context.action) : 'inspect';

  const steps: PlanStep[] = [];
  if (url) {
    steps.push({
      id: randomUUID(),
      position: 0,
      kind: 'browser.navigate',
      title: 'navigate to target url',
      skill: 'browser',
      args: { url },
      retryPolicy: { maxAttempts: 2, retryableKinds: ['network', 'transient'] },
    });
    steps.push({
      id: randomUUID(),
      position: 1,
      kind: 'browser.extract',
      title: 'extract readable page text',
      skill: 'browser',
      args: { selector: 'body' },
      dependsOn: [steps[0].id],
      retryPolicy: { maxAttempts: 1, retryableKinds: [] },
    });
  } else if (provider || action) {
    steps.push({
      id: randomUUID(),
      position: 0,
      kind: 'integration.call',
      title: `${provider} ${action}`,
      skill: 'integration',
      args: { provider, action, payload: input.context?.payload ?? {} },
      retryPolicy: { maxAttempts: 2, retryableKinds: ['rate_limit', 'temporary_unavailable'] },
    });
  } else {
    steps.push({
      id: randomUUID(),
      position: 0,
      kind: 'verify',
      title: 'validate objective shape',
      skill: 'browser',
      args: { objective },
      retryPolicy: { maxAttempts: 1, retryableKinds: [] },
    });
  }

  return { taskId: input.id, objective, steps };
}
