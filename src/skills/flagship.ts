import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';
import { buildAutopilotCycle } from '../autopilot/engine';

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function readObjective(ctx: ExecutionContext): string {
  return normalizeText(ctx.step.args.objective) || ctx.state.objective;
}

function readContext(ctx: ExecutionContext): Record<string, unknown> {
  const context = ctx.step.args.context;
  return context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
}

function collectSignals(haystack: string, tokens: string[]): string[] {
  const lower = haystack.toLowerCase();
  return [...new Set(tokens.filter((token) => lower.includes(token.toLowerCase())))];
}

function recordArtifact(ctx: ExecutionContext, payload: unknown): void {
  ctx.state.artifacts[ctx.step.id] = payload;
}

function result(note: string, output: unknown, trace: Record<string, unknown>): SkillResult {
  return { ok: true, output, retryable: false, note, trace };
}

export class AutopilotSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'autopilot',
    domain: 'cognitive-orchestration',
    capabilities: ['planning', 'delegation', 'checkpointing', 'proactivity'],
    version: '1.1.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'autopilot';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const harnessState = (ctx.step.args.harnessState && typeof ctx.step.args.harnessState === 'object' && !Array.isArray(ctx.step.args.harnessState))
      ? (ctx.step.args.harnessState as Record<string, unknown>)
      : (ctx.state.artifacts.harnessState && typeof ctx.state.artifacts.harnessState === 'object' && !Array.isArray(ctx.state.artifacts.harnessState)
        ? (ctx.state.artifacts.harnessState as Record<string, unknown>)
        : {});
    const cycle = buildAutopilotCycle(objective, harnessState, { ...context, hint: ctx.step.args.hint });
    const output = {
      objective,
      mode: 'proactivity',
      cycle,
      guardrails: ['keep side effects explicit', 'prefer deterministic steps', 'preserve recovery history'],
    };
    recordArtifact(ctx, output);
    return result('autopilot cycle generated from harness state', output, { priorities: cycle.priorities, triggerCount: cycle.backgroundTriggers.length });
  }
}

export class UserModelingSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'user-modeling',
    domain: 'user-context',
    capabilities: ['preference extraction', 'tone detection', 'profile shaping'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'user-modeling';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const joinedContext = Object.entries(context)
      .map(([key, value]) => `${key}:${normalizeText(value)}`)
      .join(' ');
    const signals = collectSignals(`${objective} ${joinedContext}`, ['preference', 'preferences', 'tone', 'style', 'persona', 'profile', 'timezone', 'locale', 'channel', 'formal', 'casual', 'brief', 'detailed']);
    const output = {
      objective,
      profile: {
        contextKeys: Object.keys(context).slice(0, 8),
        preferenceHints: signals,
        preferredTone: signals.includes('formal') ? 'formal' : signals.includes('casual') ? 'casual' : 'unspecified',
      },
      confidence: signals.length ? 0.78 : 0.45,
      nextAction: 'use the profile to constrain downstream steps',
    };
    recordArtifact(ctx, output);
    return result('user model inferred from context', output, { signals });
  }
}

export class GroundingSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'grounding',
    domain: 'evidence-management',
    capabilities: ['claim tracing', 'evidence pairing', 'assumption tagging'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'grounding';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const claims = Array.isArray(ctx.step.args.claims)
      ? ctx.step.args.claims.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['claim', 'fact', 'source', 'citation', 'evidence', 'assumption', 'grounding']);
    const evidence = Array.isArray(ctx.step.args.evidence)
      ? ctx.step.args.evidence.map(normalizeText).filter(Boolean)
      : Object.keys(ctx.state.outputs).slice(-5);
    const assumptions = collectSignals(`${objective} ${JSON.stringify(context)}`, ['assume', 'assumption', 'likely', 'maybe', 'probably', 'uncertain']);
    const confidence = Math.min(0.95, 0.45 + evidence.length * 0.12 + (claims.length > 0 ? 0.08 : 0));
    const output = {
      objective,
      groundedFacts: claims,
      evidence,
      assumptions,
      confidence,
    };
    recordArtifact(ctx, output);
    return result('grounding pass completed', output, { evidenceCount: evidence.length, claims });
  }
}

export class SignalObservationSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'signal-observation',
    domain: 'telemetry-analysis',
    capabilities: ['trend detection', 'anomaly detection', 'signal summarization'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'signal-observation';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const signals = Array.isArray(ctx.step.args.signals)
      ? ctx.step.args.signals.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['signal', 'signals', 'observe', 'observation', 'monitor', 'telemetry', 'trend', 'anomaly', 'spike', 'drop', 'pattern']);
    const observationWindow = normalizeText(ctx.step.args.window) || 'latest task context';
    const output = {
      objective,
      observationWindow,
      signals,
      notableChanges: Object.keys(ctx.state.outputs).slice(-3),
      trend: signals.some((signal) => /anomal/i.test(signal)) ? 'watch anomalies' : signals.some((signal) => /trend|spike|drop/i.test(signal)) ? 'scan for movement' : 'steady scan',
    };
    recordArtifact(ctx, output);
    return result('signal observation completed', output, { observationWindow, signals });
  }
}

type VisionBox = { x: number; y: number; width: number; height: number };
type VisionTarget = { selector?: string; text?: string; box?: VisionBox; action?: string; clickable?: boolean };

function isVisionBox(value: unknown): value is VisionBox {
  return typeof value === 'object' && value !== null && ['x', 'y', 'width', 'height'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number');
}

function extractVisionTargets(domSnapshot: unknown): VisionTarget[] {
  if (!Array.isArray(domSnapshot)) return [];
  return domSnapshot
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const box = isVisionBox(record.box) ? record.box : isVisionBox(record.bounds) ? record.bounds : undefined;
      return {
        selector: typeof record.selector === 'string' ? record.selector : undefined,
        text: typeof record.text === 'string' ? record.text : undefined,
        box,
        clickable: typeof record.clickable === 'boolean' ? record.clickable : undefined,
      } satisfies VisionTarget;
    })
    .filter((value): value is VisionTarget => Boolean(value))
    .filter((entry) => entry.clickable !== false)
    .slice(0, 12);
}

export class ComputerUseSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'computer-use',
    domain: 'desktop-interaction',
    capabilities: ['ui action planning', 'surface selection', 'vision snapshots', 'coordinate clicks'],
    version: '1.1.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'computer-use';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const surface = normalizeText(ctx.step.args.surface) || 'desktop';
    const screenshot = normalizeText(ctx.step.args.screenshot);
    const domSnapshot = ctx.step.args.domSnapshot;
    const actions = Array.isArray(ctx.step.args.actions)
      ? ctx.step.args.actions.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['click', 'type', 'scroll', 'drag', 'open', 'select', 'submit', 'focus', 'press']);
    const visionTargets = extractVisionTargets(domSnapshot);
    const coordinateClicks = visionTargets
      .filter((target) => target.box)
      .map((target) => ({
        selector: target.selector ?? target.text ?? 'unknown',
        x: Math.round((target.box!.x ?? 0) + (target.box!.width ?? 0) / 2),
        y: Math.round((target.box!.y ?? 0) + (target.box!.height ?? 0) / 2),
        action: target.action ?? (target.clickable === false ? 'inspect' : 'click'),
      }));
    const output = {
      objective,
      surface,
      vision: {
        screenshotPresent: screenshot.length > 0,
        domSnapshotPresent: Array.isArray(domSnapshot),
        targetCount: visionTargets.length,
        coordinateClicks,
        fallback: 'if the GUI cannot be represented with coordinates, fall back to browser extraction first',
      },
      interactionPlan: coordinateClicks.length > 0
        ? coordinateClicks.map((click) => `${click.action} at ${click.x},${click.y} for ${click.selector}`)
        : actions.length > 0
          ? actions.map((action) => `perform ${action}`)
          : ['inspect the interface', 'identify the next target', 'advance only with visible state'],
      safetyChecks: ['confirm the target application', 'avoid hidden destructive actions', 'capture state before submission'],
      nextAction: coordinateClicks.length > 0 ? 'execute the safest visible click first' : 'request a screenshot or DOM snapshot before acting',
    };
    recordArtifact(ctx, output);
    return result('vision-backed computer-use plan generated', output, { surface, targetCount: visionTargets.length, screenshotPresent: screenshot.length > 0 });
  }
}
