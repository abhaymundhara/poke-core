export * from './planner-intelligence';
import { buildPlan as buildPlannerPlan } from './planner-intelligence';
import type { TaskInput, TaskPlan } from './types';

export function buildPlan(input: TaskInput): TaskPlan {
  return buildPlannerPlan(input);
}
