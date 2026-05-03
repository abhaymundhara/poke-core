import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { ComputerRuntime, type ComputerInteractionStep, type ComputerRuntimeOptions } from '../runtime/computer';
import type { SkillAdapter } from './types';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function point(value: unknown): { x: number; y: number } | undefined {
  const input = record(value);
  const x = num(input.x);
  const y = num(input.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

function normalizeAction(action: unknown): ComputerInteractionStep | null {
  if (!record(action)) return null;
  const type = text(action.action).toLowerCase();
  if (type === 'mouse_move') {
    const p = point(action);
    return p ? { action: 'mouse_move', ...p, durationMs: num(action.durationMs), label: text(action.label) || undefined } : null;
  }
  if (type === 'mouse_click') {
    const p = point(action);
    if (!p) return null;
    const button = text(action.button);
    return {
      action: 'mouse_click',
      ...p,
      button: button === 'right' || button === 'middle' ? button : 'left',
      clicks: num(action.clicks),
      doubleClick: bool(action.doubleClick),
      label: text(action.label) || undefined,
    };
  }
  if (type === 'keyboard_type') {
    return {
      action: 'keyboard_type',
      text: text(action.text),
      delayMs: num(action.delayMs),
      pressEnter: bool(action.pressEnter),
      label: text(action.label) || undefined,
    };
  }
  if (type === 'keyboard_press') {
    return {
      action: 'keyboard_press',
      keys: Array.isArray(action.keys) ? action.keys.map(text).filter(Boolean) : text(action.keys),
      label: text(action.label) || undefined,
    };
  }
  if (type === 'screenshot') {
    return { action: 'screenshot', label: text(action.label) || undefined };
  }
  return null;
}

function readInteractionPlan(args: Record<string, unknown>): ComputerInteractionStep[] {
  const plan = array(args.interactionPlan).map(normalizeAction).filter((value): value is ComputerInteractionStep => Boolean(value));
  if (plan.length > 0) return plan;
  const action = normalizeAction(args);
  return action ? [action] : [];
}

function buildRuntimeOptions(args: Record<string, unknown>): ComputerRuntimeOptions {
  const viewport = record(args.viewport);
  const screen = record(args.screen);
  const pointer = point(args.pointerOffset);
  return {
    sessionKey: text(args.sessionKey) || undefined,
    viewport: num(viewport.width) && num(viewport.height) ? { width: num(viewport.width)!, height: num(viewport.height)! } : undefined,
    screen: num(screen.width) && num(screen.height)
      ? {
          width: num(screen.width)!,
          height: num(screen.height)!,
          scaleFactor: num(screen.scaleFactor),
          devicePixelRatio: num(screen.devicePixelRatio),
        }
      : undefined,
    pointerOffset: pointer,
    scaleFactor: num(args.scaleFactor),
    screenshotRoot: text(args.screenshotRoot) || undefined,
    focusStrategy: text(args.focusStrategy) === 'require-focus' ? 'require-focus' : 'best-effort',
    retryCount: num(args.retryCount) ?? num(args.retries),
    backoffMs: num(args.backoffMs),
    driverCommand: text(args.driverCommand) || undefined,
    driverArgs: array(args.driverArgs).map((entry) => text(entry)).filter(Boolean),
  };
}

function summarizeActions(actions: ComputerInteractionStep[]): string {
  if (actions.length === 0) return 'no computer actions executed';
  return `executed ${actions.length} computer action${actions.length === 1 ? '' : 's'}`;
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|closed|focus|retry|stale|unavailable|blocked/i.test(message);
}

export class ComputerSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'computer',
    domain: 'desktop-interaction',
    capabilities: ['mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'screenshot_capture'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'computer' || step.skill === 'computer-use' || step.kind.startsWith('computer.') || step.kind === 'computer-use.vision';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = record(ctx.step.args);
    const runtime = new ComputerRuntime(buildRuntimeOptions(args));
    const actions = readInteractionPlan(args);
    const captureOnly = bool(args.captureOnly) || bool(args.screenshotOnly);

    try {
      let planResult: Awaited<ReturnType<ComputerRuntime['runInteractionPlan']>> | null = null;
      let captureResult: Awaited<ReturnType<ComputerRuntime['captureScreenshot']>> | null = null;

      if (actions.length > 0) {
        planResult = await runtime.runInteractionPlan(actions);
      } else if (captureOnly) {
        captureResult = await runtime.captureScreenshot({ label: text(args.label) || 'capture-only' });
      }

      const metrics = planResult?.metrics ?? (captureResult?.screenshot ? { width: captureResult.screenshot.width, height: captureResult.screenshot.height } : undefined);
      const screenshots = planResult?.screenshots ?? (captureResult?.screenshot ? [captureResult.screenshot] : []);
      const finalScreenshot = planResult?.finalScreenshot ?? captureResult?.screenshot ?? null;
      const actionRecords = planResult?.actions ?? (captureResult ? [captureResult] : []);
      const output = {
        sessionKey: text(args.sessionKey) || ctx.taskId,
        driver: planResult?.driver ?? 'screenshot-only',
        metrics,
        actions: actionRecords,
        screenshots,
        finalScreenshot,
        actionCount: actionRecords.length,
      };
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;
      return {
        ok: true,
        output,
        retryable: false,
        note: summarizeActions(actions),
        trace: {
          driver: planResult?.driver ?? 'screenshot-only',
          actionCount: actionRecords.length,
          screenshotCount: screenshots.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = {
        sessionKey: text(args.sessionKey) || ctx.taskId,
        error: message,
      };
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;
      return {
        ok: false,
        output,
        retryable: isRetryableError(error),
        note: 'computer runtime failed',
        trace: { error: message },
      };
    }
  }
}
