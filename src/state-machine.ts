import type { TaskStatus, TransitionKind } from './types';

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  draft: ['planning', 'failed'],
  planning: ['routing', 'failed'],
  routing: ['executing', 'recovering', 'failed'],
  executing: ['routing', 'recovering', 'failed', 'rolled_back', 'completed'],
  recovering: ['routing', 'failed', 'rolled_back'],
  completed: [],
  failed: ['rolled_back'],
  rolled_back: [],
};

export function transition(from: TaskStatus, to: TaskStatus): { ok: boolean; reason?: string } {
  if (ALLOWED[from].includes(to)) return { ok: true };
  return { ok: false, reason: `invalid transition: ${from} -> ${to}` };
}

export function classifyTransition(from: TaskStatus, to: TaskStatus): TransitionKind {
  if (to === 'planning') return 'plan';
  if (to === 'routing') return 'route';
  if (to === 'executing') return 'execute';
  if (to === 'recovering') return 'recover';
  if (to === 'completed') return 'complete';
  if (to === 'rolled_back') return 'rollback';
  return from === to ? 'validate' : 'fail';
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'rolled_back';
}
